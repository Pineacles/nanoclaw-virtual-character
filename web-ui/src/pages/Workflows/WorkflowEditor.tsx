import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { WorkflowScopeChip } from './WorkflowScopeChip';
import { renderMarkdown } from '../../lib/markdown';
import type { Workflow } from '../../hooks/useWorkflows';

interface WorkflowEditorProps {
  workflow: Workflow | null;
  content: string;
  isDirty: boolean;
  isSaving: boolean;
  isLoading: boolean;
  onChange: (v: string) => void;
  onSave: (filename: string, content: string) => Promise<void>;
  onCancel: () => void;
  onDelete: (filename: string) => Promise<void>;
  /** Mobile only: back button handler */
  onBack?: () => void;
}

/**
 * Right pane: monospace textarea editor with frontmatter.
 * Header: filename + unsaved badge + save/cancel/delete actions.
 * Body: full-height textarea (monospace, raw markdown + YAML frontmatter).
 */
export function WorkflowEditor({
  workflow,
  content,
  isDirty,
  isSaving,
  isLoading,
  onChange,
  onSave,
  onCancel,
  onDelete,
  onBack,
}: WorkflowEditorProps) {
  const renderedHtml = useMemo(() => (content ? renderMarkdown(content) : ''), [content]);

  if (!workflow) {
    return (
      <div className="flex-1 flex items-center justify-center text-nc-text-dim text-sm">
        {onBack ? null : 'Select a workflow to edit'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Editor header */}
      <div
        className={cn(
          'px-5 py-3 flex items-center justify-between flex-shrink-0',
          'border-b border-nc-border-soft',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to workflow list"
              className="nc-press mr-1 text-nc-accent text-[13px] font-medium cursor-pointer border-none bg-transparent"
            >
              ← Back
            </button>
          )}
          <span
            className="text-[13px] text-nc-text font-medium font-mono truncate"
            style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
          >
            {workflow.filename}
          </span>
          <WorkflowScopeChip scope={workflow.scope} />
          {isDirty && (
            <span className="text-[10.5px] px-[7px] py-[1px] rounded-pill bg-nc-accent-soft text-nc-accent font-medium">
              unsaved
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isDirty && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel changes"
              className={cn(
                'nc-press px-2.5 py-1 rounded-[7px] text-[12.5px]',
                'border border-nc-border bg-nc-surface text-nc-text-muted',
                'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
              )}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void onSave(workflow.filename, content)}
            disabled={isSaving || !isDirty}
            aria-label="Save workflow"
            className={cn(
              'nc-press nc-gradient-fill px-2.5 py-1 rounded-[7px] text-[12.5px]',
              'text-white font-medium disabled:opacity-40 cursor-pointer',
            )}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void onDelete(workflow.filename)}
            aria-label="Delete workflow"
            className={cn(
              'nc-press px-2.5 py-1 rounded-[7px] text-[12.5px]',
              'border border-nc-border bg-nc-surface text-nc-text-muted',
              'hover:text-red-500 hover:border-red-400/50 transition-colors duration-[--nc-dur-micro] cursor-pointer',
            )}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Editor body */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="nc-skeleton w-48 h-4 rounded" />
        </div>
      ) : isDirty ? (
        <textarea
          value={content}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Edit ${workflow.filename}`}
          spellCheck={false}
          className={cn(
            'flex-1 p-5 resize-none bg-transparent border-none outline-none',
            'text-[12.5px] text-nc-text leading-[1.7] font-mono',
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
