import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function homeDir() {
  return os.homedir();
}

export function dataDir() {
  if (process.env.ZCODE_THINKING_KIT_HOME) return process.env.ZCODE_THINKING_KIT_HOME;
  return path.join(homeDir(), '.zcode-thinking-kit');
}

export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultLogDir() {
  if (process.env.ZCODE_LOG_DIR) return process.env.ZCODE_LOG_DIR;
  return path.join(homeDir(), '.zcode', 'cli', 'log');
}

export function defaultZcodeV2Config() {
  if (process.env.ZCODE_V2_CONFIG) return process.env.ZCODE_V2_CONFIG;
  return path.join(homeDir(), '.zcode', 'v2', 'config.json');
}

export function pidPath() {
  return path.join(dataDir(), 'proxy.pid');
}

export function defaultAuditPath() {
  return path.join(dataDir(), 'audit.jsonl');
}

export function resolveConfigPath(cliPath) {
  if (cliPath) return path.resolve(cliPath);
  if (process.env.ZCODE_THINKING_KIT_CONFIG) {
    return path.resolve(process.env.ZCODE_THINKING_KIT_CONFIG);
  }
  const candidates = [
    path.join(process.cwd(), 'thinking.config.json'),
    path.join(KIT_DIR, 'thinking.config.json'),
    path.join(dataDir(), 'thinking.config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(KIT_DIR, 'thinking.config.json');
}

export function exampleConfigPath() {
  return path.join(KIT_DIR, 'thinking.config.example.json');
}
