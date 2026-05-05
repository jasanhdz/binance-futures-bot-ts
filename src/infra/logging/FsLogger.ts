import fs from 'fs';
import path from 'path';
import type { Logger } from '../../app/ports/Logger';
import Table from 'cli-table3';
import { TelegramService } from '../adapters/TelegramAdapter';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

export const COLORS = {
  RESET,
  RED,
  GREEN,
  CYAN,
};

export const zoneBadge = (z?: string) => {
  switch (z) {
    case 'SUPPORT':
      return color.ok('🛡️ SUPPORT');
    case 'RESISTANCE':
      return color.error('🧱 RESISTANCE');
    case 'MIDDLE':
      return color.gray('⚖️ MIDDLE');
    case 'LOWER_RANGE':
      return color.info('⬇️ LOWER');
    case 'UPPER_RANGE':
      return color.info('⬆️ UPPER');
    default:
      return color.gray('—');
  }
};

export const trendBadge = (dir?: string) => {
  switch (dir) {
    case 'STRONG_BULL':
      return color.ok('⚡ STRONG BULL') + ' 📈';
    case 'BULL':
      return color.ok('🟢 BULL');
    case 'NEUTRAL':
      return color.warn('🟡 NEUTRAL');
    case 'BEAR':
      return color.error('🔴 BEAR');
    case 'STRONG_BEAR':
      return color.error('⚡ STRONG BEAR') + ' 📉';
    default:
      return color.gray('⚪ UNKNOWN');
  }
};

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
        } catch { }
      }
    }
  } catch { }
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

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatUsd = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const formatted = usdFormatter.format(value);
  if (value > 0) return color.ok(formatted);
  if (value < 0) return color.error(formatted);
  return color.gray(formatted);
};

const formatRoiPct = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const formatted = `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (value > 0) return color.ok(formatted);
  if (value < 0) return color.error(formatted);
  return color.gray(formatted);
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
      if (ctx?.message) return `${color.gray(t)} ${ctx.message}`;
      const side = ctx?.side ?? '?';
      const s = ctx?.symbol ? color.info(ctx.symbol.padEnd(8)) : '';
      return `${color.gray(t)} ⛔ ${s} Stop ${side} @ ${n(ctx?.stop)}`;
    }

    case 'tp_upserted':
    case 'ensure_tp_created': {
      if (ctx?.message) return `${color.gray(t)} ${ctx.message}`;
      const side = ctx?.side ?? '?';
      const s = ctx?.symbol ? color.info(ctx.symbol.padEnd(8)) : '';
      return `${color.gray(t)} 🎯 ${s} TP ${side} @ ${n(ctx?.tp)}`;
    }

    case 'profit_guard_status': {
      // Línea resumida con ROE actual y pico
      return `${color.gray(t)} 🛡️ ROE ${p(ctx?.roe ?? 0)} (peak ${p(ctx?.peak ?? 0)})`;
    }

    case 'position_snapshot': {
      const table = new Table({
        head: [
          color.gray('Time'),
          color.gray('Symbol'),
          color.gray('Side'),
          color.gray('Entry'),
          color.gray('Mark'),
          color.gray('ROI %'),
          color.gray('Cond'),
          color.gray('PnL (USDT)'),
          color.gray('Qty'),
          color.gray('Lev'),
          color.gray('Open (s)'),
        ],
      });

      const fmt = (value: unknown, digits = 6) =>
        typeof value === 'number' && Number.isFinite(value)
          ? value.toFixed(digits)
          : value !== undefined
            ? String(value)
            : '—';

      const openSecs =
        typeof ctx?.openMs === 'number' && Number.isFinite(ctx.openMs)
          ? (ctx.openMs / 1000).toFixed(0)
          : '—';

      const prob = (() => {
        if (typeof ctx?.probCond === 'string') {
          return { text: ctx.probCond, above: ctx?.probAbove } as const;
        }
        const lp = typeof ctx?.longProb === 'number' ? ctx.longProb : undefined;
        const sp = typeof ctx?.shortProb === 'number' ? ctx.shortProb : undefined;
        const th = typeof ctx?.probThreshold === 'number' ? ctx.probThreshold : undefined;
        if (lp === undefined && sp === undefined && th === undefined) return { text: '—', above: undefined } as const;

        const fmtProb = (v?: number) =>
          typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
        const base = `(L=${fmtProb(lp)} | S=${fmtProb(sp)})`;
        if (th === undefined) return { text: base, above: undefined } as const;

        const sideProb = ctx?.side === 'LONG' ? lp : ctx?.side === 'SHORT' ? sp : undefined;
        const bestProb = Math.max(lp ?? Number.NEGATIVE_INFINITY, sp ?? Number.NEGATIVE_INFINITY);
        const refProb = sideProb ?? (bestProb > Number.NEGATIVE_INFINITY ? bestProb : undefined);
        if (refProb === undefined) return { text: `${base} t=${th.toFixed(2)}`, above: undefined } as const;

        const above = refProb > th;
        const comparator = above ? '>' : '<';
        return { text: `${base} ${comparator} t=${th.toFixed(2)}`, above } as const;
      })();

      const probText =
        prob.text === '—'
          ? color.gray(prob.text)
          : prob.above === true
            ? color.ok(prob.text)
            : prob.above === false
              ? color.warn(prob.text)
              : color.dim(prob.text);

      table.push([
        color.gray(t),
        color.info(String(ctx?.symbol ?? '—')),
        String(ctx?.side ?? '—'),
        fmt(ctx?.entry),
        fmt(ctx?.mark),
        formatRoiPct(ctx?.roiPct),
        probText,
        formatUsd(ctx?.pnlUsd),
        fmt(ctx?.qtyAbs, 4),
        fmt(ctx?.leverage, 0),
        openSecs,
      ]);

      return table.toString();
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
      const s = ctx?.symbol ? color.info(ctx.symbol.padEnd(8)) : '';
      const a = ctx?.action ?? '?';
      const r = ctx?.reason ?? '';
      const emoji =
        a === 'ENTER_LONG' ? '🟢' : a === 'ENTER_SHORT' ? '🔻' : a === 'EXIT' ? '🚪' : '⏸️';

      // Log compacto: [hora] emoji ACCIÓN · razón
      return `${color.gray(t)} ${emoji}  ${s} ${color.bold(String(a))}${r ? ' · ' + r : ''}`;
    }

    // 1) Agrega este case dentro de prettyLine(level, msg, ctx)
    case 'market_snapshot': {
      const t = new Date().toLocaleTimeString();

      const n = (x: any, d = 4) =>
        typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—';
      const pct = (x?: number, d = 2) =>
        typeof x === 'number' && Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : '—';

      const sgn = (x?: number, s?: string) =>
        typeof x === 'number'
          ? (x > 0 ? color.ok : x < 0 ? color.error : color.gray)(s ?? String(x))
          : color.gray('—');

      const line1 =
        `${color.gray(t)} ${color.info('💹 market')} ${color.gray('•')} ` +
        `P:${color.bold(n(ctx?.price))} ${color.gray('│')} ` +
        `R:${color.error(n(ctx?.resistance))} ` +
        `S:${color.ok(n(ctx?.support))} ${color.gray('│')} ` +
        `${zoneBadge(ctx?.zone)}`;

      const t10 = typeof ctx?.t10 === 'number' ? ctx.t10 : undefined;
      const t5 = typeof ctx?.t5 === 'number' ? ctx.t5 : undefined;
      const line2 =
        ` ${trendBadge(ctx?.trend)} ${color.gray('│')} ` +
        `T10:${sgn(t10, pct(t10))} ${color.gray('·')} ` +
        `T5:${sgn(t5, pct(t5))} ${color.gray('│')} ` +
        `RSI:${n(ctx?.rsi, 1)} ${color.gray('·')} ADX:${n(ctx?.adx, 1)} ${color.gray('·')} ` +
        `BBW:${pct(ctx?.bbw, 2)}`;

      // (Opcional) Estructura de EMAs si las mandas en ctx
      const line3 =
        typeof ctx?.ema7 === 'number' &&
          typeof ctx?.ema25 === 'number' &&
          typeof ctx?.ema99 === 'number'
          ? `${color.gray('   └ ')}EMA7:${n(ctx.ema7)}  EMA25:${n(ctx.ema25)}  EMA99:${n(ctx.ema99)}`
          : '';

      return line1 + '\n' + line2 + (line3 ? '\n' + line3 : '');
    }

    case 'phantom_tick': {
      const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const s = ctx?.symbol ? ctx.symbol.replace('USDT', '') : '';
      const price = ctx?.price ? ctx.price.toFixed(2) : '0.00';

      // MODE 1: COMBAT (Active Position)
      if (ctx?.pnl !== undefined && ctx?.roe !== undefined) {
        const pnl = ctx.pnl;
        const roe = ctx.roe;
        const pnlColor = pnl >= 0 ? color.ok : color.error;
        const pnlSign = pnl >= 0 ? '+' : '-';
        const pnlStr = `${pnlSign}$${Math.abs(pnl).toFixed(2)}`;
        const roeStr = `${pnlSign}${Math.abs(roe).toFixed(2)}%`;

        const sideIcon = ctx.action === 'SHORT' ? '🔻' : '🔺';
        const sideText = ctx.action || 'POS';

        return `${color.gray(`[${t}]`)} ${sideIcon} ${color.bold(`${sideText} ${s}`)} @ $${price} | 💰 PnL: ${pnlColor(`${pnlStr} (${roeStr})`)}`;
      }

      // MODE 2: HUNT (Idle)
      const sp = ctx?.shortProb || 0;
      const lp = ctx?.longProb || 0;
      const th = ctx?.threshold || 0.55;

      const spColor = sp > th ? color.ok : color.dim;
      const lpColor = lp > th ? color.ok : color.dim;

      // Parse Blockers from Flags
      const f = ctx?.flags || {};
      const blockers: string[] = [];

      if (!f.near_resistance) blockers.push('RES');
      if (!f.is_tired) blockers.push('TIRED');
      if (!f.is_volatile) blockers.push('VOL');
      if (!f.is_rejection) blockers.push('REJ');

      const blockerText = blockers.length > 0
        ? `${color.error('🛑 Blocker:')} [${blockers.join('|')}]`
        : `${color.ok('✅ READY')}`;

      return `${color.gray(`[${t}]`)} 🔍 ${color.info(s)}: $${price} | ⚡ L:${lpColor(lp.toFixed(2))} S:${spColor(sp.toFixed(2))} ${color.gray(`(Req: ${th.toFixed(2)})`)} | ${blockerText}`;
    }

    case 'aegis_scan': {
      const s = ctx?.symbol ? color.info(String(ctx.symbol).padEnd(8)) : '';
      const rawAction = ctx?.turboRawAction ?? '—';
      const rawScore = typeof ctx?.turboRawScore === 'number' ? ctx.turboRawScore.toFixed(3) : '—';
      const gatedAction = ctx?.turboGatedAction ?? '—';
      const gatedReason = ctx?.turboGatedReason ?? '—';
      const safeReason = ctx?.safeReason ?? '—';
      return `${color.gray(t)} 🛡️ Aegis ${s} raw=${color.bold(String(rawAction))}/${rawScore} gated=${String(gatedAction)} reason=${String(gatedReason)} safe=${String(safeReason)}`;
    }

    case 'aegis_micro_live_gate_denied': {
      const s = ctx?.symbol ? color.info(String(ctx.symbol).padEnd(8)) : '';
      const score = typeof ctx?.turboScore === 'number' ? ctx.turboScore.toFixed(3) : '—';
      const reason = ctx?.reason ?? 'unknown';
      const blockedBy = ctx?.gatedBlockedBy ? ` blockedBy=${ctx.gatedBlockedBy}` : '';
      return `${color.gray(t)} 🛡️ AegisGate ${s} ${color.warn('DENIED')} reason=${String(reason)} score=${score}${blockedBy}`;
    }

    case 'aegis_micro_live_gate_allowed_dry_run': {
      const s = ctx?.symbol ? color.info(String(ctx.symbol).padEnd(8)) : '';
      const score = typeof ctx?.turboScore === 'number' ? ctx.turboScore.toFixed(3) : '—';
      return `${color.gray(t)} ⚡ AegisGate ${s} ${color.warn('ALLOWED DRY-RUN')} side=${ctx?.side ?? '—'} lev=${ctx?.leverage ?? '—'}x frac=${ctx?.positionFraction ?? '—'} score=${score}`;
    }

    // Otherwise, use Table (Active Position)



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

  // 3) Telegram System Log (Errors & Warnings)
  if (level === 'error') {
    const ctxStr = ctx ? `\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`` : '';
    TelegramService.sendSystemLog(`🔴 *SYSTEM ERROR* 🔴\n\n*Type:* ${msg}${ctxStr}`)
      .catch((e: any) => console.error('[FsLogger] Failed to send Telegram error:', e));
  } else if (level === 'warn') {
    // Optional: Uncomment to send warnings too, or filter specific ones
    // const ctxStr = ctx ? `\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`` : '';
    // TelegramService.sendSystemLog(`⚠️ *SYSTEM WARNING* ⚠️\n\n*Type:* ${msg}${ctxStr}`)
    //    .catch(e => console.error('[FsLogger] Failed to send Telegram warning:', e));
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
} catch { }
