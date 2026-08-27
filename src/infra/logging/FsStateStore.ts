// src/infra/fs/FsStateStore.ts
import fs from 'fs';
import fsPromises, { FileHandle } from 'fs/promises';
import path from 'path';
import { StateStore } from '../../app/ports/StateStore';
import { BotState } from '../../domain/types';

const dataDir = path.resolve(__dirname, '../../../data');
const defaultState: BotState = { mode: 'IDLE' };

function ensureDir(directory: string) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function sanitizeKey(key: string) {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export class FsStateStore implements StateStore {
  private readonly statePath: string;
  private memoryCache: BotState;
  private savePromise: Promise<void> | null = null;
  private pendingSave: boolean = false;
  private saveError: unknown;

  constructor(
    private readonly key: string = 'default',
    private readonly scope = 'prod',
    private readonly baseDir = dataDir,
  ) {
    const scopeSuffix = this.scope ? `_${sanitizeKey(this.scope)}` : '';
    const keySuffix = key === 'default' ? '' : `_${sanitizeKey(key)}`;
    this.statePath = path.join(baseDir, `state${scopeSuffix}${keySuffix}.json`);

    // Carga inicial SÍNCRONA (solo al arrancar el bot, esto está bien)
    try {
      ensureDir(baseDir);
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8');
        this.memoryCache = parseState(raw);
      } else {
        this.memoryCache = { ...defaultState };
      }
    } catch (err) {
      console.error('State load failed', err);
      const failure = new Error('BOT_STATE_LOAD_FAILED');
      (failure as Error & { cause?: unknown }).cause = err;
      throw failure;
    }
  }

  get(): BotState {
    // Lectura instantánea desde RAM (0ms de latencia)
    return { ...this.memoryCache };
  }

  set(patch: Partial<BotState>): BotState {
    // Update in memory
    const next = { ...this.memoryCache, ...patch };
    this.memoryCache = next;

    // Schedule async write
    this.scheduleDiskWrite();

    return next;
  }

  reset(): void {
    this.memoryCache = { ...defaultState };
    this.scheduleDiskWrite();
  }

  forSymbol(symbol: string): StateStore {
    return new FsStateStore(`${this.key}_${sanitizeKey(symbol)}`, this.scope, this.baseDir);
  }

  /**
   * Mecanismo de escritura no bloqueante con debounce simple.
   * Si ya estamos guardando, marcamos 'pendingSave' para guardar de nuevo al terminar.
   */
  private scheduleDiskWrite(): void {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.writeState().finally(() => {
      this.savePromise = null;
      if (this.pendingSave) {
        this.pendingSave = false;
        this.scheduleDiskWrite();
      }
    });
    void this.savePromise.catch(() => undefined);
  }

  async flush(): Promise<void> {
    while (this.savePromise || this.pendingSave) {
      if (!this.savePromise) {
        this.pendingSave = false;
        this.scheduleDiskWrite();
      }
      await this.savePromise;
    }
    if (this.saveError) {
      const error = this.saveError;
      this.saveError = undefined;
      throw error;
    }
  }

  private async writeState(): Promise<void> {
    const tempPath = `${this.statePath}.tmp`;
    const data = JSON.stringify(this.memoryCache, null, 2);
    let file: FileHandle | undefined;
    try {
      file = await fsPromises.open(tempPath, 'w');
      await file.writeFile(data, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await fsPromises.rename(tempPath, this.statePath);
      const directory = await fsPromises.open(this.baseDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (err) {
      this.saveError = err;
      console.error('State async save failed:', err);
      throw err;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
}

function parseState(raw: string): BotState {
  const state = JSON.parse(raw) as Partial<BotState>;
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    !['IDLE', 'LONG_RIDE', 'SHORT_RIDE'].includes(state.mode ?? '')
  ) {
    throw new Error('BOT_STATE_INVALID');
  }
  const dailyRisk = state.dailyRisk;
  if (
    dailyRisk !== undefined &&
    (!Number.isInteger(dailyRisk.dayKey) ||
      !Number.isInteger(dailyRisk.tradesToday) ||
      dailyRisk.tradesToday < 0 ||
      (dailyRisk.dailyStartBalance !== undefined &&
        dailyRisk.dailyStartBalance !== null &&
        (!Number.isFinite(dailyRisk.dailyStartBalance) || dailyRisk.dailyStartBalance <= 0)) ||
      !dailyRisk.strategyTradesToday ||
      typeof dailyRisk.strategyTradesToday !== 'object' ||
      Array.isArray(dailyRisk.strategyTradesToday) ||
      Object.entries(dailyRisk.strategyTradesToday).some(
        ([strategyId, count]) =>
          !['AEGIS_TURBO', 'MOMENTUM_RIDE', 'MICRO_BURST_V1'].includes(strategyId) ||
          !Number.isInteger(count) ||
          (count as number) < 0,
      ))
  ) {
    throw new Error('BOT_STATE_INVALID');
  }
  return state as BotState;
}
