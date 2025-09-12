import fs from 'fs';
import path from 'path';
import type { Logger } from '../../core/ports/Logger';

// ===== Config =====
const logDir = path.resolve(__dirname, '../../../logs');
const legacyPath = path.join(logDir, 'history.log');

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

const LOG_TO_FILE = process.env.LOG_TO_FILE !== '0';
const LOG_RETAIN_DAYS = Number(process.env.LOG_RETAIN_DAYS ?? 7);
const PRETTY = process.env.LOG_PRETTY === '1'; // ⟵ activa modo humano
let FILE_LOGGING_DISABLED = false;

// ===== Helpers =====
function ensureLogDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}
function should(level: Level) {
  return ORDER[level] >= ORDER[CURRENT_LEVEL];
}
function todayPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `history-${date}.log`);
}
function pruneOldLogs(retainDays: number) {
  try {
    ensureLogDir();
    const now = Date.now();
    const cutoff = now - retainDays * 86_400_000;
    for (const f of fs.readdirSync(logDir)) {
      if (!/^history-\d{4}-\d{2}-\d{2}\.log(\.gz)?$/.test(f)) continue;
      const t = Date.parse(f.slice(8, 18) + 'T00:00:00Z');
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
    if (err.code === 'ENOSPC' || err.code === 'EFBIG') {
      console.warn(
        color.warn(`[Logger] ${err.code}: deshabilitando archivo; quedará solo consola.`),
      );
      pruneOldLogs(Math.max(3, Math.min(LOG_RETAIN_DAYS, 30)));
      FILE_LOGGING_DISABLED = true;
      return;
    }
    console.error(color.error('❌ Error escribiendo log: ' + err));
  });
}

// ===== Colores ANSI simples (sin dependencias) =====
const code = (n: number) => (s: string) => `\x1b[${n}m${s}\x1b[0m`;
const color = {
  dim: code(2),
  gray: code(90),
  info: code(36), // cyan
  ok: code(32), // green
  warn: code(33), // yellow
  error: code(31), // red
  bold: code(1),
};

// ===== Plantillas “bonitas” por msg =====
function prettyLine(level: Level, msg: string, ctx?: any) {
  const t = new Date().toLocaleTimeString();
  const L = (s: string) =>
    level === 'error'
      ? color.error(s)
      : level === 'warn'
        ? color.warn(s)
        : level === 'info'
          ? color.info(s)
          : color.gray(s);

  // formateadores auxiliares
  const n = (x: any, d = 2) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  const p = (x: number) => (x * 100).toFixed(1) + '%';

  switch (msg) {
    case 'sync_attach_to_open_position': {
      const side = ctx?.side ?? '?';
      const entry = n(ctx?.entry);
      const lev = n(ctx?.lev, 0);
      const qty = n(ctx?.qtyAbs, 4);
      const emoji = side === 'LONG' ? '🟢' : '🔻';
      return `${color.gray(t)} ${emoji} ${color.bold('Attach')} ${side} @ ${entry} ×${lev} | qty ${qty}`;
    }

    case 'raw_open_orders': {
      // En lugar de volcar arrays enormes, resumimos:
      const count = ctx?.count ?? 0;
      const sample = Array.isArray(ctx?.sample) ? ctx.sample : [];
      const stops = sample.filter((o: any) => o.type?.includes('STOP'));
      const tps = sample.filter((o: any) => o.type?.includes('TAKE_PROFIT'));
      const bestStop = stops.length
        ? stops.reduce((a: any, b: any) => (Number(a.stopPrice) > Number(b.stopPrice) ? a : b))
            .stopPrice
        : '-';
      const bestTP = tps.length ? tps[0].stopPrice : '-';
      return `${color.gray(t)} 📜 Órdenes abiertas: ${count} | ⛔ stop* ${bestStop} | 🎯 tp* ${bestTP}`;
    }

    case 'tp_watch': {
      const side = ctx?.side ?? '?';
      const hit = ctx?.hit ? color.ok('HIT') : color.dim('…');
      return `${color.gray(t)} 🎯 TP watch ${side}: mark ${n(ctx?.mark)} vs target ${n(ctx?.target)} ${hit}`;
    }

    case 'market_opened': {
      const side = ctx?.side ?? '?';
      return `${color.gray(t)} 🚀 Abierto ${side} qty ${n(ctx?.qty, 4)} @ ~${n(ctx?.avgPrice)}`;
    }

    case 'stop_upserted':
    case 'ensure_stop_created': {
      const side = ctx?.side ?? '?';
      return `${color.gray(t)} ⛔ Stop ${side} @ ${n(ctx?.stop)}`;
    }

    case 'tp_upserted':
    case 'ensure_tp_created': {
      const side = ctx?.side ?? '?';
      return `${color.gray(t)} 🎯 TP ${side} @ ${n(ctx?.tp)}`;
    }

    case 'profit_guard_status': {
      // Línea resumida con ROE actual y pico
      return `${color.gray(t)} 🛡️ ROE ${p(ctx?.roe ?? 0)} (peak ${p(ctx?.peak ?? 0)})`;
    }

    case 'BE_protect_close':
    case 'Time_stop_close':
    case 'Giveback_close':
    case 'Early_fail_close': {
      const tag = msg.replace('_', ' ');
      return `${color.gray(t)} 🔒 ${color.warn(tag)} ${ctx ? color.dim(JSON.stringify(ctx)) : ''}`;
    }

    case 'signal': {
      const t = new Date().toLocaleTimeString();
      const a = ctx?.action ?? '?';
      const r = ctx?.reason ?? '';
      const emoji =
        a === 'ENTER_LONG' ? '🟢' : a === 'ENTER_SHORT' ? '🔻' : a === 'EXIT' ? '🚪' : '⏸️';

      // Log compacto: [hora] emoji ACCIÓN · razón
      return `${color.gray(t)} ${emoji}  ${color.bold(String(a))}${r ? ' · ' + r : ''}`;
    }

    default: {
      // Fallback: msg + pares clave=valor (plano, sin objetos anidados)
      const flat =
        ctx && typeof ctx === 'object'
          ? Object.entries(ctx)
              .filter(([_, v]) => typeof v !== 'object')
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')
          : '';
      return `${color.gray(t)} ${L(msg)}${flat ? ' ' + color.dim(flat) : ''}`;
    }
  }
}

// ===== Núcleo de escritura =====
function write(level: Level, msg: string, ctx?: any) {
  if (!should(level)) return;

  const payload = { ts: new Date().toISOString(), level, msg, ...(ctx ? { ctx } : {}) };

  // 1) Consola (pretty o JSON)
  if (PRETTY) {
    const line = prettyLine(level, msg, ctx);
    const out =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'info'
            ? console.log
            : console.debug;
    out(line);
  } else {
    const json = JSON.stringify(payload);
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(json);
  }

  // 2) Archivo siempre estructurado (si está habilitado)
  if (LOG_TO_FILE && !FILE_LOGGING_DISABLED) {
    const json = JSON.stringify(payload);
    append(todayPath(), json);
    // Compat línea plana
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

// Limpieza opcional al arranque
try {
  pruneOldLogs(LOG_RETAIN_DAYS);
} catch {}
