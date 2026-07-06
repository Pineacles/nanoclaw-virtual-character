import { useState } from 'react';
import { cn } from '../../lib/cn';
import { IconPlus } from '../../components/icons';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { useWorkflows } from '../../hooks/useWorkflows';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import { WorkflowList } from './WorkflowList';
import { WorkflowEditor } from './WorkflowEditor';

interface WorkflowsPageProps {
  isMobile: boolean;
  authenticated: boolean;
}

/**
 * Workflows page.
 * Desktop: split — left list (340px) + right editor.
 * Mobile: list view, tap workflow → editor with back button.
 */
export function WorkflowsPage({ isMobile, authenticated }: WorkflowsPageProps) {
  const {
    workflows,
    activeWorkflow,
    isLoading,
    isSaving,
    isDirty,
    editorContent,
    setEditorContent,
    selectWorkflow,
    saveWorkflow,
    createWorkflow,
    deleteWorkflow,
  } = useWorkflows(authenticated);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? 'the assistant';

  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');

  const handleSelectWorkflow = async (filename: string) => {
    await selectWorkflow(filename);
    if (isMobile) setMobileShowEditor(true);
  };

  const handleCancel = () => {
    if (activeWorkflow) setEditorContent(activeWorkflow.content);
  };

  const handleDelete = async (filename: string) => {
    await deleteWorkflow(filename);
    if (isMobile) setMobileShowEditor(false);
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) { setCreateError('Name is required'); return; }
    // Convert name to kebab-case filename
    const filename = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '.md';
    const template = `---\nname: ${trimmed}\ndescription: \nscope: group\ntriggers:\n  - \n---\n\n# ${trimmed}\n\n`;
    try {
      await createWorkflow(filename, template);
      setShowNewForm(false);
      setNewName('');
      setCreateError('');
      if (isMobile) setMobileShowEditor(true);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Error creating workflow');
    }
  };

  const header = (
    <div
      className={cn(
        'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
        'flex items-center justify-between',
        isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
      )}
    >
      <div>
        <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
          Workflows
        </h1>
        <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">
          {isMobile
            ? `${workflows.length} rule${workflows.length !== 1 ? 's' : ''}`
            : `Reusable behavior rules ${assistantName} follows automatically`}
        </p>
      </div>

      {showNewForm ? (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
              if (e.key === 'Escape') { setShowNewForm(false); setNewName(''); setCreateError(''); }
            }}
            placeholder="Workflow name"
            aria-label="New workflow name"
            autoFocus
            className={cn(
              'h-8 px-2.5 rounded-[7px] text-[12.5px] border outline-none',
              'border-nc-border bg-nc-surface text-nc-text',
              'focus:border-nc-accent transition-colors duration-[--nc-dur-micro]',
              isMobile ? 'w-32' : 'w-40',
            )}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            aria-label="Confirm create workflow"
            className="nc-press nc-gradient-fill h-8 px-3 rounded-[7px] text-[12.5px] text-white font-medium cursor-pointer"
          >
            Create
          </button>
          {createError && <span className="text-[11px] text-red-500">{createError}</span>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowNewForm(true)}
          aria-label="New workflow"
          className={cn(
            'nc-press nc-gradient-fill flex items-center gap-1.5 cursor-pointer text-white font-medium rounded-[8px]',
            isMobile ? 'w-8 h-8 justify-center' : 'px-3 py-[6px] text-[13px]',
          )}
          style={{ boxShadow: '0 1px 3px var(--nc-accent)40' }}
        >
          <IconPlus size={14} />
          {!isMobile && 'New workflow'}
        </button>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <BackgroundMesh variant="filled" className="flex flex-col h-full">
        {header}
        {mobileShowEditor ? (
          <WorkflowEditor
            workflow={activeWorkflow}
            content={editorContent}
            isDirty={isDirty}
            isSaving={isSaving}
            isLoading={isLoading}
            onChange={setEditorContent}
            onSave={saveWorkflow}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onBack={() => setMobileShowEditor(false)}
          />
        ) : (
          <WorkflowList
            workflows={workflows}
            activeFilename={activeWorkflow?.filename ?? null}
            onSelect={(fn) => void handleSelectWorkflow(fn)}
            className="flex-1"
          />
        )}
      </BackgroundMesh>
    );
  }

  // Desktop split
  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {header}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-[340px] flex-shrink-0 border-r border-nc-border-soft overflow-hidden flex flex-col">
          <WorkflowList
            workflows={workflows}
            activeFilename={activeWorkflow?.filename ?? null}
            onSelect={(fn) => void handleSelectWorkflow(fn)}
            className="flex-1"
          />
        </div>
        <WorkflowEditor
          workflow={activeWorkflow}
          content={editorContent}
          isDirty={isDirty}
          isSaving={isSaving}
          isLoading={isLoading}
          onChange={setEditorContent}
          onSave={saveWorkflow}
          onCancel={handleCancel}
          onDelete={handleDelete}
        />
      </div>
    </BackgroundMesh>
  );
}
