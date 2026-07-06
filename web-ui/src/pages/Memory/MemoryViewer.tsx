import { useState, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { IconEdit, IconTrash, IconX, IconCheck } from '../../components/icons';
import { renderMarkdown } from '../../lib/markdown';
import type { MemoryFile } from '../../hooks/useMemoryFiles';

interface MemoryViewerProps {
  file: MemoryFile | null;
  content: string;
  isLoading: boolean;
  isSaving: boolean;
  onSave: (filename: string, content: string) => Promise<void>;
  onDelete: (filename: string) => Promise<void>;
  /** When true (mobile detail mode), hide the filename row — the page header already shows it. */
  compactHeader?: boolean;
}

/**
 * Right pane: renders markdown content of the selected memory file.
 * Has edit mode (raw textarea) and view mode (prose render).
 * CLAUDE.md cannot be deleted.
 */
export function MemoryViewer({
  file,
  content,
  isLoading,
  isSaving,
  onSave,
  onDelete,
  compactHeader = false,
}: MemoryViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const startEdit = () => {
    setDraft(content);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft('');
  };

  const handleSave = async () => {
    if (!file) return;
    await onSave(file.filename, draft);
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!file) return;
    await onDelete(file.filename);
    setConfirmDelete(false);
  };

  const renderedHtml = useMemo(() => (content ? renderMarkdown(content) : ''), [content]);

  const isProtected = file?.filename === 'CLAUDE.md';
  const modifiedLabel = file
    ? `edited ${new Date(file.modified).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';

  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center text-nc-text-dim text-sm">
        Select a file to view
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Viewer header */}
      <div
        className={cn(
          'flex items-center justify-between flex-shrink-0',
          'border-b border-nc-border-soft',
          compactHeader ? 'px-4 py-2' : 'px-5 py-3',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {!compactHeader && (
            <>
              <span
                className="text-[13px] text-nc-text font-medium font-mono truncate"
                style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
              >
                {file.filename}
              </span>
              <span className="text-[11px] text-nc-text-dim flex-shrink-0">· {modifiedLabel}</span>
            </>
          )}
          {compactHeader && (
            <span className="text-[11px] text-nc-text-dim">{modifiedLabel}</span>
          )}
          {isEditing && (
            <span className="text-[10.5px] px-[7px] py-[1px] rounded-pill bg-nc-accent-soft text-nc-accent font-medium">
              editing
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                aria-label="Cancel edit"
                className={cn(
                  'nc-press px-2.5 py-1 rounded-[7px] text-[12.5px]',
                  'border border-nc-border bg-nc-surface text-nc-text-muted',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                aria-label="Save file"
                className={cn(
                  'nc-press nc-gradient-fill px-2.5 py-1 rounded-[7px] text-[12.5px]',
                  'text-white font-medium disabled:opacity-50 cursor-pointer',
                )}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={startEdit}
                aria-label="Edit file"
                className={cn(
                  'nc-press flex items-center gap-1.5 px-2.5 py-1 rounded-[7px] text-[12.5px]',
                  'border border-nc-border bg-nc-surface text-nc-text-muted',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                <IconEdit size={12} />
                Edit
              </button>
              {!isProtected && !confirmDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete file"
                  className={cn(
                    'nc-press w-[30px] h-[28px] rounded-[7px] flex items-center justify-center',
                    'border border-nc-border bg-nc-surface text-nc-text-muted',
                    'hover:text-red-500 hover:border-red-400 transition-colors duration-[--nc-dur-micro] cursor-pointer',
                  )}
                >
                  <IconTrash size={13} />
                </button>
              )}
              {confirmDelete && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-nc-text-dim">Delete?</span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    aria-label="Confirm delete"
                    className="nc-press w-7 h-7 rounded-[7px] flex items-center justify-center bg-red-500/10 text-red-500 border border-red-400/40 cursor-pointer"
                  >
                    <IconCheck size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    aria-label="Cancel delete"
                    className="nc-press w-7 h-7 rounded-[7px] flex items-center justify-center border border-nc-border bg-nc-surface text-nc-text-muted cursor-pointer"
                  >
                    <IconX size={11} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="nc-skeleton w-48 h-4 rounded" />
        </div>
      ) : isEditing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Edit file content"
          className={cn(
            'flex-1 p-5 resize-none bg-transparent border-none outline-none',
            'text-[13px] text-nc-text leading-relaxed font-mono',
          )}
          style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', lineHeight: 1.7 }}
        />
      ) : (
        <div
          className="flex-1 overflow-y-auto p-5 text-[14px] text-nc-text leading-[1.7] nc-prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </div>
  );
}
