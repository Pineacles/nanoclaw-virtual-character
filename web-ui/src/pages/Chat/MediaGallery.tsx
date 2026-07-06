import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { IconX, IconFile } from '../../components/icons';
import { getUploadUrl } from '../../lib/api';
import { useSessionMedia } from '../../hooks/useSessionMedia';
import type { MediaItem } from '../../hooks/useSessionMedia';

interface MediaGalleryProps {
  sessionId: string;
  isMobile: boolean;
  onClose: () => void;
}

/** Full-screen lightbox for a single image */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Image preview"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close image preview"
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-btn bg-white/10 text-white border-none cursor-pointer hover:bg-white/20 transition-colors"
      >
        <IconX size={18} />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] rounded-[10px] object-contain"
      />
    </div>
  );
}

/** Single image thumbnail */
function ImageThumb({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const authUrl = getUploadUrl(item.filename);
  return (
    <button
      type="button"
      aria-label={`View image ${item.filename}`}
      onClick={onOpen}
      className={cn(
        'nc-press relative overflow-hidden rounded-[8px] border border-nc-border-soft',
        'bg-nc-surface-alt cursor-pointer',
        'w-[120px] h-[120px] flex-shrink-0',
      )}
    >
      <img
        src={authUrl}
        alt={item.filename}
        className="w-full h-full object-cover"
        loading="lazy"
      />
    </button>
  );
}

/** Single file row */
function FileRow({ item }: { item: MediaItem }) {
  const authUrl = getUploadUrl(item.filename);
  const dateStr = new Date(item.timestamp).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return (
    <a
      href={authUrl}
      download={item.filename}
      aria-label={`Download ${item.filename}`}
      className={cn(
        'flex items-center gap-3 px-4 py-3',
        'border-b border-nc-border-soft',
        'text-nc-text hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] no-underline',
      )}
    >
      <span className="w-8 h-8 flex items-center justify-center rounded-[7px] bg-nc-surface-hi text-nc-text-muted flex-shrink-0">
        <IconFile size={15} />
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] text-nc-text font-medium truncate"
          style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
        >
          {item.filename}
        </div>
        <div className="text-[11px] text-nc-text-dim mt-0.5">{dateStr}</div>
      </div>
    </a>
  );
}

/** Skeleton thumbnail placeholder */
function SkeletonThumb() {
  return (
    <div className="w-[120px] h-[120px] rounded-[8px] nc-skeleton flex-shrink-0" />
  );
}

interface MediaGroup {
  label: string;
  items: MediaItem[];
}

/**
 * Bucket media items by recency relative to today: Today, Yesterday,
 * This week (last 7d), Earlier this month, then by `Month YYYY`.
 * Input is assumed newest-first; output preserves that order within groups.
 */
function groupByDate(items: MediaItem[]): MediaGroup[] {
  const now = new Date();
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const today = startOfDay(now).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const groups = new Map<string, MediaItem[]>();
  const order: string[] = [];

  const add = (label: string, item: MediaItem) => {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(item);
  };

  for (const item of items) {
    const t = new Date(item.timestamp).getTime();
    if (Number.isNaN(t)) {
      add('Unknown date', item);
      continue;
    }
    if (t >= today) add('Today', item);
    else if (t >= yesterday) add('Yesterday', item);
    else if (t >= weekAgo) add('This week', item);
    else if (t >= monthStart) add('Earlier this month', item);
    else {
      const d = new Date(t);
      const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      add(label, item);
    }
  }

  return order.map((label) => ({ label, items: groups.get(label)! }));
}

/**
 * Media gallery — desktop modal (centered, max-w-3xl) or mobile bottom sheet.
 * Shows images as square thumbnails and files as download rows.
 */
export function MediaGallery({ sessionId, isMobile, onClose }: MediaGalleryProps) {
  const { items, isLoading, loaded, load, loadMore, hasMore, loadingMore } = useSessionMedia(sessionId);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !lightbox) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, lightbox]);

  const groups = groupByDate(items);

  const inner = (
    <div className={cn('flex flex-col h-full min-h-0', !isMobile && 'max-h-[80vh]')}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-nc-border-soft flex-shrink-0">
        <span className="text-[14px] font-semibold text-nc-text tracking-[-0.01em]">Media</span>
        <button
          type="button"
          aria-label="Close media gallery"
          onClick={onClose}
          className="nc-press w-7 h-7 flex items-center justify-center rounded-btn border-none bg-transparent text-nc-text-muted cursor-pointer hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
        >
          <IconX size={15} />
        </button>
      </div>

      {/* Body — overscroll-contain prevents the body scroll from bleeding into the page on mobile */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {isLoading && (
          <div className="flex flex-wrap gap-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonThumb key={i} />
            ))}
          </div>
        )}

        {loaded && items.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <p className="text-[13px] text-nc-text-dim">No media in this chat yet.</p>
          </div>
        )}

        {loaded && groups.map((g) => {
          const groupImages = g.items.filter((i) => i.type === 'image');
          const groupFiles = g.items.filter((i) => i.type === 'file');
          return (
            <section key={g.label} className="border-b border-nc-border-soft last:border-b-0">
              <div className="px-4 pt-3 pb-2 sticky top-0 bg-nc-surface z-10">
                <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-nc-text-dim">
                  {g.label}
                </p>
              </div>
              {groupImages.length > 0 && (
                <div className="px-4 pb-3">
                  <div className="flex flex-wrap gap-2">
                    {groupImages.map((item) => (
                      <ImageThumb
                        key={item.messageId + item.filename}
                        item={item}
                        onOpen={() => setLightbox(item)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {groupFiles.length > 0 && (
                <div className="pb-2">
                  {groupFiles.map((item) => (
                    <FileRow key={item.messageId + item.filename} item={item} />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {/* Load more / end of media */}
        {loaded && items.length > 0 && (
          <div className="flex items-center justify-center py-4">
            {hasMore ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={cn(
                  'nc-press bg-nc-surface-alt border border-nc-border-soft',
                  'rounded-[10px] px-4 py-2 text-[13px] text-nc-text font-medium',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : (
              <span className="text-[12px] text-nc-text-dim">no older media</span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        {lightbox && (
          <Lightbox
            src={getUploadUrl(lightbox.filename)}
            alt={lightbox.filename}
            onClose={() => setLightbox(null)}
          />
        )}
        {/* Scrim */}
        <div
          className="fixed inset-0 z-30 bg-black/40"
          aria-hidden="true"
          onClick={onClose}
        />
        {/* Bottom sheet */}
        <div
          role="dialog"
          aria-label="Media gallery"
          aria-modal="true"
          className={cn(
            'nc-bottom-sheet fixed inset-x-0 bottom-0 z-40 rounded-t-[18px]',
            'bg-nc-surface border-t border-nc-border-soft',
            'h-[85vh] flex flex-col overflow-hidden',
          )}
        >
          {inner}
        </div>
      </>
    );
  }

  // Desktop modal
  return (
    <>
      {lightbox && (
        <Lightbox
          src={getUploadUrl(lightbox.filename)}
          alt={lightbox.filename}
          onClose={() => setLightbox(null)}
        />
      )}
      {/* Scrim */}
      <div
        className="fixed inset-0 z-30 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* Centered modal */}
      <div
        role="dialog"
        aria-label="Media gallery"
        aria-modal="true"
        className={cn(
          'fixed z-40 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
          'bg-nc-surface rounded-[16px] border border-nc-border shadow-[0_8px_40px_rgba(0,0,0,0.16)]',
          'w-full overflow-hidden',
        )}
        style={{ maxWidth: '768px' }}
      >
        {inner}
      </div>
    </>
  );
}
