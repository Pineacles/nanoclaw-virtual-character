import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { PersonaCard } from './PersonaCard';
import { ContextFileViewer } from './ContextFileViewer';
import { SessionContextPanel } from './SessionContextPanel';
import { useGroupConfig } from '../../hooks/useGroupConfig';

interface WebSession {
  id: string;
  name: string;
  mode?: 'persona' | 'plain';
}

interface ContextFile {
  filename: string;
  size: number;
  modified: string;
}

interface ContextPanelProps {
  activeTab: string;
  authenticated: boolean;
  sessions: WebSession[];
  isMobile?: boolean;
  mobileDetailOpen?: boolean;
  /** Called when a file is tapped on mobile — filename used by the page header. */
  onMobileFileOpen?: (filename?: string) => void;
  onMobileBack?: () => void;
}

type IdentityFile = 'persona' | 'claude-md';

/**
 * Content area for the active context tab.
 * identity: two PersonaCards + file viewer
 * general: list of context/*.md files with viewer
 * session-<id>: per-session context editor
 */
export function ContextPanel({
  activeTab,
  authenticated,
  sessions,
  isMobile = false,
  mobileDetailOpen = false,
  onMobileFileOpen,
  onMobileBack,
}: ContextPanelProps) {
  if (activeTab === 'identity') {
    return (
      <IdentityTabPanel
        authenticated={authenticated}
        isMobile={isMobile}
        mobileDetailOpen={mobileDetailOpen}
        onMobileFileOpen={onMobileFileOpen}
      />
    );
  }
  if (activeTab === 'general') {
    return (
      <GeneralTabPanel
        authenticated={authenticated}
        isMobile={isMobile}
        mobileDetailOpen={mobileDetailOpen}
        onMobileFileOpen={onMobileFileOpen}
      />
    );
  }
  const session = sessions.find((s) => `session-${s.id}` === activeTab);
  if (session) {
    return <SessionContextPanel sessionId={session.id} authenticated={authenticated} />;
  }
  return (
    <div className="flex-1 flex items-center justify-center text-nc-text-dim text-sm">
      Select a tab
    </div>
  );
}

interface MobilePanelProps {
  isMobile?: boolean;
  mobileDetailOpen?: boolean;
  onMobileFileOpen?: (filename?: string) => void;
}

/* ── Identity tab ── */
function IdentityTabPanel({
  authenticated,
  isMobile = false,
  mobileDetailOpen = false,
  onMobileFileOpen,
}: { authenticated: boolean } & MobilePanelProps) {
  const [selected, setSelected] = useState<IdentityFile>('persona');
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? 'the assistant';

  const endpoint = selected === 'persona' ? '/api/system-prompt' : '/api/memory/CLAUDE.md';

  const load = useCallback(async () => {
    if (!authenticated) return;
    setIsLoading(true);
    setNotFound(false);
    try {
      const data = await api.get<{ content: string }>(endpoint);
      setContent(data.content ?? '');
    } catch (err) {
      const isNotFound = err instanceof Error && err.message.includes('404');
      if (isNotFound) {
        setNotFound(true);
        setContent('');
      } else {
        setContent('');
      }
    }
    setIsLoading(false);
  }, [authenticated, endpoint]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (draft: string) => {
    setIsSaving(true);
    try {
      await api.put(endpoint, { content: draft });
      setContent(draft);
      setNotFound(false);
    } finally {
      setIsSaving(false);
    }
  };

  const filename = selected === 'persona' ? 'persona.md' : 'CLAUDE.md';
  const label = selected === 'persona' ? 'persona · preview' : 'CLAUDE.md · preview';

  const cardList = (
    <div className="grid grid-cols-2 gap-2.5">
      <PersonaCard
        label="Persona"
        title={`Who ${assistantName} is`}
        desc="Voice, values, quirks · persona.md"
        variant="accent"
        isSelected={selected === 'persona'}
        onClick={() => { setSelected('persona'); if (isMobile) onMobileFileOpen?.('persona.md'); }}
      />
      <PersonaCard
        label="CLAUDE.md"
        title="Behavior rules"
        desc="Hard constraints · memory"
        variant="default"
        isSelected={selected === 'claude-md'}
        onClick={() => { setSelected('claude-md'); if (isMobile) onMobileFileOpen?.('CLAUDE.md'); }}
      />
    </div>
  );

  const fileViewer = notFound && selected === 'claude-md' ? (
    <div className="flex-1 flex items-center justify-center px-6 text-center">
      <p className="text-[13px] text-nc-text-dim leading-[1.6]">
        CLAUDE.md not found in this group. Create it from a chat or via the Memory page.
      </p>
    </div>
  ) : (
    <div className={cn(
      'rounded-[12px] border border-nc-border bg-nc-surface overflow-hidden',
      'min-h-[300px] flex flex-col',
    )}>
      <ContextFileViewer
        filename={filename}
        content={content}
        isLoading={isLoading}
        isSaving={isSaving}
        onSave={handleSave}
        label={label}
      />
    </div>
  );

  // Mobile: show either card list OR full-width viewer
  if (isMobile) {
    return (
      <div
        role="tabpanel"
        id="context-panel-identity"
        aria-labelledby="context-tab-identity"
        className="flex-1 flex flex-col overflow-hidden"
      >
        {mobileDetailOpen ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {notFound && selected === 'claude-md' ? (
              <div className="flex-1 flex items-center justify-center px-6 text-center">
                <p className="text-[13px] text-nc-text-dim leading-[1.6]">
                  CLAUDE.md not found in this group. Create it from a chat or via the Memory page.
                </p>
              </div>
            ) : (
              <ContextFileViewer
                filename={filename}
                content={content}
                isLoading={isLoading}
                isSaving={isSaving}
                onSave={handleSave}
                label={label}
                compactHeader
              />
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            {cardList}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="tabpanel"
      id="context-panel-identity"
      aria-labelledby="context-tab-identity"
      className="flex-1 flex flex-col overflow-hidden"
    >
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-[760px] mx-auto flex flex-col gap-4">
          {cardList}
          {fileViewer}
        </div>
      </div>
    </div>
  );
}

/* ── General tab ── */
function GeneralTabPanel({
  authenticated,
  isMobile = false,
  mobileDetailOpen = false,
  onMobileFileOpen,
}: { authenticated: boolean } & MobilePanelProps) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    api.get<ContextFile[]>('/api/context').then(setFiles).catch(() => {});
  }, [authenticated]);

  const loadFile = async (filename: string) => {
    setIsLoading(true);
    setActiveFile(filename);
    try {
      const data = await api.get<{ filename: string; content: string }>(`/api/context/${encodeURIComponent(filename)}`);
      setContent(data.content ?? '');
    } catch { setContent(''); }
    setIsLoading(false);
    if (isMobile) onMobileFileOpen?.(filename);
  };

  const handleSave = async (draft: string) => {
    if (!activeFile) return;
    setIsSaving(true);
    try {
      await api.put(`/api/context/${encodeURIComponent(activeFile)}`, { content: draft });
      setContent(draft);
    } finally {
      setIsSaving(false);
    }
  };

  const fileList = (
    <>
      {files.length === 0 && (
        <p className="px-4 py-6 text-[12.5px] text-nc-text-dim">No context files</p>
      )}
      <ul className="list-none m-0 p-0">
        {files.map((f) => (
          <li key={f.filename}>
            <button
              type="button"
              onClick={() => void loadFile(f.filename)}
              className={cn(
                'nc-press w-full px-4 py-3 text-left border-b border-nc-border-soft',
                'text-[13px] cursor-pointer transition-colors duration-[--nc-dur-micro]',
                activeFile === f.filename
                  ? 'bg-nc-surface-hi text-nc-text font-medium'
                  : 'bg-transparent text-nc-text-muted hover:bg-nc-surface-hi',
              )}
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            >
              {f.filename}
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  // Mobile: full-width list → full-width detail
  if (isMobile) {
    return (
      <div
        role="tabpanel"
        id="context-panel-general"
        aria-labelledby="context-tab-general"
        className="flex-1 flex flex-col overflow-hidden"
      >
        {mobileDetailOpen && activeFile ? (
          <ContextFileViewer
            filename={activeFile}
            content={content}
            isLoading={isLoading}
            isSaving={isSaving}
            onSave={handleSave}
            compactHeader
          />
        ) : (
          <div className="flex-1 overflow-y-auto">
            {fileList}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="tabpanel"
      id="context-panel-general"
      aria-labelledby="context-tab-general"
      className="flex-1 flex overflow-hidden"
    >
      {/* File list */}
      <div className="w-[240px] flex-shrink-0 border-r border-nc-border-soft overflow-y-auto">
        {fileList}
      </div>

      {/* Viewer */}
      {activeFile ? (
        <ContextFileViewer
          filename={activeFile}
          content={content}
          isLoading={isLoading}
          isSaving={isSaving}
          onSave={handleSave}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-nc-text-dim text-[13px]">
          Select a context file
        </div>
      )}
    </div>
  );
}

