import { useCallback, useState } from 'react';
import { api } from '../lib/api';

export interface MediaItem {
  url: string;
  filename: string;
  type: 'image' | 'file';
  messageId: string;
  timestamp: string;
  sender: 'user' | 'bot';
}

interface MediaResponse {
  items: MediaItem[];
}

const MEDIA_PAGE_SIZE = 30;

export function useSessionMedia(sessionId: string) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Pagination
  const [oldestTimestamp, setOldestTimestamp] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.get<MediaResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/media?limit=${MEDIA_PAGE_SIZE}`,
      );
      setItems(data.items);
      setLoaded(true);
      // Items are sorted newest-first; oldest is the last element.
      const last = data.items.length > 0 ? data.items[data.items.length - 1] : null;
      setOldestTimestamp(last?.timestamp ?? null);
      setHasMore(data.items.length === MEDIA_PAGE_SIZE);
    } catch {
      setItems([]);
      setLoaded(true);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  /** Load the next older page of media and append (items are sorted newest-first). */
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !oldestTimestamp) return;
    setLoadingMore(true);
    try {
      const data = await api.get<MediaResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/media?limit=${MEDIA_PAGE_SIZE}&before=${encodeURIComponent(oldestTimestamp)}`,
      );
      setItems((prev) => [...prev, ...data.items]);
      const last = data.items.length > 0 ? data.items[data.items.length - 1] : null;
      setOldestTimestamp(last?.timestamp ?? oldestTimestamp);
      setHasMore(data.items.length === MEDIA_PAGE_SIZE);
    } catch {
      // ignore — user can try again
    } finally {
      setLoadingMore(false);
    }
  }, [sessionId, hasMore, loadingMore, oldestTimestamp]);

  return { items, isLoading, loaded, load, loadMore, hasMore, loadingMore };
}
