import { useState } from 'react';
import { cn } from '../../lib/cn';
import { IconPlus, IconBack } from '../../components/icons';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { useMemoryFiles } from '../../hooks/useMemoryFiles';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import { MemoryFileList } from './MemoryFileList';
import { MemoryViewer } from './MemoryViewer';

interface MemoryPageProps {
  isMobile: boolean;
  authenticated: boolean;
}

/**
 * Memory page — two-column (desktop) / list→detail (mobile).
 * Left: scrollable file list + search + new file button.
 * Right: markdown viewer with edit affordances.
 */
export function MemoryPage({ isMobile, authenticated }: MemoryPageProps) {
  const {
    files,
    activeFile,
    setActiveFile,
    content,
    isLoading,
    isSaving,
    save,
    createFile,
    deleteFile,
  } = useMemoryFiles(authenticated);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? 'the assistant';

  // Mobile: track whether viewer is shown instead of list
  const [mobileShowViewer, setMobileShowViewer] = useState(false);
  const [showNewInput, setShowNewInput] = useState(false);
  const [newFilename, setNewFilename] = useState('');
  const [createError, setCreateError] = useState('');

  const totalSizeKb = files.reduce((acc, f) => acc + f.size, 0);
  const totalLabel = `${files.length} file${files.length !== 1 ? 's' : ''} · ${(Math.round(totalSizeKb / 100) / 10).toFixed(1)}k total`;

  const handleSelectFile = async (file: typeof activeFile) => {
    if (!file) return;
    await setActiveFile(file);
    if (isMobile) setMobileShowViewer(true);
  };

  const handleNewFile = async () => {
    const trimmed = newFilename.trim();
    if (!trimmed) return;
    const name = trimmed.endsWith('.md') ? trimmed : trimmed + '.md';
    if (name.includes('/') || name.includes('..')) {
      setCreateError('No slashes in filenames');
      return;
    }
    try {
      await createFile(name, '');
      setShowNewInput(false);
      setNewFilename('');
      setCreateError('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Error creating file');
    }
  };

  const header = (
    <div className={cn(
      'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
      'flex items-center justify-between',
      isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
    )}>
      {isMobile && mobileShowViewer ? (
        <button
          type="button"
          onClick={() => setMobileShowViewer(false)}
          aria-label="Back to file list"
          className="nc-press flex items-center gap-2 cursor-pointer border-none bg-transparent min-w-0 max-w-[calc(100%-44px)]"
        >
          <IconBack size={18} className="text-nc-accent flex-shrink-0" />
          <span
            className="text-[14px] text-nc-text font-medium truncate"
            style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
          >
            {activeFile?.filename ?? 'Memory'}
          </span>
        </button>
      ) : (
        <div>
          <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
            Memory
          </h1>
          <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">
            {isMobile ? totalLabel : `Knowledge files ${assistantName} references during conversation`}
          </p>
        </div>
      )}

      {!(isMobile && mobileShowViewer) && (
        showNewInput ? (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={newFilename}
              onChange={(e) => setNewFilename(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleNewFile(); if (e.key === 'Escape') { setShowNewInput(false); setNewFilename(''); setCreateError(''); } }}
              placeholder="filename.md"
              aria-label="New file name"
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
              onClick={() => void handleNewFile()}
              aria-label="Confirm new file"
              className="nc-press nc-gradient-fill h-8 px-3 rounded-[7px] text-[12.5px] text-white font-medium cursor-pointer"
            >
              Create
            </button>
            {createError && <span className="text-[11px] text-red-500">{createError}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNewInput(true)}
            aria-label="New memory file"
            className={cn(
              'nc-press nc-gradient-fill flex items-center gap-1.5 cursor-pointer text-white font-medium rounded-[8px]',
              isMobile ? 'w-8 h-8 justify-center' : 'px-3 py-[6px] text-[13px]',
            )}
            style={{ boxShadow: '0 1px 3px var(--nc-accent)40' }}
          >
            <IconPlus size={14} />
            {!isMobile && 'New file'}
          </button>
        )
      )}
    </div>
  );

  if (isMobile) {
    return (
      <BackgroundMesh variant="filled" className="flex flex-col h-full">
        {header}
        {mobileShowViewer ? (
          <MemoryViewer
            file={activeFile}
            content={content}
            isLoading={isLoading}
            isSaving={isSaving}
            onSave={save}
            onDelete={async (fn) => { await deleteFile(fn); setMobileShowViewer(false); }}
            compactHeader
          />
        ) : (
          <div className="flex-1 overflow-y-auto">
            {files.map((f) => (
              <button
                key={f.filename}
                type="button"
                onClick={() => void handleSelectFile(f)}
                className={cn(
                  'w-full px-4 py-3.5 flex items-center gap-3',
                  'border-b border-nc-border-soft bg-transparent cursor-pointer',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] text-left',
                )}
              >
                <span className={cn(
                  'w-9 h-9 rounded-[9px] bg-nc-surface-hi text-nc-text-muted',
                  'flex items-center justify-center flex-shrink-0',
                )}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[14px] text-nc-text font-medium truncate"
                      style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
                    >
                      {f.filename}
                    </span>
                    {f.filename === 'CLAUDE.md' && (
                      <span className="text-[10px] px-[6px] py-[1px] rounded-pill bg-nc-accent-soft text-nc-accent font-medium flex-shrink-0">
                        core
                      </span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-nc-text-dim mt-0.5">
                    {(Math.round(f.size / 100) / 10).toFixed(1)}k · {f.modified.split('T')[0]}
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-nc-text-dim flex-shrink-0">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            ))}
            {files.length === 0 && (
              <p className="px-4 py-8 text-center text-nc-text-dim text-sm">No memory files yet</p>
            )}
          </div>
        )}
      </BackgroundMesh>
    );
  }

  // Desktop layout
  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {header}
      <div className="flex-1 flex overflow-hidden">
        {/* File list sidebar */}
        <div className="w-[280px] flex-shrink-0 border-r border-nc-border-soft flex flex-col">
          <MemoryFileList
            files={files}
            activeFile={activeFile}
            onSelect={(f) => void handleSelectFile(f)}
            className="flex-1 overflow-hidden"
          />
        </div>
        {/* Viewer */}
        <MemoryViewer
          file={activeFile}
          content={content}
          isLoading={isLoading}
          isSaving={isSaving}
          onSave={save}
          onDelete={deleteFile}
        />
      </div>
    </BackgroundMesh>
  );
}
