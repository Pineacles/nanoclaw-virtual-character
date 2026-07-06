import fs from 'fs';
import path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';

import { GROUPS_DIR } from '../../config.js';
import {
  getTasksForGroup,
  createTask,
  updateTask,
  deleteTask,
  getMessageById,
  getNextBotMessage,
  deleteMessage,
  createWebSession,
  getWebSessions,
  updateWebSession,
  deleteWebSession,
} from '../../db.js';
import { CronExpressionParser } from 'cron-parser';
import { computeNextRun } from '../../task-scheduler.js';
import { logger } from '../../logger.js';
import { resolveMood } from './mood.js';
import {
  getGroupFolder,
  getGroupJid,
  getGroupDir as getGroupDirConfig,
  getGroupConfig,
  reloadGroupConfig,
  getAssistantName,
  getUserName,
  isFeatureEnabled,
} from './group-config.js';
import {
  listContextFiles,
  readContextFile,
  writeContextFile,
  deleteContextFile,
} from './context-loader.js';
import {
  buildAgentContext,
  getSessionContext,
  saveSessionContext,
  deleteSessionContext,
} from './context-builder.js';
import {
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  deleteWorkflow,
} from './workflow-loader.js';
import { getReceipts } from './receipts.js';

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function groupDir(): string {
  return getGroupDirConfig();
}

// --- Messages ---

function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  getMessages: ApiDeps['getMessages'],
): void {
  if (req.method !== 'GET') return error(res, 'Method not allowed', 405);
  const sessionId = url.searchParams.get('session_id') ?? undefined;
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(isNaN(rawLimit) ? 20 : Math.max(1, rawLimit), 100);
  const before = url.searchParams.get('before') ?? undefined;
  const messages = getMessages(sessionId, limit, before).map((m) => {
    let content = m.content;
    let system_context: string | null = null;

    // Preferred: sentinel-wrapped system block (new format).
    const sysMatch = content.match(/<<<sys>>>([\s\S]*?)<<<end-sys>>>\n?/);
    if (sysMatch) {
      system_context = sysMatch[1];
      content = content.replace(/<<<sys>>>[\s\S]*?<<<end-sys>>>\n?/, '');
    } else {
      // Backwards compat for messages stored before the sentinel change.
      // Use a GREEDY match to find the LAST ] followed by \n, since old
      // system blocks may contain inner ] characters from room bleed.
      const oldMatch = content.match(/^\[System: Current time is [\s\S]+\]\n/);
      if (oldMatch) {
        system_context = oldMatch[0].replace(/\n$/, '');
        content = content.slice(oldMatch[0].length);
      }
    }

    // Extract and strip auto-loaded memory context block.
    const autoMatch = content.match(
      /<<<auto-memory>>>\n([\s\S]*?)\n<<<end-auto-memory>>>/,
    );
    let auto_loaded_memories: string[] = [];
    if (autoMatch) {
      auto_loaded_memories = [
        ...autoMatch[1].matchAll(/^--- (.+?) ---$/gm),
      ].map((mm) => mm[1].trim());
      content = content.replace(
        /\n?<<<auto-memory>>>[\s\S]*?<<<end-auto-memory>>>\n?/,
        '',
      );
    }

    return { ...m, content, auto_loaded_memories, system_context };
  });
  json(res, messages);
}

function handleDeleteMessage(
  _req: IncomingMessage,
  res: ServerResponse,
  messageId: string,
): void {
  const msg = getMessageById(messageId, getGroupJid());
  if (!msg) return error(res, 'Message not found', 404);

  const deletedIds: string[] = [messageId];

  // If user message, also delete the next bot response
  if (msg.is_bot_message === 0) {
    const nextBot = getNextBotMessage(
      getGroupJid(),
      msg.timestamp,
      msg.session_id,
    );
    if (nextBot) {
      deleteMessage(nextBot.id, getGroupJid());
      deletedIds.push(nextBot.id);
    }
  }

  deleteMessage(messageId, getGroupJid());
  json(res, { ok: true, deletedIds });
}

// --- Sessions ---

function handleSessionsList(_req: IncomingMessage, res: ServerResponse): void {
  json(res, getWebSessions());
}

async function handleSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const id = crypto.randomUUID();
  const mode = body.mode === 'plain' ? 'plain' : 'persona';
  const session = createWebSession(id, body.name || 'New Chat', mode);
  json(res, session, 201);
}

async function handleSessionUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  updateWebSession(sessionId, body.name);
  json(res, { ok: true });
}

function handleSessionDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): void {
  if (sessionId === 'whatsapp') {
    return error(res, 'Cannot delete the WhatsApp session', 403);
  }
  deleteWebSession(sessionId);
  deleteSessionContext(sessionId);
  json(res, { ok: true });
}

// --- Memory ---

function handleMemoryList(_req: IncomingMessage, res: ServerResponse): void {
  const dir = groupDir();
  if (!fs.existsSync(dir)) return json(res, []);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const result = files.map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return {
      filename: f,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  });
  json(res, result);
}

function handleMemoryRead(
  _req: IncomingMessage,
  res: ServerResponse,
  filename: string,
): void {
  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/')
  ) {
    return error(res, 'Invalid filename', 400);
  }
  const filePath = path.join(groupDir(), filename);
  if (!fs.existsSync(filePath)) return error(res, 'Not found', 404);
  const content = fs.readFileSync(filePath, 'utf-8');
  json(res, { filename, content });
}

async function handleMemoryWrite(
  req: IncomingMessage,
  res: ServerResponse,
  filename: string,
): Promise<void> {
  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/')
  ) {
    return error(res, 'Invalid filename', 400);
  }
  const body = JSON.parse(await readBody(req));
  const filePath = path.join(groupDir(), filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body.content, 'utf-8');
  json(res, { ok: true });
}

function handleMemoryDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  filename: string,
): void {
  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/')
  ) {
    return error(res, 'Invalid filename', 400);
  }
  if (filename === 'CLAUDE.md') {
    return error(res, 'Cannot delete system prompt file', 403);
  }
  const filePath = path.join(groupDir(), filename);
  if (!fs.existsSync(filePath)) return error(res, 'Not found', 404);
  fs.unlinkSync(filePath);
  json(res, { ok: true });
}

async function handleMemoryCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!body.filename || !body.filename.endsWith('.md')) {
    return error(res, 'filename must end with .md', 400);
  }
  if (body.filename.includes('..') || body.filename.includes('/')) {
    return error(res, 'Invalid filename', 400);
  }
  const filePath = path.join(groupDir(), body.filename);
  if (fs.existsSync(filePath)) return error(res, 'File already exists', 409);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body.content || '', 'utf-8');
  json(res, { ok: true }, 201);
}

// --- Tasks ---

function handleTasksList(_req: IncomingMessage, res: ServerResponse): void {
  const tasks = getTasksForGroup(getGroupFolder());
  json(res, tasks);
}

async function handleTaskCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const scheduleType = body.schedule_type || 'once';

  // Validate cron expression before creating
  if (scheduleType === 'cron' && body.schedule_value) {
    try {
      CronExpressionParser.parse(body.schedule_value);
    } catch {
      return error(
        res,
        `Invalid cron expression: "${body.schedule_value}"`,
        400,
      );
    }
  }

  // Generate title from prompt (first 50 chars, first sentence)
  const autoTitle =
    body.title ||
    body.prompt
      .split(/[.!?\n]/)[0]
      .slice(0, 50)
      .trim() ||
    'Untitled Job';

  const task = {
    id: crypto.randomUUID(),
    group_folder: getGroupFolder(),
    chat_jid: getGroupJid(),
    prompt: body.prompt,
    schedule_type: scheduleType,
    schedule_value: body.schedule_value || '',
    context_mode: body.context_mode || ('group' as const),
    next_run: body.next_run || null,
    status: 'active' as const,
    created_at: new Date().toISOString(),
    title: autoTitle,
    decision_mode: body.decision_mode ?? 0,
    workflow_ref: body.workflow_ref || null,
    reference_files: body.reference_files || null,
    run_as: body.run_as || 'default',
    model: body.model || null,
  };
  // Auto-compute next_run for cron/interval tasks if not provided
  if (!task.next_run && task.schedule_type !== 'once') {
    task.next_run = computeNextRun(
      task as Parameters<typeof computeNextRun>[0],
    );
  }
  createTask(task);
  json(res, task, 201);
}

async function handleTaskUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  updateTask(taskId, body);
  json(res, { ok: true });
}

function handleTaskDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): void {
  deleteTask(taskId);
  json(res, { ok: true });
}

// --- Image Upload ---

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!body.data || !body.filename) {
    return error(res, 'data and filename required', 400);
  }

  // Validate filename
  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp = Date.now();
  const filename = `${timestamp}_${safeName}`;

  const uploadsDir = path.join(groupDir(), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  // Decode base64 data URI
  const matches = body.data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return error(res, 'Invalid data URI', 400);

  const buffer = Buffer.from(matches[2], 'base64');
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, buffer);

  json(res, {
    path: `/workspace/group/uploads/${filename}`,
    filename,
  });
}

// --- Settings ---

function settingsPath(): string {
  return path.join(groupDir(), 'settings.json');
}

function handleSettingsGet(_req: IncomingMessage, res: ServerResponse): void {
  const p = settingsPath();
  if (!fs.existsSync(p)) return json(res, {});
  try {
    json(res, JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    json(res, {});
  }
}

async function handleSettingsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  fs.mkdirSync(groupDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(body, null, 2), 'utf-8');
  json(res, { ok: true });
}

// --- Quick Actions ---

function quickActionsPath(): string {
  return path.join(groupDir(), 'quick-actions.json');
}

function handleQuickActionsGet(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const p = quickActionsPath();
  if (!fs.existsSync(p)) return json(res, []);
  try {
    json(res, JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    json(res, []);
  }
}

async function handleQuickActionCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const p = quickActionsPath();
  let actions: Array<{ id: string; label: string; prompt: string }> = [];
  if (fs.existsSync(p)) {
    try {
      actions = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      /* empty */
    }
  }
  const action = {
    id: crypto.randomUUID(),
    label: body.label,
    prompt: body.prompt,
  };
  actions.push(action);
  fs.mkdirSync(groupDir(), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(actions, null, 2), 'utf-8');
  json(res, action, 201);
}

function handleQuickActionDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  actionId: string,
): void {
  const p = quickActionsPath();
  if (!fs.existsSync(p)) return error(res, 'Not found', 404);
  let actions: Array<{ id: string; label: string; prompt: string }> = [];
  try {
    actions = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return error(res, 'Not found', 404);
  }
  const filtered = actions.filter((a) => a.id !== actionId);
  if (filtered.length === actions.length) return error(res, 'Not found', 404);
  fs.writeFileSync(p, JSON.stringify(filtered, null, 2), 'utf-8');
  json(res, { ok: true });
}

// --- Session Media ---

interface MediaItem {
  url: string;
  filename: string;
  type: 'image' | 'file';
  messageId: string;
  timestamp: string;
  sender: 'user' | 'bot';
}

function handleSessionMedia(
  res: ServerResponse,
  sessionId: string,
  url: URL,
  getMessages: ApiDeps['getMessages'],
): void {
  const IMAGE_MARKER =
    /\[Image: (?:\/workspace\/group\/uploads\/|uploads\/)([^\]]+)\]/g;
  const FILE_MARKER =
    /\[File: (?:\/workspace\/group\/uploads\/|uploads\/)([^\]]+)\]/g;
  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;

  const rawLimit = parseInt(url.searchParams.get('limit') ?? '30', 10);
  const mediaLimit = Math.min(
    isNaN(rawLimit) ? 30 : Math.max(1, rawLimit),
    100,
  );
  const before = url.searchParams.get('before') ?? undefined;

  // Use a large scan window to find enough media items — we'll cap after scanning.
  // The before cursor restricts which messages we scan (by message timestamp).
  const msgs = getMessages(sessionId, 5000, before);
  const items: MediaItem[] = [];

  for (const m of msgs) {
    const sender: 'user' | 'bot' = m.is_bot_message ? 'bot' : 'user';

    for (const re of [IMAGE_MARKER, FILE_MARKER]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(m.content)) !== null) {
        const filename = match[1];
        const isImage = IMAGE_EXTS.test(filename);
        items.push({
          url: `/uploads/${encodeURIComponent(filename)}`,
          filename,
          type: isImage ? 'image' : 'file',
          messageId: m.id,
          timestamp: m.timestamp,
          sender,
        });
      }
    }
  }

  // Newest first
  items.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Trim to requested page size
  const page = items.slice(0, mediaLimit);

  json(res, { items: page });
}

// --- Avatar ---

const AVATAR_FILES: Array<{ filename: string; mime: string }> = [
  { filename: 'avatar.png', mime: 'image/png' },
  { filename: 'avatar.jpg', mime: 'image/jpeg' },
  { filename: 'avatar.webp', mime: 'image/webp' },
];

function findAvatarFile(): { filePath: string; mime: string } | null {
  for (const { filename, mime } of AVATAR_FILES) {
    const filePath = path.join(groupDir(), filename);
    if (fs.existsSync(filePath)) return { filePath, mime };
  }
  return null;
}

function handleAvatarGet(req: IncomingMessage, res: ServerResponse): void {
  const found = findAvatarFile();
  if (!found) return error(res, 'Not found', 404);

  const stat = fs.statSync(found.filePath);
  const etag = `"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'private, max-age=300',
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': found.mime,
    ETag: etag,
    'Cache-Control': 'private, max-age=300',
  });
  res.end(fs.readFileSync(found.filePath));
}

// --- Route dispatcher ---

export interface TaskProgressEvent {
  type: 'task_started' | 'task_progress' | 'task_complete';
  taskId: string;
  tool?: string;
  target?: string;
  status?: string;
  result?: string | null;
  error?: string | null;
  duration_ms?: number;
}

export interface ApiDeps {
  getMessages: (
    sessionId?: string,
    limit?: number,
    before?: string,
  ) => Array<{
    id: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_bot_message: number;
    mood: string;
  }>;
  runTaskNow?: (
    taskId: string,
    onProgress?: (event: TaskProgressEvent) => void,
  ) => Promise<{
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
  }>;
  broadcast?: (msg: unknown) => void;
}

export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // Messages
    if (p === '/api/messages' && method === 'GET') {
      handleMessages(req, res, url, deps.getMessages);
      return true;
    }
    const messageMatch = p.match(/^\/api\/messages\/(.+)$/);
    if (messageMatch && method === 'DELETE') {
      handleDeleteMessage(req, res, decodeURIComponent(messageMatch[1]));
      return true;
    }

    // Sessions
    if (p === '/api/sessions' && method === 'GET') {
      handleSessionsList(req, res);
      return true;
    }
    if (p === '/api/sessions' && method === 'POST') {
      await handleSessionCreate(req, res);
      return true;
    }
    // Per-session media — must be checked before the catch-all /api/sessions/:id
    const sessMediaMatch = p.match(/^\/api\/sessions\/([^/]+)\/media$/);
    if (sessMediaMatch && method === 'GET') {
      handleSessionMedia(
        res,
        decodeURIComponent(sessMediaMatch[1]),
        url,
        deps.getMessages,
      );
      return true;
    }

    // Per-session context — must be checked before the catch-all /api/sessions/:id
    const sessCtxMatch = p.match(/^\/api\/sessions\/([^/]+)\/context$/);
    if (sessCtxMatch) {
      const sessionId = decodeURIComponent(sessCtxMatch[1]);
      if (method === 'GET') {
        json(res, getSessionContext(sessionId));
        return true;
      }
      if (method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        const updated = saveSessionContext(sessionId, body);
        json(res, updated);
        return true;
      }
    }
    const sessionMatch = p.match(/^\/api\/sessions\/(.+)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      if (method === 'PUT') {
        await handleSessionUpdate(req, res, sessionId);
        return true;
      }
      if (method === 'DELETE') {
        handleSessionDelete(req, res, sessionId);
        return true;
      }
    }

    // Memory
    if (p === '/api/memory' && method === 'GET') {
      handleMemoryList(req, res);
      return true;
    }
    if (p === '/api/memory' && method === 'POST') {
      await handleMemoryCreate(req, res);
      return true;
    }
    const memoryMatch = p.match(/^\/api\/memory\/(.+)$/);
    if (memoryMatch) {
      const filename = decodeURIComponent(memoryMatch[1]);
      if (method === 'GET') {
        handleMemoryRead(req, res, filename);
        return true;
      }
      if (method === 'PUT') {
        await handleMemoryWrite(req, res, filename);
        return true;
      }
      if (method === 'DELETE') {
        handleMemoryDelete(req, res, filename);
        return true;
      }
    }

    // Tasks
    if (p === '/api/tasks' && method === 'GET') {
      handleTasksList(req, res);
      return true;
    }
    if (p === '/api/tasks' && method === 'POST') {
      await handleTaskCreate(req, res);
      return true;
    }
    const taskRunMatch = p.match(/^\/api\/tasks\/(.+)\/run$/);
    if (taskRunMatch && method === 'POST') {
      const taskId = decodeURIComponent(taskRunMatch[1]);
      if (!deps.runTaskNow) {
        return (error(res, 'Run task not available', 501), true);
      }
      logger.info({ taskId }, 'Task test-run requested');
      // Run in background to avoid HTTP timeout (tasks can take minutes)
      json(res, { status: 'started', taskId });
      const onProgress = deps.broadcast
        ? (event: TaskProgressEvent) => deps.broadcast!(event)
        : undefined;
      deps
        .runTaskNow(taskId, onProgress)
        .then((result) => {
          logger.info(
            {
              taskId,
              status: result.status,
              duration_ms: result.duration_ms,
              result: result.result?.slice(0, 200),
            },
            'Task test-run completed',
          );
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ taskId, err: msg }, 'Task test-run failed');
          deps.broadcast?.({
            type: 'task_complete',
            taskId,
            status: 'error',
            result: null,
            error: msg,
            duration_ms: 0,
          });
        });
      return true;
    }

    const taskMatch = p.match(/^\/api\/tasks\/(.+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      if (method === 'PUT') {
        await handleTaskUpdate(req, res, taskId);
        return true;
      }
      if (method === 'DELETE') {
        handleTaskDelete(req, res, taskId);
        return true;
      }
    }

    // Mood
    if (p === '/api/mood' && method === 'GET') {
      if (!isFeatureEnabled('mood')) {
        json(res, { current_mood: 'neutral', energy: 5, activity: '' });
        return true;
      }
      json(res, resolveMood());
      return true;
    }

    // Read receipts
    if (p === '/api/receipts' && method === 'GET') {
      if (!isFeatureEnabled('presence_indicator')) {
        json(res, { receipts: {} });
        return true;
      }
      json(res, { receipts: getReceipts(getGroupFolder()) });
      return true;
    }

    // Upload
    if (p === '/api/upload' && method === 'POST') {
      await handleUpload(req, res);
      return true;
    }

    // Settings
    if (p === '/api/settings' && method === 'GET') {
      handleSettingsGet(req, res);
      return true;
    }
    if (p === '/api/settings' && method === 'PUT') {
      await handleSettingsUpdate(req, res);
      return true;
    }

    // Quick Actions
    if (p === '/api/quick-actions' && method === 'GET') {
      handleQuickActionsGet(req, res);
      return true;
    }
    if (p === '/api/quick-actions' && method === 'POST') {
      await handleQuickActionCreate(req, res);
      return true;
    }
    const qaMatch = p.match(/^\/api\/quick-actions\/(.+)$/);
    if (qaMatch && method === 'DELETE') {
      handleQuickActionDelete(req, res, decodeURIComponent(qaMatch[1]));
      return true;
    }

    // Context files
    if (p === '/api/context' && method === 'GET') {
      json(res, listContextFiles());
      return true;
    }
    if (p === '/api/context/preview' && method === 'GET') {
      const preview = buildAgentContext({
        sessionId: 'preview',
        source: 'web',
      });
      json(res, { context: preview });
      return true;
    }
    const ctxMatch = p.match(/^\/api\/context\/(.+)$/);
    if (ctxMatch) {
      const filename = decodeURIComponent(ctxMatch[1]);
      if (method === 'GET') {
        const content = readContextFile(filename);
        if (content === null) return (error(res, 'Not found', 404), true);
        json(res, { filename, content });
        return true;
      }
      if (method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!writeContextFile(filename, body.content || ''))
          return (error(res, 'Invalid filename', 400), true);
        json(res, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        if (!deleteContextFile(filename))
          return (error(res, 'Not found', 404), true);
        json(res, { ok: true });
        return true;
      }
    }

    // Voice call transcript save
    if (p === '/api/voice/call-ended' && method === 'POST') {
      if (!isFeatureEnabled('voice_call')) {
        error(res, 'Voice call feature is disabled', 403);
        return true;
      }
      const body = JSON.parse(await readBody(req));
      const transcript = body.transcript as {
        role: string;
        text: string;
        timestamp: string;
      }[];
      const durationSec = body.duration_seconds || 0;

      // Format transcript as markdown
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
      const filename = `call-${dateStr}-${timeStr}.md`;

      const lines = [
        `# Voice Call — ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
        `**Duration:** ${Math.floor(durationSec / 60)}m ${durationSec % 60}s`,
        '',
        '---',
        '',
      ];
      for (const entry of transcript) {
        const speaker =
          entry.role === 'user' ? getUserName() : getAssistantName();
        lines.push(`**${speaker}:** ${entry.text}`);
        lines.push('');
      }

      const convDir = path.join(groupDir(), 'conversations');
      fs.mkdirSync(convDir, { recursive: true });
      fs.writeFileSync(path.join(convDir, filename), lines.join('\n'), 'utf-8');

      json(res, { ok: true, file: filename });
      return true;
    }

    // System prompt (.system-prompt — persona/identity block)
    if (p === '/api/system-prompt') {
      const promptPath = path.join(groupDir(), '.system-prompt');
      if (method === 'GET') {
        if (!fs.existsSync(promptPath))
          return (json(res, { content: '' }), true);
        json(res, { content: fs.readFileSync(promptPath, 'utf-8') });
        return true;
      }
      if (method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        fs.writeFileSync(promptPath, body.content || '', 'utf-8');
        json(res, { ok: true });
        return true;
      }
    }

    // Workflows
    if (p === '/api/workflows' && method === 'GET') {
      json(res, listWorkflows());
      return true;
    }
    if (p === '/api/workflows' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.filename || !body.filename.endsWith('.md')) {
        return (error(res, 'filename must end with .md', 400), true);
      }
      if (!writeWorkflow(body.filename, body.content || ''))
        return (error(res, 'Invalid filename', 400), true);
      json(res, { ok: true }, 201);
      return true;
    }
    const wfMatch = p.match(/^\/api\/workflows\/(.+)$/);
    if (wfMatch) {
      const filename = decodeURIComponent(wfMatch[1]);
      if (method === 'GET') {
        const wf = readWorkflow(filename);
        if (!wf) return (error(res, 'Not found', 404), true);
        json(res, wf);
        return true;
      }
      if (method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!writeWorkflow(filename, body.content || ''))
          return (error(res, 'Invalid filename', 400), true);
        json(res, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        if (!deleteWorkflow(filename))
          return (error(res, 'Not found', 404), true);
        json(res, { ok: true });
        return true;
      }
    }

    // Avatar
    if (p === '/api/avatar' && method === 'GET') {
      handleAvatarGet(req, res);
      return true;
    }

    // Group config
    if (p === '/api/group-config' && method === 'GET') {
      json(res, getGroupConfig());
      return true;
    }
    if (p === '/api/group-config' && method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const configPath = path.join(groupDir(), 'group.json');
      fs.writeFileSync(configPath, JSON.stringify(body, null, 2), 'utf-8');
      reloadGroupConfig();

      // Handle feature toggle side effects
      if (body.features) {
        const tasks = getTasksForGroup(
          body.group_folder || getGroupConfig().group_folder,
        );

        const featureKeywords: Record<string, string[]> = {
          mood: ['mood schedule'],
          personality: ['Big Five personality'],
          diary: ['weekly reflection'],
        };

        for (const [feature, keywords] of Object.entries(featureKeywords)) {
          const enabled = body.features[feature] !== false;
          const relatedTasks = tasks.filter((t) =>
            keywords.some((kw) => t.prompt.includes(kw)),
          );

          for (const task of relatedTasks) {
            if (enabled && task.status === 'paused') {
              updateTask(task.id, { status: 'active' });
            } else if (!enabled && task.status === 'active') {
              updateTask(task.id, { status: 'paused' });
            }
          }
        }
      }

      json(res, { ok: true });
      return true;
    }

    // Feature health
    if (p === '/api/feature-health' && method === 'GET') {
      const config = getGroupConfig();
      const tasks = getTasksForGroup(config.group_folder);

      const featureTaskMap: Record<
        string,
        { keywords: string[]; required: boolean }
      > = {
        mood: { keywords: ['mood schedule'], required: true },
        personality: { keywords: ['Big Five personality'], required: false }, // one-time, not always needed
        diary: { keywords: ['weekly reflection'], required: true },
        // emotional_state, schedule, relationship, memory don't need tasks
      };

      const health: Record<
        string,
        {
          enabled: boolean;
          healthy: boolean;
          tasks: string[];
          missing_tasks?: string[];
        }
      > = {};

      for (const [feature, enabled] of Object.entries(config.features)) {
        const mapping = featureTaskMap[feature];
        if (!mapping) {
          // Features without tasks are healthy if enabled
          health[feature] = { enabled, healthy: true, tasks: [] };
          continue;
        }

        const foundTasks = tasks.filter(
          (t) =>
            mapping.keywords.some((kw) => t.prompt.includes(kw)) &&
            t.status === 'active',
        );
        const hasRequired = !mapping.required || foundTasks.length > 0;

        health[feature] = {
          enabled,
          healthy: !enabled || hasRequired,
          tasks: foundTasks.map((t) => t.title || t.id),
          ...(enabled && !hasRequired
            ? { missing_tasks: mapping.keywords }
            : {}),
        };
      }

      json(res, health);
      return true;
    }

    return false;
  } catch (err) {
    logger.error({ err, path: p }, 'API route error');
    error(res, 'Internal server error', 500);
    return true;
  }
}
