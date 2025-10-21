import fs from 'fs';
import path from 'path';
import { StateStore } from '../../core/ports/StateStore';
import { BotState } from '../../core/types';

const dataDir = path.resolve(__dirname, '../../../data');
const defaultState: BotState = { mode: 'IDLE' };

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function sanitizeKey(key: string) {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export class FsStateStore implements StateStore {
  private readonly statePath: string;

  constructor(private readonly key: string = 'default', private readonly scope = 'prod') {
    const scopeSuffix = this.scope ? `_${sanitizeKey(this.scope)}` : '';
    const keySuffix = key === 'default' ? '' : `_${sanitizeKey(key)}`;
    this.statePath = path.join(dataDir, `state${scopeSuffix}${keySuffix}.json`);
  }

  get(): BotState {
    try {
      ensureDir();
      if (!fs.existsSync(this.statePath)) return { ...defaultState };
      const raw = fs.readFileSync(this.statePath, 'utf8');
      return JSON.parse(raw) as BotState;
    } catch {
      return { ...defaultState };
    }
  }

  set(patch: Partial<BotState>): BotState {
    const curr = this.get();
    const next = { ...curr, ...patch };
    ensureDir();
    fs.writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  reset(): void {
    ensureDir();
    fs.writeFileSync(this.statePath, JSON.stringify(defaultState, null, 2), 'utf8');
  }
}
