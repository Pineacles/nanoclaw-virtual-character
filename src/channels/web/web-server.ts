import http from 'http';
import { spawnEnv } from '../../spawn-path.js';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  storeMessage,
  storeMessageDirect,
  touchWebSession,
  getWebSessions,
  getWebSessionById,
  createWebSession,
  getBotMessageCount,
  updateWebSession,
  getChatMessages,
  queryChatMessages,
  getLastBotMessageTimestamp,
} from '../../db.js';
import {
  saveMemory,
  searchMemories,
  getMemoryById,
  getRecentMemories,
  consolidateMemories,
  getMemoryStats,
} from '../../memory-db.js';
import { resolveMood, applyMoodTag, stripMoodTags } from './mood.js';
import { resolveInternalToken } from '../../internal-auth.js';
import { verifyAuth } from './auth.js';
import { handleApiRoute, ApiDeps } from './api-routes.js';
import type { ClientMessage, ServerMessage } from './types.js';
import type { BridgedAudio, OnInboundMessage } from '../../types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

import {
  getGroupFolder,
  getGroupJid,
  getGroupConfig,
  getTimezone,
  getAssistantName,
  getUserName,
  getUserSenderId,
  getGroupDir as getGroupDirPath,
  isFeatureEnabled,
} from './group-config.js';
import { buildPerMessagePrefix, getCurrentMood } from './context-builder.js';
import { matchTriggeredWorkflows } from './workflow-loader.js';
import {
  regenerateEmotionalStateAsync,
  shouldRegenerate as shouldRegenerateEmotionalState,
  noteMessage as noteEmotionalStateMessage,
  RecentMessage,
} from './emotional-state.js';
import { computePresence } from '../../presence/engine.js';
import { markMessagesRead, getReceipts } from './receipts.js';

export interface WebServerOpts {
  onMessage: OnInboundMessage;
  getMessages: (
    sessionId?: string,
    limit?: number,
    before?: string,
  ) => ReturnType<ApiDeps['getMessages']>;
  runTaskNow?: (
    taskId: string,
    onProgress?: (event: import('./api-routes.js').TaskProgressEvent) => void,
  ) => Promise<{
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
  }>;
  whatsappBridgeJids?: string[];
  sendToWhatsApp?: (jid: string, text: string) => Promise<void>;
}

export interface WebServer {
  server: http.Server;
  wss: WebSocketServer;
  sendToClient(text: string, done: boolean, sessionId: string): void;
  /**
   * FIX 3: mirror a message to connected web clients without writing a DB row.
   * Used when the caller already stored the message explicitly (impulse/sched
   * paths) so the web UI still sees it but no duplicate row is created.
   */
  broadcastMessage(text: string, sessionId: string, mood?: string): void;
  injectBridgedMessage(
    senderJid: string,
    senderName: string,
    content: string,
    images?: Buffer[],
    audios?: BridgedAudio[],
  ): Promise<void>;
  setTyping(isTyping: boolean, sessionId: string): void;
  setToolUse(tool: string, target?: string, sessionId?: string): void;
  setQueued(sessionId: string, queued: boolean): void;
  close(): void;
}

async function generateSessionTitle(
  sessionId: string,
  botResponse: string,
  broadcast: (msg: ServerMessage) => void,
  pipelineJid: string,
): Promise<void> {
  try {
    // Get the first user message in this session
    const messages = getChatMessages(pipelineJid, 5, sessionId);
    const firstUserMsg = messages.find((m) => m.is_bot_message === 0);
    if (!firstUserMsg) return;

    const userText = firstUserMsg.content.replace(/^\[System: [^\]]+\]\n/, '');

    const prompt = `Generate a 3-5 word title for this conversation. Return ONLY the title, nothing else. No quotes, no punctuation.\n\nUser: ${userText.slice(0, 300)}\nAssistant: ${botResponse.slice(0, 300)}`;

    const { spawn } = await import('child_process');

    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        'claude',
        ['--print', '--model', 'claude-haiku-4-5-20251001'],
        {
          timeout: 30000,
          env: spawnEnv(),
        },
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`claude exit ${code}: ${err}`));
      });
      proc.on('error', reject);
      proc.stdin.write(prompt);
      proc.stdin.end();
    });

    const title = stdout.trim();
    if (!title || title.length > 60) return;

    updateWebSession(sessionId, title);
    broadcast({ type: 'session_renamed', sessionId, name: title });
  } catch (err) {
    logger.error({ err }, 'Failed to generate session title');
  }
}

const WHATSAPP_SESSION_ID = 'whatsapp';

function internalJson(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readInternalBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function handleInternalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  callerGroup: string,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method || 'GET';

  // Callers are bound to the group their token was issued for and may not
  // read or write any other group's data.
  const forbidsGroup = (target: string | null): boolean =>
    callerGroup !== (target ?? getGroupFolder());
  const forbidden = (target: string | null): boolean => {
    if (!forbidsGroup(target)) return false;
    logger.warn(
      { path: p, callerGroup, target },
      'Blocked cross-group /internal/ request',
    );
    internalJson(res, { error: 'Forbidden' }, 403);
    return true;
  };

  // --- Chat query ---
  if (p === '/internal/chat-query' && method === 'GET') {
    const groupFolder = url.searchParams.get('group_folder');
    if (!groupFolder)
      return (
        internalJson(res, { error: 'group_folder is required' }, 400),
        true
      );

    if (forbidden(groupFolder)) return true;

    const rows = queryChatMessages({
      groupFolder,
      limit: parseInt(url.searchParams.get('limit') || '20', 10),
      source: url.searchParams.get('source') || 'all',
      since: url.searchParams.get('since') || undefined,
      sender: url.searchParams.get('sender') || undefined,
    });
    return (internalJson(res, rows), true);
  }

  // --- Memory save ---
  if (p === '/internal/memory-save' && method === 'POST') {
    const body = JSON.parse(await readInternalBody(req));
    if (!body.group_folder || !body.content) {
      return (
        internalJson(
          res,
          { error: 'group_folder and content are required' },
          400,
        ),
        true
      );
    }
    if (forbidden(body.group_folder)) return true;
    const result = saveMemory({
      group_folder: body.group_folder,
      content: body.content,
      category: body.category,
      importance: body.importance,
      tags: body.tags,
      source: body.source,
      confidence: body.confidence,
      valence: body.valence,
    });
    return (internalJson(res, result), true);
  }

  // --- Memory search ---
  if (p === '/internal/memory-search' && method === 'GET') {
    const groupFolder = url.searchParams.get('group_folder');
    const query = url.searchParams.get('q');
    if (!groupFolder || !query) {
      return (
        internalJson(res, { error: 'group_folder and q are required' }, 400),
        true
      );
    }
    if (forbidden(groupFolder)) return true;
    const results = searchMemories({
      group_folder: groupFolder,
      query,
      category: url.searchParams.get('category') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '10', 10),
      valence_min: url.searchParams.has('valence_min')
        ? parseFloat(url.searchParams.get('valence_min')!)
        : undefined,
      valence_max: url.searchParams.has('valence_max')
        ? parseFloat(url.searchParams.get('valence_max')!)
        : undefined,
    });
    return (internalJson(res, results), true);
  }

  // --- Memory get by ID ---
  if (p === '/internal/memory-get' && method === 'GET') {
    const groupFolder = url.searchParams.get('group_folder');
    const id = url.searchParams.get('id');
    if (!groupFolder || !id) {
      return (
        internalJson(res, { error: 'group_folder and id are required' }, 400),
        true
      );
    }
    if (forbidden(groupFolder)) return true;
    const memory = getMemoryById(groupFolder, id);
    if (!memory) return (internalJson(res, { error: 'Not found' }, 404), true);
    return (internalJson(res, memory), true);
  }

  // --- Recent memories ---
  if (p === '/internal/memory-recent' && method === 'GET') {
    const groupFolder = url.searchParams.get('group_folder');
    if (!groupFolder) {
      return (
        internalJson(res, { error: 'group_folder is required' }, 400),
        true
      );
    }
    if (forbidden(groupFolder)) return true;
    const memories = getRecentMemories({
      group_folder: groupFolder,
      limit: parseInt(url.searchParams.get('limit') || '20', 10),
      since: url.searchParams.get('since') || undefined,
    });
    return (internalJson(res, memories), true);
  }

  // --- Memory stats ---
  if (p === '/internal/memory-stats' && method === 'GET') {
    const groupFolder = url.searchParams.get('group_folder');
    if (!groupFolder) {
      return (
        internalJson(res, { error: 'group_folder is required' }, 400),
        true
      );
    }
    if (forbidden(groupFolder)) return true;
    return (internalJson(res, getMemoryStats(groupFolder)), true);
  }

  // --- Memory consolidation ---
  if (p === '/internal/memory-consolidate' && method === 'POST') {
    const body = JSON.parse(await readInternalBody(req));
    if (!body.group_folder) {
      return (
        internalJson(res, { error: 'group_folder is required' }, 400),
        true
      );
    }
    if (forbidden(body.group_folder)) return true;
    const count = consolidateMemories(body.group_folder, {
      olderThanDays: body.older_than_days,
      maxAccessCount: body.max_access_count,
      maxImportance: body.max_importance,
    });
    return (internalJson(res, { archived: count }), true);
  }

  // --- Context files (agent can read/write context/*.md) ---
  // These operate on the instance group, so the caller's token must match it.
  if (p.startsWith('/internal/context-') && forbidden(null)) return true;

  if (p === '/internal/context-list' && method === 'GET') {
    const { listContextFiles: listCtx } = await import('./context-loader.js');
    return (internalJson(res, listCtx()), true);
  }

  if (p === '/internal/context-read' && method === 'GET') {
    const filename = url.searchParams.get('filename');
    if (!filename)
      return (internalJson(res, { error: 'filename required' }, 400), true);
    const { readContextFile: readCtx } = await import('./context-loader.js');
    const content = readCtx(filename);
    if (content === null)
      return (internalJson(res, { error: 'Not found' }, 404), true);
    return (internalJson(res, { filename, content }), true);
  }

  if (p === '/internal/context-write' && method === 'POST') {
    const body = JSON.parse(await readInternalBody(req));
    if (!body.filename || body.content === undefined) {
      return (
        internalJson(res, { error: 'filename and content required' }, 400),
        true
      );
    }
    const { writeContextFile: writeCtx } = await import('./context-loader.js');
    if (!writeCtx(body.filename, body.content)) {
      return (
        internalJson(res, { error: 'Invalid filename (must end in .md)' }, 400),
        true
      );
    }
    return (internalJson(res, { ok: true }), true);
  }

  if (p === '/internal/context-delete' && method === 'POST') {
    const body = JSON.parse(await readInternalBody(req));
    if (!body.filename)
      return (internalJson(res, { error: 'filename required' }, 400), true);
    const { deleteContextFile: deleteCtx } =
      await import('./context-loader.js');
    if (!deleteCtx(body.filename))
      return (internalJson(res, { error: 'Not found' }, 404), true);
    return (internalJson(res, { ok: true }), true);
  }

  return false;
}

export function createWebServer(opts: WebServerOpts): WebServer {
  const env = readEnvFile(['WEB_PORT']);
  const port = parseInt(env.WEB_PORT || '3003', 10);

  // Ensure permanent WhatsApp sessions exist.
  // If multiple bridge JIDs are configured, sessions are created per-number
  // (auto-created in injectBridgedMessage). If only the legacy single JID is
  // present (backward compat), create the single 'whatsapp' session upfront.
  if (opts.whatsappBridgeJids && opts.whatsappBridgeJids.length === 1) {
    const existing = getWebSessionById(WHATSAPP_SESSION_ID);
    if (!existing) {
      createWebSession(WHATSAPP_SESSION_ID, 'WhatsApp');
    }
  }

  // Static file serving - look for built frontend
  const staticDir = path.resolve(process.cwd(), 'web-ui', 'dist');

  const server = http.createServer(async (req, res) => {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );

    // Internal API — every caller must present the per-spawn token issued by
    // container-runner, which binds it to its own group. No source-IP trust:
    // a reverse proxy (cloudflared runs with host networking) makes internet
    // requests arrive from loopback, and the bridge network is shared by
    // containers of OTHER NanoClaw instances. The token is the only signal
    // that the caller is a container this instance spawned, and it scopes
    // the caller to its own group's data.
    if (url.pathname.startsWith('/internal/')) {
      const sourceIp = req.socket.remoteAddress || '';
      const token = req.headers['x-internal-token'];
      const callerGroup = resolveInternalToken(
        typeof token === 'string' ? token : null,
      );
      if (!callerGroup) {
        logger.warn(
          { path: url.pathname, sourceIp },
          'Rejected /internal/ request without valid token',
        );
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const handled = await handleInternalRoute(req, res, url, callerGroup);
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // CORS for API routes
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!verifyAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const handled = await handleApiRoute(req, res, url, {
        getMessages: opts.getMessages,
        runTaskNow: opts.runTaskNow,
        broadcast: (msg: unknown) => broadcast(msg as ServerMessage),
      });
      if (handled) return;

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Serve uploaded files — /uploads/<filename>
    if (url.pathname.startsWith('/uploads/')) {
      if (!verifyAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const filename = path.basename(url.pathname.slice('/uploads/'.length));
      if (!filename || filename.includes('..')) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      const filePath = path.resolve(
        process.cwd(),
        'groups',
        getGroupFolder(),
        'uploads',
        filename,
      );
      if (
        !filePath.startsWith(
          path.resolve(process.cwd(), 'groups', getGroupFolder(), 'uploads'),
        ) ||
        !fs.existsSync(filePath)
      ) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filename).toLowerCase();
      const UPLOAD_MIME: Record<string, string> = {
        ...MIME_TYPES,
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.zip': 'application/zip',
        '.doc': 'application/msword',
        '.docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
      const contentType = UPLOAD_MIME[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(content);
      return;
    }

    // Static file serving
    serveStatic(res, url.pathname, staticDir);
  });

  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade with auth
  server.on('upgrade', (req, socket, head) => {
    if (!verifyAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Proxy /voice-ws to the Python voice server on port 3004
    // Uses raw TCP proxy — forward the upgrade request directly
    if (url.pathname === '/voice-ws') {
      // Check if voice call feature is enabled
      if (!isFeatureEnabled('voice_call')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const targetSocket = net.createConnection(
        { host: '127.0.0.1', port: 3004 },
        () => {
          // Reconstruct the HTTP upgrade request for the target
          const reqUrl = req.url || '/';
          let rawReq = `GET ${reqUrl} HTTP/1.1\r\n`;
          // Forward key headers
          const forwardHeaders = [
            'host',
            'upgrade',
            'connection',
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-extensions',
            'sec-websocket-protocol',
          ];
          for (const h of forwardHeaders) {
            const val = req.headers[h];
            if (val) rawReq += `${h}: ${val}\r\n`;
          }
          rawReq += '\r\n';
          targetSocket.write(rawReq);
          if (head.length > 0) targetSocket.write(head);

          // Pipe bidirectionally
          socket.pipe(targetSocket);
          targetSocket.pipe(socket);
        },
      );

      targetSocket.on('error', () => {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      });
      socket.on('error', () => targetSocket.destroy());
      socket.on('close', () => targetSocket.destroy());
      targetSocket.on('close', () => socket.destroy());
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Track active connections
  const clients = new Set<WebSocket>();

  // Presence tracking — updated whenever the bot sends a message or starts typing
  let lastOutboundAt: number | null = null;
  let isCurrentlyTyping = false;

  // Per-session streaming message state
  const sessionMessageIds = new Map<string, string>();

  // Per-session live state — survives client reconnects
  interface SessionState {
    typing: boolean;
    tool: { tool: string; target?: string } | null;
    messageId: string | null;
    content: string | null;
    queued: boolean;
  }
  const sessionStates = new Map<string, SessionState>();

  function getSessionState(sid: string): SessionState {
    let state = sessionStates.get(sid);
    if (!state) {
      state = {
        typing: false,
        tool: null,
        messageId: null,
        content: null,
        queued: false,
      };
      sessionStates.set(sid, state);
    }
    return state;
  }

  function sendSessionState(ws: WebSocket, sid: string): void {
    const state = getSessionState(sid);
    send(ws, {
      type: 'session_state',
      sessionId: sid,
      typing: state.typing,
      tool: state.tool,
      messageId: state.messageId,
      content: state.content,
      queued: state.queued,
    });
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, { type: 'connected' });
    if (isFeatureEnabled('presence_indicator')) {
      send(ws, buildPresenceMsg());
    }
    logger.info('Web UI client connected');

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          send(ws, { type: 'pong' });
          return;
        }

        if (msg.type === 'get_session_state') {
          sendSessionState(ws, msg.sessionId);
          return;
        }

        if (msg.type === 'chat') {
          let content = msg.content;

          // Handle images: save base64 data and append path references
          if (msg.images && msg.images.length > 0) {
            const uploadsDir = path.resolve(
              process.cwd(),
              'groups',
              getGroupFolder(),
              'uploads',
            );
            fs.mkdirSync(uploadsDir, { recursive: true });

            for (const dataUri of msg.images) {
              const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
              if (!matches) continue;
              const ext = matches[1].split('/')[1] || 'png';
              const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
              const buffer = Buffer.from(matches[2], 'base64');
              fs.writeFileSync(path.join(uploadsDir, filename), buffer);
              content += `\n[Image: /workspace/group/uploads/${filename}]`;
            }
          }

          // Handle generic file attachments
          if (msg.files && msg.files.length > 0) {
            const uploadsDir = path.resolve(
              process.cwd(),
              'groups',
              getGroupFolder(),
              'uploads',
            );
            fs.mkdirSync(uploadsDir, { recursive: true });

            for (const file of msg.files) {
              const matches = file.data.match(/^data:([^;]+);base64,(.+)$/);
              if (!matches) continue;
              const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
              const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeName}`;
              const buffer = Buffer.from(matches[2], 'base64');
              fs.writeFileSync(path.join(uploadsDir, filename), buffer);
              content += `\n[File: /workspace/group/uploads/${filename}]`;
            }
          }

          const messageId = crypto.randomUUID();
          const timestamp = new Date().toISOString();

          const sessionId = msg.sessionId || 'default';

          // Check session mode to determine pipeline
          const webSession = getWebSessionById(sessionId);
          const isPlainSession = webSession?.mode === 'plain';

          const basePipelineJid =
            (opts.whatsappBridgeJids && opts.whatsappBridgeJids[0]) ||
            getGroupJid();
          const pipelineJid = isPlainSession
            ? `${basePipelineJid}:plain`
            : basePipelineJid;

          // Build context from group config, mood, memory, and context/*.md files
          const mood = getCurrentMood();
          const perMessagePrefix = buildPerMessagePrefix({
            sessionId,
            source: 'web',
            messageHint: content.slice(0, 200),
            userMessage: content,
            groupFolder: getGroupFolder(),
            chatJid: pipelineJid,
          });
          const agentContent = isPlainSession
            ? `[System: Current time is ${new Date().toLocaleString('en-GB', { timeZone: getTimezone(), weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}. Chat session: ${sessionId}.]\n${content}`
            : `${perMessagePrefix}\n${content}`;

          // Touch session updated_at
          touchWebSession(sessionId);

          // Store under the pipeline JID so messages are found by the message loop
          // (pipelineJid is computed above, before buildPerMessagePrefix, so ToM can query prior messages)
          storeMessage({
            id: messageId,
            chat_jid: pipelineJid,
            sender: getUserSenderId(),
            sender_name: getUserName(),
            content: agentContent,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
            session_id: sessionId,
            mood: mood.current_mood,
          });

          // Broadcast user message to all clients so other tabs/windows see it
          broadcast({
            type: 'new_user_message',
            id: messageId,
            sender_name: getUserName(),
            content,
            timestamp,
            sessionId,
          });

          // Check if another session is busy — if so, mark this one as queued
          for (const [sid, state] of sessionStates) {
            if (sid !== sessionId && state.typing) {
              const myState = getSessionState(sessionId);
              myState.queued = true;
              send(ws, {
                type: 'session_state',
                sessionId,
                typing: false,
                tool: null,
                messageId: null,
                content: null,
                queued: true,
              });
              break;
            }
          }

          // Compute triggered workflows from RAW user content (before prefix).
          // Web sessions are not plain — plain mode skips workflows entirely.
          const triggeredWorkflows = isPlainSession
            ? []
            : matchTriggeredWorkflows(content, sessionId).map(
                (w) => w.filename,
              );

          // Deliver to NanoClaw pipeline
          opts.onMessage(pipelineJid, {
            id: messageId,
            chat_jid: pipelineJid,
            sender: getUserSenderId(),
            sender_name: getUserName(),
            content: agentContent,
            timestamp,
            mood: mood.current_mood,
            session_id: sessionId,
            triggered_workflows:
              triggeredWorkflows.length > 0 ? triggeredWorkflows : undefined,
          });
        }
      } catch (err) {
        logger.error({ err }, 'Error processing WebSocket message');
        send(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info('Web UI client disconnected');
    });
  });

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: ServerMessage): void {
    for (const ws of clients) {
      send(ws, msg);
    }
  }

  function buildPresenceMsg(): ServerMessage & {
    type: 'presence';
  } {
    // Schedule-presence must never contradict her actual visible activity:
    // if she demonstrably sent something (this process or, after a restart,
    // per the DB), that is her real "last seen" floor.
    let lastReal = lastOutboundAt;
    try {
      // Her activity spans the web chat AND the WhatsApp bridge chat —
      // whichever she used last counts.
      const jids = [getGroupJid(), ...(opts.whatsappBridgeJids ?? [])];
      for (const jid of jids) {
        const dbTs = getLastBotMessageTimestamp(jid, getAssistantName());
        if (!dbTs) continue;
        const t = new Date(dbTs).getTime();
        if (!Number.isNaN(t) && (!lastReal || t > lastReal)) lastReal = t;
      }
    } catch {
      /* presence stays schedule-only */
    }
    const presence = computePresence(getGroupFolder(), {
      recentActivityAt: lastReal,
    });
    const state = isCurrentlyTyping ? 'online' : presence.state;
    let lastSeenAt =
      state === 'online' ? new Date().toISOString() : presence.lastSeenAt;
    if (lastReal && lastSeenAt && new Date(lastSeenAt).getTime() < lastReal) {
      lastSeenAt = new Date(lastReal).toISOString();
    }
    return { type: 'presence', state, lastSeenAt };
  }

  server.listen(port, () => {
    logger.info({ port }, 'Web UI server listening');
  });

  // Periodic presence broadcast every 45s (unref so it doesn't keep the process alive)
  if (isFeatureEnabled('presence_indicator')) {
    const presenceInterval = setInterval(() => {
      broadcast(buildPresenceMsg());
    }, 45_000);
    presenceInterval.unref();
  }

  const pipelineJid =
    (opts.whatsappBridgeJids && opts.whatsappBridgeJids[0]) || getGroupJid();

  return {
    server,
    wss,
    sendToClient(text: string, done: boolean, sessionId: string) {
      let messageId = sessionMessageIds.get(sessionId);
      if (!messageId) {
        messageId = crypto.randomUUID();
        sessionMessageIds.set(sessionId, messageId);
      }

      // Always strip mood tags from displayed text so they never flash during streaming
      const displayText = stripMoodTags(text);

      // Update persistent session state
      const state = getSessionState(sessionId);
      state.messageId = messageId;
      state.content = displayText;

      if (!done) {
        // Streaming update — no mood yet
        broadcast({
          type: 'message',
          id: messageId,
          content: displayText,
          done: false,
          sessionId,
        });
      } else {
        // Track last outbound time for presence
        lastOutboundAt = Date.now();
        // Apply mood tag to mood.json and push update instantly via WebSocket
        const { cleanText, mood: tagMood } = applyMoodTag(text);
        const moodNow = resolveMood();

        // FIX 2: if cleanText is empty (e.g. a mood-tag-only bubble that
        // FIX 1 should have prevented, but guard defensively), still apply
        // the mood and broadcast the mood update but skip the message broadcast
        // and skip storeMessageDirect — an empty DB row is never useful.
        if (!cleanText.trim()) {
          logger.debug(
            { sessionId },
            'sendToClient: skipping empty cleanText after applyMoodTag',
          );
          broadcast({
            type: 'mood',
            current_mood: moodNow.current_mood,
            energy: moodNow.energy,
            activity: moodNow.activity,
          });
          sessionMessageIds.delete(sessionId);
          state.typing = false;
          state.tool = null;
          state.messageId = null;
          state.content = null;
          state.queued = false;
          return;
        }

        // Send final message with mood so the bubble gets the right color
        broadcast({
          type: 'message',
          id: messageId,
          content: cleanText,
          done: true,
          sessionId,
          mood: tagMood,
        });

        broadcast({
          type: 'mood',
          current_mood: moodNow.current_mood,
          energy: moodNow.energy,
          activity: moodNow.activity,
        });

        storeMessageDirect({
          id: messageId,
          chat_jid: pipelineJid,
          sender: 'bot',
          sender_name: getAssistantName(),
          content: cleanText,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          session_id: sessionId,
          mood: tagMood,
        });

        // Fire-and-forget emotional state regeneration.
        // Reads recent messages from the DB and asks Haiku to capture the
        // emotional undercurrent beneath the assistant's moment-to-moment mood.
        // Throttled: every 3rd response, or after 30min gap, or on mood shift.
        if (isFeatureEnabled('emotional_state')) {
          try {
            const groupFolder = getGroupFolder();
            noteEmotionalStateMessage(groupFolder);

            // moodShifted: did the mood-style cache also regen this turn?
            // We don't have a direct signal, so use a heuristic: if applyMoodTag
            // returned a different primary than the last cached mood, treat as shifted.
            const moodShifted = false; // conservative — let the throttle handle most cases

            if (shouldRegenerateEmotionalState(groupFolder, moodShifted)) {
              // Fetch the last 10 messages from the chat (mix of user + bot)
              // getChatMessages returns oldest-first (ASC after DESC subquery)
              const chatMessages = getChatMessages(
                pipelineJid,
                10,
                sessionId,
              ).map(
                (m): RecentMessage => ({
                  sender_name:
                    m.sender_name ||
                    (m.is_bot_message ? getAssistantName() : getUserName()),
                  content: m.content || '',
                  is_bot_message: m.is_bot_message === 1,
                }),
              );

              regenerateEmotionalStateAsync(
                groupFolder,
                chatMessages,
                tagMood,
                moodNow.energy,
              );
            }
          } catch (err) {
            logger.error({ err }, 'Failed to schedule emotional state regen');
          }
        }

        // Auto-name session after first bot response
        const botCount = getBotMessageCount(pipelineJid, sessionId);
        if (botCount === 1) {
          generateSessionTitle(sessionId, cleanText, broadcast, pipelineJid);
        }

        sessionMessageIds.delete(sessionId);

        // Clear session state — response is done
        state.typing = false;
        state.tool = null;
        state.messageId = null;
        state.content = null;
        state.queued = false;
      }
    },
    broadcastMessage(text: string, sessionId: string, mood?: string) {
      // FIX 3: broadcast a message to web clients without storing it.
      // The caller (impulse/sched paths) already called storeMessageDirect,
      // so we only need to push the message event to connected clients.
      const displayText = stripMoodTags(text);
      if (!displayText.trim()) return;
      const messageId = crypto.randomUUID();
      lastOutboundAt = Date.now();
      broadcast({
        type: 'message',
        id: messageId,
        content: displayText,
        done: true,
        sessionId,
        mood,
      });
      // Also push a fresh mood update so the UI reflects any tag in the text
      const moodNow = resolveMood();
      broadcast({
        type: 'mood',
        current_mood: moodNow.current_mood,
        energy: moodNow.energy,
        activity: moodNow.activity,
      });
    },
    setTyping(isTyping: boolean, sessionId: string) {
      const state = getSessionState(sessionId);
      state.typing = isTyping;
      isCurrentlyTyping = isTyping;
      if (isTyping) {
        lastOutboundAt = Date.now();
      }
      if (isTyping && state.queued) {
        // Session is no longer queued — it's being processed now
        state.queued = false;
        broadcast({
          type: 'session_state',
          sessionId,
          typing: true,
          tool: null,
          messageId: null,
          content: null,
          queued: false,
        });
      }
      if (!isTyping) {
        state.tool = null;
      }
      broadcast({ type: 'typing', isTyping, sessionId });
      // Presence: immediately reflect online when she starts/stops typing
      if (isFeatureEnabled('presence_indicator')) {
        broadcast(buildPresenceMsg());
        // Read receipts: when the bot starts typing it means she read the messages
        if (isTyping) {
          try {
            const folder = getGroupFolder();
            const recentMsgs = getChatMessages(pipelineJid, 50, sessionId);
            const userMsgIds = recentMsgs
              .filter((m) => !m.is_bot_message)
              .map((m) => m.id);
            if (userMsgIds.length > 0) {
              const readAt = new Date().toISOString();
              const newly = markMessagesRead(folder, userMsgIds, readAt);
              if (newly.length > 0) {
                broadcast({ type: 'read_receipt', receipts: newly });
              }
            }
          } catch (err) {
            logger.error({ err }, 'Failed to mark messages read');
          }
        }
      }
    },
    setToolUse(tool: string, target?: string, sessionId?: string) {
      if (sessionId) {
        const state = getSessionState(sessionId);
        state.tool = { tool, target };
      }
      broadcast({ type: 'tool_use', tool, target, sessionId });
    },
    setQueued(sessionId: string, queued: boolean) {
      const state = getSessionState(sessionId);
      state.queued = queued;
      broadcast({
        type: 'session_state',
        sessionId,
        typing: state.typing,
        tool: state.tool,
        messageId: state.messageId,
        content: state.content,
        queued,
      });
    },
    /**
     * Inject a message from WhatsApp into the web UI chat pipeline.
     * Creates a per-number session (e.g. "whatsapp-15551234567") when multiple
     * bridge numbers are configured, or falls back to the legacy single
     * "whatsapp" session for backward compatibility.
     * Stores the message, pushes it to WebSocket clients, and triggers the agent.
     */
    async injectBridgedMessage(
      senderJid: string,
      senderName: string,
      content: string,
      images?: Buffer[],
      audios?: BridgedAudio[],
    ): Promise<void> {
      const messageId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      // Determine session ID: per-number for multi-bridge, legacy for single.
      const phoneNumber = senderJid.split('@')[0];
      const isMultiBridge = (opts.whatsappBridgeJids?.length ?? 0) > 1;
      const sessionId = isMultiBridge
        ? `whatsapp-${phoneNumber}`
        : WHATSAPP_SESSION_ID;

      // Auto-create session for this number if it doesn't exist yet
      if (!getWebSessionById(sessionId)) {
        createWebSession(sessionId, `WhatsApp ${senderName || phoneNumber}`);
      }

      let fullContent = content;

      // Save images to uploads and append references
      if (images && images.length > 0) {
        const uploadsDir = path.resolve(
          process.cwd(),
          'groups',
          getGroupFolder(),
          'uploads',
        );
        fs.mkdirSync(uploadsDir, { recursive: true });
        for (const buf of images) {
          const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.jpg`;
          fs.writeFileSync(path.join(uploadsDir, filename), buf);
          fullContent += `\n[Image: /workspace/group/uploads/${filename}]`;
        }
      }

      // Save voice notes / audio to uploads and append references. The raw
      // decrypted bytes are written untouched (OGG/Opus for ptt); the TTS
      // gateway's /transcribe normalizes to 16kHz-mono WAV for Whisper, so we
      // keep the pristine original here. ptt -> [Voice:], else [Audio:] —
      // both trigger the voice-reply workflow.
      if (audios && audios.length > 0) {
        const uploadsDir = path.resolve(
          process.cwd(),
          'groups',
          getGroupFolder(),
          'uploads',
        );
        fs.mkdirSync(uploadsDir, { recursive: true });
        for (const a of audios) {
          const ext = a.ptt
            ? 'ogg'
            : (a.mimetype || 'audio/ogg').split('/')[1]?.split(';')[0] || 'ogg';
          const filename = `voice_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
          fs.writeFileSync(path.join(uploadsDir, filename), a.data);
          fullContent += `\n[${a.ptt ? 'Voice' : 'Audio'}: /workspace/group/uploads/${filename}]`;
          logger.info(
            { filename, size: a.data.length, ptt: a.ptt },
            'WhatsApp bridge: voice/audio saved',
          );
        }
        // Pre-warm the TTS model now (fire-and-forget) so its ~20s cold load
        // overlaps Whisper STT + the agent composing the reply, instead of
        // stacking on top of them. The gateway is published on the host at :8200.
        const warmUrl =
          process.env.TTS_WARMUP_URL || 'http://127.0.0.1:8200/warmup';
        fetch(warmUrl, { method: 'POST' }).catch((err) =>
          logger.debug(
            { err: String(err) },
            'TTS warmup ping failed (non-fatal)',
          ),
        );
      }

      // Build context from group config, mood, memory, and context/*.md files
      const mood = getCurrentMood();
      const perMessagePrefix = buildPerMessagePrefix({
        sessionId,
        source: 'whatsapp',
        messageHint: fullContent.slice(0, 200),
        userMessage: fullContent,
        groupFolder: getGroupFolder(),
        chatJid: pipelineJid,
      });
      const agentContent = `${perMessagePrefix}\n${fullContent}`;

      touchWebSession(sessionId);

      // Store under pipeline JID so messages are found by the message loop
      storeMessage({
        id: messageId,
        chat_jid: pipelineJid,
        sender: 'whatsapp:user',
        sender_name: senderName,
        content: agentContent,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        session_id: sessionId,
        mood: mood.current_mood,
      });

      // Push to WebSocket so web UI sees it immediately
      broadcast({
        type: 'new_user_message',
        id: messageId,
        sender_name: senderName,
        content: fullContent,
        timestamp,
        sessionId,
      });

      // Check if another session is busy — if so, mark this one as queued
      for (const [sid, state] of sessionStates) {
        if (sid !== sessionId && state.typing) {
          const myState = getSessionState(sessionId);
          myState.queued = true;
          broadcast({
            type: 'session_state',
            sessionId,
            typing: false,
            tool: null,
            messageId: null,
            content: null,
            queued: true,
          });
          break;
        }
      }

      const triggeredWorkflows = matchTriggeredWorkflows(
        fullContent,
        sessionId,
      ).map((w) => w.filename);

      // Trigger agent pipeline using the pipeline JID (which is the registered group)
      opts.onMessage(pipelineJid, {
        id: messageId,
        chat_jid: pipelineJid,
        sender: 'whatsapp:user',
        sender_name: senderName,
        content: agentContent,
        timestamp,
        mood: mood.current_mood,
        session_id: sessionId,
        triggered_workflows:
          triggeredWorkflows.length > 0 ? triggeredWorkflows : undefined,
      });
    },
    close() {
      for (const ws of clients) ws.close();
      wss.close();
      server.close();
    },
  };
}

function serveStatic(
  res: http.ServerResponse,
  pathname: string,
  staticDir: string,
): void {
  // Default to index.html for SPA routing
  let filePath = path.join(
    staticDir,
    pathname === '/' ? 'index.html' : pathname,
  );

  // Security: prevent path traversal
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // If file doesn't exist, serve index.html (SPA fallback)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(staticDir, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found - build the web UI first (npm run build:web)');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
}
