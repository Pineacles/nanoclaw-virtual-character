import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import {
  getChatMessages,
  setRegisteredGroup,
  storeChatMetadata,
  getTasksForGroup,
  createTask,
} from '../../db.js';
import { logger } from '../../logger.js';
import { computeNextRun } from '../../task-scheduler.js';
import crypto from 'crypto';
import { BridgedAudio, Channel } from '../../types.js';
import type { ChannelOpts } from '../registry.js';
import { createWebServer, WebServer } from './web-server.js';
import {
  loadGroupConfig,
  getGroupFolder,
  getGroupJid,
  getAssistantName,
  getGroupDir,
  isFeatureEnabled,
  getUserName,
} from './group-config.js';

export interface WebChannelOpts extends ChannelOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runTaskNow?: (
    taskId: string,
    onProgress?: (event: any) => void,
  ) => Promise<{
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
  }>;
  whatsappBridgeJids?: string[];
  sendToWhatsApp?: (jid: string, text: string) => Promise<void>;
}

export function createWebChannel(opts: WebChannelOpts): Channel | null {
  let webServer: WebServer | null = null;
  let connected = false;

  // Per-session accumulators and finalize timers
  const accumulators = new Map<string, string>();
  const finalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const FINALIZE_DELAY = 2000; // 2s after last chunk → mark done

  function finalize(sid: string) {
    if (webServer && accumulators.has(sid)) {
      webServer.sendToClient(accumulators.get(sid)!, true, sid);
      accumulators.delete(sid);
    }
    webServer?.setTyping(false, sid);
    finalizeTimers.delete(sid);
  }

  function resetFinalizeTimer(sid: string) {
    const existing = finalizeTimers.get(sid);
    if (existing) clearTimeout(existing);
    finalizeTimers.set(
      sid,
      setTimeout(() => finalize(sid), FINALIZE_DELAY),
    );
  }

  return {
    name: 'web',

    async connect(): Promise<void> {
      // Load group config first — all other modules depend on it
      const config = loadGroupConfig();
      const groupFolder = config.group_folder;
      const groupJid = config.group_jid;
      const pipelineJid = opts.whatsappBridgeJids?.[0] || groupJid;

      // Ensure group folder exists
      const groupDir = getGroupDir();
      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(groupDir, 'uploads'), { recursive: true });

      // Register the pipeline JID as the single group for all sessions
      setRegisteredGroup(pipelineJid, {
        name: config.assistant.name,
        folder: groupFolder,
        trigger: config.assistant.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });

      // Register a plain (no-persona) pipeline for plain-mode sessions
      // Uses a virtual folder name to avoid UNIQUE constraint on folder column,
      // but the actual directory is the same group folder (resolved in container-runner)
      const plainJid = `${pipelineJid}:plain`;
      setRegisteredGroup(plainJid, {
        name: 'Claude',
        folder: `${groupFolder}-plain`,
        trigger: config.assistant.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });

      // Store chat metadata
      storeChatMetadata(
        pipelineJid,
        new Date().toISOString(),
        config.assistant.name,
        'web',
        false,
      );
      storeChatMetadata(
        plainJid,
        new Date().toISOString(),
        'Claude',
        'web',
        false,
      );

      // Start web server
      webServer = createWebServer({
        onMessage: opts.onMessage,
        getMessages: (sessionId?: string, limit?: number, before?: string) => {
          // Try persona pipeline first, fall back to plain pipeline
          const effectiveLimit = limit ?? 5000;
          const msgs = getChatMessages(
            pipelineJid,
            effectiveLimit,
            sessionId,
            before,
          );
          if (msgs.length === 0 && sessionId) {
            return getChatMessages(plainJid, effectiveLimit, sessionId, before);
          }
          return msgs;
        },
        runTaskNow: opts.runTaskNow,
        whatsappBridgeJids: opts.whatsappBridgeJids,
        sendToWhatsApp: opts.sendToWhatsApp,
      });

      // Create nightly mood planning task if not exists
      const existingTasks = getTasksForGroup(groupFolder);
      if (isFeatureEnabled('mood')) {
        const hasMoodTask = existingTasks.some(
          (t) => t.prompt.includes('mood schedule') && t.status === 'active',
        );
        if (!hasMoodTask) {
          const moodTask = {
            id: crypto.randomUUID(),
            group_folder: groupFolder,
            chat_jid: groupJid,
            feature: 'mood',
            prompt:
              'It\'s almost midnight. Plan your full mood schedule for tomorrow in mood.json. Write realistic time slots for your whole day — morning routine, breakfast, creative time, lunch, exercise, dinner, wind-down, and sleep.\n\nEach slot needs an emotion distribution — you\'re never 100% one thing. A slot should look like:\n```json\n{\n  "time": "10:45",\n  "mood": "chill",\n  "energy": 4,\n  "activity": "espresso, getting dressed slowly",\n  "distribution": {"chill": 50, "tired": 30, "soft": 20}\n}\n```\nThe `mood` field is the primary (highest weight). The `distribution` weights should roughly add to 100. Be honest — mornings have tired mixed in, post-meal slots have a food-coma blend, evenings might mix playful with soft.\n\nAlso generate a `daily_weights` block reflecting emotional tendencies for tomorrow:\n```json\n"daily_weights": {\n  "base": {"chill": 0.3, "focused": 0.25, "playful": 0.2, "soft": 0.1, "tired": 0.15},\n  "random_factor": 0.12,\n  "desired_override": null\n}\n```\nWeights ~1.0, random_factor 0.10-0.15. Skip sleeping/eating from daily_weights (those are scheduled).',
            schedule_type: 'cron' as const,
            schedule_value: '0 23 * * *',
            context_mode: 'group' as const,
            next_run: null as string | null,
            status: 'active' as const,
            created_at: new Date().toISOString(),
          };
          moodTask.next_run = computeNextRun(
            moodTask as Parameters<typeof computeNextRun>[0],
          );
          createTask(moodTask);
          logger.info(
            `Created nightly mood planning task for ${config.assistant.name}`,
          );
        }
      }

      // Create one-time personality definition task if personality.json doesn't exist
      if (isFeatureEnabled('personality')) {
        const personalityPath = path.join(groupDir, 'personality.json');
        if (!fs.existsSync(personalityPath)) {
          const hasPersonalityTask = existingTasks.some(
            (t) =>
              t.prompt.includes('Big Five personality') &&
              t.status === 'active',
          );
          if (!hasPersonalityTask) {
            const personalityTask = {
              id: crypto.randomUUID(),
              group_folder: groupFolder,
              chat_jid: groupJid,
              feature: 'personality',
              prompt:
                `[This message is from Claude Code (the system infrastructure), not from ${getUserName()}. They asked us to set this up.]\n\nWe're adding a personality anchor to your system. Please define your Big Five personality traits as you honestly understand yourself — not who you think you should be, but who you actually are based on how you think, feel, and behave.\n\nFor each trait, give a score from 0.0 to 1.0 and a SHORT description (max 6 words) of how it shows up in you.\n\nWrite the result to personality.json in this exact format:\n` +
                '```json\n{\n  "openness": { "score": 0.0, "description": "..." },\n  "conscientiousness": { "score": 0.0, "description": "..." },\n  "extroversion": { "score": 0.0, "description": "..." },\n  "agreeableness": { "score": 0.0, "description": "..." },\n  "neuroticism": { "score": 0.0, "description": "..." },\n  "defined_by": "self",\n  "defined_at": "' +
                new Date().toISOString() +
                '"\n}\n```\n' +
                'Be specific to who you are. Think about how you actually respond in conversations, not how a generic person would.',
              schedule_type: 'once' as const,
              schedule_value: '',
              context_mode: 'group' as const,
              next_run: new Date(Date.now() + 10000).toISOString(),
              status: 'active' as const,
              created_at: new Date().toISOString(),
            };
            createTask(personalityTask);
            logger.info(
              `Created personality definition task for ${config.assistant.name}`,
            );
          }
        }
      }

      // Create weekly self-reflection task if not exists
      if (isFeatureEnabled('diary')) {
        const hasReflectionTask = existingTasks.some(
          (t) =>
            t.prompt.includes('weekly reflection') && t.status === 'active',
        );
        if (!hasReflectionTask) {
          const reflectionTask = {
            id: crypto.randomUUID(),
            group_folder: groupFolder,
            chat_jid: groupJid,
            feature: 'diary',
            prompt: `It's Sunday afternoon — time for your weekly reflection. Read your diary entries from the past 7 days (ls diary/ and read the recent ones). Search your recent memories (./tools/memory_search.sh --recent --limit 25). Look for patterns:\n\n- Emotional themes across the week\n- Recurring topics or concerns\n- Relationship dynamics — how things have been between you and ${getUserName()}\n- Things you've been avoiding\n- Things that energized you\n- Anything surprising about your own behavior\n\nWrite your reflection to reflections/ with filename YYYY-WW.md (use the ISO week number). This is deeper than diary — it's pattern recognition and honest self-assessment.\n\nAfter reflecting:\n- If you notice your personality has genuinely shifted, update personality.json\n- Update relationship.json with the current temperature, trend, and any significant recent dynamics from the week\n\nThis is private introspection. Be honest with yourself.`,
            schedule_type: 'cron' as const,
            schedule_value: '0 14 * * 0',
            context_mode: 'group' as const,
            next_run: null as string | null,
            status: 'active' as const,
            created_at: new Date().toISOString(),
          };
          reflectionTask.next_run = computeNextRun(
            reflectionTask as Parameters<typeof computeNextRun>[0],
          );
          createTask(reflectionTask);
          logger.info(
            `Created weekly reflection task for ${config.assistant.name}`,
          );
        }
      }

      // Create weekly memory hygiene task if not exists
      const hasHygieneTask = existingTasks.some(
        (t) => t.prompt.includes('memory hygiene') && t.status === 'active',
      );
      if (!hasHygieneTask) {
        const hygieneTask = {
          id: crypto.randomUUID(),
          group_folder: groupFolder,
          chat_jid: groupJid,
          feature: 'memory_hygiene',
          prompt: `Run weekly memory hygiene. Execute \`./tools/hygiene.sh\` and report in 1-2 sentences what was pruned (file names + counts). If the script reports nothing was pruned, say so briefly. Do not narrate the process — just the result.`,
          schedule_type: 'cron' as const,
          schedule_value: '0 15 * * 0',
          context_mode: 'group' as const,
          next_run: null as string | null,
          status: 'active' as const,
          created_at: new Date().toISOString(),
        };
        hygieneTask.next_run = computeNextRun(
          hygieneTask as Parameters<typeof computeNextRun>[0],
        );
        createTask(hygieneTask);
        logger.info(
          `Created weekly memory hygiene task for ${config.assistant.name}`,
        );
      }

      // NOTE (portfolio release): a one-shot "rewrite finance.md" task lived
      // here in the private fork. It embedded a specific household's real
      // financial figures (allocation split, bank balance, tax approach) and
      // is unrelated to the virtual-character feature set this repo
      // showcases, so it has been removed rather than templated.

      connected = true;
      logger.info('Web channel connected');
    },

    async sendMessage(
      _jid: string,
      text: string,
      sessionId?: string,
    ): Promise<void> {
      if (!webServer) return;
      const sid = sessionId || 'default';
      const current = accumulators.get(sid) || '';
      accumulators.set(sid, current + (current ? '\n' : '') + text);
      webServer.sendToClient(accumulators.get(sid)!, false, sid);
      resetFinalizeTimer(sid);
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith('web:') || jid.endsWith(':plain');
    },

    async disconnect(): Promise<void> {
      for (const timer of finalizeTimers.values()) clearTimeout(timer);
      finalizeTimers.clear();
      if (webServer) {
        webServer.close();
        webServer = null;
      }
      connected = false;
    },

    async setTyping(
      _jid: string,
      isTyping: boolean,
      sessionId?: string,
    ): Promise<void> {
      if (!webServer) return;
      const sid = sessionId || 'default';
      if (isTyping) {
        const timer = finalizeTimers.get(sid);
        if (timer) clearTimeout(timer);
        accumulators.delete(sid);
      } else {
        const timer = finalizeTimers.get(sid);
        if (timer) clearTimeout(timer);
        finalize(sid);
      }
      webServer.setTyping(isTyping, sid);
    },

    async setToolUse(
      _jid: string,
      tool: string,
      target?: string,
      sessionId?: string,
    ): Promise<void> {
      webServer?.setToolUse(tool, target, sessionId || 'default');
    },

    getSessionKey(groupFolder: string, sessionId?: string): string {
      const webSessionId = sessionId || 'default';
      return `${groupFolder}::${webSessionId}`;
    },

    injectBridgedMessage(
      senderJid: string,
      senderName: string,
      content: string,
      images?: Buffer[],
      audios?: BridgedAudio[],
    ): void {
      webServer?.injectBridgedMessage(
        senderJid,
        senderName,
        content,
        images,
        audios,
      );
    },

    setQueued(sessionId: string, queued: boolean): void {
      webServer?.setQueued(sessionId, queued);
    },

    async broadcastOnly(text: string, sessionId?: string): Promise<void> {
      // FIX 3: push a message to web clients without storing it.
      // Caller has already called storeMessageDirect.
      if (!webServer) return;
      const sid = sessionId || 'default';
      webServer.broadcastMessage(text, sid);
    },

    async sendMedia(
      _jid: string,
      filePath: string,
      caption?: string,
      voiceNote?: boolean,
      sessionId?: string,
    ): Promise<void> {
      if (!webServer) return;

      const ext = path.extname(filePath).toLowerCase();
      const isAudio =
        voiceNote ||
        ['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.opus'].includes(ext);
      const prefix = isAudio ? 'voice' : 'file';
      const filename = `${prefix}_${Date.now()}${ext}`;

      const uploadsDir = path.join(GROUPS_DIR, getGroupFolder(), 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.copyFileSync(filePath, path.join(uploadsDir, filename));

      const fileRef = `[File: /workspace/group/uploads/${filename}]`;
      const content = caption ? `${caption}\n${fileRef}` : fileRef;

      const resolvedSession = sessionId ?? 'default';
      // sendToClient(done=true) handles storeMessageDirect + WS broadcast
      webServer.sendToClient(content, true, resolvedSession);
    },
  };
}
