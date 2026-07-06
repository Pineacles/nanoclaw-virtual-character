import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { renderMarkdown } from '../../lib/markdown';
import { IconEdit } from '../../components/icons';

interface ContextFileViewerProps {
  filename: string;
  content: string;
  isLoading: boolean;
  isSaving: boolean;
  onSave: (content: string) => Promise<void>;
  label?: string;
  /** When true (mobile detail mode), hide the filename row — the page header already shows it. */
  compactHeader?: boolean;
}

/**
 * Shared file viewer for context files.
 * View mode: rendered markdown. Edit mode: raw textarea.
 * Same visual pattern as MemoryViewer.
 */
export function ContextFileViewer({
  filename,
  content,
  isLoading,
  isSaving,
  onSave,
  label,
  compactHeader = false,
}: ContextFileViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const renderedHtml = useMemo(() => (content ? renderMarkdown(content) : ''), [content]);

  const startEdit = () => {
    setDraft(content);
    setIsEditing(true);
  };

  const cancel = () => {
    setIsEditing(false);
    setDraft('');
  };

  const handleSave = async () => {
    await onSave(draft);
    setIsEditing(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header row */}
      <div className={cn(
        'flex items-center justify-between border-b border-nc-border-soft flex-shrink-0',
        compactHeader ? 'px-4 py-2' : 'px-[22px] py-[10px]',
      )}>
        <div className="flex items-center gap-2 min-w-0">
          {!compactHeader && label && (
            <span className="text-[11px] text-nc-text-dim font-semibold uppercase tracking-[0.04em]">
              {label}
            </span>
          )}
          {!compactHeader && (
            <span
              className="text-[12px] text-nc-text-muted truncate"
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            >
              {filename}
            </span>
          )}
          {isEditing && (
            <span className="text-[10.5px] px-[7px] py-[1px] rounded-pill bg-nc-accent-soft text-nc-accent font-medium">
              editing
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={cancel}
                aria-label="Cancel edit"
                className={cn(
                  'nc-press px-2.5 py-1 rounded-btn text-[12.5px]',
                  'border border-nc-border bg-nc-surface text-nc-text-muted',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving}
                aria-label="Save file"
                className="nc-press nc-gradient-fill px-2.5 py-1 rounded-btn text-[12.5px] text-white font-medium disabled:opacity-50 cursor-pointer"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              aria-label="Edit file"
              className={cn(
                'nc-press flex items-center gap-1.5 px-2.5 py-1 rounded-btn text-[12.5px]',
                'border border-nc-border bg-nc-surface text-nc-text-muted',
                'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
              )}
            >
              <IconEdit size={12} />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="nc-skeleton w-48 h-4 rounded" />
        </div>
      ) : isEditing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Edit ${filename}`}
          className="flex-1 p-5 resize-none bg-transparent border-none outline-none text-[13px] text-nc-text leading-[1.7]"
          style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', lineHeight: 1.7 }}
        />
      ) : (
        <div
          className="flex-1 overflow-y-auto p-5 nc-prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </div>
  );
}
