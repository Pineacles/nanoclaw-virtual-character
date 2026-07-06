import { readEnvFile } from '../../env.js';
import { registerChannel } from '../registry.js';
import { createWebChannel } from './web-channel.js';

registerChannel('web', (opts) => {
  const env = readEnvFile(['WEB_AUTH_TOKEN']);
  if (!env.WEB_AUTH_TOKEN) {
    return null;
  }
  return createWebChannel({
    ...opts,
    runTaskNow: opts.runTaskNow,
    whatsappBridgeJids: opts.whatsappBridgeJids,
    sendToWhatsApp: opts.sendToWhatsApp,
  });
});
