import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface WorkflowMeta {
  filename: string;
  name: string;
  description: string;
  scope: string; // 'group' | 'session:<id>'
  triggers: string[];
  size: number;
  modified: string;
}

export interface Workflow extends WorkflowMeta {
  content: string; // full file including frontmatter
  body: string;    // markdown body only
}

export interface UseWorkflowsResult {
  workflows: WorkflowMeta[];
  activeWorkflow: Workflow | null;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  editorContent: string;
  setEditorContent: (v: string) => void;
  selectWorkflow: (filename: string) => Promise<void>;
  saveWorkflow: (filename: string, content: string) => Promise<void>;
  createWorkflow: (filename: string, content: string) => Promise<void>;
  deleteWorkflow: (filename: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Workflows hook — list / CRUD for groups/<group>/workflows/*.md
 * Endpoints: GET/POST /api/workflows, GET/PUT/DELETE /api/workflows/:filename
 */
export function useWorkflows(authenticated: boolean): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<WorkflowMeta[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editorContent, setEditorContent] = useState('');

  const isDirty = Boolean(activeWorkflow && editorContent !== activeWorkflow.content);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      const data = await api.get<WorkflowMeta[]>('/api/workflows');
      setWorkflows(data);
    } catch {
      // ignore
    }
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectWorkflow = useCallback(async (filename: string) => {
    setIsLoading(true);
    try {
      const wf = await api.get<Workflow>(`/api/workflows/${encodeURIComponent(filename)}`);
      setActiveWorkflow(wf);
      setEditorContent(wf.content);
    } catch {
      setActiveWorkflow(null);
      setEditorContent('');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveWorkflow = useCallback(async (filename: string, content: string) => {
    setIsSaving(true);
    try {
      await api.put(`/api/workflows/${encodeURIComponent(filename)}`, { content });
      setActiveWorkflow((prev) => prev ? { ...prev, content } : null);
      await refresh();
    } finally {
      setIsSaving(false);
    }
  }, [refresh]);

  const createWorkflow = useCallback(async (filename: string, content: string) => {
    await api.post('/api/workflows', { filename, content });
    await refresh();
    await selectWorkflow(filename);
  }, [refresh, selectWorkflow]);

  const deleteWorkflow = useCallback(async (filename: string) => {
    await api.delete(`/api/workflows/${encodeURIComponent(filename)}`);
    if (activeWorkflow?.filename === filename) {
      setActiveWorkflow(null);
      setEditorContent('');
    }
    await refresh();
  }, [refresh, activeWorkflow]);

  return {
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
    refresh,
  };
}
