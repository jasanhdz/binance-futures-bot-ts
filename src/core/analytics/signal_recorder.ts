// src/core/analytics/signal_recorder.ts
import fs from 'fs';
import path from 'path';

type SignalPayload = {
  ts: number;
  symbol: string;
  action: string;
  reason?: string;
  price?: number;
  extras?: Record<string, unknown>;
};

const dataDir = path.resolve(__dirname, '../../../data');
const suffix = process.env.IS_TESTNET === '1' ? '_testnet' : '';
const logPath = path.join(dataDir, `signals${suffix}.ndjson`);

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

export function recordSignal(payload: SignalPayload) {
  try {
    ensureDir();
    const line = JSON.stringify(payload);
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // logging failure should not crash the bot
    if (process.env.DEBUG_SIGNAL_RECORDER === '1') {
      console.error('signal_record_fail', err);
    }
  }
}
