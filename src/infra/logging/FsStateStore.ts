// src/infra/fs/FsStateStore.ts
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { StateStore } from '../../app/ports/StateStore';
import { BotState } from '../../domain/types';

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
  private memoryCache: BotState;
  private isSaving: boolean = false;
  private pendingSave: boolean = false;

  constructor(private readonly key: string = 'default', private readonly scope = 'prod') {
    const scopeSuffix = this.scope ? `_${sanitizeKey(this.scope)}` : '';
    const keySuffix = key === 'default' ? '' : `_${sanitizeKey(key)}`;
    this.statePath = path.join(dataDir, `state${scopeSuffix}${keySuffix}.json`);

    // Carga inicial SÍNCRONA (solo al arrancar el bot, esto está bien)
    try {
      ensureDir();
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8');
        this.memoryCache = JSON.parse(raw) as BotState;
      } else {
        this.memoryCache = { ...defaultState };
      }
    } catch (err) {
      console.error('State load failed, using default', err);
      this.memoryCache = { ...defaultState };
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
    return new FsStateStore(`${this.key}_${sanitizeKey(symbol)}`, this.scope);
  }

  /**
   * Mecanismo de escritura no bloqueante con debounce simple.
   * Si ya estamos guardando, marcamos 'pendingSave' para guardar de nuevo al terminar.
   */
  private async scheduleDiskWrite() {
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }

    this.isSaving = true;

    try {
      // Escribir a archivo temporal primero (Atomic Write pattern)
      const tempPath = `${this.statePath}.tmp`;
      const data = JSON.stringify(this.memoryCache, null, 2);

      await fsPromises.writeFile(tempPath, data, 'utf8');
      await fsPromises.rename(tempPath, this.statePath);

    } catch (err) {
      console.error('State async save failed:', err);
    } finally {
      this.isSaving = false;
      // Si hubo cambios mientras guardábamos, lanzamos otra escritura
      if (this.pendingSave) {
        this.pendingSave = false;
        this.scheduleDiskWrite();
      }
    }
  }
}
