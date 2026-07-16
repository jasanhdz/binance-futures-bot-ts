/**
 * Position Ownership — the strategy-agnostic contract that lets ONE TypeScript
 * executor run many strategies (PHASE_O, GEN2, MANUAL, future models) over the
 * same wallet without any of them managing another's positions.
 *
 * Root cause this fixes: TradingService.attachOpenExchangePositionsToSymbolState
 * adopted ANY open position on its symbols and applied Phase O's exit logic. A
 * Gen2 DOGE short was adopted and closed by Phase O's TIME_LIMIT, contaminating
 * the scientific evidence. Ownership makes every position's owner explicit and
 * persistent, so the executor only manages what it owns.
 *
 * Discriminator (verified against live orders): Gen2 sets newClientOrderId with a
 * `GEN2-` prefix; Phase O sets none (Binance auto-generates a random id). The
 * persistent registry records the explicit owner+policy for every order the bots
 * place; classification falls back to the id prefix when the registry is cold.
 */
import fs from 'fs';
import path from 'path';

export type Owner = 'PHASE_O' | 'GEN2' | 'MANUAL' | 'UNKNOWN';

export interface StrategyContext {
  owner: Owner;
  strategy: string; // e.g. AEGIS_TURBO, GEN2_EQM_TRRM
  exitPolicy: string; // e.g. PHASE_O_FULL, GEN2_H12
  riskPolicy: string; // e.g. PHASE_O_LIVE, GEN2_EXPERIMENTAL
  notificationPolicy: string; // e.g. PHASE_O, GEN2
}

export interface OwnershipRecord extends StrategyContext {
  clientOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
}

export const GEN2_CLIENT_ORDER_PREFIX = 'GEN2-';

/** Owner implied by a clientOrderId when the registry has no explicit record. */
export function classifyClientOrderId(clientOrderId: string | undefined | null): Owner {
  if (!clientOrderId) return 'UNKNOWN';
  if (clientOrderId.startsWith(GEN2_CLIENT_ORDER_PREFIX)) return 'GEN2';
  return 'UNKNOWN';
}

export class PositionOwnershipRegistry {
  private records: Record<string, OwnershipRecord> = {};

  constructor(private filePath: string) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath)) {
      try {
        this.records = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        this.records = {}; // corrupt registry -> start empty; entries re-register on next order
      }
    }
  }

  private persist(): void {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /** Register (idempotently) the owner+policy of an order at placement time. */
  register(record: OwnershipRecord): void {
    if (!record.clientOrderId) return;
    if (this.records[record.clientOrderId]) return; // first write wins; ownership is immutable
    this.records[record.clientOrderId] = record;
    this.persist();
  }

  get(clientOrderId: string): OwnershipRecord | undefined {
    return this.records[clientOrderId];
  }

  /**
   * Resolve the owner of a position from the clientOrderIds that opened it.
   * Registry record wins; otherwise the id prefix; otherwise UNKNOWN. If several
   * ids resolve to different owners, GEN2 wins (fail-safe: never let Phase O
   * adopt a position that any GEN2 order touched).
   */
  resolveOwner(openingClientOrderIds: Array<string | undefined | null>): { owner: Owner; record?: OwnershipRecord } {
    let fallback: Owner = 'UNKNOWN';
    for (const id of openingClientOrderIds) {
      if (!id) continue;
      const rec = this.records[id];
      if (rec) {
        if (rec.owner === 'GEN2') return { owner: 'GEN2', record: rec };
        fallback = rec.owner;
      } else if (classifyClientOrderId(id) === 'GEN2') {
        return { owner: 'GEN2' };
      }
    }
    return { owner: fallback };
  }
}
