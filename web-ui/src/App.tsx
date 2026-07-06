import { useEffect, useState, lazy, Suspense } from 'react';
import { DesktopLayout } from './components/shell/DesktopLayout';
import { MobileLayout } from './components/shell/MobileLayout';
import { ChatPage } from './pages/Chat';
import { MoreSheet } from './components/sheet/MoreSheet';

const MemoryPage = lazy(() => import('./pages/Memory').then((m) => ({ default: m.MemoryPage })));
const TasksPage = lazy(() => import('./pages/Tasks').then((m) => ({ default: m.TasksPage })));
const WorkflowsPage = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.WorkflowsPage })));
const ContextPage = lazy(() => import('./pages/Context').then((m) => ({ default: m.ContextPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const VoicePage = lazy(() => import('./pages/Voice').then((m) => ({ default: m.VoicePage })));
import { useChat } from './hooks/useChat';
import { useMood, getMoodColor } from './hooks/useMood';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';
import { useGroupConfig } from './hooks/useGroupConfig';
import { getToken, setToken } from './lib/api';
import type { WebSession } from './components/sheet/SessionsPanel';

export type PageView = 'chat' | 'memory' | 'workflows' | 'tasks' | 'context' | 'voice' | 'settings';

const VIEW_KEY = 'nanoclaw_active_view';

/** Detect desktop breakpoint (≥1024px). Re-evaluates on resize. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}

/* ── Login screen ── */
function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('');
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) onLogin(value.trim());
  };
  return (
    <div className="flex h-full items-center justify-center bg-nc-bg">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 p-8 bg-nc-surface rounded-[18px] border border-nc-border w-full max-w-xs"
      >
        <h1 className="text-nc-text font-semibold text-lg tracking-[-0.01em] m-0">
          NanoClaw
        </h1>
        <p className="text-nc-text-muted text-sm m-0">Enter your access token to connect.</p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Token"
          aria-label="Access token"
          className="w-full h-10 px-3 rounded-btn bg-nc-surface-alt border border-nc-border text-nc-text text-sm outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro]"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          aria-label="Connect"
          className="nc-press nc-gradient-fill text-white h-10 rounded-btn text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

export function App() {
  // Auth
  const [authToken, setAuthToken] = useState(getToken);
  const authenticated = authToken.length > 0;

  const handleLogin = (token: string) => {
    setToken(token);
    setAuthToken(token);
  };

  // Theme
  useTheme();

  // Group config (feature flags)
  const { groupConfig } = useGroupConfig();
  const voiceEnabled = groupConfig?.features?.voice_call ?? false;

  // Layout
  const isDesktop = useIsDesktop();

  // View routing
  const [view, setView] = useState<PageView>(() => {
    const stored = localStorage.getItem(VIEW_KEY) as PageView | null;
    return stored ?? 'chat';
  });

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // Session state
  const [activeSessionId, setActiveSessionId] = useState('default');
  const [activeSessionName, setActiveSessionName] = useState('Personal');
  const [activeSessionMode, setActiveSessionMode] = useState<'persona' | 'plain' | 'whatsapp'>('persona');

  // Mood
  const { mood, setMood } = useMood(authenticated);
  const moodColor = getMoodColor(mood.current_mood);

  // Tasks (for WS event wiring)
  const { handleTaskEvent } = useTasks(authenticated);

  // Chat
  const { messages, streamingBubble, isTyping, toolStatus, isQueued, connected, sendMessage, loadOlder, hasMoreOlder, loadingOlder, presence } = useChat(
    authenticated,
    activeSessionId,
    (m) => setMood((prev) => ({ ...prev, ...m })),
    (sessionId, name) => {
      if (sessionId === activeSessionId) setActiveSessionName(name);
    },
    handleTaskEvent,
  );

  // Mobile sheet state
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);

  if (!authenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  const chatPage = (
    <ChatPage
      isMobile={!isDesktop}
      messages={messages}
      streamingBubble={streamingBubble}
      isTyping={isTyping}
      toolStatus={toolStatus}
      isQueued={isQueued}
      connected={connected}
      activeSessionId={activeSessionId}
      sessionName={activeSessionName}
      sessionMode={activeSessionMode}
      moodActivity={mood.activity}
      moodColor={moodColor}
      presence={presence}
      onSend={sendMessage}
      onNewChat={() => {
        setActiveSessionId(`session-${Date.now()}`);
        setActiveSessionName('New chat');
        setActiveSessionMode('persona');
      }}
      onSessionSwitch={() => setMoreSheetOpen(true)}
      onLoadOlder={loadOlder}
      hasMoreOlder={hasMoreOlder}
      loadingOlder={loadingOlder}
    />
  );

  const handleSessionSelect = (s: WebSession) => {
    setActiveSessionId(s.id);
    setActiveSessionName(s.name);
    setActiveSessionMode(s.mode === 'plain' ? 'plain' : 'persona');
    setView('chat');
  };

  const currentPage = (() => {
    switch (view) {
      case 'chat':
        return chatPage;
      case 'memory':
        return <MemoryPage isMobile={!isDesktop} authenticated={authenticated} />;
      case 'tasks':
        return <TasksPage isMobile={!isDesktop} authenticated={authenticated} />;
      case 'workflows':
        return <WorkflowsPage isMobile={!isDesktop} authenticated={authenticated} />;
      case 'context':
        return <ContextPage isMobile={!isDesktop} authenticated={authenticated} />;
      case 'settings':
        return <SettingsPage isMobile={!isDesktop} authenticated={authenticated} />;
      case 'voice':
        return <VoicePage isMobile={!isDesktop} authenticated={authenticated} voiceEnabled={voiceEnabled} />;
      default:
        return chatPage;
    }
  })();

  const fallback = <div className="flex h-full items-center justify-center text-nc-text-dim">Loading…</div>;

  if (isDesktop) {
    return (
      <DesktopLayout
        active={view}
        onNavigate={setView}
        moodColor={moodColor}
        moodLabel={mood.current_mood}
        authenticated={authenticated}
        activeSessionId={activeSessionId}
        onSessionSelect={handleSessionSelect}
        onSessionCreated={(s) => {
          setActiveSessionId(s.id);
          setActiveSessionName(s.name);
          setActiveSessionMode(s.mode === 'plain' ? 'plain' : 'persona');
        }}
        onNewChat={() => {
          setView('chat');
          setActiveSessionId(`session-${Date.now()}`);
          setActiveSessionName('New chat');
        }}
      >
        <Suspense fallback={fallback}>{currentPage}</Suspense>
      </DesktopLayout>
    );
  }

  return (
    <>
      <MobileLayout
        active={view}
        onNavigate={setView}
        moodColor={moodColor}
        onMoreClick={() => setMoreSheetOpen(true)}
      >
        <Suspense fallback={fallback}>{currentPage}</Suspense>
      </MobileLayout>

      {moreSheetOpen && (
        <MoreSheet
          onClose={() => setMoreSheetOpen(false)}
          moodColor={moodColor}
          moodLabel={mood.current_mood}
          authenticated={authenticated}
          activeSessionId={activeSessionId}
          onSessionSelect={handleSessionSelect}
          onSessionCreated={(s) => {
            setActiveSessionId(s.id);
            setActiveSessionName(s.name);
            setActiveSessionMode(s.mode === 'plain' ? 'plain' : 'persona');
          }}
          onNavigate={(v) => { setView(v); setMoreSheetOpen(false); }}
        />
      )}
    </>
  );
}
