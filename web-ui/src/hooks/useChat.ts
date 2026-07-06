// Adapted from web-ui-legacy — backend WS contract unchanged.
// workflowVerdict added to ChatMessage to match the design's badge system.
// presence + read_receipt WS events added.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from './useWebSocket';
import type { ServerMessage } from './useWebSocket';

export type PresenceState = 'online' | 'away' | 'sleeping' | 'offline';

export interface PresenceEvent {
  state: PresenceState;
  lastSeenAt: string | null;
}

export interface WorkflowVerdict {
  used: string[];
  skipped: string[];
}

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'bot';
  timestamp: string;
  streaming?: boolean;
  mood?: string;
  autoLoadedMemories?: string[];
  workflowVerdict?: WorkflowVerdict;
  systemContext?: string | null;
  readAt?: string;
}

export interface ToolStatus {
  tool: string;
  target?: string;
}

export interface TaskEvent {
  type: 'task_started' | 'task_progress' | 'task_complete';
  taskId: string;
  tool?: string;
  target?: string;
  status?: string;
  result?: string | null;
  error?: string | null;
  duration_ms?: number;
}

/** Parses the *[wf:✓ name1,name2 | ⚠ skipped1]* suffix from bot message content. */
function parseWorkflowVerdict(content: string): { clean: string; verdict: WorkflowVerdict | undefined } {
  const match = content.match(/\*\[wf:(.*?)\]\*\s*$/);
  if (!match) return { clean: content, verdict: undefined };

  const raw = match[1];
  const used: string[] = [];
  const skipped: string[] = [];

  const parts = raw.split('|');
  for (const part of parts) {
    const t = part.trim();
    if (t.startsWith('✓')) {
      used.push(...t.slice(1).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (t.startsWith('⚠')) {
      skipped.push(...t.slice(1).split(',').map((s) => s.trim()).filter(Boolean));
    }
  }

  return {
    clean: content.slice(0, match.index).trim(),
    verdict: used.length > 0 || skipped.length > 0 ? { used, skipped } : undefined,
  };
}

// REST response shape from /api/messages
interface ApiMessage {
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  mood: string;
  auto_loaded_memories?: string[];
  system_context?: string | null;
}

/** Map a single ApiMessage to ChatMessage (shared between initial load and loadOlder). */
function mapApiMessage(m: ApiMessage): ChatMessage {
  if (m.is_bot_message) {
    const { clean, verdict } = parseWorkflowVerdict(m.content);
    return {
      id: m.id,
      content: clean,
      sender: 'bot' as const,
      timestamp: m.timestamp,
      mood: m.mood,
      autoLoadedMemories: m.auto_loaded_memories,
      workflowVerdict: verdict,
    };
  }
  return {
    id: m.id,
    content: m.content,
    sender: 'user' as const,
    timestamp: m.timestamp,
    autoLoadedMemories: m.auto_loaded_memories,
    systemContext: m.system_context,
  };
}

const PAGE_SIZE = 20;

export function useChat(
  authenticated: boolean,
  activeSessionId: string,
  onMoodPush?: (mood: { current_mood: string; energy: number; activity: string }) => void,
  onSessionRenamed?: (sessionId: string, name: string) => void,
  onTaskEvent?: (event: TaskEvent) => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingBubble, setStreamingBubble] = useState<ChatMessage | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [isQueued, setIsQueued] = useState(false);
  const [presence, setPresence] = useState<PresenceEvent | null>(null);

  // Pagination state
  const [oldestTimestamp, setOldestTimestamp] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const onMoodPushRef = useRef(onMoodPush);
  const onSessionRenamedRef = useRef(onSessionRenamed);
  const onTaskEventRef = useRef(onTaskEvent);
  const activeSessionIdRef = useRef(activeSessionId);
  const streamingRef = useRef<{ id: string; content: string } | null>(null);

  onMoodPushRef.current = onMoodPush;
  onTaskEventRef.current = onTaskEvent;
  activeSessionIdRef.current = activeSessionId;
  onSessionRenamedRef.current = onSessionRenamed;

  // Load history on mount and session switch.
  // Reset pagination state on session switch, then fetch latest page.
  // Also fetch /api/receipts to merge readAt into user messages (404 = silently skip).
  useEffect(() => {
    if (!authenticated) return;
    // Reset pagination before fetch
    setOldestTimestamp(null);
    setHasMoreOlder(false);
    setLoadingOlder(false);

    const messagesPromise = api
      .get<ApiMessage[]>(`/api/messages?session_id=${encodeURIComponent(activeSessionId)}&limit=${PAGE_SIZE}`);
    const receiptsPromise = api
      .get<{ receipts: Record<string, string> }>('/api/receipts')
      .then((r) => r.receipts)
      .catch(() => ({} as Record<string, string>));

    Promise.all([messagesPromise, receiptsPromise])
      .then(([msgs, receipts]) => {
        const mapped = msgs.map((m) => {
          const base = mapApiMessage(m);
          if (base.sender === 'user' && receipts[base.id]) {
            return { ...base, readAt: receipts[base.id] };
          }
          return base;
        });
        setMessages(mapped);
        setOldestTimestamp(msgs.length > 0 ? msgs[0].timestamp : null);
        setHasMoreOlder(msgs.length === PAGE_SIZE);
      })
      .catch(() => {
        // Will retry on reconnect
      });
  }, [authenticated, activeSessionId]);

  const onWsMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'presence') {
      const state = msg.state as PresenceState | undefined;
      const lastSeenAt = (msg.lastSeenAt as string | null | undefined) ?? null;
      if (state) {
        setPresence({ state, lastSeenAt });
      }
    }

    if (msg.type === 'read_receipt' && Array.isArray(msg.receipts)) {
      const incoming = msg.receipts as { id: string; readAt: string }[];
      if (incoming.length > 0) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.sender !== 'user') return m;
            const receipt = incoming.find((r) => r.id === m.id);
            if (receipt && receipt.readAt !== m.readAt) {
              return { ...m, readAt: receipt.readAt };
            }
            return m;
          }),
        );
      }
    }

    if (msg.type === 'new_user_message' && msg.id && msg.content) {
      const sessionId = msg.sessionId as string | undefined;
      if (sessionId && sessionId !== activeSessionIdRef.current) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [
          ...prev,
          {
            id: msg.id as string,
            content: msg.content as string,
            sender: 'user' as const,
            timestamp: (msg.timestamp as string | undefined) || new Date().toISOString(),
          },
        ];
      });
    }

    if (msg.type === 'session_renamed' && msg.sessionId && msg.name) {
      onSessionRenamedRef.current?.(msg.sessionId as string, msg.name as string);
    }

    if (msg.type === 'task_started' || msg.type === 'task_progress' || msg.type === 'task_complete') {
      onTaskEventRef.current?.(msg as unknown as TaskEvent);
    }

    if (msg.type === 'session_state') {
      const sm = msg as {
        type: string;
        sessionId?: string;
        isTyping?: boolean;
        tool?: { tool: string; target?: string };
        queued?: boolean;
        messageId?: string;
        content?: string;
      };
      if (sm.sessionId !== activeSessionIdRef.current) return;
      setIsTyping(!!sm.isTyping);
      setToolStatus(sm.tool ? { tool: sm.tool.tool, target: sm.tool.target } : null);
      setIsQueued(!!sm.queued);
      if (sm.messageId && sm.content) {
        setStreamingBubble({
          id: sm.messageId!,
          content: sm.content!,
          sender: 'bot',
          timestamp: new Date().toISOString(),
          streaming: true,
        });
      }
    }

    if (msg.type === 'mood' && msg.current_mood) {
      onMoodPushRef.current?.({
        current_mood: msg.current_mood as string,
        energy: (msg.energy as number | undefined) ?? 5,
        activity: (msg.activity as string | undefined) ?? '',
      });
    }

    if (msg.type === 'typing') {
      const sessionId = msg.sessionId as string | undefined;
      if (sessionId && sessionId !== activeSessionIdRef.current) return;
      const typing = (msg.isTyping as boolean | undefined) ?? false;
      setIsTyping(typing);
      if (typing) setIsQueued(false);
      if (!typing) setToolStatus(null);
    }

    if (msg.type === 'tool_use') {
      const sessionId = msg.sessionId as string | undefined;
      if (sessionId && sessionId !== activeSessionIdRef.current) return;
      setToolStatus({ tool: msg.tool as string, target: msg.target as string | undefined });
    }

    if (msg.type === 'message') {
      const { id, content, done, sessionId, mood } = msg as {
        type: string;
        id: string;
        content: string;
        done: boolean;
        sessionId?: string;
        mood?: string;
      };
      if (sessionId && sessionId !== activeSessionIdRef.current) return;
      if (content) setToolStatus(null);

      if (done) {
        setIsTyping(false);
        setToolStatus(null);
        const { clean, verdict } = parseWorkflowVerdict(content);
        setStreamingBubble(null);
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== id);
          return [
            ...filtered,
            {
              id,
              content: clean,
              sender: 'bot' as const,
              timestamp: new Date().toISOString(),
              mood,
              workflowVerdict: verdict,
            },
          ];
        });
        streamingRef.current = null;
      } else {
        streamingRef.current = { id, content };
        setStreamingBubble({
          id,
          content,
          sender: 'bot',
          timestamp: new Date().toISOString(),
          streaming: true,
        });
      }
    }
  }, []);

  const { connected, send } = useWebSocket({ onMessage: onWsMessage, enabled: authenticated });

  useEffect(() => {
    if (connected && activeSessionId) {
      send({ type: 'get_session_state', sessionId: activeSessionId });
    }
    setIsTyping(false);
    setToolStatus(null);
    setIsQueued(false);
    setStreamingBubble(null);
  }, [connected, activeSessionId, send]);

  const sendMessage = useCallback(
    (content: string, images?: string[], files?: { name: string; data: string }[]) => {
      send({ type: 'chat', content, images, files, sessionId: activeSessionId });
    },
    [send, activeSessionId],
  );

  const deleteMessage = useCallback(async (id: string) => {
    try {
      const result = await api.delete<{ ok: boolean; deletedIds: string[] }>(
        `/api/messages/${encodeURIComponent(id)}`,
      );
      if (result.deletedIds) {
        setMessages((prev) => prev.filter((m) => !result.deletedIds.includes(m.id)));
      }
    } catch {
      // ignore
    }
  }, []);

  /** Load the next older page of messages (prepend to list). */
  const loadOlder = useCallback(async () => {
    if (!hasMoreOlder || loadingOlder || !oldestTimestamp) return;
    setLoadingOlder(true);
    try {
      const older = await api.get<ApiMessage[]>(
        `/api/messages?session_id=${encodeURIComponent(activeSessionIdRef.current)}&limit=${PAGE_SIZE}&before=${encodeURIComponent(oldestTimestamp)}`,
      );
      const mappedOlder = older.map(mapApiMessage);
      setMessages((prev) => [...mappedOlder, ...prev]);
      setOldestTimestamp(older.length > 0 ? older[0].timestamp : oldestTimestamp);
      setHasMoreOlder(older.length === PAGE_SIZE);
    } catch {
      // ignore — user can try scrolling up again
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMoreOlder, loadingOlder, oldestTimestamp]);

  return {
    messages,
    streamingBubble,
    isTyping,
    toolStatus,
    isQueued,
    connected,
    sendMessage,
    deleteMessage,
    loadOlder,
    hasMoreOlder,
    loadingOlder,
    presence,
  };
}
