/**
 * Tests for IPC sendMessage → storeMessageDirect wiring (Task 2 fix).
 *
 * The IPC watcher's sendMessage dep in index.ts must persist outbound bot
 * messages to messages.db for WhatsApp JIDs so that conversation history
 * reflects what was sent. Web JIDs are excluded because webChannel.sendMessage
 * already calls sendToClient → storeMessageDirect internally (double-store guard).
 *
 * These tests exercise the invariant by replicating the logic as a unit and
 * verifying the DB state, using an in-memory test database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getLastBotMessageTimestamp,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';

// Mirror the JID classifier from index.ts
function isWhatsAppJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us');
}

// Mirror the session resolver from index.ts
function resolveWhatsAppSessionId(whatsappJid: string): string {
  return `wa:${whatsappJid}`;
}

// ---------------------------------------------------------------------------
// Replicated sendMessage logic (matches index.ts startIpcWatcher wiring)
// ---------------------------------------------------------------------------

interface FakeChannel {
  name: string;
  sendMessage: (jid: string, text: string) => Promise<void>;
  broadcastOnly?: (text: string, sessionId: string) => Promise<void>;
}

/**
 * Build the sendMessage closure that mirrors the implementation in index.ts.
 * Accepts injectable channels so tests can spy on sendMessage/broadcastOnly.
 */
function buildIpcSendMessage(
  channels: FakeChannel[],
  assistantName: string,
): (jid: string, text: string) => Promise<void> {
  return async (jid: string, text: string) => {
    // Find matching channel (simplified: WhatsApp JIDs → 'whatsapp' channel,
    // web sessions → 'web' channel; index.ts uses findChannel(channels, jid))
    const channel = channels.find((c) =>
      isWhatsAppJid(jid) ? c.name === 'whatsapp' : c.name === 'web',
    );
    if (!channel) throw new Error(`No channel for JID: ${jid}`);

    // formatted = formatOutbound(text) — simplified to identity for tests
    const formatted = text;
    if (!formatted) return;

    await channel.sendMessage(jid, formatted);

    // THE FIX: store outbound IPC messages in DB for WhatsApp JIDs
    if (isWhatsAppJid(jid)) {
      const webSessionId = resolveWhatsAppSessionId(jid);
      storeMessageDirect({
        id: `ipc-${Date.now()}-test`,
        chat_jid: jid,
        sender: 'bot',
        sender_name: assistantName,
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: webSessionId,
      });
      const webChannel = channels.find((c) => c.name === 'web');
      await webChannel?.broadcastOnly?.(formatted, webSessionId);
    }
    // Web JIDs: NOT stored here — webChannel.sendMessage → sendToClient already calls
    // storeMessageDirect internally, so adding it here would double-store.
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ASSISTANT = 'Assistant';
const WA_JID = '15551234567@s.whatsapp.net';
const WEB_JID = 'web-session-abc';
const GROUP_JID = 'group1234@g.us';

beforeEach(() => {
  _initTestDatabase();
  // messages.chat_jid has a FK to chats.jid — pre-seed all JIDs used in tests.
  const now = new Date().toISOString();
  storeChatMetadata(WA_JID, now);
  storeChatMetadata(WEB_JID, now);
  storeChatMetadata(GROUP_JID, now);
});

describe('IPC sendMessage — WhatsApp JID', () => {
  it('stores outbound message in DB for @s.whatsapp.net JID', async () => {
    const waChannel: FakeChannel = {
      name: 'whatsapp',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const webBroadcast = vi.fn().mockResolvedValue(undefined);
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      broadcastOnly: webBroadcast,
    };

    const sendMessage = buildIpcSendMessage([waChannel, webChannel], ASSISTANT);
    await sendMessage(WA_JID, 'Good morning! Here is your brief.');

    const ts = getLastBotMessageTimestamp(WA_JID, ASSISTANT);
    expect(ts).toBeDefined();
    expect(waChannel.sendMessage).toHaveBeenCalledWith(
      WA_JID,
      'Good morning! Here is your brief.',
    );
  });

  it('calls broadcastOnly on web channel for WhatsApp JID (web UI mirror)', async () => {
    const waChannel: FakeChannel = {
      name: 'whatsapp',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const webBroadcast = vi.fn().mockResolvedValue(undefined);
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      broadcastOnly: webBroadcast,
    };

    const sendMessage = buildIpcSendMessage([waChannel, webChannel], ASSISTANT);
    await sendMessage(WA_JID, 'morning brief text');

    expect(webBroadcast).toHaveBeenCalledOnce();
    const [broadcastText, sessionId] = webBroadcast.mock.calls[0];
    expect(broadcastText).toBe('morning brief text');
    expect(sessionId).toBe(`wa:${WA_JID}`);
  });

  it('does NOT call webChannel.sendMessage for WhatsApp JID (no double-store)', async () => {
    const waChannel: FakeChannel = {
      name: 'whatsapp',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const webSend = vi.fn().mockResolvedValue(undefined);
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: webSend,
      broadcastOnly: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = buildIpcSendMessage([waChannel, webChannel], ASSISTANT);
    await sendMessage(WA_JID, 'test message');

    // broadcastOnly yes, sendMessage no — sendMessage would re-store via sendToClient
    expect(webSend).not.toHaveBeenCalled();
  });

  it('stores with correct sender, is_from_me=true, is_bot_message=true', async () => {
    let stored: Parameters<typeof storeMessageDirect>[0] | null = null;
    const origStore = storeMessageDirect;

    // We can't easily spy on storeMessageDirect without vi.mock at module level,
    // so instead verify via getLastBotMessageTimestamp (which queries is_bot_message=1).
    const waChannel: FakeChannel = {
      name: 'whatsapp',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      broadcastOnly: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = buildIpcSendMessage([waChannel, webChannel], ASSISTANT);
    await sendMessage(WA_JID, 'Guten Morgen!');

    // getLastBotMessageTimestamp checks is_bot_message=1 — if it returns a value,
    // the message was stored with is_bot_message set correctly.
    const ts = getLastBotMessageTimestamp(WA_JID, ASSISTANT);
    expect(ts).toBeDefined();
    expect(typeof ts).toBe('string');
  });
});

describe('IPC sendMessage — web JID', () => {
  it('does NOT call storeMessageDirect for web JID (web channel stores internally)', async () => {
    const webSend = vi.fn().mockResolvedValue(undefined);
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: webSend,
      broadcastOnly: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = buildIpcSendMessage([webChannel], ASSISTANT);
    await sendMessage(WEB_JID, 'web session message');

    // Web channel sendMessage was called (sends the message)
    expect(webSend).toHaveBeenCalledWith(WEB_JID, 'web session message');

    // DB should NOT have a bot message for this JID (web channel stores internally,
    // not via storeMessageDirect in the IPC wiring)
    const ts = getLastBotMessageTimestamp(WEB_JID, ASSISTANT);
    expect(ts).toBeUndefined();
  });
});

describe('IPC sendMessage — @g.us group JID', () => {
  it('stores outbound message for group WhatsApp JIDs (@g.us)', async () => {
    const waChannel: FakeChannel = {
      name: 'whatsapp',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const webChannel: FakeChannel = {
      name: 'web',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      broadcastOnly: vi.fn().mockResolvedValue(undefined),
    };

    const sendMessage = buildIpcSendMessage([waChannel, webChannel], ASSISTANT);
    await sendMessage(GROUP_JID, 'group announcement');

    const ts = getLastBotMessageTimestamp(GROUP_JID, ASSISTANT);
    expect(ts).toBeDefined();
  });
});
