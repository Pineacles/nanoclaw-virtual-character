import fs from 'fs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// Mock every module api-routes.ts imports so loading it doesn't pull in the
// real DB, scheduler, or filesystem-backed loaders — mirrors the mocking
// style used in mood.test.ts.
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/tmp/test-groups' }));
vi.mock('../../db.js', () => ({
  getTasksForGroup: vi.fn(() => []),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getMessageById: vi.fn(),
  getNextBotMessage: vi.fn(),
  deleteMessage: vi.fn(),
  createWebSession: vi.fn(),
  getWebSessions: vi.fn(() => []),
  updateWebSession: vi.fn(),
  deleteWebSession: vi.fn(),
}));
vi.mock('cron-parser', () => ({ CronExpressionParser: { parse: vi.fn() } }));
vi.mock('../../task-scheduler.js', () => ({ computeNextRun: vi.fn() }));
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./mood.js', () => ({
  resolveMood: vi.fn(() => ({ current_mood: 'chill', energy: 5 })),
}));
vi.mock('./group-config.js', () => ({
  getGroupFolder: vi.fn(() => 'testgroup'),
  getGroupJid: vi.fn(() => 'test@s.whatsapp.net'),
  getGroupDir: vi.fn(() => '/tmp/test-groups/testgroup'),
  getGroupConfig: vi.fn(() => ({ group_folder: 'testgroup', features: {} })),
  reloadGroupConfig: vi.fn(),
  getAssistantName: vi.fn(() => 'Assistant'),
  getUserName: vi.fn(() => 'User'),
  isFeatureEnabled: vi.fn(() => false),
}));
vi.mock('./context-loader.js', () => ({
  listContextFiles: vi.fn(),
  readContextFile: vi.fn(),
  writeContextFile: vi.fn(),
  deleteContextFile: vi.fn(),
}));
vi.mock('./context-builder.js', () => ({
  buildAgentContext: vi.fn(),
  getSessionContext: vi.fn(),
  saveSessionContext: vi.fn(),
  deleteSessionContext: vi.fn(),
}));
vi.mock('./workflow-loader.js', () => ({
  listWorkflows: vi.fn(),
  readWorkflow: vi.fn(),
  writeWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
}));
vi.mock('./receipts.js', () => ({ getReceipts: vi.fn(() => ({})) }));

import { handleApiRoute } from './api-routes.js';

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, method: 'GET' } as unknown as IncomingMessage;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: undefined as Buffer | string | undefined,
    writeHead(status: number, headers?: Record<string, unknown>) {
      res.statusCode = status;
      Object.assign(res.headers, headers);
      return res;
    },
    end(chunk?: Buffer | string) {
      res.body = chunk;
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

describe('GET /api/avatar', () => {
  const url = new URL('http://localhost/api/avatar');
  const deps = { getMessages: vi.fn(() => []) };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no avatar file exists for the group', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const req = makeReq();
    const res = makeRes();

    const handled = await handleApiRoute(req, res, url, deps);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body as string)).toEqual({ error: 'Not found' });
  });

  it('serves avatar.png with an ETag and cache header when present', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith('avatar.png'),
    );
    vi.spyOn(fs, 'statSync').mockReturnValue({
      mtimeMs: 12345,
      size: 42,
    } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-png-bytes'));
    const req = makeReq();
    const res = makeRes();

    const handled = await handleApiRoute(req, res, url, deps);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toBe('private, max-age=300');
    expect(res.headers['ETag']).toBeDefined();
    expect(res.body).toEqual(Buffer.from('fake-png-bytes'));
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith('avatar.png'),
    );
    vi.spyOn(fs, 'statSync').mockReturnValue({
      mtimeMs: 12345,
      size: 42,
    } as fs.Stats);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const etag = `"${(12345).toString(16)}-${(42).toString(16)}"`;

    const req = makeReq({ 'if-none-match': etag });
    const res = makeRes();

    const handled = await handleApiRoute(req, res, url, deps);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(304);
    expect(readSpy).not.toHaveBeenCalled();
  });
});
