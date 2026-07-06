import { useState } from 'react';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { MobileChatHeader, DesktopChatHeader } from './ChatHeader';
import { Greeting } from './Greeting';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { MediaGallery } from './MediaGallery';
import type { ChatMessage, ToolStatus, PresenceEvent } from '../../hooks/useChat';

interface ChatPageProps {
  /* Layout */
  isMobile: boolean;
  /* Data */
  messages: ChatMessage[];
  streamingBubble: ChatMessage | null;
  isTyping: boolean;
  toolStatus: ToolStatus | null;
  isQueued: boolean;
  connected: boolean;
  /* Session info */
  activeSessionId: string;
  sessionName: string;
  sessionMode: 'persona' | 'plain' | 'whatsapp';
  /* Mood */
  moodActivity?: string;
  moodColor?: string;
  /* Presence */
  presence?: PresenceEvent | null;
  /* Actions */
  onSend: (content: string, images?: string[], files?: { name: string; data: string }[]) => void;
  onNewChat: () => void;
  onSessionSwitch: () => void;
  /* Pagination */
  onLoadOlder: () => void;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
}

/**
 * Chat page — wires all sub-components.
 * Three states: empty (greeting + mesh), filled (messages), streaming (messages + cursor).
 */
export function ChatPage({
  isMobile,
  messages,
  streamingBubble,
  isTyping,
  toolStatus,
  isQueued,
  connected,
  activeSessionId,
  sessionName,
  sessionMode,
  moodActivity,
  moodColor,
  presence,
  onSend,
  onNewChat,
  onSessionSwitch,
  onLoadOlder,
  hasMoreOlder,
  loadingOlder,
}: ChatPageProps) {
  const hasMessages = messages.length > 0 || streamingBubble !== null;
  const isStreaming = streamingBubble !== null;
  const meshVariant = hasMessages ? 'filled' : 'greeting';
  const [mediaOpen, setMediaOpen] = useState(false);

  return (
    <BackgroundMesh variant={meshVariant} className="flex flex-col h-full">
      {/* Header */}
      {isMobile ? (
        <MobileChatHeader
          sessionName={sessionName}
          moodColor={moodColor}
          presence={presence}
          isTyping={isTyping}
          onSessionSwitch={onSessionSwitch}
          onNewChat={onNewChat}
          onMediaOpen={() => setMediaOpen(true)}
        />
      ) : (
        <DesktopChatHeader
          sessionName={sessionName}
          sessionMode={sessionMode}
          hasMessages={hasMessages}
          presence={presence}
          isTyping={isTyping}
          onMediaOpen={() => setMediaOpen(true)}
        />
      )}

      {/* Disconnected banner */}
      {!connected && (
        <div
          role="alert"
          className="flex-shrink-0 px-4 py-2 text-[12.5px] text-center"
          style={{ background: 'var(--nc-badge-placeholder-bg)', color: 'var(--nc-badge-placeholder-fg)' }}
        >
          {isMobile ? 'Reconnecting…' : 'Connection lost. Attempting to reconnect…'}
        </div>
      )}

      {/* Queued banner */}
      {isQueued && (
        <div className="flex-shrink-0 px-4 py-2 text-[12px] text-nc-text-muted text-center bg-nc-surface-alt border-b border-nc-border-soft">
          Queued — another session is running
        </div>
      )}

      {/* Body */}
      {hasMessages ? (
        <MessageList
          messages={messages}
          streamingBubble={streamingBubble}
          isTyping={isTyping}
          toolStatus={toolStatus}
          isMobile={isMobile}
          activeSessionId={activeSessionId}
          onLoadOlder={onLoadOlder}
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
        />
      ) : (
        <Greeting
          moodActivity={moodActivity}
          onSend={onSend}
          isMobile={isMobile}
        />
      )}

      {/* Composer — solid bg so it sits cleanly above gradient */}
      <div className="nc-page flex-shrink-0 bg-nc-bg">
        <Composer
          onSend={onSend}
          isStreaming={isStreaming}
          isConnected={connected}
          isMobile={isMobile}
          sessionMode={sessionMode === 'whatsapp' ? undefined : sessionMode}
          modelLabel="Sonnet 4.5"
        />
      </div>

      {/* Media gallery overlay */}
      {mediaOpen && (
        <MediaGallery
          sessionId={activeSessionId}
          isMobile={isMobile}
          onClose={() => setMediaOpen(false)}
        />
      )}
    </BackgroundMesh>
  );
}
