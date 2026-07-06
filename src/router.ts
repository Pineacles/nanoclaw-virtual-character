import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    // Self-initiated outbound (cron / impulse) bypassed the SDK session JSONL
    // when sent, so the agent has no record of them. Re-injected here as bot
    // turns, marked explicitly so the model knows it sent them, not the user.
    const isSelfInitiated =
      !!m.is_bot_message &&
      (m.id.startsWith('sched-') || m.id.startsWith('impulse-'));
    if (isSelfInitiated) {
      return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}" self_initiated_outbound="true">${escapeXml(m.content)}</message>`;
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  let t = text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  // Unclosed opening tag: everything after it is internal — drop to end.
  t = t.replace(/<internal>[\s\S]*$/, '');
  // Orphan tags (incl. stray closes from chunked streaming) — remove the tags themselves.
  t = t.replace(/<\/?internal>/g, '');
  return t.trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
