import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

import crypto from 'crypto';
import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { computePresence, readGroupFeature } from '../presence/engine.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  BridgedAudio,
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** If set, messages from these JIDs are bridged to the web channel instead of the normal pipeline. */
  bridgeJids?: string[];
  /** Called when a message arrives from one of the bridgeJids. */
  onBridgeMessage?: (
    senderJid: string,
    senderName: string,
    content: string,
    images?: Buffer[],
    audios?: BridgedAudio[],
  ) => void;
}

/** Baileys message key shape for read receipts. */
interface BaileysKey {
  remoteJid: string;
  id: string;
  participant?: string;
  fromMe: false;
}

const READ_BUFFER_MAX = 50;

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Per-jid ring buffer of inbound message keys for deferred read receipts. */
  private readBuffer = new Map<string, BaileysKey[]>();
  /** Presence loop timer — kept so it can be cleared on disconnect. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** Last global presence state we sent, so we only send on change. */
  private lastPresenceSent: 'available' | 'unavailable' | null = null;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      printQRInTerminal: false,
      logger: logger as any,
      browser: Browsers.macOS('Chrome'),
    });

    // Request pairing code if phone number is set and not yet registered
    const pairingPhone = process.env.WHATSAPP_PAIRING_PHONE;
    let pairingRequested = false;

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && pairingPhone && !pairingRequested) {
        pairingRequested = true;
        const cleanPhone = pairingPhone.replace(/[^0-9]/g, '');
        logger.info({ phone: cleanPhone }, 'Requesting pairing code...');
        this.sock
          .requestPairingCode(cleanPhone)
          .then((code: string) => {
            logger.info(
              { code },
              '=== WHATSAPP PAIRING CODE — enter this on the phone ===',
            );
          })
          .catch((err: unknown) => {
            logger.error({ err }, 'Failed to request pairing code');
          });
        return;
      }

      if (qr && !pairingPhone) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        this.stopPresenceLoop();
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          // Logged out: do NOT exit the process. A dead WhatsApp link must not
          // take down the whole instance (web UI, scheduler, other channels).
          // Unblock startup so the rest of NanoClaw finishes connecting, then
          // stay disconnected until the user re-pairs (/setup or bridge QR).
          this.connected = false;
          logger.warn(
            'WhatsApp logged out — staying up without WhatsApp. Web UI and other channels keep running. Re-pair via /setup to restore the bridge.',
          );
          onFirstOpen?.();
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Feature 4: start the scheduled online/offline presence loop
        this.startPresenceLoop();

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable
          const chatJid = await this.translateJid(rawJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Bridge mode: intercept messages from any of the bridged JIDs
          if (
            this.opts.bridgeJids?.includes(chatJid) &&
            this.opts.onBridgeMessage
          ) {
            const fromMe = msg.key.fromMe || false;
            const content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Skip bot's own messages (sent by us via the bridge)
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);
            if (isBotMessage) continue;

            // Skip empty protocol messages (text/image/video/audio all count
            // as real content; audio has no caption so it must be listed here
            // or voice notes get silently dropped).
            if (
              !content &&
              !normalized.imageMessage &&
              !normalized.videoMessage &&
              !normalized.audioMessage
            )
              continue;

            const senderName =
              msg.pushName ||
              (msg.key.participant || msg.key.remoteJid || '').split('@')[0];

            // Download media if present
            const images: Buffer[] = [];
            const audios: BridgedAudio[] = [];
            try {
              if (normalized.imageMessage) {
                const buf = await downloadMediaMessage(msg, 'buffer', {});
                if (Buffer.isBuffer(buf)) images.push(buf);
              }
              if (normalized.audioMessage) {
                const buf = await downloadMediaMessage(msg, 'buffer', {});
                if (Buffer.isBuffer(buf) && buf.length > 0) {
                  audios.push({
                    data: buf,
                    ptt: !!normalized.audioMessage.ptt,
                    mimetype: normalized.audioMessage.mimetype || undefined,
                  });
                  logger.info(
                    { size: buf.length, ptt: !!normalized.audioMessage.ptt },
                    'WhatsApp bridge: voice/audio downloaded',
                  );
                } else {
                  logger.warn(
                    { isBuffer: Buffer.isBuffer(buf) },
                    'WhatsApp bridge: audio download empty/invalid, skipping',
                  );
                }
              }
              if (normalized.videoMessage) {
                // Videos are too large to inject — just note it in the text
                const videoCaption = normalized.videoMessage.caption || '';
                this.opts.onBridgeMessage(
                  chatJid,
                  senderName,
                  videoCaption
                    ? `${content}\n[Video attached]`
                    : content || '[Video attached]',
                );
                continue;
              }
            } catch (err) {
              logger.warn({ err }, 'Failed to download WhatsApp media');
            }

            this.opts.onBridgeMessage(
              chatJid,
              senderName,
              content || '',
              images.length > 0 ? images : undefined,
              audios.length > 0 ? audios : undefined,
            );
            continue;
          }

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              normalized.documentMessage?.caption ||
              '';

            const hasMedia =
              !!normalized.imageMessage ||
              !!normalized.videoMessage ||
              !!normalized.audioMessage ||
              !!normalized.documentMessage ||
              !!normalized.stickerMessage;

            // Skip protocol messages with no text and no media
            if (!content && !hasMedia) continue;

            // Download and save media attachments
            const group = groups[chatJid];
            if (hasMedia) {
              try {
                const uploadsDir = path.join(
                  GROUPS_DIR,
                  group.folder,
                  'uploads',
                );
                fs.mkdirSync(uploadsDir, { recursive: true });

                if (normalized.imageMessage) {
                  const buf = await downloadMediaMessage(msg, 'buffer', {});
                  if (Buffer.isBuffer(buf)) {
                    const ext =
                      (normalized.imageMessage.mimetype || 'image/jpeg')
                        .split('/')[1]
                        ?.split(';')[0] || 'jpg';
                    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
                    fs.writeFileSync(path.join(uploadsDir, filename), buf);
                    content += `\n[Image: /workspace/group/uploads/${filename}]`;
                    logger.info(
                      { filename, size: buf.length },
                      'WhatsApp image saved',
                    );
                  }
                }

                if (normalized.videoMessage) {
                  const buf = await downloadMediaMessage(msg, 'buffer', {});
                  if (Buffer.isBuffer(buf)) {
                    const ext =
                      (normalized.videoMessage.mimetype || 'video/mp4')
                        .split('/')[1]
                        ?.split(';')[0] || 'mp4';
                    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
                    fs.writeFileSync(path.join(uploadsDir, filename), buf);
                    content += `\n[Video: /workspace/group/uploads/${filename}]`;
                    logger.info(
                      { filename, size: buf.length },
                      'WhatsApp video saved',
                    );
                  }
                }

                if (normalized.audioMessage) {
                  const buf = await downloadMediaMessage(msg, 'buffer', {});
                  if (Buffer.isBuffer(buf)) {
                    const isPtt = normalized.audioMessage.ptt;
                    const ext = isPtt
                      ? 'ogg'
                      : (normalized.audioMessage.mimetype || 'audio/ogg')
                          .split('/')[1]
                          ?.split(';')[0] || 'ogg';
                    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
                    fs.writeFileSync(path.join(uploadsDir, filename), buf);
                    content += `\n[${isPtt ? 'Voice' : 'Audio'}: /workspace/group/uploads/${filename}]`;
                    logger.info(
                      { filename, size: buf.length, isPtt },
                      'WhatsApp audio saved',
                    );
                  }
                }

                if (normalized.documentMessage) {
                  const buf = await downloadMediaMessage(msg, 'buffer', {});
                  if (Buffer.isBuffer(buf)) {
                    const originalName =
                      normalized.documentMessage.fileName || 'document';
                    const safeName = originalName.replace(
                      /[^a-zA-Z0-9._-]/g,
                      '_',
                    );
                    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeName}`;
                    fs.writeFileSync(path.join(uploadsDir, filename), buf);
                    content += `\n[Document: /workspace/group/uploads/${filename}]`;
                    logger.info(
                      { filename, originalName, size: buf.length },
                      'WhatsApp document saved',
                    );
                  }
                }

                if (normalized.stickerMessage) {
                  const buf = await downloadMediaMessage(msg, 'buffer', {});
                  if (Buffer.isBuffer(buf)) {
                    const ext =
                      (normalized.stickerMessage.mimetype || 'image/webp')
                        .split('/')[1]
                        ?.split(';')[0] || 'webp';
                    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
                    fs.writeFileSync(path.join(uploadsDir, filename), buf);
                    content += `\n[Sticker: /workspace/group/uploads/${filename}]`;
                  }
                }
              } catch (err) {
                logger.warn(
                  { err, chatJid },
                  'Failed to download WhatsApp media',
                );
                // Caption text (if any) is still usable — don't pollute it
                // with a download-failed marker. Messages with no text and
                // failed download will be dropped by the !content.trim() guard
                // below, which is the correct behaviour.
              }
            }

            // Still skip if no content after media processing
            if (!content.trim()) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            // Feature 2: buffer inbound (non-bot) message keys for deferred read receipts
            if (!fromMe && !isBotMessage && msg.key.id) {
              const key: BaileysKey = {
                remoteJid: chatJid,
                id: msg.key.id,
                fromMe: false,
                ...(msg.key.participant
                  ? { participant: msg.key.participant }
                  : {}),
              };
              const buf = this.readBuffer.get(chatJid) ?? [];
              buf.push(key);
              if (buf.length > READ_BUFFER_MAX) buf.shift();
              this.readBuffer.set(chatJid, buf);
            }

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    _sessionId?: string,
  ): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      // Feature 4: appear available when actively sending a message
      const folder = this.folderForJid(jid);
      if (folder && readGroupFeature(folder, 'presence_indicator')) {
        await this.sendGlobalPresence('available');
      }
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendMedia(
    jid: string,
    filePath: string,
    caption?: string,
    voiceNote?: boolean,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WA disconnected, cannot send media');
      return;
    }

    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const filename = path.basename(filePath);

    // Determine media type from extension
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', '3gp'];
    const audioExts = ['ogg', 'mp3', 'wav', 'aac', 'm4a', 'opus'];

    try {
      if (imageExts.includes(ext)) {
        await this.sock.sendMessage(jid, {
          image: buffer,
          caption: caption || undefined,
        });
      } else if (videoExts.includes(ext)) {
        await this.sock.sendMessage(jid, {
          video: buffer,
          caption: caption || undefined,
        });
      } else if (audioExts.includes(ext)) {
        let audioBuf = buffer;
        let mimetype = `audio/${ext}`;
        // Default to voice note for WhatsApp audio (more natural)
        const sendAsPtt = voiceNote !== false;

        // WhatsApp voice notes require OGG/Opus. Always convert non-ogg audio.
        if (ext !== 'ogg' && ext !== 'opus') {
          try {
            const tmpIn = path.join(
              os.tmpdir(),
              `nanoclaw-${Date.now()}.${ext}`,
            );
            const tmpOut = path.join(os.tmpdir(), `nanoclaw-${Date.now()}.ogg`);
            fs.writeFileSync(tmpIn, buffer);
            execSync(
              `ffmpeg -y -i ${tmpIn} -c:a libopus -b:a 64k -ac 1 -ar 48000 ${tmpOut}`,
              { timeout: 30000 },
            );
            audioBuf = fs.readFileSync(tmpOut);
            mimetype = 'audio/ogg; codecs=opus';
            try {
              fs.unlinkSync(tmpIn);
            } catch {
              /* ignore */
            }
            try {
              fs.unlinkSync(tmpOut);
            } catch {
              /* ignore */
            }
            logger.info(
              {
                from: ext,
                size: buffer.length,
                convertedSize: audioBuf.length,
              },
              'Converted audio to OGG/Opus',
            );
          } catch (err) {
            logger.warn(
              { err, ext },
              'ffmpeg conversion failed, sending as-is',
            );
          }
        } else {
          mimetype = 'audio/ogg; codecs=opus';
        }

        // Feature 3: send 'recording' presence indicator before voice notes
        if (sendAsPtt) {
          const folder = this.folderForJid(jid);
          if (folder && readGroupFeature(folder, 'presence_indicator')) {
            try {
              await this.sock.sendPresenceUpdate('recording', jid);
              // Random delay 2000–3500 ms to feel natural
              const delay = 2000 + Math.floor(Math.random() * 1500);
              await new Promise<void>((r) => setTimeout(r, delay));
            } catch {
              /* presence failures must never block the actual send */
            }
          }
        }

        await this.sock.sendMessage(jid, {
          audio: audioBuf,
          ptt: sendAsPtt,
          mimetype,
        });

        // Clear the recording indicator after send
        if (sendAsPtt) {
          const folder = this.folderForJid(jid);
          if (folder && readGroupFeature(folder, 'presence_indicator')) {
            this.sock.sendPresenceUpdate('paused', jid).catch(() => {
              /* ignore */
            });
          }
        }
      } else {
        // Send as document for everything else (pdf, docx, zip, etc.)
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          csv: 'text/csv',
          txt: 'text/plain',
          zip: 'application/zip',
          json: 'application/json',
        };
        await this.sock.sendMessage(jid, {
          document: buffer,
          mimetype: mimeMap[ext] || 'application/octet-stream',
          fileName: filename,
          caption: caption || undefined,
        });
      }
      logger.info({ jid, filePath, ext }, 'Media sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send media');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
    this.stopPresenceLoop();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Resolve the group folder for a given jid, or null if not registered. */
  private folderForJid(jid: string): string | null {
    const groups = this.opts.registeredGroups();
    return groups[jid]?.folder ?? null;
  }

  /**
   * Feature 4: send a global (connection-level) presence update only when it
   * differs from the last one we sent, to avoid flooding WhatsApp servers.
   * Baileys global presence is per-connection (not per-jid), so we track a
   * single last-sent value and deduplicate.
   */
  private async sendGlobalPresence(
    state: 'available' | 'unavailable',
  ): Promise<void> {
    if (!this.sock || !this.connected) return;
    if (this.lastPresenceSent === state) return;
    try {
      await this.sock.sendPresenceUpdate(state);
      this.lastPresenceSent = state;
    } catch (err) {
      logger.debug({ err, state }, 'Failed to send global presence update');
    }
  }

  /** Feature 4: start a 60-second loop that publishes available/unavailable
   *  based on computePresence() for each registered group with the flag on. */
  private startPresenceLoop(): void {
    this.stopPresenceLoop();
    const timer = setInterval(() => {
      this.tickPresenceLoop();
    }, 60_000);
    // unref so the timer doesn't keep the process alive on its own
    timer.unref();
    this.presenceTimer = timer;
  }

  private stopPresenceLoop(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private tickPresenceLoop(): void {
    if (!this.sock || !this.connected) return;
    try {
      const groups = this.opts.registeredGroups();
      // Use the FIRST flagged group's folder to compute global presence
      // (Baileys connection-level presence is not per-jid).
      for (const group of Object.values(groups)) {
        if (!readGroupFeature(group.folder, 'presence_indicator')) continue;
        const p = computePresence(group.folder);
        const desired: 'available' | 'unavailable' =
          p.state === 'online' ? 'available' : 'unavailable';
        // Fire-and-forget; sendGlobalPresence deduplicates
        this.sendGlobalPresence(desired).catch((err) => {
          logger.debug({ err }, 'Presence loop: sendGlobalPresence failed');
        });
        return; // Only use the first flagged group
      }
    } catch (err) {
      logger.debug({ err }, 'Presence loop tick error');
    }
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    _sessionId?: string,
  ): Promise<void> {
    // Feature 1: gate on presence_indicator feature flag for this jid's group
    const folder = this.folderForJid(jid);
    if (!folder || !readGroupFeature(folder, 'presence_indicator')) return;
    if (!this.sock || !this.connected) return;
    try {
      // Feature 4: always appear available right before typing (people are online when texting)
      if (isTyping) await this.sendGlobalPresence('available');
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /** Feature 2: mark buffered inbound messages as read (blue ticks). */
  async markRead(jid: string): Promise<void> {
    const folder = this.folderForJid(jid);
    if (!folder || !readGroupFeature(folder, 'presence_indicator')) return;
    if (!this.sock || !this.connected) return;
    const keys = this.readBuffer.get(jid);
    if (!keys || keys.length === 0) return;
    this.readBuffer.delete(jid);
    try {
      await this.sock.readMessages(keys);
      logger.debug({ jid, count: keys.length }, 'Marked messages as read');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to mark messages as read');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  if (process.env.NANOCLAW_DISABLE_WHATSAPP === '1') return null;
  return new WhatsAppChannel({
    ...opts,
    bridgeJids: opts.whatsappBridgeJids,
    onBridgeMessage: opts.onBridgeMessage,
  });
});
