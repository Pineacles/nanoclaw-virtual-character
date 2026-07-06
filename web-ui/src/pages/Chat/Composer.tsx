import { useCallback, useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react';
import { cn } from '../../lib/cn';
import { IconPlus, IconSparkle, IconSend, IconX, IconFile } from '../../components/icons';
import { useGroupConfig } from '../../hooks/useGroupConfig';

interface ComposerProps {
  onSend: (content: string, images?: string[], files?: { name: string; data: string }[]) => void;
  isStreaming: boolean;
  isConnected: boolean;
  isMobile?: boolean;
  sessionMode?: 'persona' | 'plain';
  modelLabel?: string;
}

interface StagedFile {
  id: string;
  name: string;
  /** data URL — base64-encoded for the wire */
  data: string;
  isImage: boolean;
}

const MAX_ROWS = 6;
const LINE_HEIGHT = 22;
const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

/**
 * Chat composer with auto-grow textarea and staged file attachments.
 * Files chosen via the + button are staged as chips above the textarea.
 * The user can keep typing or add more, and only Send fires the actual message.
 */
export function Composer({
  onSend,
  isStreaming,
  isConnected,
  isMobile = false,
  sessionMode,
  modelLabel,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? '';

  const hasContent = value.trim().length > 0 || staged.length > 0;
  const disabled = !hasContent || isStreaming || !isConnected;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxH = LINE_HEIGHT * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    resizeTextarea();
  };

  const submit = useCallback(() => {
    if (disabled) return;
    const text = value.trim();
    const images = staged.filter((s) => s.isImage).map((s) => s.data);
    const files = staged.filter((s) => !s.isImage).map((s) => ({ name: s.name, data: s.data }));
    onSend(
      text,
      images.length > 0 ? images : undefined,
      files.length > 0 ? files : undefined,
    );
    setValue('');
    setStaged([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
  }, [value, staged, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      submit();
    }
  };

  const stageFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const encoded = await Promise.all(
      files.map(async (f) => {
        const data = await readAsDataURL(f);
        return {
          id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: f.name,
          data,
          isImage: f.type.startsWith('image/') || IMAGE_EXTS.test(f.name),
        };
      }),
    );
    setStaged((prev) => [...prev, ...encoded]);
  }, []);

  const handleAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '*/*';
    input.onchange = () => {
      if (input.files && input.files.length > 0) void stageFiles(input.files);
    };
    input.click();
  };

  const removeStaged = (id: string) =>
    setStaged((prev) => prev.filter((s) => s.id !== id));

  return (
    <div
      className={cn('flex-shrink-0', isMobile ? 'px-3 pt-2 pb-3' : 'px-6 pb-5 pt-3 flex justify-center')}
    >
      <div className={cn('w-full', !isMobile && 'max-w-chat')}>
        <div
          className={cn(
            'nc-page bg-nc-surface border border-nc-border rounded-composer',
            'flex flex-col gap-2',
            isMobile ? 'px-4 py-2.5 pb-2' : 'px-[18px] py-3 pb-2.5',
          )}
          style={!isMobile ? { boxShadow: 'var(--nc-composer-shadow, 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05))' } : undefined}
        >
          {/* Staged attachments — chips above textarea */}
          {staged.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {staged.map((s) =>
                s.isImage ? (
                  <div
                    key={s.id}
                    className="relative w-[60px] h-[60px] rounded-[8px] overflow-hidden border border-nc-border-soft bg-nc-surface-alt flex-shrink-0"
                  >
                    <img
                      src={s.data}
                      alt={s.name}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeStaged(s.id)}
                      aria-label={`Remove ${s.name}`}
                      className="absolute top-0.5 right-0.5 w-[18px] h-[18px] flex items-center justify-center rounded-full bg-black/60 text-white border-none cursor-pointer hover:bg-black/80 transition-colors"
                    >
                      <IconX size={10} />
                    </button>
                  </div>
                ) : (
                  <div
                    key={s.id}
                    className={cn(
                      'flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-[10px]',
                      'bg-nc-surface-alt border border-nc-border-soft',
                      'max-w-[220px]',
                    )}
                  >
                    <span className="w-5 h-5 flex items-center justify-center rounded-[5px] bg-nc-surface-hi text-nc-text-muted flex-shrink-0">
                      <IconFile size={12} />
                    </span>
                    <span
                      className="text-[12px] text-nc-text font-medium truncate"
                      style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
                    >
                      {s.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeStaged(s.id)}
                      aria-label={`Remove ${s.name}`}
                      className="w-[18px] h-[18px] flex items-center justify-center rounded-full bg-transparent text-nc-text-dim hover:text-nc-text border-none cursor-pointer flex-shrink-0"
                    >
                      <IconX size={10} />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={staged.length > 0 ? 'Add a message…' : `Message ${assistantName}…`}
            aria-label="Message input"
            rows={1}
            className={cn(
              'w-full bg-transparent border-none outline-none resize-none',
              'text-[14.5px] leading-[1.45] text-nc-text',
              'placeholder:text-nc-text-dim',
              'nc-composer-grow',
              'min-h-[22px]',
            )}
            style={{ overflowY: 'hidden', paddingTop: 2 }}
          />

          {/* Action row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button
                onClick={handleAttach}
                aria-label="Attach file"
                className="nc-press w-[30px] h-[30px] rounded-full flex items-center justify-center bg-transparent text-nc-text-muted hover:text-nc-text hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] border-none cursor-pointer"
              >
                <IconPlus size={16} />
              </button>
              <button
                aria-label={`Session mode: ${sessionMode ?? 'persona'}`}
                className={cn(
                  'nc-press h-7 px-2.5 rounded-[14px] flex items-center gap-[5px]',
                  'border border-nc-border bg-transparent text-nc-text-muted',
                  'text-xs font-medium cursor-default',
                )}
              >
                <span className="text-nc-accent flex"><IconSparkle size={13} /></span>
                <span>Persona</span>
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={submit}
                disabled={disabled}
                aria-label="Send message"
                className={cn(
                  'nc-press w-8 h-8 rounded-full flex items-center justify-center border-none cursor-pointer',
                  'nc-gradient-fill text-white',
                  'transition-opacity duration-[--nc-dur-micro]',
                  disabled && 'opacity-40 cursor-not-allowed',
                )}
                style={{
                  boxShadow: disabled ? 'none' : 'var(--nc-send-shadow, 0 2px 8px var(--nc-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.25))',
                }}
              >
                <IconSend size={14} />
              </button>
            </div>
          </div>
        </div>

        {!isMobile && modelLabel && (
          <div className="text-[11px] text-nc-text-dim text-center mt-2">
            {modelLabel} · Persona on · Memory + 2 workflows active
          </div>
        )}
      </div>
    </div>
  );
}
