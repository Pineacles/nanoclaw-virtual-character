import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { Thinking } from './Thinking';
import { ToolStatus } from './ToolStatus';
import type { ChatMessage, ToolStatus as ToolStatusData } from '../../hooks/useChat';

interface MessageListProps {
  messages: ChatMessage[];
  streamingBubble: ChatMessage | null;
  isTyping: boolean;
  toolStatus: ToolStatusData | null;
  isMobile?: boolean;
  activeSessionId: string;
  onLoadOlder: () => void;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
}

/**
 * Scrollable message area.
 * Session switch → instant jump to bottom (useLayoutEffect, synchronous before paint).
 * New message in active session → smooth scroll.
 * Scroll near top → trigger loadOlder, then restore scroll position.
 * Centered column, max-width 720px on desktop.
 */
export function MessageList({
  messages,
  streamingBubble,
  isTyping,
  toolStatus,
  isMobile = false,
  activeSessionId,
  onLoadOlder,
  hasMoreOlder,
  loadingOlder,
}: MessageListProps) {
  // Compute the id of the most-recent user message that has a readAt — this is
  // the single "frontier" receipt shown (KakaoTalk/WhatsApp pattern).
  const lastReadUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender === 'user' && m.readAt) return m.id;
    }
    return null;
  }, [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevSessionRef = useRef(activeSessionId);
  const prevLengthRef = useRef(messages.length);

  // Refs to capture scroll position before loadOlder prepends messages.
  const prevScrollHeightRef = useRef<number | null>(null);
  const prevScrollTopRef = useRef<number | null>(null);

  // Ref-based "in flight" guard so onScroll only fires loadOlder once per approach.
  const loadOlderInflightRef = useRef(false);

  // Whether the user is currently pinned at (or near) the bottom of the list.
  // Drives "follow new messages" behavior — if the user scrolled up to read
  // history, we don't yank them back to the bottom on every new message.
  // Initial true: we land at the bottom on first render.
  const pinnedToBottomRef = useRef(true);

  function isAtBottom(container: HTMLDivElement): boolean {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  // Instant scroll on session change or first message arrival (0 → >0).
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (messages.length === 0) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    prevSessionRef.current = activeSessionId;
    prevLengthRef.current = messages.length;
    // Clear any stale loadOlder capture on session switch.
    prevScrollHeightRef.current = null;
    prevScrollTopRef.current = null;
    loadOlderInflightRef.current = false;
    // After landing at the bottom, we are pinned again.
    pinnedToBottomRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, messages.length === 0 ? 0 : 1]);

  // After messages array grows: either restore scroll (loadOlder prepend)
  // or follow the bottom (new message and user was pinned).
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const sameSession = prevSessionRef.current === activeSessionId;
    const grew = messages.length > prevLengthRef.current;
    const wasLoadOlder =
      prevScrollHeightRef.current !== null && prevScrollTopRef.current !== null;

    if (sameSession && grew && wasLoadOlder) {
      // Restore: new height minus old height = how much was prepended.
      container.scrollTop =
        container.scrollHeight - prevScrollHeightRef.current! + prevScrollTopRef.current!;
      prevScrollHeightRef.current = null;
      prevScrollTopRef.current = null;
      // We're now in the middle of the conversation, not pinned.
      pinnedToBottomRef.current = false;
    } else if (sameSession && grew && pinnedToBottomRef.current) {
      // New message at the bottom AND user was pinned → follow.
      container.scrollTop = container.scrollHeight;
    }
    // else: user is reading older messages; don't yank them back.

    prevLengthRef.current = messages.length;
    prevSessionRef.current = activeSessionId;
    loadOlderInflightRef.current = false;
  }, [messages.length, activeSessionId]);

  // Smooth scroll when typing indicator toggles on (bot starts responding) —
  // but only if the user is at the bottom already.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !isTyping) return;
    if (!pinnedToBottomRef.current) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [isTyping]);

  // onScroll handler: track pin state and trigger loadOlder near the top.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      // Update pin state on every scroll so follow-bottom respects user intent.
      pinnedToBottomRef.current = isAtBottom(container);

      if (loadOlderInflightRef.current) return;
      if (!hasMoreOlder || loadingOlder) return;
      if (container.scrollTop < 150) {
        loadOlderInflightRef.current = true;
        prevScrollHeightRef.current = container.scrollHeight;
        prevScrollTopRef.current = container.scrollTop;
        onLoadOlder();
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMoreOlder, loadingOlder, onLoadOlder]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
      <div
        className="w-full mx-auto px-4 pt-8 pb-4"
        style={{ maxWidth: isMobile ? undefined : 960 }}
      >
        {/* Loading older indicator at top */}
        {loadingOlder && (
          <div className="flex items-center justify-center h-10 mb-2">
            <span className="text-nc-text-dim text-xs">loading earlier messages…</span>
          </div>
        )}

        {/* Start of conversation hint */}
        {!hasMoreOlder && messages.length > 0 && !loadingOlder && (
          <div className="flex items-center justify-center h-10 mb-2">
            <span className="text-nc-text-dim text-xs">start of conversation</span>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            isMobile={isMobile}
            isLastRead={m.id === lastReadUserMessageId}
          />
        ))}

        {/* Streaming bubble — isolated state, only this re-renders during token stream */}
        {streamingBubble && (
          <MessageBubble key={streamingBubble.id} message={streamingBubble} isMobile={isMobile} />
        )}

        {/* Thinking / tool status below messages */}
        {isTyping && !toolStatus && <Thinking />}
        {toolStatus && (
          <div className="pl-[17px] mt-[-4px] mb-4">
            <ToolStatus status={toolStatus} />
          </div>
        )}

        <div aria-hidden="true" />
      </div>
    </div>
  );
}
