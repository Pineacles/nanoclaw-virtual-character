/**
 * Workflow loader — reads workflow .md files from groups/<folder>/workflows/
 * Workflows have YAML frontmatter (name, description, scope, triggers) and markdown body.
 * Agent creates workflows by writing files here; frontend can CRUD via API.
 */

import fs from 'fs';
import path from 'path';
import { getGroupDir, getUserName } from './group-config.js';

export interface WorkflowMeta {
  filename: string;
  name: string;
  description: string;
  scope: string; // 'group' or 'session:<id>'
  triggers: string[];
  size: number;
  modified: string;
}

export interface Workflow extends WorkflowMeta {
  content: string; // full file content including frontmatter
  body: string; // just the markdown body (after frontmatter)
}

interface CachedWorkflows {
  data: WorkflowMeta[];
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000; // 30s — workflows may be created by agent mid-conversation
let cache: CachedWorkflows | null = null;

function workflowsDir(): string {
  return path.join(getGroupDir(), 'workflows');
}

/** Parse YAML-ish frontmatter from a workflow file */
function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const raw = match[1];
  const body = match[2];
  const meta: Record<string, unknown> = {};

  let currentKey = '';
  let inArray = false;
  const arrayItems: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Array item
    if (trimmed.startsWith('- ') && inArray) {
      arrayItems.push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
      continue;
    }

    // Flush previous array
    if (inArray && currentKey) {
      meta[currentKey] = [...arrayItems];
      arrayItems.length = 0;
      inArray = false;
    }

    // Key: value
    const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === '' || value === '|') {
        // Could be start of array or multiline
        inArray = true;
        continue;
      }
      meta[currentKey] = value.replace(/^["']|["']$/g, '');
    }
  }

  // Flush trailing array
  if (inArray && currentKey) {
    meta[currentKey] = [...arrayItems];
  }

  return { meta, body };
}

function loadMeta(
  filename: string,
  content: string,
  stat: fs.Stats,
): WorkflowMeta {
  const { meta } = parseFrontmatter(content);
  return {
    filename,
    name: (meta.name as string) || filename.replace('.md', ''),
    description: (meta.description as string) || '',
    scope: (meta.scope as string) || 'group',
    triggers: Array.isArray(meta.triggers) ? (meta.triggers as string[]) : [],
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

/** List all workflows with metadata */
export function listWorkflows(): WorkflowMeta[] {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const dir = workflowsDir();
  if (!fs.existsSync(dir)) {
    cache = { data: [], loadedAt: now };
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const data = files.map((f) => {
    const filePath = path.join(dir, f);
    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    return loadMeta(f, content, stat);
  });

  cache = { data, loadedAt: now };
  return data;
}

/** Read a full workflow including body */
export function readWorkflow(filename: string): Workflow | null {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return null;
  const filePath = path.join(workflowsDir(), filename);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);
  const meta = loadMeta(filename, content, stat);
  const { body } = parseFrontmatter(content);

  return { ...meta, content, body };
}

/** Write/update a workflow file */
export function writeWorkflow(filename: string, content: string): boolean {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return false;
  if (!filename.endsWith('.md')) return false;
  const dir = workflowsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
  invalidateWorkflowCache();
  return true;
}

/** Delete a workflow file */
export function deleteWorkflow(filename: string): boolean {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return false;
  const filePath = path.join(workflowsDir(), filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  invalidateWorkflowCache();
  return true;
}

/** Force cache refresh */
export function invalidateWorkflowCache(): void {
  cache = null;
}

/**
 * Match workflows whose triggers appear (case-insensitive substring) in the user message.
 * Honors scope: only group-scoped + matching session-scoped workflows are considered.
 */
export function matchTriggeredWorkflows(
  userMessage: string,
  sessionId?: string,
): WorkflowMeta[] {
  if (!userMessage) return [];
  const msg = userMessage.toLowerCase();
  return listWorkflows().filter((w) => {
    if (
      w.scope !== 'group' &&
      (!sessionId || w.scope !== `session:${sessionId}`)
    ) {
      return false;
    }
    if (!w.triggers || w.triggers.length === 0) return false;
    return w.triggers.some((t) => t && msg.includes(t.toLowerCase()));
  });
}

/**
 * Build the per-message hard directive that tells the agent it MUST read
 * the matched workflow files before doing anything else. Returns empty string
 * when no workflows are triggered.
 */
export function buildWorkflowDirective(
  userMessage: string,
  sessionId?: string,
): string {
  const matched = matchTriggeredWorkflows(userMessage, sessionId);
  if (matched.length === 0) return '';
  const paths = matched
    .map((w) => `/workspace/group/workflows/${w.filename}`)
    .join(' AND ');
  const names = matched.map((w) => w.name).join(', ');
  return [
    `⚠️ WORKFLOW REQUIRED — your incoming message matched the trigger for: ${names}.`,
    `You MUST call the Read tool on ${paths} BEFORE any other tool use, analysis, or response text. Do not skip this even if you remember the workflow — ${getUserName()} is shown a verdict ('✓ used' or '⚠ skipped') based on whether you actually read the file.`,
  ].join(' ');
}

/**
 * Build a compact summary of all workflows for agent context injection.
 * Only includes name, description, and triggers — not the full body.
 */
export function buildWorkflowSummary(sessionId?: string): string {
  const workflows = listWorkflows();
  if (workflows.length === 0) return '';

  // Filter by scope: include 'group' scope + matching session scope
  const visible = workflows.filter((w) => {
    if (w.scope === 'group') return true;
    if (sessionId && w.scope === `session:${sessionId}`) return true;
    return false;
  });

  if (visible.length === 0) return '';

  const lines = visible.map((w) => {
    const triggers =
      w.triggers.length > 0 ? ` [triggers: ${w.triggers.join(', ')}]` : '';
    return `  - ${w.name}: ${w.description}${triggers} (file: workflows/${w.filename})`;
  });

  const directive = `WORKFLOW PRIORITY — Before you run any command, tool call, or multi-step procedure, scan this list first. If a workflow matches what you're about to do, you MUST read the file with Read on /workspace/group/workflows/<filename> and follow it exactly. Do not improvise commands when a workflow exists — workflows are how ${getUserName()} told you to do these things. Only fall through to your own approach if NO workflow matches.`;
  return `${directive}\n\nAvailable workflows:\n${lines.join('\n')}`;
}
