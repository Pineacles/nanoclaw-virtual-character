/**
 * Context loader — reads all .md files from groups/<folder>/context/
 * and concatenates them for injection into agent prompts.
 * Files are sorted alphabetically so users can control order via naming (01-foo.md, 02-bar.md).
 */

import fs from 'fs';
import path from 'path';
import { getGroupDir } from './group-config.js';

interface CachedContext {
  content: string;
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000; // Re-read files every 60 seconds
let cache: CachedContext | null = null;

function loadFromDisk(): string {
  const contextDir = path.join(getGroupDir(), 'context');
  if (!fs.existsSync(contextDir)) return '';

  const files = fs
    .readdirSync(contextDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (files.length === 0) return '';

  const blocks: string[] = [];
  for (const file of files) {
    const content = fs
      .readFileSync(path.join(contextDir, file), 'utf-8')
      .trim();
    if (content) {
      blocks.push(content);
    }
  }

  return blocks.join('\n\n');
}

/** Get concatenated context from all .md files in context/ directory */
export function loadContextFiles(): string {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.content;
  }
  const content = loadFromDisk();
  cache = { content, loadedAt: now };
  return content;
}

/** Force cache refresh (e.g. after API write) */
export function invalidateContextCache(): void {
  cache = null;
}

/** List context files with metadata (for API) */
export function listContextFiles(): Array<{
  filename: string;
  size: number;
  modified: string;
}> {
  const contextDir = path.join(getGroupDir(), 'context');
  if (!fs.existsSync(contextDir)) return [];

  return fs
    .readdirSync(contextDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const stat = fs.statSync(path.join(contextDir, f));
      return {
        filename: f,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });
}

/** Read a specific context file */
export function readContextFile(filename: string): string | null {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return null;
  const filePath = path.join(getGroupDir(), 'context', filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/** Write a context file */
export function writeContextFile(filename: string, content: string): boolean {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return false;
  if (!filename.endsWith('.md')) return false;
  const contextDir = path.join(getGroupDir(), 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, filename), content, 'utf-8');
  invalidateContextCache();
  return true;
}

/** Delete a context file */
export function deleteContextFile(filename: string): boolean {
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  )
    return false;
  const filePath = path.join(getGroupDir(), 'context', filename);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  invalidateContextCache();
  return true;
}
