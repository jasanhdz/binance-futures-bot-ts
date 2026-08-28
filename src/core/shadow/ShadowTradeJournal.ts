import * as fs from 'node:fs';
import * as path from 'node:path';
import { ShadowPositionKey, serializeShadowPositionKey } from './ShadowPositionKey';
import { ShadowPosition, ShadowTradeEvent } from './ShadowTradingTypes';

export interface ShadowJournal {
  appendPosition(position: ShadowPosition): void;
  appendEvent(event: ShadowTradeEvent): void;
  loadOpenPositions(): ShadowPosition[];
  loadAllPositions(): ShadowPosition[];
  loadAllEvents(): ShadowTradeEvent[];
  getHealth(): { healthy: boolean; malformedCount: number };
  loadRecoveryBlockedKeys?(): ShadowPositionKey[];
  flush(): void;
}

export class FileShadowTradeJournal implements ShadowJournal {
  private readonly positions = new Map<string, ShadowPosition>();
  private readonly malformed: string[] = [];
  private readonly recoveryBlocked = new Map<string, ShadowPositionKey>();

  constructor(
    private readonly tradeDir: string,
    private readonly eventDir: string,
  ) {
    this.loadPositions();
  }

  appendPosition(position: ShadowPosition): void {
    this.append(this.tradeDir, position, position.openedAtMs);
    this.positions.set(position.tradeId, position);
  }

  appendEvent(event: ShadowTradeEvent): void {
    this.append(this.eventDir, event, event.eventAtMs);
  }

  loadOpenPositions(): ShadowPosition[] {
    const byKey = new Map<string, ShadowPosition>();
    for (const position of this.positions.values()) {
      if (position.state === 'CLOSED') continue;
      const key = serializeShadowPositionKey(position.key);
      if (this.recoveryBlocked.has(key)) continue;
      if (byKey.has(key)) {
        this.recoveryBlocked.set(key, position.key);
        byKey.delete(key);
        continue;
      }
      byKey.set(key, position);
    }
    return [...byKey.values()].map((position) => ({ ...position }));
  }

  loadRecoveryBlockedKeys(): ShadowPositionKey[] {
    return [...this.recoveryBlocked.values()];
  }

  loadAllPositions(): ShadowPosition[] {
    return [...this.positions.values()].map((position) => ({ ...position }));
  }

  loadAllEvents(): ShadowTradeEvent[] {
    const events: ShadowTradeEvent[] = [];
    for (const file of this.files(this.eventDir)) {
      for (const [index, line] of fs
        .readFileSync(path.join(this.eventDir, file), 'utf8')
        .split('\n')
        .entries()) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as ShadowTradeEvent);
        } catch {
          this.malformed.push(`${file}:${index + 1}`);
        }
      }
    }
    return events;
  }

  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: this.malformed.length === 0, malformedCount: this.malformed.length };
  }

  flush(): void {}

  private loadPositions(): void {
    for (const file of this.files(this.tradeDir)) {
      for (const [index, line] of fs
        .readFileSync(path.join(this.tradeDir, file), 'utf8')
        .split('\n')
        .entries()) {
        if (!line.trim()) continue;
        try {
          const position = JSON.parse(line) as ShadowPosition;
          if (!position.tradeId || !position.key?.strategyId || !position.key?.symbol)
            throw new Error('invalid_position');
          if (position.state === 'CLOSED') this.positions.delete(position.tradeId);
          else this.positions.set(position.tradeId, position);
        } catch {
          this.malformed.push(`${file}:${index + 1}`);
        }
      }
    }
  }

  private append(directory: string, value: unknown, atMs: number): void {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${new Date(atMs).toISOString().slice(0, 10)}.jsonl`);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private files(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.jsonl'))
      .sort();
  }
}

export function assertShadowKey(position: ShadowPosition, key: ShadowPositionKey): void {
  if (serializeShadowPositionKey(position.key) !== serializeShadowPositionKey(key))
    throw new Error('SHADOW_POSITION_KEY_MISMATCH');
}
