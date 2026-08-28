import * as fs from 'fs';
import * as path from 'path';
import {
  MicroBurstPaperLifecycleEvent,
  MicroBurstPaperPosition,
} from '../../domain/strategies/micro-burst/MicroBurstPaperTrading';

const DEFAULT_TRADE_DIR = 'logs/micro-burst/shadow-trades';
const DEFAULT_EVENT_DIR = 'logs/micro-burst/shadow-trade-events';

export class MicroBurstPaperTradeJournal {
  private readonly positions = new Map<string, MicroBurstPaperPosition>();
  private readonly malformed: string[] = [];

  constructor(
    private readonly tradeDir = DEFAULT_TRADE_DIR,
    private readonly eventDir = DEFAULT_EVENT_DIR,
  ) {
    this.load();
  }

  loadOpenPositions(): MicroBurstPaperPosition[] {
    const open = [...this.positions.values()].filter((position) => position.state !== 'CLOSED');
    const symbols = new Set<string>();
    for (const position of open) {
      if (symbols.has(position.symbol))
        throw new Error(`PAPER_POSITION_AMBIGUOUS:${position.symbol}`);
      symbols.add(position.symbol);
    }
    return open.map((position) => ({ ...position }));
  }

  loadAllPositions(): MicroBurstPaperPosition[] {
    const latest = new Map<string, MicroBurstPaperPosition>();
    if (!fs.existsSync(this.tradeDir)) return [];
    for (const file of fs
      .readdirSync(this.tradeDir)
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort()) {
      const content = fs.readFileSync(path.join(this.tradeDir, file), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const position = JSON.parse(line) as MicroBurstPaperPosition;
          if (position.tradeId) latest.set(position.tradeId, position);
        } catch {
          // Health is reported by the constructor load pass.
        }
      }
    }
    return [...latest.values()];
  }

  loadAllEvents(): MicroBurstPaperLifecycleEvent[] {
    const events: MicroBurstPaperLifecycleEvent[] = [];
    if (!fs.existsSync(this.eventDir)) return events;
    for (const file of fs
      .readdirSync(this.eventDir)
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort()) {
      for (const line of fs.readFileSync(path.join(this.eventDir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as MicroBurstPaperLifecycleEvent);
        } catch {
          this.malformed.push(`${file}:event`);
        }
      }
    }
    return events;
  }

  appendPosition(position: MicroBurstPaperPosition): void {
    this.append(this.tradeDir, position, position.openedAtMs);
    if (position.state === 'CLOSED') this.positions.delete(position.tradeId);
    else this.positions.set(position.tradeId, { ...position });
  }

  appendEvent(event: MicroBurstPaperLifecycleEvent): void {
    this.append(this.eventDir, event, event.eventAtMs);
  }

  flush(): void {
    // Writes are synchronous and fsync'd at append time.
  }

  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: this.malformed.length === 0, malformedCount: this.malformed.length };
  }

  private load(): void {
    if (!fs.existsSync(this.tradeDir)) return;
    for (const file of fs
      .readdirSync(this.tradeDir)
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort()) {
      const content = fs.readFileSync(path.join(this.tradeDir, file), 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (!line.trim()) continue;
        try {
          const position = JSON.parse(line) as MicroBurstPaperPosition;
          if (!position.tradeId || !position.symbol || !position.state)
            throw new Error('invalid_position');
          if (position.state === 'CLOSED') this.positions.delete(position.tradeId);
          else this.positions.set(position.tradeId, position);
        } catch {
          this.malformed.push(`${file}:${index + 1}`);
        }
      }
    }
  }

  private append(directory: string, value: unknown, eventAtMs: number): void {
    const date = new Date(eventAtMs).toISOString().slice(0, 10);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${date}.jsonl`);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
