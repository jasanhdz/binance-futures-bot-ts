import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PositionManagerRouter } from '../../core/strategy/PositionManagerRouter';
import type { PositionManagementResult } from '../../core/strategy/StrategyDecision';
import { createUnfrozenStrategyIdentity } from '../../core/strategy/StrategyIdentity';
import { SharedEntryReservation } from '../../core/risk/SharedEntryReservation';
import { ShadowTradingEngine } from '../../core/shadow/ShadowTradingEngine';
import { FileShadowTradeJournal } from '../../core/shadow/ShadowTradeJournal';
import type {
  ShadowEntryIntent,
  ShadowManagementObservation,
  ShadowStrategyPolicy,
} from '../../core/shadow/ShadowTradingTypes';

const BASE = 1_800_000_000_000;
const roots: string[] = [];
const owners = ['MICRO_BURST', 'TEST_PROBE'] as const;

type ManagerContext = {
  readonly tradeId: string;
  readonly requestedDecision: 'HOLD' | 'CLOSE_MARKET';
};

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-paper-recovery-'));
  roots.push(root);
  return root;
}

function intent(strategyId: ShadowEntryIntent['strategyId'], symbol: string): ShadowEntryIntent {
  return {
    strategyId,
    strategyVersion: 'deterministic-paper-fixture-v1',
    symbol,
    side: 'LONG',
    decisionAtMs: BASE,
    decisionReceivedAtMs: BASE,
    referencePrice: 100,
    structuralStop: 99,
    destination: 102,
    leverage: 1,
    positionFraction: 0.01,
    parentDecisionId: `fixture-${strategyId}-${symbol}`,
    provenance: {
      strategyVersion: 'deterministic-paper-fixture-v1',
      codeCommitSha: 'synthetic-test-fixture',
      cohortId: 'SYNTHETIC_ONLY_NOT_MARKET_EVIDENCE',
    },
    diagnostics: { source: 'DETERMINISTIC_TEST_FIXTURE' },
  };
}

function paperPolicy(strategyId: ShadowEntryIntent['strategyId']): ShadowStrategyPolicy {
  return {
    strategyId,
    evaluateLifecycle: (_position, observation) => {
      const result = observation.strategyContext as PositionManagementResult;
      return result.decision === 'CLOSE_MARKET'
        ? { action: 'CLOSE', reason: result.reason }
        : { action: 'HOLD', reason: result.reason };
    },
  };
}

function policies(): ReadonlyMap<ShadowEntryIntent['strategyId'], ShadowStrategyPolicy> {
  return new Map(owners.map((owner) => [owner, paperPolicy(owner)]));
}

function observation(
  action: ManagerContext['requestedDecision'],
  atMs: number,
  currentPrice: number,
): ShadowManagementObservation {
  return {
    exchangeTimeMs: atMs,
    receivedAtMs: atMs,
    currentPrice,
    quote: {
      bestBid: currentPrice - 0.1,
      bestAsk: currentPrice + 0.1,
      observedAtMs: atMs,
      status: 'HEALTHY',
    },
    marketDataQuality: 'HEALTHY',
    strategyContext: action,
  };
}

describe('multi-strategy paper journal recovery', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists two independently owned paper positions and recovers them in a fresh process instance', async () => {
    const root = createRoot();
    const tradeDir = path.join(root, 'trades');
    const eventDir = path.join(root, 'events');
    const microIdentity = createUnfrozenStrategyIdentity(
      'MICRO_BURST',
      'deterministic-paper-fixture-v1',
      'm'.repeat(40),
    );
    const probeIdentity = createUnfrozenStrategyIdentity(
      'TEST_PROBE',
      'deterministic-paper-fixture-v1',
      'p'.repeat(40),
    );
    const managerRouter = new PositionManagerRouter<ManagerContext>();
    for (const owner of owners) {
      managerRouter.register({
        strategyId: owner,
        manage: (identity, context) => {
          if (identity.strategyId !== owner)
            throw new Error(`POSITION_OWNER_MISMATCH:${owner}:${identity.strategyId}`);
          return {
            tradeId: context.tradeId,
            decision: context.requestedDecision,
            reason: `${owner}_${context.requestedDecision}_FIXTURE`,
            diagnostics: { owner },
          };
        },
      });
    }
    expect(managerRouter.has('MICRO_BURST')).toBe(true);
    expect(managerRouter.has('TEST_PROBE')).toBe(true);

    const journalBeforeRestart = new FileShadowTradeJournal(tradeDir, eventDir);
    const paperBeforeRestart = new ShadowTradingEngine(journalBeforeRestart, policies());
    const entryReservation = new SharedEntryReservation();

    const microReservation = entryReservation.tryAcquire('ETHUSDT');
    expect(microReservation.acquired).toBe(true);
    expect(entryReservation.tryAcquire('ETHUSDT')).toEqual({
      acquired: false,
      reason: 'SYMBOL_BUSY',
    });
    if (!microReservation.acquired) throw new Error('EXPECTED_MICRO_FIXTURE_RESERVATION');
    const microOpen = paperBeforeRestart.open(intent('MICRO_BURST', 'ETHUSDT'), {
      bestBid: 100,
      bestAsk: 100.1,
      observedAtMs: BASE,
      status: 'HEALTHY',
    });
    microReservation.release();
    expect(microOpen.status).toBe('OPENED');
    if (microOpen.status !== 'OPENED') throw new Error('EXPECTED_MICRO_FIXTURE_PAPER_OPEN');

    const probeReservation = entryReservation.tryAcquire('BTCUSDT');
    expect(probeReservation.acquired).toBe(true);
    if (!probeReservation.acquired) throw new Error('EXPECTED_PROBE_FIXTURE_RESERVATION');
    const probeOpen = paperBeforeRestart.open(intent('TEST_PROBE', 'BTCUSDT'), {
      bestBid: 100,
      bestAsk: 100.1,
      observedAtMs: BASE,
      status: 'HEALTHY',
    });
    probeReservation.release();
    expect(probeOpen.status).toBe('OPENED');
    if (probeOpen.status !== 'OPENED') throw new Error('EXPECTED_PROBE_FIXTURE_PAPER_OPEN');

    const initialPositions = paperBeforeRestart.getOpenPositions();
    expect(initialPositions.map(({ strategyId, symbol }) => [strategyId, symbol]).sort()).toEqual(
      [
        ['MICRO_BURST', 'ETHUSDT'],
        ['TEST_PROBE', 'BTCUSDT'],
      ].sort(),
    );
    expect(
      initialPositions.every(
        (position) => position.provenance.cohortId === 'SYNTHETIC_ONLY_NOT_MARKET_EVIDENCE',
      ),
    ).toBe(true);

    for (const [identity, position] of [
      [microIdentity, microOpen.position],
      [probeIdentity, probeOpen.position],
    ] as const) {
      const routed = await managerRouter.route(identity, {
        tradeId: position.tradeId,
        requestedDecision: 'HOLD',
      });
      expect(routed.status).toBe('ROUTED');
      if (routed.status !== 'ROUTED') throw new Error('EXPECTED_OWNER_HOLD_ROUTE');
      const held = paperBeforeRestart.manage(
        { strategyId: identity.strategyId, symbol: position.symbol },
        { ...observation('HOLD', BASE + 1_000, 101), strategyContext: routed.decision },
      );
      expect(held).toMatchObject({ strategyId: identity.strategyId, state: 'MANAGING' });
    }
    paperBeforeRestart.flush();

    // Reopen both JSONL directories through a new journal and engine; no old in-memory journal is reused.
    const journalAfterRestart = new FileShadowTradeJournal(tradeDir, eventDir);
    expect(journalAfterRestart).not.toBe(journalBeforeRestart);
    const paperAfterRestart = new ShadowTradingEngine(journalAfterRestart, policies());
    expect(paperAfterRestart.getOpenPositions()).toHaveLength(2);
    expect(
      paperAfterRestart
        .getOpenPositions()
        .map((position) => position.strategyId)
        .sort(),
    ).toEqual(['MICRO_BURST', 'TEST_PROBE']);
    expect(
      paperAfterRestart.manage(
        { strategyId: 'MICRO_BURST', symbol: 'BTCUSDT' },
        observation('CLOSE_MARKET', BASE + 2_000, 102),
      ),
    ).toBeUndefined();

    for (const [identity, position] of [
      [microIdentity, microOpen.position],
      [probeIdentity, probeOpen.position],
    ] as const) {
      const routed = await managerRouter.route(identity, {
        tradeId: position.tradeId,
        requestedDecision: 'CLOSE_MARKET',
      });
      expect(routed.status).toBe('ROUTED');
      if (routed.status !== 'ROUTED') throw new Error('EXPECTED_OWNER_CLOSE_ROUTE');
      const closed = paperAfterRestart.manage(
        { strategyId: identity.strategyId, symbol: position.symbol },
        { ...observation('CLOSE_MARKET', BASE + 2_000, 102), strategyContext: routed.decision },
      );
      expect(closed).toMatchObject({ strategyId: identity.strategyId, state: 'CLOSED' });
    }

    const finalJournal = new FileShadowTradeJournal(tradeDir, eventDir);
    expect(finalJournal.loadOpenPositions()).toHaveLength(0);
    expect(
      finalJournal.loadAllPositions().filter((position) => position.state === 'CLOSED'),
    ).toHaveLength(2);
    expect(finalJournal.loadAllEvents().filter((event) => event.event === 'CLOSED')).toHaveLength(
      2,
    );

    // Two duplicate open records for one canonical owner/symbol key are fail-closed on recovery.
    for (const duplicateId of ['duplicate-a', 'duplicate-b'])
      finalJournal.appendPosition({
        ...microOpen.position,
        tradeId: duplicateId,
        state: 'OPEN_SHADOW',
        closedAtMs: undefined,
        closedReceivedAtMs: undefined,
      });
    const duplicateRecoveryJournal = new FileShadowTradeJournal(tradeDir, eventDir);
    expect(duplicateRecoveryJournal.loadOpenPositions()).toHaveLength(0);
    expect(duplicateRecoveryJournal.loadRecoveryBlockedKeys()).toContainEqual(
      microOpen.position.key,
    );
    const duplicateRecoveryEngine = new ShadowTradingEngine(duplicateRecoveryJournal, policies());
    expect(
      duplicateRecoveryEngine.open(intent('MICRO_BURST', 'ETHUSDT'), {
        bestBid: 100,
        bestAsk: 100.1,
        observedAtMs: BASE + 3_000,
        status: 'HEALTHY',
      }).status,
    ).toBe('RECOVERY_BLOCKED');
  });
});
