// WebSocket protocol types

// Client → Server
export type ClientMessage =
  | {
      type: 'chat';
      content: string;
      images?: string[];
      files?: { name: string; data: string }[];
      sessionId?: string;
    }
  | { type: 'get_session_state'; sessionId: string }
  | { type: 'ping' };

// Server → Client
export type ServerMessage =
  | {
      type: 'message';
      id: string;
      content: string;
      done: boolean;
      sessionId: string;
      mood?: string;
    }
  | { type: 'typing'; isTyping: boolean; sessionId?: string }
  | { type: 'tool_use'; tool: string; target?: string; sessionId?: string }
  | { type: 'connected' }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'mood'; current_mood: string; energy: number; activity: string }
  | { type: 'session_renamed'; sessionId: string; name: string }
  | {
      type: 'new_user_message';
      id: string;
      sender_name: string;
      content: string;
      timestamp: string;
      sessionId?: string;
    }
  | {
      type: 'session_state';
      sessionId: string;
      typing: boolean;
      tool?: { tool: string; target?: string } | null;
      messageId?: string | null;
      content?: string | null;
      queued?: boolean;
    }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_progress'; taskId: string; tool: string; target?: string }
  | {
      type: 'task_complete';
      taskId: string;
      status: string;
      result: string | null;
      error: string | null;
      duration_ms: number;
    }
  | { type: 'presence'; state: string; lastSeenAt: string | null }
  | {
      type: 'read_receipt';
      receipts: Array<{ id: string; readAt: string }>;
    };
