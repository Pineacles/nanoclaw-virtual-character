import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { SessionsPanel } from '../sheet/SessionsPanel';
import type { WebSession } from '../sheet/SessionsPanel';
import type { PageView } from '../../App';

interface DesktopLayoutProps {
  active: PageView;
  onNavigate: (view: PageView) => void;
  moodColor?: string;
  moodLabel?: string;
  onNewChat?: () => void;
  children: ReactNode;
  authenticated: boolean;
  activeSessionId: string;
  onSessionSelect: (session: WebSession) => void;
  onSessionCreated: (session: WebSession) => void;
}

/**
 * Desktop shell: fixed 248px sidebar on the left, flex-1 main slot on the right.
 * Sessions list in sidebar is rendered via SessionsPanel (fetches /api/sessions).
 */
export function DesktopLayout({
  active,
  onNavigate,
  moodColor,
  moodLabel,
  onNewChat,
  children,
  authenticated,
  activeSessionId,
  onSessionSelect,
  onSessionCreated,
}: DesktopLayoutProps) {
  const sessionsSlot = (
    <SessionsPanel
      authenticated={authenticated}
      activeSessionId={activeSessionId}
      onSessionSelect={onSessionSelect}
      onSessionCreated={onSessionCreated}
    />
  );

  return (
    <div className="flex w-full h-full overflow-hidden bg-nc-bg">
      <Sidebar
        active={active}
        onNavigate={onNavigate}
        moodColor={moodColor}
        moodLabel={moodLabel}
        onNewChat={onNewChat}
        sessionsSlot={sessionsSlot}
      />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
