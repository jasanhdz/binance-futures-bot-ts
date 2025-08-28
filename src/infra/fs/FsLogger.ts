import fs from 'fs';
import path from 'path';
import { Logger } from '../../core/ports/Logger';

const logDir = path.resolve(__dirname, '../../../logs');

function ensureLogDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function should(level: Level) {
  return ORDER[level] >= ORDER[CURRENT_LEVEL];
}

function todayPath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(logDir, `history-${date}.log`);
}

function writeLine(level: Level, msg: string, ctx?: any) {
  if (!should(level)) return;
  ensureLogDir();
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx ? { ctx } : {}),
  };
  const line = JSON.stringify(payload);
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line);
  fs.appendFile(todayPath(), line + '\n', (err) => {
    if (err) console.error('❌ Error escribiendo log:', err);
  });
}

export class FsLogger implements Logger {
  debug(msg: string, ctx?: any): void {
    writeLine('debug', msg, ctx);
  }
  info(msg: string, ctx?: any): void {
    writeLine('info', msg, ctx);
  }
  warn(msg: string, ctx?: any): void {
    writeLine('warn', msg, ctx);
  }
  error(msg: string, ctx?: any): void {
    writeLine('error', msg, ctx);
  }
}
