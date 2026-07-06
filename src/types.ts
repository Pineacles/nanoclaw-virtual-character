export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  session_id?: string;
  mood?: string;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  // Workflow filenames whose triggers matched the raw user content for this message.
  // Computed at message-arrival time (web-server.ts) so src/index.ts doesn't have to
  // strip the [System: ...] prefix to recover the original user text. In-memory only;
  // not persisted to DB — the verdict gets attached to the bot reply via *[wf:...]* tag.
  triggered_workflows?: string[];
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once' | 'dynamic';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  title?: string;
  feature?: string; // Feature this task belongs to (e.g., 'mood', 'diary', 'personality')
  decision_mode?: number;
  workflow_ref?: string | null;
  reference_files?: string | null;
  run_as?: string;
  model?: string | null;
  room_read_level?: 'strong' | 'light' | 'gate' | null;
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sessionId?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: send a media file (image, audio, video, document).
  sendMedia?(
    jid: string,
    filePath: string,
    caption?: string,
    voiceNote?: boolean,
    sessionId?: string,
  ): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean, sessionId?: string): Promise<void>;
  // Optional: real-time tool use status. Channels that support it show what the agent is doing.
  setToolUse?(
    jid: string,
    tool: string,
    target?: string,
    sessionId?: string,
  ): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: override SDK session key (e.g. per-web-session isolation).
  getSessionKey?(groupFolder: string, sessionId?: string): string;
  // Optional: inject a message from another channel (WhatsApp bridge).
  injectBridgedMessage?(
    senderJid: string,
    senderName: string,
    content: string,
    images?: Buffer[],
    audios?: BridgedAudio[],
  ): void | Promise<void>;
  // Optional: show queue status for a session.
  setQueued?(sessionId: string, queued: boolean): void;
  // Optional: mirror a message to web clients WITHOUT storing it in the DB.
  // Used by paths that already call storeMessageDirect explicitly (impulse /
  // scheduler reach-out) so the web UI stays in sync without a duplicate row.
  broadcastOnly?(text: string, sessionId?: string): Promise<void>;
  // Optional: mark buffered inbound messages as read (blue ticks).
  // Implementations send read receipts for all buffered keys for the given jid,
  // then clear the buffer. Gated per-group on the presence_indicator feature flag.
  markRead?(jid: string): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

/** A voice note / audio attachment bridged to the web pipeline. The raw
 *  decrypted bytes are kept untouched (OGG/Opus for ptt) and saved by the
 *  receiver; normalization for STT happens downstream in the TTS gateway. */
export interface BridgedAudio {
  data: Buffer;
  /** push-to-talk voice note (true) vs. a shared audio file (false) */
  ptt: boolean;
  mimetype?: string;
}

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
