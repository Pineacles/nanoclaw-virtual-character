import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface GroupConfig {
  features?: {
    mood?: boolean;
    personality?: boolean;
    diary?: boolean;
    emotional_state?: boolean;
    schedule?: boolean;
    relationship?: boolean;
    memory?: boolean;
    voice_call?: boolean;
    [key: string]: boolean | undefined;
  };
  assistant?: { name?: string; trigger?: string };
  user?: { name?: string };
  style?: { signature_markers?: string[]; signature_note?: string };
  mood?: { fallback?: { mood: string; energy: number } };
  group_folder?: string;
  [key: string]: unknown;
}

interface UseGroupConfigResult {
  groupConfig: GroupConfig | null;
  isLoading: boolean;
}

// Module-level cache so multiple components using this hook share one fetch.
let cache: GroupConfig | null = null;
let pendingPromise: Promise<GroupConfig> | null = null;

/**
 * Fetch and cache the group config from /api/group-config.
 * Cache persists for the page lifetime; call window.__ncClearGroupConfig?.() to bust.
 */
export function useGroupConfig(): UseGroupConfigResult {
  const [groupConfig, setGroupConfig] = useState<GroupConfig | null>(cache);
  const [isLoading, setIsLoading] = useState(cache === null);

  useEffect(() => {
    if (cache !== null) {
      setGroupConfig(cache);
      setIsLoading(false);
      return;
    }
    if (!pendingPromise) {
      pendingPromise = api.get<GroupConfig>('/api/group-config').catch((err) => {
        console.warn('NanoClaw: backend missing /api/group-config; UI will render in fallback mode.', err);
        pendingPromise = null;
        return {} as GroupConfig;
      });
    }
    let cancelled = false;
    void pendingPromise.then((config) => {
      cache = config;
      if (!cancelled) {
        setGroupConfig(config);
        setIsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return { groupConfig, isLoading };
}
