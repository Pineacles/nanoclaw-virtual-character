import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';

interface SessionContextPanelProps {
  sessionId: string;
  authenticated: boolean;
}

/** Per-session context editor tab panel. */
export function SessionContextPanel({ sessionId, authenticated }: SessionContextPanelProps) {
  const [context, setContext] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    api.get<{ context: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/context`)
      .then((d) => setContext(d.context ?? ''))
      .catch(() => {});
  }, [authenticated, sessionId]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.put(`/api/sessions/${encodeURIComponent(sessionId)}/context`, { context });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="tabpanel"
      id={`context-panel-session-${sessionId}`}
      aria-labelledby={`context-tab-session-${sessionId}`}
      className="flex-1 flex flex-col p-4 md:p-6 gap-3"
    >
      <div className="text-[11px] text-nc-text-dim font-semibold uppercase tracking-[0.04em]">
        Per-session context
      </div>
      <textarea
        value={context}
        onChange={(e) => setContext(e.target.value)}
        aria-label="Per-session context"
        placeholder="Add context injected only into this session's messages…"
        className={cn(
          'flex-1 resize-none rounded-[10px] border border-nc-border bg-nc-surface',
          'px-4 py-3 text-[13px] text-nc-text leading-[1.6]',
          'outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro]',
          'placeholder:text-nc-text-dim',
        )}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          aria-label="Save session context"
          className="nc-press nc-gradient-fill h-9 px-4 rounded-btn text-[13px] text-white font-medium disabled:opacity-50 cursor-pointer"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-[12.5px] text-nc-accent">Saved</span>}
      </div>
    </div>
  );
}
