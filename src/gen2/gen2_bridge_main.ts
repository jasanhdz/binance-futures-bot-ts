/**
 * GEN2 bridge entrypoint — standalone, NOT wired into the live bot's main.ts
 * and NOT installed in PM2. Run manually:
 *
 *   GEN2_BRIDGE_SECRET=... ts-node src/gen2/gen2_bridge_main.ts
 *
 * Env:
 *   GEN2_BRIDGE_SECRET      (required) HMAC secret shared with Aegis
 *   GEN2_BRIDGE_PORT        default 8791 (binds 127.0.0.1 only)
 *   GEN2_CANDIDATE_ID       default gen2-20260711T202935Z
 *   GEN2_ALLOWED_SYMBOLS    default ADAUSDT,DOGEUSDT
 *   GEN2_STATE_DIR          default logs/gen2_bridge
 *   GEN2_EXECUTION_ENABLED  'true' to bind the real exchange adapter; anything
 *                           else -> validate-only ACCEPTED_DRYRUN (default)
 *
 * Phase O pause state is read (read-only) from regime_config.live.yaml; if it
 * cannot be confirmed as paused, the bridge starts with phaseOAllowOrders=true
 * which makes validateOrder refuse every order (fail-closed).
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import { Gen2Bridge, Gen2ExchangePort } from './Gen2Bridge';
import { createGen2BridgeServer } from './Gen2BridgeServer';
import { BinanceGen2ExchangeAdapter } from './BinanceGen2ExchangeAdapter';
import { Gen2TelegramNotifier } from './Gen2TelegramNotifier';
import { TelegramService } from '../infra/adapters/TelegramAdapter';

// PM2/always-on: GEN2-specific secrets live in .env.gen2 (gitignored). Shared
// Binance/Telegram credentials are REUSED from the TS bot's existing .env — no
// duplication. dotenv is first-wins, so loading .env.gen2 first keeps GEN2 vars
// (bridge secret, execution flag, symbols) authoritative, and .env only fills in
// BINANCE_API_KEY/SECRET and TELEGRAM_* that .env.gen2 leaves unset. Explicit
// process env still wins over both.
dotenv.config({ path: process.env.GEN2_ENV_FILE || path.resolve(__dirname, '..', '..', '.env.gen2') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function readPhaseOAllowOrders(repoRoot: string): boolean {
  try {
    const cfg = yaml.load(fs.readFileSync(path.join(repoRoot, 'regime_config.live.yaml'), 'utf-8')) as any;
    const phase = cfg?.aegis?.phase_o_short_live;
    if (phase && phase.enabled === true && phase.allow_orders === false) return false;
    return true; // unknown/unpaused -> orders refused by validateOrder
  } catch {
    return true;
  }
}

/**
 * Execution enablement — SINGLE SOURCE OF TRUTH is gen2_config.yaml
 * execution_enabled. GEN2_EXECUTION_ENABLED is DENY-ONLY (can only force off).
 * config missing/invalid -> disabled. Default -> disabled.
 */
function readConfigExecutionEnabled(configPath: string): { enabled: boolean; valid: boolean; reason: string } {
  try {
    if (!fs.existsSync(configPath)) return { enabled: false, valid: false, reason: 'CONFIG_MISSING' };
    const cfg = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;
    if (!cfg || typeof cfg !== 'object') return { enabled: false, valid: false, reason: 'CONFIG_INVALID' };
    return { enabled: cfg.execution_enabled === true, valid: true, reason: 'OK' };
  } catch (e: any) {
    return { enabled: false, valid: false, reason: `CONFIG_READ_ERROR:${String(e?.message || e).slice(0, 60)}` };
  }
}

function emergencyDenyActive(): boolean {
  const v = process.env.GEN2_EXECUTION_ENABLED;
  return v !== undefined && ['false', '0', 'off', 'no', 'disable', 'disabled'].includes(v.trim().toLowerCase());
}

function main(): void {
  const secret = process.env.GEN2_BRIDGE_SECRET || '';
  if (!secret) {
    console.error(JSON.stringify({ fatal: 'GEN2_BRIDGE_SECRET_NOT_SET' }));
    process.exit(1);
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  const port = Number(process.env.GEN2_BRIDGE_PORT || 8791);
  const candidateId = process.env.GEN2_CANDIDATE_ID || 'gen2-20260711T202935Z';
  const allowedSymbols = (process.env.GEN2_ALLOWED_SYMBOLS || 'ADAUSDT,DOGEUSDT').split(',').map((s) => s.trim().toUpperCase());
  const stateDir = process.env.GEN2_STATE_DIR || path.join(repoRoot, 'logs', 'gen2_bridge');
  const apiKey = process.env.BINANCE_FUTURES_API_KEY || process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET || '';

  // SINGLE SOURCE OF TRUTH: config enables, env can only deny.
  // repoRoot = .../trading_system/binance-futures-bot-ts, and gen2_config.yaml
  // lives at .../aegis_gen2/gen2_config.yaml (a SIBLING of trading_system, per
  // GEN2_ROOT in aegis_alpha/tools/gen2_d3_common.py) -> two levels up, not one.
  const configPath = process.env.GEN2_CONFIG_PATH || path.resolve(repoRoot, '..', '..', 'aegis_gen2', 'gen2_config.yaml');
  const cfgExec = readConfigExecutionEnabled(configPath);
  const denyOverride = emergencyDenyActive();
  const credsPresent = Boolean(apiKey && apiSecret);
  const effectiveExecution = cfgExec.enabled && cfgExec.valid && !denyOverride && credsPresent;

  let exchange: Gen2ExchangePort | undefined;
  if (effectiveExecution) {
    exchange = new BinanceGen2ExchangeAdapter(apiKey, apiSecret);
  }
  const phaseOAllowOrders = readPhaseOAllowOrders(repoRoot);

  // Reuse the single existing Telegram client; redact HMAC secret and keys.
  const telegramEnabled = process.env.GEN2_TELEGRAM !== 'false';
  const notifier = new Gen2TelegramNotifier(
    (message: string) => TelegramService.sendAlert(message),
    () => Date.now(),
    [secret, apiKey, apiSecret].filter(Boolean),
  );

  const bridge = new Gen2Bridge({
    secret,
    candidateId,
    allowedSymbols,
    stateDir,
    executionEnabled: Boolean(exchange),
    phaseOAllowOrders,
    exchange,
    onEvent: telegramEnabled
      ? (event) => {
          void notifier.notifyEvent(event as { type: string; client_order_id?: string; payload?: Record<string, unknown> });
        }
      : undefined,
  });
  const server = createGen2BridgeServer({ bridge, allowedSymbols, exchange });
  // H12 time exits are risk-reducing: the scheduler runs regardless of the kill switch.
  setInterval(() => {
    bridge.processTimeExits().catch((err) => {
      console.error(JSON.stringify({ time_exit_scheduler_error: String(err?.message || err) }));
    });
  }, 30_000).unref();
  server.listen(port, '127.0.0.1', () => {
    const startup = {
      gen2_bridge: 'LISTENING',
      port,
      candidate_id: candidateId,
      allowed_symbols: allowedSymbols,
      config_execution_enabled: cfgExec.enabled,
      config_valid: cfgExec.valid,
      emergency_deny_override: denyOverride,
      effective_execution: effectiveExecution,
      phase_o_allow_orders: phaseOAllowOrders,
      state_dir: stateDir,
    };
    console.log(JSON.stringify(startup));
    if (telegramEnabled && !cfgExec.valid) {
      void notifier.notify(
        'CRITICAL',
        'GEN2 BRIDGE: config inválida',
        `execution config no legible (${cfgExec.reason}); ejecución DESHABILITADA (fail-closed).`,
        `bridge-config-invalid-${Date.now()}`,
      );
    }
    if (telegramEnabled) {
      void notifier.notify(
        'INFO',
        'GEN2 BRIDGE ONLINE',
        [
          `candidate: ${candidateId}`,
          `Execution config: ${cfgExec.enabled ? 'ENABLED' : 'DISABLED'}`,
          `Emergency deny override: ${denyOverride ? 'ON' : 'OFF'}`,
          `Effective execution: ${effectiveExecution ? 'ENABLED' : 'DISABLED (dry-run)'}`,
          `phase_o_allow_orders: ${phaseOAllowOrders}`,
          `allowed: ${allowedSymbols.join(' ')}`,
          `port: ${port} (127.0.0.1)`,
        ].join('\n'),
        `bridge-online-${Date.now()}`,
      );
    }
  });
}

main();
