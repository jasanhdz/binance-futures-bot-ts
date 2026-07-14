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

// PM2/always-on: secrets live in .env.gen2 (gitignored), loaded at boot.
// Explicit env vars still win over the file.
dotenv.config({ path: process.env.GEN2_ENV_FILE || path.resolve(__dirname, '..', '..', '.env.gen2') });

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
  const executionRequested = process.env.GEN2_EXECUTION_ENABLED === 'true';
  const apiKey = process.env.BINANCE_FUTURES_API_KEY || process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET || '';

  let exchange: Gen2ExchangePort | undefined;
  if (executionRequested && apiKey && apiSecret) {
    exchange = new BinanceGen2ExchangeAdapter(apiKey, apiSecret);
  }
  const phaseOAllowOrders = readPhaseOAllowOrders(repoRoot);
  const bridge = new Gen2Bridge({
    secret,
    candidateId,
    allowedSymbols,
    stateDir,
    executionEnabled: Boolean(exchange),
    phaseOAllowOrders,
    exchange,
  });
  const server = createGen2BridgeServer({ bridge, allowedSymbols, exchange });
  // H12 time exits are risk-reducing: the scheduler runs regardless of the kill switch.
  setInterval(() => {
    bridge.processTimeExits().catch((err) => {
      console.error(JSON.stringify({ time_exit_scheduler_error: String(err?.message || err) }));
    });
  }, 30_000).unref();
  server.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        gen2_bridge: 'LISTENING',
        port,
        candidate_id: candidateId,
        allowed_symbols: allowedSymbols,
        execution_enabled: Boolean(exchange),
        execution_requested: executionRequested,
        phase_o_allow_orders: phaseOAllowOrders,
        state_dir: stateDir,
      }),
    );
  });
}

main();
