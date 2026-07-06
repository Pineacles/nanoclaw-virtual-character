import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { IconSearch, IconBack } from '../../components/icons';
import { ContextTabs } from './ContextTabs';
import { ContextPanel } from './ContextPanel';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import type { ContextTab } from './ContextTabs';

interface ContextPageProps {
  isMobile: boolean;
  authenticated: boolean;
}

interface WebSession {
  id: string;
  name: string;
  mode?: 'persona' | 'plain';
}

const STATIC_TABS: ContextTab[] = [
  { id: 'identity', label: 'Identity' },
  { id: 'general', label: 'General' },
];

/**
 * Context page — tabbed view.
 * Identity tab: Persona card + CLAUDE.md card + viewer.
 * General tab: context/*.md file list + viewer.
 * Per-session tabs: one per web session (from /api/sessions).
 */
export function ContextPage({ isMobile, authenticated }: ContextPageProps) {
  // Default to 'general' on all viewports — more useful than Identity
  const [activeTab, setActiveTab] = useState('general');
  // Mobile: track whether a file/detail is open (list-then-detail pattern)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  // Mobile: filename shown in the back-button title row when detail is open
  const [mobileDetailFilename, setMobileDetailFilename] = useState<string>('');
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? 'the assistant';

  useEffect(() => {
    if (!authenticated) return;
    api.get<WebSession[]>('/api/sessions').then(setSessions).catch(() => {});
  }, [authenticated]);

  const tabs: ContextTab[] = [
    ...STATIC_TABS,
    ...sessions
      .filter((s) => s.id !== 'whatsapp' && !s.id.startsWith('whatsapp-'))
      .map((s) => ({ id: `session-${s.id}`, label: s.name })),
  ];

  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {/* Page header */}
      <div
        className={cn(
          'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
          'flex items-center justify-between',
          isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
        )}
      >
        {isMobile && mobileDetailOpen ? (
          <button
            type="button"
            onClick={() => setMobileDetailOpen(false)}
            aria-label="Back to context list"
            className="nc-press flex items-center gap-2 cursor-pointer border-none bg-transparent min-w-0 max-w-[calc(100%-44px)]"
          >
            <IconBack size={18} className="text-nc-accent flex-shrink-0" />
            <span
              className="text-[14px] text-nc-text font-medium truncate"
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            >
              {mobileDetailFilename || 'Context'}
            </span>
          </button>
        ) : (
          <div>
            <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
              Context
            </h1>
            <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">
              {isMobile ? `${sessions.length + 2} layers` : `What ${assistantName} sees before every reply`}
            </p>
          </div>
        )}

        {!(isMobile && mobileDetailOpen) && (
          <button
            type="button"
            aria-label="Preview assembled context"
            onClick={() => void previewContext()}
            className={cn(
              'nc-press flex items-center gap-1.5 cursor-pointer font-medium rounded-btn',
              'border border-nc-border bg-nc-surface text-nc-text-muted',
              isMobile ? 'w-8 h-8 justify-center' : 'px-3 py-[6px] text-[13px]',
              'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]',
            )}
          >
            <IconSearch size={14} />
            {!isMobile && 'Preview assembled'}
          </button>
        )}
      </div>

      {/* Tabs — hidden when mobile detail is open */}
      {!(isMobile && mobileDetailOpen) && (
        <ContextTabs
          tabs={tabs}
          activeId={activeTab}
          onSelect={(id) => { setActiveTab(id); setMobileDetailOpen(false); }}
        />
      )}

      {/* Panel */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <ContextPanel
          activeTab={activeTab}
          authenticated={authenticated}
          sessions={sessions}
          isMobile={isMobile}
          mobileDetailOpen={mobileDetailOpen}
          onMobileFileOpen={(filename) => {
            setMobileDetailFilename(filename ?? '');
            setMobileDetailOpen(true);
          }}
          onMobileBack={() => setMobileDetailOpen(false)}
        />
      </div>
    </BackgroundMesh>
  );
}

async function previewContext() {
  try {
    const data = await api.get<{ context: string }>('/api/context/preview');
    const win = window.open('', '_blank', 'width=700,height=600');
    if (win) {
      win.document.write(`<pre style="font-family:monospace;padding:16px;white-space:pre-wrap">${escapeHtml(data.context)}</pre>`);
    }
  } catch {
    // ignore
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
