import type { AggTradeEvent } from '../../app/ports/MarketData';
import { RollingAggTradeBuffer } from './RollingAggTradeBuffer';
import { processLocalCausalSequence } from './LocalCausalWatermark';

export type AggTradeStreamStatus = 'connecting' | 'open' | 'reconnecting';

export interface AggTradeLease<T extends RollingAggTradeBuffer> {
  readonly state: T;
  release(): void;
}

export interface AggTradeSubscriptionSource {
  subscribe(
    symbol: string,
    onEvent: (event: AggTradeEvent) => void,
    onStatus?: (status: AggTradeStreamStatus) => void,
  ): () => void;
}

type StateEntry<T extends RollingAggTradeBuffer> = {
  state: T;
  references: number;
  listeners: Set<(event: AggTradeEvent) => void>;
  unsubscribe: () => void;
  connectionGeneration: number;
};

/** Owns one canonical rolling AggTrade state and stream per symbol. */
export class AggTradeDataPlane<T extends RollingAggTradeBuffer = RollingAggTradeBuffer> {
  private readonly states = new Map<string, StateEntry<T>>();

  constructor(
    private readonly createState: (symbol: string) => T,
    private readonly source: AggTradeSubscriptionSource,
  ) {}

  acquire(symbol: string, listener?: (event: AggTradeEvent) => void): AggTradeLease<T> {
    const normalizedSymbol = symbol.toUpperCase();
    let entry = this.states.get(normalizedSymbol);
    if (!entry) {
      const state = this.createState(normalizedSymbol);
      const listeners = new Set<(event: AggTradeEvent) => void>();
      entry = {
        state,
        references: 0,
        listeners,
        unsubscribe: () => {},
        connectionGeneration: 0,
      };
      this.states.set(normalizedSymbol, entry);
      try {
        entry.unsubscribe = this.source.subscribe(
          normalizedSymbol,
          (event) => {
            if (this.states.get(normalizedSymbol)?.state !== entry!.state) return;
            const received = event.localCausality
              ? event
              : {
                  ...event,
                  localCausality: processLocalCausalSequence().receive(
                    Math.max(1, entry!.connectionGeneration),
                  ),
                };
            entry!.state.push(received);
            for (const consumer of entry!.listeners) consumer(received);
          },
          (status) => {
            if (this.states.get(normalizedSymbol)?.state !== entry!.state) return;
            if (status === 'connecting') entry!.connectionGeneration++;
            if (status === 'connecting' || status === 'reconnecting') {
              entry!.state.markContinuityUncertain();
            }
          },
        );
      } catch (error) {
        this.states.delete(normalizedSymbol);
        state.clear();
        throw error;
      }
    }

    entry.references++;
    if (listener) entry.listeners.add(listener);
    let released = false;
    return {
      state: entry.state,
      release: () => {
        if (released) return;
        released = true;
        const current = this.states.get(normalizedSymbol);
        if (!current || current.state !== entry!.state) return;
        if (listener) current.listeners.delete(listener);
        current.references--;
        if (current.references === 0) {
          this.states.delete(normalizedSymbol);
          try {
            current.unsubscribe();
          } catch {
            // Final cleanup must not leave a zombie registry entry.
          }
          current.state.clear();
        }
      },
    };
  }

  get(symbol: string): T | undefined {
    return this.states.get(symbol.toUpperCase())?.state;
  }

  getReferenceCount(symbol: string): number {
    return this.states.get(symbol.toUpperCase())?.references ?? 0;
  }

  close(): void {
    const entries = [...this.states.entries()];
    this.states.clear();
    for (const [, entry] of entries) {
      try {
        entry.unsubscribe();
      } catch {
        // Best-effort cleanup for all active symbols.
      }
      entry.state.clear();
    }
  }
}
