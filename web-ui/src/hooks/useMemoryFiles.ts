import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface MemoryFile {
  filename: string;
  size: number;
  modified: string;
}

export interface UseMemoryFilesResult {
  files: MemoryFile[];
  activeFile: MemoryFile | null;
  setActiveFile: (file: MemoryFile | null) => void;
  content: string;
  isLoading: boolean;
  isSaving: boolean;
  save: (filename: string, newContent: string) => Promise<void>;
  createFile: (filename: string, initialContent?: string) => Promise<void>;
  deleteFile: (filename: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Memory files hook — manages CRUD for groups/<group>/*.md files.
 * Endpoints: GET/POST /api/memory, GET/PUT/DELETE /api/memory/:filename
 */
export function useMemoryFiles(authenticated: boolean): UseMemoryFilesResult {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [activeFile, setActiveFileState] = useState<MemoryFile | null>(null);
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      const data = await api.get<MemoryFile[]>('/api/memory');
      setFiles(data);
    } catch {
      // ignore network errors silently
    }
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setActiveFile = useCallback(async (file: MemoryFile | null) => {
    setActiveFileState(file);
    if (!file) { setContent(''); return; }
    setIsLoading(true);
    try {
      const data = await api.get<{ filename: string; content: string }>(
        `/api/memory/${encodeURIComponent(file.filename)}`,
      );
      setContent(data.content);
    } catch {
      setContent('');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const save = useCallback(async (filename: string, newContent: string) => {
    setIsSaving(true);
    try {
      await api.put(`/api/memory/${encodeURIComponent(filename)}`, { content: newContent });
      setContent(newContent);
      await refresh();
    } finally {
      setIsSaving(false);
    }
  }, [refresh]);

  const createFile = useCallback(async (filename: string, initialContent = '') => {
    await api.post('/api/memory', { filename, content: initialContent });
    await refresh();
  }, [refresh]);

  const deleteFile = useCallback(async (filename: string) => {
    await api.delete(`/api/memory/${encodeURIComponent(filename)}`);
    if (activeFile?.filename === filename) {
      setActiveFileState(null);
      setContent('');
    }
    await refresh();
  }, [refresh, activeFile]);

  return {
    files,
    activeFile,
    setActiveFile,
    content,
    isLoading,
    isSaving,
    save,
    createFile,
    deleteFile,
    refresh,
  };
}
