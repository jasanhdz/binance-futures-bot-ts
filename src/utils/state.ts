// src/utils/state.ts
import fs from 'fs';
import path from 'path';

type Mode = 'IDLE' | 'LONG_RIDE' | 'SHORT_RIDE';

export type BotState = {
  mode: Mode;
  lastSide?: 'LONG' | 'SHORT';
  lastEntryPrice?: number;
  lastTPAt?: number; // timestamp ms del último TP
  lastExitReason?: string; // 'tp' | 'cut' | ...
};

const dataDir = path.resolve(__dirname, '../../data');
const statePath = path.join(dataDir, 'state.json');

const defaultState: BotState = { mode: 'IDLE' };

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
}

export function getState(): BotState {
  try {
    ensureDir();
    if (!fs.existsSync(statePath)) return { ...defaultState };
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw) as BotState;
  } catch {
    return { ...defaultState };
  }
}

export function setState(patch: Partial<BotState>) {
  const curr = getState();
  const next = { ...curr, ...patch };
  ensureDir();
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function resetState() {
  setState({ ...defaultState });
}
