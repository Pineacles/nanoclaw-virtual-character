import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { IconPlus, IconEdit, IconCheck, IconX, IconTrash } from '../icons';

export interface WebSession {
  id: string;
  name: string;
  mode: 'persona' | 'plain';
  created_at: string;
  updated_at: string;
}

interface SessionsPanelProps {
  onSessionSelect?: (session: WebSession) => void;
  activeSessionId?: string;
  authenticated: boolean;
  /** Called after a session is created — pass new session back to parent */
  onSessionCreated?: (session: WebSession) => void;
}

const MODE_COLORS: Record<string, string> = {
  whatsapp: 'var(--nc-session-whatsapp)',
  plain: 'var(--nc-text-dim)',
  persona: 'var(--nc-accent)',
};

/**
 * Reusable sessions list — used in Sidebar (desktop) and MoreSheet (mobile).
 * Loads from /api/sessions. Supports rename, delete, new session.
 * WhatsApp sessions: no rename/delete.
 */
export function SessionsPanel({
  onSessionSelect,
  activeSessionId,
  authenticated,
  onSessionCreated,
}: SessionsPanelProps) {
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);

  const load = useCallback(async () => {
    if (!authenticated) return;
    try {
      const data = await api.get<WebSession[]>('/api/sessions');
      setSessions(data);
    } catch (err) {
      console.warn('NanoClaw: backend missing /api/sessions; UI will render in fallback mode.', err);
      setSessions([]);
    }
  }, [authenticated]);

  useEffect(() => { void load(); }, [load]);

  const createSession = useCallback(async (mode: 'persona' | 'plain') => {
    setShowNewMenu(false);
    const name = `New ${mode} session`;
    try {
      const created = await api.post<WebSession>('/api/sessions', { name, mode });
      setSessions((prev) => [...prev, created]);
      onSessionCreated?.(created);
    } catch (err) {
      console.warn('NanoClaw: POST /api/sessions failed.', err);
    }
  }, [onSessionCreated]);

  const startRename = (s: WebSession) => {
    setRenaming(s.id);
    setRenameValue(s.name);
    setConfirmDelete(null);
  };

  const confirmRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    try {
      await api.put(`/api/sessions/${encodeURIComponent(renaming)}`, { name: renameValue.trim() });
      setSessions((prev) => prev.map((s) => s.id === renaming ? { ...s, name: renameValue.trim() } : s));
    } catch (err) {
      console.warn('NanoClaw: PUT /api/sessions/:id failed.', err);
    }
    setRenaming(null);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/sessions/${encodeURIComponent(id)}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.warn('NanoClaw: DELETE /api/sessions/:id failed.', err);
    }
    setConfirmDelete(null);
  };

  const isWhatsApp = (id: string) => id === 'whatsapp' || id.startsWith('whatsapp-');

  return (
    <div className="flex flex-col h-full">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2 relative">
        <span className="text-[11px] text-nc-text-dim font-medium uppercase tracking-[0.06em]">
          Sessions
        </span>
        <button
          type="button"
          onClick={() => setShowNewMenu((v) => !v)}
          aria-label="New session"
          aria-expanded={showNewMenu}
          className="nc-press w-6 h-6 flex items-center justify-center rounded-brand bg-transparent border-none cursor-pointer text-nc-text-muted hover:text-nc-text transition-colors duration-[--nc-dur-micro]"
        >
          <IconPlus size={14} />
        </button>
        {showNewMenu && (
          <div
            className={cn(
              'nc-page absolute right-3 top-8 z-10 rounded-[10px] border border-nc-border bg-nc-surface',
              'shadow-[0_4px_16px_rgba(0,0,0,0.1)] overflow-hidden min-w-[140px]',
            )}
          >
            {(['persona', 'plain'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => void createSession(mode)}
                className={cn(
                  'nc-press w-full px-3 py-2.5 text-left text-[13px] cursor-pointer border-none bg-transparent',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] text-nc-text',
                  'flex items-center gap-2',
                )}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: MODE_COLORS[mode] }}
                  aria-hidden="true"
                />
                {mode === 'persona' ? 'Persona mode' : 'Plain mode'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Session list */}
      <ul className="flex-1 overflow-y-auto list-none m-0 p-0 px-1">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const isWA = isWhatsApp(s.id);
          const isRenaming = renaming === s.id;
          const isDeleting = confirmDelete === s.id;

          return (
            <li key={s.id}>
              {isRenaming ? (
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    autoFocus
                    aria-label="Rename session"
                    className="flex-1 h-6 px-2 text-[12.5px] rounded-[6px] border border-nc-border bg-nc-bg text-nc-text outline-none focus:border-nc-accent"
                  />
                  <button type="button" onClick={() => void confirmRename()} aria-label="Confirm rename" className="nc-press w-6 h-6 flex items-center justify-center text-nc-accent cursor-pointer border-none bg-transparent">
                    <IconCheck size={10} />
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} aria-label="Cancel rename" className="nc-press w-6 h-6 flex items-center justify-center text-nc-text-dim cursor-pointer border-none bg-transparent">
                    <IconX size={10} />
                  </button>
                </div>
              ) : isDeleting ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                  <span className="text-[12px] text-nc-text-dim flex-1">Delete?</span>
                  <button type="button" onClick={() => void handleDelete(s.id)} aria-label="Confirm delete session" className="nc-press px-2 py-0.5 rounded-[5px] text-[11px] bg-red-500/10 text-red-500 border border-red-400/40 cursor-pointer">Yes</button>
                  <button type="button" onClick={() => setConfirmDelete(null)} aria-label="Cancel delete" className="nc-press px-2 py-0.5 rounded-[5px] text-[11px] border border-nc-border bg-nc-surface text-nc-text-muted cursor-pointer">No</button>
                </div>
              ) : (
                <div className={cn(
                  'group flex items-center gap-0 pr-0.5 rounded-brand cursor-pointer',
                  'transition-colors duration-[--nc-dur-micro]',
                  isActive ? 'bg-nc-surface-hi' : 'hover:bg-nc-surface-hi',
                )}>
                  <button
                    type="button"
                    onClick={() => onSessionSelect?.(s)}
                    className={cn(
                      'nc-press flex-1 flex items-center gap-[9px] px-2.5 py-1.5 border-none bg-transparent cursor-pointer text-left',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="nc-mood-breathe w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: isWA ? MODE_COLORS.whatsapp : MODE_COLORS[s.mode] }}
                    />
                    <span className={cn(
                      'truncate text-[13px]',
                      isActive ? 'text-nc-text font-medium' : 'text-nc-text-muted font-normal',
                    )}>
                      {s.name}
                    </span>
                  </button>
                  {!isWA && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-[--nc-dur-micro]">
                      <button type="button" onClick={() => startRename(s)} aria-label={`Rename ${s.name}`} className="nc-press w-6 h-6 flex items-center justify-center rounded-brand border-none bg-transparent text-nc-text-dim hover:text-nc-text cursor-pointer">
                        <IconEdit size={11} />
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(s.id)} aria-label={`Delete ${s.name}`} className="nc-press w-6 h-6 flex items-center justify-center rounded-brand border-none bg-transparent text-nc-text-dim hover:text-red-500 cursor-pointer">
                        <IconTrash size={11} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li>
            <p className="px-3 py-2 text-[12px] text-nc-text-dim">No sessions yet</p>
          </li>
        )}
      </ul>
    </div>
  );
}
