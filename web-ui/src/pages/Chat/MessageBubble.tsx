import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { MoodDot } from '../../components/ui/MoodDot';
import { PillBadge } from '../../components/ui/PillBadge';
import { IconCheck, IconFile } from '../../components/icons';
import { getMoodColor } from '../../hooks/useMood';
import { renderMarkdown } from '../../lib/markdown';
import { parseAttachments, type ParsedAttachment } from '../../lib/attachments';
import { getUploadUrl } from '../../lib/api';
import { PersonaAvatar } from '../../components/PersonaAvatar';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import type { ChatMessage } from '../../hooks/useChat';

/** Inline image with click-to-zoom lightbox */
function InlineImage({ url, alt }: { url: string; alt: string }) {
  const [zoom, setZoom] = useState(false);
  const src = getUploadUrl(url.replace(/^\/uploads\//, ''));
  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setZoom(true)}
        className="rounded-[10px] max-w-full max-h-72 object-contain cursor-pointer hover:opacity-90 transition-opacity border border-nc-border-soft"
      />
      {zoom && (
        <div
          role="dialog"
          aria-label="Image preview"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setZoom(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-[10px] shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

/** Compact inline audio player */
function InlineAudio({ url, name }: { url: string; name: string }) {
  const src = getUploadUrl(url.replace(/^\/uploads\//, ''));
  return (
    <div
      className={cn(
        'flex flex-col gap-1 px-2.5 py-2 rounded-[10px]',
        'bg-nc-surface-alt border border-nc-border-soft',
        'max-w-[280px]',
      )}
    >
      <span
        className="text-[11px] text-nc-text-muted truncate"
        style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
      >
        {name}
      </span>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        controls
        preload="metadata"
        src={src}
        className="w-full h-8"
        style={{ maxWidth: '256px' }}
      />
    </div>
  );
}

/** Inline file row (download link) */
function InlineFile({ url, name }: { url: string; name: string }) {
  const href = getUploadUrl(url.replace(/^\/uploads\//, ''));
  return (
    <a
      href={href}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-2.5 px-3 py-2 rounded-[10px] no-underline',
        'bg-nc-surface-alt border border-nc-border-soft',
        'text-nc-text hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]',
        'max-w-[280px]',
      )}
    >
      <span className="w-7 h-7 flex items-center justify-center rounded-[7px] bg-nc-surface-hi text-nc-text-muted flex-shrink-0">
        <IconFile size={14} />
      </span>
      <span
        className="text-[12.5px] font-medium truncate flex-1"
        style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
      >
        {name}
      </span>
    </a>
  );
}

/** Grid of inline attachments below a message bubble */
function AttachmentGrid({ attachments }: { attachments: ParsedAttachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.type === 'image');
  const files = attachments.filter((a) => a.type === 'file');
  const audios = attachments.filter((a) => a.type === 'audio');
  return (
    <div className="flex flex-col gap-2 mt-2">
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', images.length === 1 ? '' : 'max-w-md')}>
          {images.map((a, i) => (
            <InlineImage key={`${a.filename}-${i}`} url={a.url} alt={a.displayName} />
          ))}
        </div>
      )}
      {audios.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {audios.map((a, i) => (
            <InlineAudio key={`${a.filename}-${i}`} url={a.url} name={a.displayName} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {files.map((a, i) => (
            <InlineFile key={`${a.filename}-${i}`} url={a.url} name={a.displayName} />
          ))}
        </div>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  isMobile?: boolean;
  /** True only on the most-recent read user message — drives single receipt display. */
  isLastRead?: boolean;
}

/** Small info icon for the system context pill */
function IconInfo({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

/**
 * Clickable pill + popover showing the raw system context block.
 * The popover is portaled to <body> with position:fixed so it always renders
 * above subsequent message bubbles, regardless of scroll-container stacking.
 */
function SystemContextMarker({ systemContext }: { systemContext: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Position the popover relative to the button (right-aligned, below)
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const updatePos = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div className="flex justify-end mt-1.5">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Show system context that was prepended"
          className={cn(
            'flex items-center gap-[5px] px-2 py-[3px] rounded-pill text-[11px] font-medium',
            'border cursor-pointer transition-colors duration-[--nc-dur-micro] nc-press',
          )}
          style={{
            background: 'var(--nc-badge-sys-bg)',
            color: 'var(--nc-badge-sys-fg)',
            borderColor: 'var(--nc-badge-sys-bd)',
          }}
        >
          <IconInfo size={10} />
          context
        </button>
      </div>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="System context"
          className={cn(
            'fixed rounded-[10px] border shadow-[0_8px_28px_rgba(0,0,0,0.18)]',
            'max-h-[320px] overflow-y-auto',
          )}
          style={{
            top: pos.top,
            right: pos.right,
            width: 'min(360px, 90vw)',
            background: 'var(--nc-surface)',
            borderColor: 'var(--nc-border)',
            zIndex: 1000,
          }}
        >
          <pre
            className="p-[14px] m-0 text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words"
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              color: 'var(--nc-text-muted)',
            }}
          >
            {systemContext}
          </pre>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Auto-loaded memory marker — shown on the user bubble when the user's
 * message triggered a topic-keyword auto-memory fetch (e.g. mentions
 * "money" → finance.md). Click to expand and see which files were loaded.
 */
function AutoMemoryMarker({ memories }: { memories: string[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? 'the assistant';

  // Short labels: 'finance.md' → 'finance', 'briefings/2026-05-02.md' → 'briefings'
  const shortNames = Array.from(
    new Set(memories.map((n) => n.split('/')[0].replace(/\.md$/, ''))),
  );

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const updatePos = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (memories.length === 0) return null;

  return (
    <>
      <div className="flex justify-end mt-1.5">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Show auto-loaded memory files"
          className={cn(
            'flex items-center gap-[5px] px-2 py-[3px] rounded-pill text-[11px] font-medium',
            'border cursor-pointer transition-colors duration-[--nc-dur-micro] nc-press',
          )}
          style={{
            background: 'var(--nc-badge-memory-bg, rgba(217, 158, 23, 0.12))',
            color: 'var(--nc-badge-memory-fg, #b8860b)',
            borderColor: 'var(--nc-badge-memory-bd, rgba(217, 158, 23, 0.32))',
          }}
        >
          <span aria-hidden="true">↳</span>
          memory: {shortNames.join(', ')}
        </button>
      </div>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Auto-loaded memories"
          className={cn(
            'fixed rounded-[10px] border shadow-[0_8px_28px_rgba(0,0,0,0.18)]',
            'overflow-hidden',
          )}
          style={{
            top: pos.top,
            right: pos.right,
            width: 'min(300px, 90vw)',
            background: 'var(--nc-surface)',
            borderColor: 'var(--nc-border)',
            zIndex: 1000,
          }}
        >
          <div className="px-3.5 py-2.5 border-b border-nc-border-soft">
            <div className="text-[10px] uppercase tracking-[0.06em] text-nc-text-dim font-semibold">
              Auto-loaded memory
            </div>
            <div className="text-[11.5px] text-nc-text-muted mt-0.5">
              Files injected into {assistantName}'s context based on your message.
            </div>
          </div>
          <ul className="list-none m-0 p-0">
            {memories.map((m, i) => (
              <li
                key={`${m}-${i}`}
                className="px-3.5 py-2 text-[12px] text-nc-text border-b border-nc-border-soft last:border-b-0"
                style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
              >
                {m}
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Renders a single chat message bubble.
 *
 * User: right-aligned, rounded bubble, nc-bubble-user bg.
 *   - systemContext → small ghost pill below bubble (right-aligned) with popover
 * Bot: left-aligned, borderless, sender label row with mood dot.
 *   - autoLoadedMemories → amber monospace pills below content
 *   - workflowVerdict.used → green checkmark pills below content
 *   - streaming → blinking cursor appended to content
 *   - markdown rendered via marked + DOMPurify
 */
function MessageBubbleInner({ message, isMobile = false, isLastRead = false }: MessageBubbleProps) {
  // Strip [Image:...] / [File:...] markers from displayed content,
  // but keep the parsed attachments to render as inline media below.
  const { cleanContent, attachments } = useMemo(
    () => parseAttachments(message.content),
    [message.content],
  );
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? '';

  if (message.sender === 'user') {
    return (
      <div className="nc-msg flex flex-col items-end mb-3.5">
        {cleanContent && (
          <div
            className={cn(
              'px-3.5 py-2.5 rounded-bubble text-[14.5px] leading-[1.5] text-nc-text',
              isMobile ? 'max-w-[82%]' : 'max-w-[70%]',
            )}
            style={{ background: 'var(--nc-bubble-user)' }}
          >
            {cleanContent}
          </div>
        )}
        {attachments.length > 0 && (
          <div className={isMobile ? 'max-w-[82%]' : 'max-w-[70%]'}>
            <AttachmentGrid attachments={attachments} />
          </div>
        )}
        {message.autoLoadedMemories && message.autoLoadedMemories.length > 0 && (
          <div className={isMobile ? 'max-w-[82%] w-full' : 'max-w-[70%] w-full'}>
            <AutoMemoryMarker memories={message.autoLoadedMemories} />
          </div>
        )}
        {message.systemContext && (
          <div className={isMobile ? 'max-w-[82%] w-full' : 'max-w-[70%] w-full'}>
            <SystemContextMarker systemContext={message.systemContext} />
          </div>
        )}
        {isLastRead && message.readAt && (
          <span className="text-[10px] text-nc-text-muted mt-0.5 pr-0.5">
            Read {new Date(message.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    );
  }

  // Bot message
  const moodColor = message.mood ? getMoodColor(message.mood) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => renderMarkdown(cleanContent), [cleanContent]);

  return (
    <div className="nc-msg mb-[18px]">
      {/* Sender label row */}
      <div className="flex items-center gap-2 mb-1.5">
        <PersonaAvatar size={16} />
        <MoodDot size={9} color={moodColor} />
        <span className="text-xs text-nc-text-muted font-medium">{assistantName.toLowerCase()}</span>
        {message.mood && (
          <PillBadge variant="mood">{message.mood}</PillBadge>
        )}
      </div>

      {/* Content — rendered as markdown, indented 17px to align under sender name */}
      {cleanContent && (
        <div
          className="text-[14.5px] leading-[1.6] text-nc-text pl-[41px] nc-prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: message.streaming
              ? html + '<span class="nc-blink inline-block align-[-2px] ml-0.5 bg-nc-accent" style="width:7px;height:14px" aria-label="Streaming"></span>'
              : html,
          }}
        />
      )}

      {/* Inline attachments (images + file cards) */}
      {attachments.length > 0 && (
        <div className="pl-[41px] max-w-md">
          <AttachmentGrid attachments={attachments} />
        </div>
      )}

      {/* Auto-loaded memory pill is shown on the user bubble (where the
          trigger happened), not the bot reply — see AutoMemoryMarker above. */}

      {/* Workflow verdict badges */}
      {message.workflowVerdict && message.workflowVerdict.used.length > 0 && (
        <div className="flex gap-1.5 mt-2 pl-[41px] flex-wrap">
          {message.workflowVerdict.used.map((w, i) => (
            <PillBadge key={i} variant="workflow">
              <IconCheck size={10} />
              {w}
            </PillBadge>
          ))}
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.streaming === next.message.streaming &&
    prev.message.mood === next.message.mood &&
    prev.isMobile === next.isMobile &&
    prev.message.systemContext === next.message.systemContext &&
    prev.message.autoLoadedMemories?.length === next.message.autoLoadedMemories?.length &&
    prev.message.workflowVerdict === next.message.workflowVerdict &&
    prev.message.readAt === next.message.readAt &&
    prev.isLastRead === next.isLastRead
  );
});
