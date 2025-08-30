import fs from 'fs';
import path from 'path';
import { Logger } from '../../core/ports/Logger';

const logDir = path.resolve(__dirname, '../../../logs');
const legacyPath = path.join(logDir, 'history.log'); // compat línea plana

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

const LOG_TO_FILE = process.env.LOG_TO_FILE !== '0'; // permite apagar logs a archivo por env
const LOG_RETAIN_DAYS = Number(process.env.LOG_RETAIN_DAYS ?? 7);

let FILE_LOGGING_DISABLED = false; // si se dispara ENOSPC, dejamos de escribir

function ensureLogDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function should(level: Level) {
  return ORDER[level] >= ORDER[CURRENT_LEVEL];
}

function todayPath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(logDir, `history-${date}.log`);
}

function pruneOldLogs(retainDays: number) {
  try {
    ensureLogDir();
    const now = Date.now();
    const cutoff = now - retainDays * 86_400_000;
    const files = fs.readdirSync(logDir);
    for (const f of files) {
      if (!/^history-\d{4}-\d{2}-\d{2}\.log(\.gz)?$/.test(f)) continue;
      const dateStr = f.slice(8, 18); // YYYY-MM-DD
      const t = Date.parse(dateStr + 'T00:00:00Z');
      if (Number.isFinite(t) && t < cutoff) {
        try {
          fs.rmSync(path.join(logDir, f));
        } catch {}
      }
    }
  } catch {}
}

function append(file: string, line: string) {
  if (!LOG_TO_FILE || FILE_LOGGING_DISABLED) return;
  ensureLogDir();
  fs.appendFile(file, line + '\n', (err) => {
    if (!err) return;
    // Si nos quedamos sin espacio o tamaño de archivo excedido → desactivar a archivo
    if (err.code === 'ENOSPC' || err.code === 'EFBIG') {
      console.warn(
        `[Logger] ${err.code}: deshabilitando escritura a archivo. Quedará solo consola.`,
      );
      // Intento de limpieza básica: borrar logs antiguos
      pruneOldLogs(Math.max(3, Math.min(LOG_RETAIN_DAYS, 30)));
      FILE_LOGGING_DISABLED = true;
      return;
    }
    console.error('❌ Error escribiendo log:', err);
  });
}

function write(level: Level, msg: string, ctx?: any) {
  if (!should(level)) return;

  // JSON estructurado a consola
  const payload = { ts: new Date().toISOString(), level, msg, ...(ctx ? { ctx } : {}) };
  const json = JSON.stringify(payload);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(json);

  // A archivo (si está habilitado)
  if (LOG_TO_FILE && !FILE_LOGGING_DISABLED) {
    const today = todayPath();
    append(today, json);

    // —— Compat “history.log” (línea plana) ——
    const flat = `[${payload.ts}] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`;
    append(legacyPath, flat);
  }
}

export class FsLogger implements Logger {
  debug(msg: string, ctx?: any) {
    write('debug', msg, ctx);
  }
  info(msg: string, ctx?: any) {
    write('info', msg, ctx);
  }
  warn(msg: string, ctx?: any) {
    write('warn', msg, ctx);
  }
  error(msg: string, ctx?: any) {
    write('error', msg, ctx);
  }
}

// Opcional: prune al arranque (silencioso)
try {
  pruneOldLogs(LOG_RETAIN_DAYS);
} catch {}
