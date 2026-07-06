import { cn } from '../../lib/cn';
import { IconFile } from '../../components/icons';
import type { MemoryFile } from '../../hooks/useMemoryFiles';

interface MemoryFileRowProps {
  file: MemoryFile;
  isActive: boolean;
  onClick: () => void;
}

/** Single row in the memory file list. Icon + filename (mono) + size. */
export function MemoryFileRow({ file, isActive, onClick }: MemoryFileRowProps) {
  const sizeKb = (Math.round(file.size / 100) / 10).toFixed(1) + 'k';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'nc-press w-full px-3 py-2 rounded-[8px] border-none',
        'flex items-center gap-2.5 cursor-pointer text-left',
        'text-[13px] transition-colors duration-[--nc-dur-micro]',
        isActive
          ? 'bg-nc-surface-hi text-nc-text font-medium'
          : 'bg-transparent text-nc-text font-normal hover:bg-nc-surface-hi',
      )}
    >
      <IconFile
        size={14}
        className={cn('flex-shrink-0', isActive ? 'text-nc-accent' : 'text-nc-text-muted')}
      />
      <span
        className="flex-1 truncate font-mono text-[12.5px]"
        style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
      >
        {file.filename}
      </span>
      <span
        className="text-[10.5px] text-nc-text-dim flex-shrink-0 font-mono"
        style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
      >
        {sizeKb}
      </span>
    </button>
  );
}
