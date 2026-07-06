import { useState } from 'react';
import { cn } from '../../lib/cn';
import { IconSearch } from '../../components/icons';
import { MemoryFileRow } from './MemoryFileRow';
import type { MemoryFile } from '../../hooks/useMemoryFiles';

interface MemoryFileListProps {
  files: MemoryFile[];
  activeFile: MemoryFile | null;
  onSelect: (file: MemoryFile) => void;
  className?: string;
}

/** Scrollable list of memory files with search filter. */
export function MemoryFileList({ files, activeFile, onSelect, className }: MemoryFileListProps) {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? files.filter((f) => f.filename.toLowerCase().includes(query.toLowerCase()))
    : files;

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Search bar */}
      <div className="px-3 pt-3 pb-1.5">
        <div
          className={cn(
            'flex items-center gap-2 h-[30px] px-2.5 rounded-[8px]',
            'border border-nc-border bg-nc-surface',
          )}
        >
          <IconSearch size={13} className="text-nc-text-dim flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            aria-label="Search memory files"
            className={cn(
              'flex-1 bg-transparent border-none outline-none',
              'text-[12.5px] text-nc-text-dim placeholder:text-nc-text-dim',
            )}
          />
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 px-2 py-1.5 flex flex-col gap-[1px] overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-[12.5px] text-nc-text-dim text-center">
            {query ? 'No files match' : 'No memory files yet'}
          </p>
        ) : (
          filtered.map((f) => (
            <MemoryFileRow
              key={f.filename}
              file={f}
              isActive={activeFile?.filename === f.filename}
              onClick={() => onSelect(f)}
            />
          ))
        )}
      </div>
    </div>
  );
}
