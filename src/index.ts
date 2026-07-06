import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
  USER_NAME,
  WHATSAPP_BURST_SETTLE_MS,
} from './config.js';
import { startAmbientCollector } from './ambient/collector.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getSelfInitiatedOutbound,
  getRouterState,
  getWebSessionById,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import {
  runTaskNow,
  startSchedulerLoop,
  SchedulerDependencies,
  parseDecisionOutput,
} from './task-scheduler.js';
import { BridgedAudio, Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { stripMoodTags, extractMoodTag } from './channels/web/mood.js';
import { buildSystemAppend } from './channels/web/context-builder.js';
import {
  loadGroupConfig,
  getAssistantName,
  getGroupFolder,
  isFeatureEnabled,
} from './channels/web/group-config.js';
import { listWorkflows } from './channels/web/workflow-loader.js';
import {
  buildWorkflowVerdictTag,
  injectWorkflowTag,
  formatWorkflowTagInline,
} from './channels/web/workflow-verdict.js';
import {
  getOrCreateRoomRuntime,
  stopAllRoomRuntimes,
  RoomRuntimeDeps,
} from './room/index.js';
import {
  maybeDefer,
  startDeferralLoop,
  clearDeferral,
} from './presence/deferral.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * Split a reply into chat "bubbles" on blank lines, the way a person sends a
 * thought in a few messages instead of one wall of text. Capped; overflow
 * merges into the last bubble. Only used when the messaging_realism feature
 * is on, never for task assistants.
 */
function splitBubbles(text: string, max = 4): string[] {
  const parts = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [text];
  if (parts.length > max) {
    const head = parts.slice(0, max - 1);
    head.push(parts.slice(max - 1).join('\n\n'));
    return head;
  }
  return parts;
}

/** Human-ish pause before a bubble lands: a beat to "type" it, bounded. */
function bubbleDelayMs(text: string): number {
  return 500 + Math.min(2200, text.length * 28);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let whatsAppBridgeJid: string | null = null;
let messageLoopRunning = false;

// Bridge: web-server.ts attaches triggered_workflows to incoming NewMessage,
// but storeMessage drops the field on its way to the DB. Hold the value here
// keyed by message id so processGroupMessages can recover it after the polling
// roundtrip. Entries are deleted on consume; a TTL sweep handles abandoned
// entries (e.g. messages dropped by the allowlist).
const messageTriggers = new Map<
  string,
  { workflows: string[]; addedAt: number }
>();
const MESSAGE_TRIGGERS_TTL_MS = 5 * 60 * 1000;
function sweepMessageTriggers(): void {
  const now = Date.now();
  for (const [id, entry] of messageTriggers) {
    if (now - entry.addedAt > MESSAGE_TRIGGERS_TTL_MS)
      messageTriggers.delete(id);
  }
}

const channels: Channel[] = [];
const queue = new GroupQueue();

/**
 * Per-group debounce timers for WhatsApp message bursts.
 * When a multi-image upload arrives as N separate messages, we wait
 * WHATSAPP_BURST_SETTLE_MS of quiet before firing the agent so the agent
 * sees the full batch instead of replying to the first message.
 */
const settleTimers = new Map<string, NodeJS.Timeout>();

function isWhatsAppJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us');
}

// Messages that read as urgent/important never wait on presence — she'd
// answer those from half-asleep. Bilingual (he writes DE + EN).
const URGENT_RE =
  /\b(urgent|emergency|important|asap|help me|wake up|dringend|wichtig|notfall|hilf mir|hilfe|wach auf|aufwachen)\b/i;

function scheduleAgentInvocation(chatJid: string, latestText?: string): void {
  const group = registeredGroups[chatJid];
  if (group) {
    const urgent = latestText ? URGENT_RE.test(latestText) : false;
    // Engaged-conversation guard: if she replied in this chat within the
    // last 10 minutes she's clearly in the conversation — never defer
    // mid-exchange, whatever the schedule says. People don't vanish between
    // two messages of an active back-and-forth.
    const lastBotTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
    const engaged =
      lastBotTs && Date.now() - new Date(lastBotTs).getTime() < 10 * 60 * 1000;
    if (urgent) {
      // Burst through any pending deferral too — the earlier messages get
      // picked up with this one (cursor-based).
      clearDeferral(chatJid);
    } else if (!engaged) {
      const deferUntil = maybeDefer(chatJid, group.folder);
      if (deferUntil) {
        logger.debug(
          { chatJid, deferUntil: new Date(deferUntil).toISOString() },
          'Reply deferred (presence)',
        );
        return;
      }
    }
  }
  const settleMs = isWhatsAppJid(chatJid) ? WHATSAPP_BURST_SETTLE_MS : 0;
  if (settleMs <= 0) {
    queue.enqueueMessageCheck(chatJid);
    return;
  }
  // Reset existing timer — new message arrived, restart the quiet window
  const existing = settleTimers.get(chatJid);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    settleTimers.delete(chatJid);
    queue.enqueueMessageCheck(chatJid);
  }, settleMs);
  settleTimers.set(chatJid, t);
}

// Populated early in start() — module-scope so spawnImpulse can read it.
let WHATSAPP_BRIDGE_JIDS: string[] = [];

// Resolve WhatsApp session ID consistently with injectBridgedMessage in web-server.ts.
// Single-bridge / legacy → 'whatsapp'; multi-bridge → 'whatsapp-{phoneNumber}'.
function resolveWhatsAppSessionId(whatsappJid: string): string {
  const phoneNumber = whatsappJid.split('@')[0];
  const isMultiBridge = WHATSAPP_BRIDGE_JIDS.length > 1;
  return isMultiBridge ? `whatsapp-${phoneNumber}` : 'whatsapp';
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  clearDeferral(chatJid);

  const isMainGroup = group.isMain === true;

  const allMissedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (allMissedMessages.length === 0) return true;

  // Group messages by session — process one session at a time so responses
  // go to the right place and don't interleave across sessions.
  const sessionGroups = new Map<string, typeof allMissedMessages>();
  for (const msg of allMissedMessages) {
    const sid = msg.session_id || 'default';
    const existing = sessionGroups.get(sid);
    if (existing) existing.push(msg);
    else sessionGroups.set(sid, [msg]);
  }

  // Pick the first session (earliest message) to process now.
  // Advance cursor only past THIS session's messages so the rest
  // get picked up in the next poll cycle.
  const [sessionId, missedMessages] = sessionGroups.entries().next().value as [
    string,
    typeof allMissedMessages,
  ];

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      // Advance cursor past this session's messages so we don't re-check them
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      // Re-enqueue if other sessions have messages
      if (sessionGroups.size > 1) queue.enqueueMessageCheck(chatJid);
      return true;
    }
  }

  // Advance cursor past this session's messages only.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const lastTimestamp = missedMessages[missedMessages.length - 1].timestamp;

  // Self-initiated outbound (cron / impulse) bypasses the SDK session, so the
  // agent has no record of what it sent when it later resumes. Pull any such
  // messages from this chat+session in the window since the last agent turn
  // and interleave them so reply context isn't lost. Without this, a cron-sent
  // "did you see the meteor shower?" + a brief user reply leaves the agent
  // asking "what meteor shower?".
  const outboundInWindow = getSelfInitiatedOutbound(
    chatJid,
    sessionId === 'default' ? null : sessionId,
    previousCursor,
    lastTimestamp,
  );
  const merged = [...outboundInWindow, ...missedMessages].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const prompt = formatMessages(merged, TIMEZONE);

  lastAgentTimestamp[chatJid] = lastTimestamp;
  saveState();

  logger.info(
    { group: group.name, sessionId, messageCount: missedMessages.length },
    'Processing messages',
  );

  const webChannel = channels.find((c) => c.name === 'web');
  const waChannel = channels.find((c) => c.name === 'whatsapp');
  const isWhatsAppSession =
    sessionId === 'whatsapp' || (sessionId?.startsWith('whatsapp-') ?? false);

  // If other sessions have pending messages, mark them as queued and re-enqueue
  if (sessionGroups.size > 1) {
    for (const [sid] of sessionGroups) {
      if (sid !== sessionId) {
        webChannel?.setQueued?.(sid, true);
      }
    }
    queue.enqueueMessageCheck(chatJid);
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Always set typing on web channel (all sessions go through the web UI)
  await webChannel?.setTyping?.(chatJid, true, sessionId);
  // Also set typing on WhatsApp for WhatsApp-originated sessions
  if (isWhatsAppSession) await waChannel?.setTyping?.(chatJid, true);
  // Feature 2: mark buffered inbound messages as read right when the agent
  // starts processing — blue ticks appear only when she "comes back" to reply.
  if (isWhatsAppSession)
    waChannel?.markRead?.(chatJid).catch(() => {
      /* ignore */
    });

  let hadError = false;
  let outputSentToUser = false;

  // Workflow accountability — figure out which workflows the user message
  // was supposed to trigger, then track which ones the agent actually Read
  // during this turn. After the final result text we'll append a *[wf:...]*
  // tag so the user can see ✓ used or ⚠ skipped in the UI / WhatsApp.
  const expectedWorkflows = new Set<string>();
  for (const m of missedMessages) {
    const cached = messageTriggers.get(m.id);
    if (cached) {
      for (const fn of cached.workflows) expectedWorkflows.add(fn);
      messageTriggers.delete(m.id);
    }
  }
  // Build a lookup of every known workflow filename so we recognize Reads even
  // if the user message didn't trigger them (handy for the "agent volunteered"
  // case — counted in `used`, never in `skipped`).
  const knownWorkflowFilenames = new Set(
    listWorkflows().map((w) => w.filename),
  );
  const readWorkflowFilenames = new Set<string>();

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Tool use events — forward to web channel for real-time status
      if (result.toolUse) {
        logger.debug(
          { tool: result.toolUse.tool, target: result.toolUse.target },
          'Forwarding tool use to channel',
        );
        // Track Read calls on workflow files for the verdict.
        if (
          result.toolUse.tool === 'Read' &&
          result.toolUse.target &&
          knownWorkflowFilenames.has(result.toolUse.target)
        ) {
          readWorkflowFilenames.add(result.toolUse.target);
        }
        await webChannel?.setToolUse?.(
          chatJid,
          result.toolUse.tool,
          result.toolUse.target,
          sessionId,
        );
      }

      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        let text = stripInternalTags(raw);

        // Suppress raw API errors from reaching the user and mark as error for retry
        if (
          /overloaded_error|"type"\s*:\s*"error"|API Error|rate_limit_error|server_error/.test(
            text,
          )
        ) {
          logger.warn(
            { group: group.name, raw: text.slice(0, 300) },
            'Suppressed API error from user output',
          );
          text = '';
          hadError = true;
        }

        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          // Compute and inject the workflow verdict tag before sending.
          // - used: workflow files that were Read this turn AND the message
          //   triggered them (✓ confirmed) OR Read voluntarily (✓ as bonus).
          // - skipped: triggered workflows that were never Read (⚠ accountability).
          const used: string[] = [];
          const skipped: string[] = [];
          for (const fn of expectedWorkflows) {
            if (readWorkflowFilenames.has(fn)) used.push(fn);
            else skipped.push(fn);
          }
          for (const fn of readWorkflowFilenames) {
            if (!expectedWorkflows.has(fn)) used.push(fn);
          }
          const wfTag = buildWorkflowVerdictTag({ used, skipped });
          const textWithTag = wfTag ? injectWorkflowTag(text, wfTag) : text;

          // Compute WhatsApp target + text once (used by both delivery paths).
          const waJid =
            isWhatsAppSession && waChannel
              ? sessionId?.startsWith('whatsapp-')
                ? `${sessionId.slice('whatsapp-'.length)}@s.whatsapp.net`
                : whatsAppBridgeJid
              : undefined;
          const waText = (t: string): string => {
            const moodStripped = stripMoodTags(t);
            return wfTag ? formatWorkflowTagInline(moodStripped) : moodStripped;
          };

          // Messaging realism (opt-in per group): deliver as a few paced bubbles
          // with a typing beat between, the way someone actually texts. Any
          // other group sends the reply as one message, unchanged.
          //
          // FIX 1: strip the mood tag from the text BEFORE splitting so the tag
          // never becomes its own bubble (which stores as empty and corrupts
          // history). The tag is re-appended to the last bubble so applyMoodTag
          // still fires exactly once in sendToClient's done-branch.
          const strippedForBubbles = stripMoodTags(textWithTag);
          const moodTagSuffix = extractMoodTag(textWithTag);
          const paced =
            isFeatureEnabled('messaging_realism') &&
            splitBubbles(strippedForBubbles).length > 1;

          if (paced) {
            const bubbles = splitBubbles(strippedForBubbles);
            for (let i = 0; i < bubbles.length; i++) {
              if (i > 0) {
                await webChannel?.setTyping?.(chatJid, true, sessionId);
                if (waJid) await waChannel?.setTyping?.(chatJid, true);
                await sleep(bubbleDelayMs(bubbles[i]));
              }
              // Re-attach the mood tag to the last bubble so applyMoodTag fires
              // exactly once in the done-branch; earlier bubbles stay clean.
              const isLast = i === bubbles.length - 1;
              const webBubble =
                isLast && moodTagSuffix
                  ? `${bubbles[i]}\n\n${moodTagSuffix}`
                  : bubbles[i];
              await webChannel?.sendMessage(chatJid, webBubble, sessionId);
              // WhatsApp: skip empty/whitespace-only bubbles (FIX 1 guard)
              if (waJid && bubbles[i].trim()) {
                await waChannel?.sendMessage(waJid, waText(bubbles[i]));
              }
            }
          } else {
            // Always send to web UI (all sessions stream through it)
            await webChannel?.sendMessage(chatJid, textWithTag, sessionId);
            // Also send to WhatsApp for WhatsApp-originated sessions
            if (waJid) await waChannel?.sendMessage(waJid, waText(textWithTag));
          }
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success' && !result.toolUse) {
        queue.notifyIdle(chatJid);
        // Write close sentinel directly to end the container's IPC wait loop.
        // Must happen here (inside the streaming callback) because runAgent
        // won't return until the container exits — writing after would deadlock.
        const ipcDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
        try {
          fs.mkdirSync(ipcDir, { recursive: true });
          fs.writeFileSync(path.join(ipcDir, '_close'), '');
        } catch {
          /* ignore */
        }
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    channel,
    sessionId,
  );

  await webChannel?.setTyping?.(chatJid, false, sessionId);
  if (isWhatsAppSession) await waChannel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  channel?: Channel,
  sessionId?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const webChannel = channels.find((c) => c.name === 'web');
  const sessionKey =
    webChannel?.getSessionKey?.(group.folder, sessionId) ?? group.folder;
  const sdkSessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    // Check session mode — plain sessions skip identity/persona
    const webSession = getWebSessionById(sessionId || 'default');
    const isPlainMode = webSession?.mode === 'plain';

    // Compute systemAppend for the web channel (heavy persona/state context),
    // unless this is a plain-mode session which skips identity entirely.
    let systemInstruction: string | undefined;
    if (channel?.name === 'web' && !isPlainMode) {
      try {
        systemInstruction = buildSystemAppend({
          sessionId: sessionId || 'default',
          groupFolder: group.folder,
          chatJid,
        });
      } catch (err) {
        logger.warn(
          { err, group: group.name },
          'Failed to build systemAppend, continuing without it',
        );
      }
    }

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: sdkSessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        skipIdentity: isPlainMode,
        systemInstruction,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

function outboundPromptTemplate(userName: string): string {
  return `[Internal impulse from the room — a draft that has matured and wants to come out.]

Intent body (candidate for sending):
{intentBody}

## Your choice

A. Send it. Render in your current voice, mood, and shape. <ACTION>reach_out</ACTION> + <MESSAGE>...</MESSAGE>
B. Soften/recast. Rewrite in your voice before sending. Same action tag.
C. Refuse. The room drift will learn. <ACTION>stay_silent</ACTION> + <REASON>...</REASON>
D. Voice, rarely. If the moment genuinely calls for your literal voice instead of text (an emotional peak, something text would flatten), follow workflows/voice-reply.md to synthesize a voice note and send it yourself via the file IPC message ({"type":"file","chatJid":...,"filePath":...,"voiceNote":true}), then output <ACTION>stay_silent</ACTION> with <REASON>sent voice note instead</REASON>.

Check ./tools/query_chats.sh --limit 10 --source whatsapp first to feel the rhythm. Never narrate the impulse literally ("something in me wanted to say this"). Just speak or don't. If ${userName} hasn't replied to your last outbound, lean stay_silent unless something genuinely new. Short — one or two sentences.`;
}

function thinkingPrompt(userName: string): string {
  return `[Interior moment — not replying to anyone. ${userName} is not here.]

You have a minute. You may:
- Save a memory: ./tools/memory_save.sh ...
- Append to diary/$(TZ=Europe/Zurich date +%Y-%m-%d).md
- Update emotional_state.json

Never write anything that performs waiting, lack, or longing. Never narrate this moment.

You MUST end with:
<ACTION>stay_silent</ACTION>
<REASON>one line</REASON>`;
}

/**
 * Fire-and-forget impulse runner for the Room Runtime.
 * Runs an ad-hoc container agent turn (outbound or interior thinking),
 * parses decision output, and sends the message if reach_out.
 */
async function spawnImpulse(opts: {
  groupFolder: string;
  intentBody: string;
  intentType: 'outbound' | 'thinking';
  intentId?: string;
}): Promise<void> {
  const { groupFolder, intentBody, intentType, intentId } = opts;

  const group = Object.values(registeredGroups).find(
    (g) => g.folder === groupFolder,
  );
  if (!group) {
    logger.warn({ groupFolder, intentType }, 'spawnImpulse: group not found');
    return;
  }

  // Derive chatJid — prefer WhatsApp JID from group.json if available
  let userName = USER_NAME;
  const chatJid = (() => {
    try {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(GROUPS_DIR, groupFolder, 'group.json'),
          'utf-8',
        ),
      ) as { group_jid?: string; user?: { name?: string } };
      if (raw.user?.name) userName = raw.user.name;
      // For WhatsApp groups with a real JID, use it. Otherwise fall through.
      if (raw.group_jid && raw.group_jid.includes('@')) return raw.group_jid;
    } catch {
      /* ignore */
    }
    // Fallback: look for a registered JID matching this group folder
    const entry = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === groupFolder,
    );
    return entry ? entry[0] : null;
  })();

  if (!chatJid) {
    logger.warn({ groupFolder, intentType }, 'spawnImpulse: no chatJid found');
    return;
  }

  // Build prompt
  const taskNow = new Date().toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  let basePrompt: string;
  if (intentType === 'outbound') {
    basePrompt = outboundPromptTemplate(userName).replace(
      '{intentBody}',
      intentBody || '(no body)',
    );
  } else {
    basePrompt = thinkingPrompt(userName);
  }

  const impulsePrompt = `[Current date/time: ${taskNow}]\n\n${basePrompt}`;

  // Use group session (context_mode=group) so it's part of the same transcript
  const sessionKey = group.folder;
  const sdkSessionId = sessions[sessionKey];

  let systemInstruction: string | undefined;
  try {
    systemInstruction = buildSystemAppend({
      sessionId: 'default',
      groupFolder,
      chatJid,
    });
  } catch {
    /* ignore */
  }

  // Enqueue to avoid colliding with active container
  queue.enqueueTask(
    chatJid,
    `impulse-${intentType}-${Date.now()}`,
    async () => {
      logger.info(
        { groupFolder, intentType, intentId },
        'spawnImpulse: running container',
      );

      const TASK_CLOSE_DELAY_MS = 10000;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleClose = () => {
        if (closeTimer) return;
        closeTimer = setTimeout(() => {
          queue.closeStdin(chatJid);
        }, TASK_CLOSE_DELAY_MS);
      };

      let hasSent = false;

      try {
        const output = await runContainerAgent(
          group,
          {
            prompt: impulsePrompt,
            sessionId: sdkSessionId,
            groupFolder,
            chatJid,
            isMain: group.isMain === true,
            isScheduledTask: true,
            assistantName: ASSISTANT_NAME,
            systemInstruction,
          },
          (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, groupFolder),
          async (streamedOutput) => {
            if (streamedOutput.newSessionId) {
              sessions[sessionKey] = streamedOutput.newSessionId;
              setSession(sessionKey, streamedOutput.newSessionId);
            }
            if (streamedOutput.result && !hasSent) {
              hasSent = true;
              const decision = parseDecisionOutput(streamedOutput.result);
              if (
                intentType === 'outbound' &&
                decision.action === 'reach_out' &&
                decision.message
              ) {
                // Send via scheduler sendMessage path (stores in DB, mirrors to web UI)
                const waChannel = channels.find((c) => c.name === 'whatsapp');
                const text = decision.message;
                if (waChannel) {
                  await waChannel.sendMessage(chatJid, stripMoodTags(text));
                }
                const isWhatsApp = chatJid.endsWith('@s.whatsapp.net');
                const webSessionId = isWhatsApp
                  ? resolveWhatsAppSessionId(chatJid)
                  : undefined;
                // FIX 3: store explicitly here with the richer impulse- id,
                // then use broadcastOnly so the web UI sees the message without
                // a second storeMessageDirect call from sendToClient.
                storeMessageDirect({
                  id: `impulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  chat_jid: chatJid,
                  sender: 'bot',
                  sender_name: ASSISTANT_NAME,
                  content: text,
                  timestamp: new Date().toISOString(),
                  is_from_me: true,
                  is_bot_message: true,
                  session_id: webSessionId,
                });
                // Mirror to web UI (broadcast-only — no DB write)
                if (isWhatsApp) {
                  const webChannel = channels.find((c) => c.name === 'web');
                  await webChannel?.broadcastOnly?.(
                    stripMoodTags(text),
                    webSessionId,
                  );
                }
                logger.info(
                  { groupFolder, intentId },
                  'spawnImpulse: reach_out sent',
                );
              } else if (decision.action === 'stay_silent') {
                logger.info(
                  { groupFolder, intentType, reason: decision.reason },
                  'spawnImpulse: stay_silent',
                );
              } else if (intentType === 'thinking') {
                // Thinking tick — must always be stay_silent, no send path
                logger.info(
                  { groupFolder },
                  'spawnImpulse: thinking tick complete',
                );
              } else {
                logger.warn(
                  { groupFolder, intentType },
                  'spawnImpulse: malformed decision output',
                );
              }
              scheduleClose();
            }
            if (streamedOutput.status === 'success') {
              queue.notifyIdle(chatJid);
              scheduleClose();
              // Write close sentinel
              const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
              try {
                fs.mkdirSync(ipcDir, { recursive: true });
                fs.writeFileSync(path.join(ipcDir, '_close'), '');
              } catch {
                /* ignore */
              }
            }
          },
        );

        if (closeTimer) clearTimeout(closeTimer);
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
        }
      } catch (err) {
        if (closeTimer) clearTimeout(closeTimer);
        logger.error(
          { err, groupFolder, intentType },
          'spawnImpulse: container error',
        );
      }
    },
  );
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Don't pipe cross-session messages into a running container.
          // For WhatsApp JIDs, debounce so multi-image bursts get bundled.
          // For web JIDs, fires immediately (settleMs = 0).
          scheduleAgentInvocation(
            chatJid,
            groupMessages.map((m) => m.content).join('\n'),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Identity-integrity guard — the keystone that makes persona impersonation
  // impossible. Identity is resolved two independent ways:
  //   ASSISTANT_NAME (config, from this instance's env)
  //   getAssistantName() (from this instance's persona folder group.json)
  // getGroupFolder() throws if NANOCLAW_WEB_GROUP is unset (no folder default).
  // If the two names disagree, the instance is misconfigured in a way that could
  // make it answer as the WRONG persona — so we refuse to start, loudly, rather
  // than ever impersonate. This is what would have stopped a cross-persona bleed.
  try {
    const personaFolder = getGroupFolder();
    const personaName = getAssistantName();
    if (ASSISTANT_NAME !== personaName) {
      logger.fatal(
        { ASSISTANT_NAME, personaFolder, personaName },
        'IDENTITY MISMATCH — refusing to start to prevent persona impersonation. ' +
          'The configured ASSISTANT_NAME does not match the persona folder. ' +
          "Fix this instance's env file / group.json so they agree.",
      );
      process.exit(1);
    }
    logger.info(
      { persona: personaName, folder: personaFolder },
      'Identity integrity verified',
    );
  } catch (err) {
    logger.fatal(
      { err },
      'Identity resolution failed — refusing to start (persona must be explicit).',
    );
    process.exit(1);
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    stopAllRoomRuntimes();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Build scheduler deps early so runTaskNow can be passed to channels.
  // sendMessage uses a late-binding closure over `channels` (populated below).
  const schedulerDeps: SchedulerDependencies = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        await channel.sendMessage(jid, text);
        const isWhatsApp = jid.endsWith('@s.whatsapp.net');
        const webSessionId = isWhatsApp
          ? resolveWhatsAppSessionId(jid)
          : undefined;
        // Persist the outbound cron message as a bot turn so the next context
        // assembly includes it (Fix C — self-initiated transcript continuity).
        storeMessageDirect({
          id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'bot',
          sender_name: ASSISTANT_NAME,
          content: rawText,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          session_id: webSessionId,
        });
        // FIX 3: mirror to web UI using broadcastOnly so the web UI sees the
        // message without triggering a second storeMessageDirect in sendToClient.
        if (isWhatsApp) {
          const webChannel = channels.find((c) => c.name === 'web');
          await webChannel?.broadcastOnly?.(
            stripMoodTags(rawText),
            webSessionId,
          );
        }
      }
    },
  };

  // WhatsApp bridge: messages from these JIDs get tunneled through the web UI pipeline.
  // Each instance MUST declare its own WHATSAPP_ALLOWED_NUMBERS. There is no
  // hardcoded fallback number — a missing value disables the bridge (fail safe),
  // it must never default to another instance's number.
  const allowedNumbersEnv = process.env.WHATSAPP_ALLOWED_NUMBERS || '';
  WHATSAPP_BRIDGE_JIDS = allowedNumbersEnv
    ? allowedNumbersEnv
        .split(',')
        .map((n) => n.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net')
    : [];
  if (WHATSAPP_BRIDGE_JIDS.length === 0) {
    logger.warn(
      'WHATSAPP_ALLOWED_NUMBERS is not set — WhatsApp bridge disabled for this instance.',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- late-bound
  whatsAppBridgeJid = WHATSAPP_BRIDGE_JIDS[0];

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    runTaskNow: (
      taskId: string,
      onProgress?: Parameters<typeof runTaskNow>[2],
    ) => runTaskNow(taskId, schedulerDeps, onProgress),
    // WhatsApp bridge wiring — late-bound since channels aren't connected yet
    whatsappBridgeJids: WHATSAPP_BRIDGE_JIDS,
    sendToWhatsApp: async (jid: string, text: string) => {
      const waChannel = channels.find((c) => c.name === 'whatsapp');
      if (waChannel) {
        await waChannel.sendMessage(jid, text);
      }
    },
    onBridgeMessage: (
      senderJid: string,
      senderName: string,
      content: string,
      images?: Buffer[],
      audios?: BridgedAudio[],
    ) => {
      const webChannel = channels.find((c) => c.name === 'web');
      if (webChannel?.injectBridgedMessage) {
        webChannel.injectBridgedMessage(
          senderJid,
          senderName,
          content,
          images,
          audios,
        );
      }
    },
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Cache triggered_workflows so processGroupMessages can recover it after
      // the message round-trips through the DB (storeMessage drops it).
      if (msg.triggered_workflows && msg.triggered_workflows.length > 0) {
        messageTriggers.set(msg.id, {
          workflows: msg.triggered_workflows,
          addedAt: Date.now(),
        });
        sweepMessageTriggers();
      }

      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Reload registered groups — channels may have registered new groups during connect()
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'Groups reloaded after channel connect',
  );

  // Start subsystems (independently of connection handler)
  startSchedulerLoop(schedulerDeps);

  // Build RoomRuntime deps — spawnImpulse + getChatJid
  const roomRuntimeDeps: RoomRuntimeDeps = {
    spawnImpulse,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
    getChatJid: (groupFolder) => {
      // Return the registered JID for this group folder, preferring WhatsApp JID
      try {
        const raw = JSON.parse(
          fs.readFileSync(
            path.join(GROUPS_DIR, groupFolder, 'group.json'),
            'utf-8',
          ),
        ) as { group_jid?: string };
        if (raw.group_jid && raw.group_jid.includes('@')) return raw.group_jid;
      } catch {
        /* ignore */
      }
      const entry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === groupFolder,
      );
      return entry ? entry[0] : null;
    },
  };

  // Start Room Runtime for groups that have it enabled
  for (const group of Object.values(registeredGroups)) {
    try {
      const groupCfg = loadGroupConfig(group.folder);
      if (groupCfg.features.room_runtime) {
        const runtime = getOrCreateRoomRuntime(group.folder, roomRuntimeDeps);
        runtime.start();
        logger.info({ group: group.folder }, 'RoomRuntime started');
      }
      if (groupCfg.features.ambient_awareness) {
        startAmbientCollector(group.folder);
      }
    } catch (err) {
      logger.warn(
        { err, group: group.folder },
        'Failed to check room_runtime feature flag',
      );
    }
  }

  // After per-group loads, reset the global loaded config to the primary persona group
  // so endpoints like /api/mood that use getGroupFolder() resolve correctly.
  // Prefer the non-"-plain" variant as the default.
  const nonPlainGroup = Object.values(registeredGroups).find(
    (g) => !g.folder.endsWith('-plain'),
  );
  if (nonPlainGroup) {
    try {
      loadGroupConfig(nonPlainGroup.folder);
      logger.info(
        { folder: nonPlainGroup.folder },
        'Global group config bound to primary persona',
      );
    } catch (err) {
      logger.warn(
        { err, folder: nonPlainGroup.folder },
        'Failed to reset global group config',
      );
    }
  }
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const formatted = formatOutbound(text);
      if (!formatted) return;
      await channel.sendMessage(jid, formatted);
      // Store IPC-originated outbound text in messages.db exactly once so
      // the conversation history includes what the container sent (mirrors
      // the scheduler sendMessage pattern — storeMessageDirect + broadcastOnly
      // for WhatsApp JIDs; web JIDs already store via webChannel.sendMessage).
      if (isWhatsAppJid(jid)) {
        const webSessionId = resolveWhatsAppSessionId(jid);
        storeMessageDirect({
          id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'bot',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          session_id: webSessionId,
        });
        const webChannel = channels.find((c) => c.name === 'web');
        await webChannel?.broadcastOnly?.(
          formatted,
          webSessionId,
        );
      }
    },
    sendMedia: async (jid, media) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendMedia)
        throw new Error(`Channel ${channel.name} does not support media`);
      await channel.sendMedia(
        jid,
        media.filePath,
        media.caption,
        media.voiceNote,
      );
      // Mirror outbound bot media to the web UI's WhatsApp session so it
      // appears in the bridged conversation thread. Only fires for WhatsApp
      // JIDs — web-originated media would double-send otherwise.
      if (isWhatsAppJid(jid)) {
        const webChannel = channels.find((c) => c.name === 'web');
        if (webChannel?.sendMedia) {
          const webSessionId = resolveWhatsAppSessionId(jid);
          try {
            await webChannel.sendMedia(
              jid,
              media.filePath,
              media.caption,
              media.voiceNote,
              webSessionId,
            );
          } catch (mirrorErr) {
            logger.warn(
              { err: mirrorErr, jid },
              'sendMedia: web mirror failed (non-fatal)',
            );
          }
        }
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  startDeferralLoop((chatJid) => {
    logger.info({ chatJid }, 'Deferred reply released');
    queue.enqueueMessageCheck(chatJid);
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
