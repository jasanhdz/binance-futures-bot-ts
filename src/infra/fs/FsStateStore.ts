import fs from 'fs';
import path from 'path';
import { StateStore } from '../../core/ports/StateStore';
import { BotState } from '../../core/types';

const dataDir = path.resolve(__dirname, '../../../data');
const statePath = path.join(dataDir, 'state.json');

const defaultState: BotState = { mode: 'IDLE' };

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

export class FsStateStore implements StateStore {
  get(): BotState {
    try {
      ensureDir();
      if (!fs.existsSync(statePath)) return { ...defaultState };
      const raw = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(raw) as BotState;
    } catch {
      return { ...defaultState };
    }
  }

  set(patch: Partial<BotState>): BotState {
    const curr = this.get();
    const next = { ...curr, ...patch };
    ensureDir();
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  reset(): void {
    ensureDir();
    fs.writeFileSync(statePath, JSON.stringify(defaultState, null, 2), 'utf8');
  }
}
