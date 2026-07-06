import {
  BridgedAudio,
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
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
  // WhatsApp bridge config
  whatsappBridgeJids?: string[];
  sendToWhatsApp?: (jid: string, text: string) => Promise<void>;
  onBridgeMessage?: (
    senderJid: string,
    senderName: string,
    content: string,
    images?: Buffer[],
    audios?: BridgedAudio[],
  ) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
