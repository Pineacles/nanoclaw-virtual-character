/**
 * Group scaffolding utility — creates a new group folder from the _template.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../config.js';

export interface ScaffoldOpts {
  assistantName: string;
  userName: string;
  timezone?: string;
}

export function scaffoldGroup(folderName: string, opts: ScaffoldOpts): string {
  const targetDir = path.join(GROUPS_DIR, folderName);
  const templateDir = path.join(GROUPS_DIR, '_template');

  if (fs.existsSync(targetDir)) {
    throw new Error(`Group folder already exists: ${folderName}`);
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error('Template folder not found: groups/_template/');
  }

  // Copy template
  fs.cpSync(templateDir, targetDir, { recursive: true });

  // Rewrite group.json with provided names
  const configPath = path.join(targetDir, 'group.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  config.group_name = opts.assistantName;
  config.group_jid = `web:${folderName}`;
  config.timezone = opts.timezone || 'UTC';
  config.assistant.name = opts.assistantName;
  config.assistant.trigger = `@${opts.assistantName}`;
  config.user.name = opts.userName;
  config.user.sender_id = `web:${folderName.toLowerCase()}`;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Create subdirectories
  const dirs = [
    'memories',
    'diary',
    'conversations',
    'context',
    'uploads',
    'logs',
    'reflections',
    'workflows',
    'screenshots',
    'session_context',
    'tools',
    'projects',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(targetDir, d), { recursive: true });
  }

  return targetDir;
}
