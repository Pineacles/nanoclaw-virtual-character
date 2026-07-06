import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { isLazyCronTitle } from './channels/web/cron-title.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add title column to scheduled_tasks (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN title TEXT DEFAULT ''`,
    );
  } catch {
    /* column already exists */
  }

  // Migrate draft tasks to active (draft status removed)
  database.exec(
    `UPDATE scheduled_tasks SET status = 'active' WHERE status = 'draft'`,
  );

  // Backfill titles for existing tasks without them
  {
    const untitled = database
      .prepare(
        `SELECT id, prompt FROM scheduled_tasks WHERE title IS NULL OR title = ''`,
      )
      .all() as Array<{ id: string; prompt: string }>;
    const stmt = database.prepare(
      `UPDATE scheduled_tasks SET title = ? WHERE id = ?`,
    );
    for (const t of untitled) {
      // Generate title: first sentence, max 50 chars
      const title =
        t.prompt
          .replace(/^\[.*?\]\s*/, '') // strip [System: ...] prefixes
          .replace(/^You are \w+[.,]\s*/i, '') // strip "You are <Assistant>."
          .split(/[.!?\n]/)[0]
          .trim()
          .slice(0, 50) || 'Untitled Job';
      stmt.run(title, t.id);
    }
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Web sessions table for multiple chat sessions
  database.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Add mode column to web_sessions (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE web_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'persona'`,
    );
  } catch {
    /* column already exists */
  }

  // Add session_id column to messages (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Always backfill: ensure no web messages have NULL session_id
  {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT OR IGNORE INTO web_sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run('default', 'Chat 1', now, now);
    database.exec(
      `UPDATE messages SET session_id = 'default' WHERE chat_jid LIKE 'web:%' AND session_id IS NULL`,
    );
  }

  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id)`,
  );

  // Add mood column to messages (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN mood TEXT DEFAULT 'chill'`);
  } catch {
    /* column already exists */
  }

  // Add feature column to scheduled_tasks (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN feature TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add decision_mode, workflow_ref, reference_files, run_as columns (migration for existing DBs)
  const columnsToAdd = [
    `ALTER TABLE scheduled_tasks ADD COLUMN decision_mode INTEGER DEFAULT 0`,
    `ALTER TABLE scheduled_tasks ADD COLUMN workflow_ref TEXT`,
    `ALTER TABLE scheduled_tasks ADD COLUMN reference_files TEXT`,
    `ALTER TABLE scheduled_tasks ADD COLUMN run_as TEXT DEFAULT 'default'`,
    `ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT NULL`,
    `ALTER TABLE scheduled_tasks ADD COLUMN room_read_level TEXT DEFAULT NULL`,
  ];
  for (const sql of columnsToAdd) {
    try {
      database.exec(sql);
    } catch {
      /* already exists */
    }
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage & { session_id?: string }): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, session_id, mood, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.session_id ?? null,
    msg.mood ?? 'chill',
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  session_id?: string;
  mood?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, session_id, mood) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.session_id ?? null,
    msg.mood ?? 'chill',
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, session_id,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, session_id,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * Return the mood column from the last N bot messages in this chat,
 * ordered oldest → newest. Used for stuck-pattern detection in the
 * per-message context. Skips messages with no mood set.
 */
export function getRecentMoods(chatJid: string, limit: number = 8): string[] {
  const sql = `
    SELECT mood FROM (
      SELECT mood, timestamp FROM messages
      WHERE chat_jid = ? AND is_bot_message = 1
        AND mood IS NOT NULL AND mood != ''
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(chatJid, limit) as { mood: string }[];
  return rows.map((r) => r.mood);
}

/**
 * Return the last N non-bot message contents for a chat, oldest → newest.
 * Used by style-tracker for deterministic style computation.
 */
export function getRecentUserMessages(
  chatJid: string,
  limit: number = 8,
): string[] {
  const sql = `
    SELECT content FROM (
      SELECT content, timestamp FROM messages
      WHERE chat_jid = ? AND is_bot_message = 0
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(chatJid, limit) as { content: string }[];
  return rows.map((r) => r.content);
}

/** Count non-bot messages in a chat since a given timestamp */
export function countRecentMessages(
  chatJid: string,
  sinceTimestamp: string,
): number {
  const sql = `
    SELECT COUNT(*) as cnt FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND is_bot_message = 0
      AND content != '' AND content IS NOT NULL
  `;
  const row = db.prepare(sql).get(chatJid, sinceTimestamp) as { cnt: number };
  return row?.cnt || 0;
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at, title, decision_mode, workflow_ref, reference_files, run_as, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.title || '',
    task.decision_mode ?? 0,
    task.workflow_ref || null,
    task.reference_files || null,
    task.run_as || 'default',
    task.model || null,
  );

  // Auto-generate a title via Haiku if none was supplied
  if (isLazyCronTitle(task.title)) {
    // Lazy import to avoid circular dependency
    import('./channels/web/cron-title.js')
      .then(({ regenerateCronTitleAsync }) => {
        regenerateCronTitleAsync(task.id, task.prompt);
      })
      .catch((err) => {
        // Log but never throw — title regen must never break task creation
        console.error('[cron-title] Failed to dispatch regen:', err);
      });
  }
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'context_mode'
      | 'title'
      | 'decision_mode'
      | 'workflow_ref'
      | 'reference_files'
      | 'run_as'
      | 'model'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.decision_mode !== undefined) {
    fields.push('decision_mode = ?');
    values.push(updates.decision_mode);
  }
  if (updates.workflow_ref !== undefined) {
    fields.push('workflow_ref = ?');
    values.push(updates.workflow_ref || null);
  }
  if (updates.reference_files !== undefined) {
    fields.push('reference_files = ?');
    values.push(updates.reference_files || null);
  }
  if (updates.run_as !== undefined) {
    fields.push('run_as = ?');
    values.push(updates.run_as || 'default');
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model || null);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getSuccessfulRunCount(taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM task_run_logs WHERE task_id = ? AND status = 'success'`,
    )
    .get(taskId) as { cnt: number };
  return row.cnt;
}

/**
 * Get all messages for a chat (including bot messages).
 * Used for chat history display where both sides of the conversation are needed.
 * When `before` is provided (ISO timestamp), returns only messages older than that timestamp.
 */
export function getChatMessages(
  chatJid: string,
  limit: number = 5000,
  sessionId?: string,
  before?: string,
): Array<{
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  mood: string;
}> {
  const sessionFilter = sessionId ? ' AND session_id = ?' : '';
  const beforeFilter = before ? ' AND timestamp < ?' : '';
  const sql = `
    SELECT * FROM (
      SELECT id, sender_name, content, timestamp, is_bot_message, COALESCE(mood, 'chill') as mood
      FROM messages
      WHERE chat_jid = ? AND content != '' AND content IS NOT NULL${sessionFilter}${beforeFilter}
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const params: unknown[] = [chatJid];
  if (sessionId) params.push(sessionId);
  if (before) params.push(before);
  params.push(limit);
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_bot_message: number;
    mood: string;
  }>;
}

// --- Message delete accessors ---

export function getMessageById(
  id: string,
  chatJid: string,
):
  | {
      id: string;
      timestamp: string;
      is_bot_message: number;
      session_id: string | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT id, timestamp, is_bot_message, session_id FROM messages WHERE id = ? AND chat_jid = ?`,
    )
    .get(id, chatJid) as
    | {
        id: string;
        timestamp: string;
        is_bot_message: number;
        session_id: string | null;
      }
    | undefined;
}

/**
 * Return self-initiated bot messages (cron `sched-` and impulse `impulse-`)
 * for a chat+session within a timestamp window. These bypass the Claude SDK
 * session JSONL when sent, so the agent has no record of them when it next
 * resumes. We re-inject them into the prompt so reply context is intact.
 *
 * Window is exclusive on the lower bound (sinceTimestamp) and inclusive on
 * the upper bound (toTimestamp).
 */
export function getSelfInitiatedOutbound(
  chatJid: string,
  sessionId: string | null | undefined,
  sinceTimestamp: string,
  toTimestamp: string,
  limit: number = 20,
): NewMessage[] {
  const sessionFilter = sessionId ? ' AND session_id = ?' : '';
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, session_id,
           reply_to_message_id, reply_to_message_content, reply_to_sender_name
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND timestamp <= ?
      AND is_bot_message = 1
      AND (id LIKE 'sched-%' OR id LIKE 'impulse-%')${sessionFilter}
    ORDER BY timestamp ASC
    LIMIT ?
  `;
  const params: unknown[] = sessionId
    ? [chatJid, sinceTimestamp, toTimestamp, sessionId, limit]
    : [chatJid, sinceTimestamp, toTimestamp, limit];
  return db.prepare(sql).all(...params) as NewMessage[];
}

export function getNextBotMessage(
  chatJid: string,
  afterTimestamp: string,
  sessionId?: string | null,
): { id: string } | undefined {
  const sessionFilter = sessionId ? ' AND session_id = ?' : '';
  const sql = `SELECT id FROM messages WHERE chat_jid = ? AND timestamp > ? AND is_bot_message = 1${sessionFilter} ORDER BY timestamp LIMIT 1`;
  const params = sessionId
    ? [chatJid, afterTimestamp, sessionId]
    : [chatJid, afterTimestamp];
  return db.prepare(sql).get(...params) as { id: string } | undefined;
}

export function deleteMessage(id: string, chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?').run(
    id,
    chatJid,
  );
}

// --- Web session accessors ---

export interface WebSession {
  id: string;
  name: string;
  mode: 'persona' | 'plain';
  created_at: string;
  updated_at: string;
}

export function createWebSession(
  id: string,
  name: string,
  mode: 'persona' | 'plain' = 'persona',
): WebSession {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO web_sessions (id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, mode, now, now);
  return { id, name, mode, created_at: now, updated_at: now };
}

export function getWebSessionById(id: string): WebSession | undefined {
  return db.prepare('SELECT * FROM web_sessions WHERE id = ?').get(id) as
    | WebSession
    | undefined;
}

export function getWebSessions(): WebSession[] {
  return db
    .prepare('SELECT * FROM web_sessions ORDER BY updated_at DESC')
    .all() as WebSession[];
}

export function updateWebSession(id: string, name: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE web_sessions SET name = ?, updated_at = ? WHERE id = ?',
  ).run(name, now, id);
}

export function deleteWebSession(id: string): void {
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM web_sessions WHERE id = ?').run(id);
}

export function getBotMessageCount(chatJid: string, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE chat_jid = ? AND session_id = ? AND is_bot_message = 1`,
    )
    .get(chatJid, sessionId) as { cnt: number };
  return row.cnt;
}

export function touchWebSession(id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE web_sessions SET updated_at = ? WHERE id = ?').run(
    now,
    id,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Chat query for container agents ---

export interface ChatQueryOptions {
  groupFolder: string;
  limit?: number;
  source?: string;
  since?: string;
  sender?: string;
}

export interface ChatQueryRow {
  timestamp: string;
  channel: string;
  sender_name: string;
  content: string;
}

/**
 * Query chat messages across all JIDs belonging to a group.
 * Used by the internal API so container agents can read recent chat history.
 */
export function queryChatMessages(opts: ChatQueryOptions): ChatQueryRow[] {
  // Find all JIDs that belong to this group
  const jidRows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(opts.groupFolder) as Array<{ jid: string }>;

  if (jidRows.length === 0) return [];

  const jids = jidRows.map((r) => r.jid);
  const placeholders = jids.map(() => '?').join(',');

  const conditions: string[] = [`m.chat_jid IN (${placeholders})`];
  const params: unknown[] = [...jids];

  if (opts.since) {
    conditions.push('m.timestamp > ?');
    params.push(opts.since);
  }

  if (opts.sender) {
    conditions.push('m.sender_name LIKE ?');
    params.push(`%${opts.sender}%`);
  }

  if (opts.source && opts.source !== 'all') {
    conditions.push('COALESCE(c.channel, ?) = ?');
    params.push(opts.source, opts.source);
  }

  const limit = opts.limit ?? 20;
  params.push(limit);

  const sql = `
    SELECT * FROM (
      SELECT m.timestamp,
             COALESCE(c.channel, 'unknown') as channel,
             m.sender_name,
             m.content
      FROM messages m
      LEFT JOIN chats c ON m.chat_jid = c.jid
      WHERE ${conditions.join(' AND ')}
        AND m.content != '' AND m.content IS NOT NULL
      ORDER BY m.timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  return db.prepare(sql).all(...params) as ChatQueryRow[];
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
