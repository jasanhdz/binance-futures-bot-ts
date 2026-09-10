import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import {
  reconcileMicroBurstEconomics,
  validMicroBurstEconomicIdentity,
  type MicroBurstEconomicIdentity,
} from '../src/strategies/micro-burst/domain/MicroBurstSettlement';

// No bootstrap, journal, state store or order mutation. Output is evidence, not a reset command.
async function main(): Promise<void> {
  const [tradeId, symbol, side, quantity, entryOrderId, closes, opened, closed] =
    process.argv.slice(2);
  const identity: MicroBurstEconomicIdentity = {
    tradeId,
    symbol,
    side: side as 'LONG' | 'SHORT',
    quantity: Number(quantity),
    entryOrderId,
    closeOrderIds: closes?.split(',') ?? [],
    openedAtMs: Date.parse(opened),
    closedAtMs: Date.parse(closed),
  };
  if (process.argv.length !== 10 || !validMicroBurstEconomicIdentity(identity))
    throw new Error(
      'Expected: tradeId symbol LONG|SHORT quantity entryOrderId closeOrderIdsCSV openedISO closedISO',
    );
  const exchange = new BinanceExchange({ info() {}, warn() {}, error() {}, debug() {} });
  const evidence = await exchange.readHistoricalMicroSettlement(identity);
  console.log(
    JSON.stringify(
      {
        identity,
        evidence,
        result: evidence
          ? reconcileMicroBurstEconomics(identity, evidence)
          : { status: 'UNVERIFIED' },
      },
      null,
      2,
    ),
  );
  process.exit(evidence ? 0 : 2);
}

void main().catch(() => {
  // Exchange errors can contain signed URLs; never serialize them.
  console.error('MICRO_HISTORICAL_AUDIT_FAILED');
  process.exit(1);
});
