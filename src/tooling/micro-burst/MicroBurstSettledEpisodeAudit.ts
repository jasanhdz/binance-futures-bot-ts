import Database from 'better-sqlite3';

interface Fill {
  id: string;
  orderId: string;
  price: number;
  quantity: number;
  eventTimeMs: number;
}

/** Local persisted settlement evidence only; never connects to the exchange. */
export function auditSettledEpisodes(databasePath: string, tradeIds: readonly string[]): unknown {
  if (!tradeIds.length) throw new Error('TRADE_IDS_REQUIRED');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const episodes = new Set<string>();
      const trades = tradeIds.map((tradeId) => {
        const row = db
          .prepare(
            'SELECT identity, evidence, result, conflicted FROM micro_loss_trades WHERE trade_id = ?',
          )
          .get(tradeId) as
          | { identity: string; evidence: string; result: string; conflicted: number }
          | undefined;
        if (!row || row.conflicted) throw new Error(`MISSING_OR_CONFLICTED_SETTLEMENT:${tradeId}`);
        const identity = JSON.parse(row.identity);
        const evidence = JSON.parse(row.evidence);
        const result = JSON.parse(row.result);
        if (
          result?.status !== 'VERIFIED' ||
          !evidence?.fillsComplete ||
          !evidence?.fundingComplete ||
          !evidence?.exactOrdersFilledAndPositionFlat
        )
          throw new Error(`INCOMPLETE_SETTLEMENT:${tradeId}`);
        if (!identity.episodeId || episodes.has(identity.episodeId))
          throw new Error(`DUPLICATE_OR_MISSING_EPISODE:${tradeId}`);
        episodes.add(identity.episodeId);
        const fills: Fill[] = evidence.fills;
        const ids = new Set<string>();
        for (const fill of fills) {
          if (
            ids.has(fill.id) ||
            ![fill.price, fill.quantity, fill.eventTimeMs].every(
              (value) => Number.isFinite(value) && value > 0,
            )
          )
            throw new Error(`INVALID_FILL:${tradeId}`);
          ids.add(fill.id);
        }
        const summarize = (selected: Fill[]) => {
          const quantity = selected.reduce((sum, fill) => sum + fill.quantity, 0);
          if (!selected.length || Math.abs(quantity - identity.quantity) > 1e-8)
            throw new Error(`FILL_QUANTITY_MISMATCH:${tradeId}`);
          const notional = selected.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
          return {
            quantity,
            notional,
            vwap: notional / quantity,
            firstFillAtMs: Math.min(...selected.map((fill) => fill.eventTimeMs)),
            lastFillAtMs: Math.max(...selected.map((fill) => fill.eventTimeMs)),
          };
        };
        const entry = summarize(fills.filter((fill) => fill.orderId === identity.entryOrderId));
        const exit = summarize(
          fills.filter((fill) => identity.closeOrderIds.includes(fill.orderId)),
        );
        return {
          tradeId,
          episodeId: identity.episodeId,
          symbol: identity.symbol,
          side: identity.side,
          configHash: identity.configHash,
          codeCommitSha: identity.codeCommitSha,
          entry,
          exit,
          fillToFillDurationMs: exit.lastFillAtMs - entry.firstFillAtMs,
          ...result,
          netReturnOnEntryNotionalBps: (result.netPnlUsdt / entry.notional) * 10_000,
          commissionsBps: (result.commissionsUsdt / entry.notional) * 10_000,
          mfeBps: null,
          maeBps: null,
          trajectoryStatus: 'NOT_ESTIMABLE_FROM_SETTLEMENT_FILLS',
        };
      });
      return {
        authority: 'READ_ONLY_DESCRIPTIVE_AUDIT',
        lossState: db
          .prepare('SELECT initialized, revision, epoch, streak, halted FROM micro_loss_state')
          .get(),
        independentEpisodes: trades.length,
        netPnlUsdt: trades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0),
        selection: 'EXPLICIT_TRADE_IDS_NOT_AN_UNBIASED_STRATEGY_SAMPLE',
        trades,
      };
    })();
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [databasePath, ...tradeIds] = process.argv.slice(2);
  if (!databasePath)
    throw new Error('USAGE: MicroBurstSettledEpisodeAudit <sqlite-path> <trade-id> [...]');
  console.log(JSON.stringify(auditSettledEpisodes(databasePath, tradeIds), null, 2));
}
