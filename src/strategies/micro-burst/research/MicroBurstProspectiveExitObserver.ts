import {
  advanceMicroBurstExit,
  initialMicroBurstExitEngineState,
  MicroBurstExitEngineState,
} from '../domain/MicroBurstExitPolicy';
import {
  defaultMicroBurstConfig,
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
} from '../domain/MicroBurstTypes';
import {
  advanceMicroBurstOfflineExit,
  initialMicroBurstOfflineExitState,
  MicroBurstOfflineExitState,
  MICRO_BURST_OFFLINE_EXIT_VARIANT,
} from './MicroBurstOfflineExitVariant';

export const PROSPECTIVE_EXIT_OBSERVER_VERSION = 'MICRO_PROSPECTIVE_EXIT_DUAL_V1' as const;

export type ProspectiveExitPolicy = 'CURRENT' | 'CANDIDATE';
export type ProspectiveSimulationStatus = 'ACTIVE' | 'CLOSED' | 'OPEN_AT_HORIZON' | 'NO_EVALUABLE';

export interface ProspectiveExitIdentity {
  entryId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  enteredAtMs: number;
  quantity: number;
  entryPrice: number;
  strategyVersion: string;
  codeCommitSha: string;
  configHash: string;
  currentPolicyVersion: string;
  candidatePolicyVersion: typeof MICRO_BURST_OFFLINE_EXIT_VARIANT;
}

export interface ProspectiveRealFill {
  fillId: string;
  orderId: string;
  eventAtMs: number;
  receivedAtMs: number;
  price: number;
  quantity: number;
  feeBps: number | null;
  fundingBps: number | null;
}

export interface ProspectiveExitDepthEvidence {
  status: string;
  observedAtMs: number;
  requiredQuantity: number;
  availableQuantity: number;
  levelsUsed: number;
  quantityCovered: boolean;
}

export interface ProspectiveExitGap {
  kind: 'EVENT_TIME' | 'RECEIVE_TIME' | 'DEPTH' | 'BTC' | 'FLOW' | 'STRUCTURE' | 'UNKNOWN';
  fromMs: number;
  toMs: number;
  reason: string;
}

export interface ProspectiveExitObservation {
  eventAtMs: number;
  receivedAtMs: number;
  evaluatedAtMs: number;
  context: MicroBurstExitContext;
  executionAssumptions: {
    roundTripCostBps: number;
    feeBps: number;
    slippageBps: number;
    source: string;
  };
  depth: ProspectiveExitDepthEvidence | null;
  inputProvenance: {
    btcAvailable: boolean;
    flowAvailable: boolean;
    structureAvailable: boolean;
    quality: Record<string, unknown>;
  };
  gap?: ProspectiveExitGap;
  actualExecution?: {
    orderAction?: string;
    orderId?: string;
    fillPrice?: number;
    fillQuantity?: number;
    filledAtMs?: number;
  };
}

export interface ProspectiveExitDecisionRecord {
  policy: ProspectiveExitPolicy;
  observedAtMs: number;
  evaluatedAtMs: number;
  decision: MicroBurstExitDecision | null;
  hypothetical: true;
  actualExecution: ProspectiveExitObservation['actualExecution'];
  economicObservedAtMs: number | null;
  economicAgeMs: number | null;
  evaluable: boolean;
  gap: ProspectiveExitGap | null;
  executionAssumptions: ProspectiveExitObservation['executionAssumptions'];
}

export interface ProspectiveExitSimulationSnapshot {
  policy: ProspectiveExitPolicy;
  status: ProspectiveSimulationStatus;
  horizonAtMs: number;
  closedAtMs: number | null;
  closeDecision: MicroBurstExitDecision | null;
  stopPrice: number | null;
  lastObservedPrice: number | null;
  state: MicroBurstExitEngineState | MicroBurstOfflineExitState;
  decisions: readonly ProspectiveExitDecisionRecord[];
}

export interface ProspectiveExitEntrySnapshot {
  identity: ProspectiveExitIdentity;
  horizonAtMs: number;
  realPositionClosedAtMs: number | null;
  realFills: readonly ProspectiveRealFill[];
  simulations: Readonly<Record<ProspectiveExitPolicy, ProspectiveExitSimulationSnapshot>>;
}

export interface ProspectiveExitObserverMetrics {
  registeredEntries: number;
  activeEntries: number;
  completedEntries: number;
  observationsAccepted: number;
  observationsDiscarded: number;
  validationFailures: number;
  gapObservations: number;
  noEvaluableEntries: number;
  capacityDrops: number;
  ioErrors: number;
  queueDepth: 0;
}

interface Simulation {
  policy: ProspectiveExitPolicy;
  status: ProspectiveSimulationStatus;
  horizonAtMs: number;
  closedAtMs: number | null;
  closeDecision: MicroBurstExitDecision | null;
  stopPrice: number | null;
  lastObservedPrice: number | null;
  state: MicroBurstExitEngineState | MicroBurstOfflineExitState;
  decisions: ProspectiveExitDecisionRecord[];
}

interface EntryRecord {
  identity: ProspectiveExitIdentity;
  horizonAtMs: number;
  realPositionClosedAtMs: number | null;
  realFills: ProspectiveRealFill[];
  simulations: Record<ProspectiveExitPolicy, Simulation>;
}

export interface MicroBurstProspectiveExitObserverOptions {
  config?: MicroBurstConfig;
  currentPolicyVersion?: string;
  maxEntries?: number;
  maxObservationsPerEntry?: number;
}

/**
 * Pure, bounded prospective collector. It has no exchange/logger/REST dependency.
 * The caller supplies the exact context it already consumed; this class never
 * backfills missing evidence or treats a real order/fill as a hypothetical fill.
 */
export class MicroBurstProspectiveExitObserver {
  private readonly config: MicroBurstConfig;
  private readonly currentConfig: MicroBurstConfig;
  private readonly maxEntries: number;
  private readonly maxObservationsPerEntry: number;
  private readonly entries = new Map<string, EntryRecord>();
  private metrics: ProspectiveExitObserverMetrics = {
    registeredEntries: 0,
    activeEntries: 0,
    completedEntries: 0,
    observationsAccepted: 0,
    observationsDiscarded: 0,
    validationFailures: 0,
    gapObservations: 0,
    noEvaluableEntries: 0,
    capacityDrops: 0,
    ioErrors: 0,
    queueDepth: 0,
  };

  public constructor(options: MicroBurstProspectiveExitObserverOptions = {}) {
    this.config = options.config ?? defaultMicroBurstConfig();
    this.currentConfig = { ...this.config, contextualPolicyVersion: 'MICRO' as const };
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
    this.maxObservationsPerEntry = Math.max(1, Math.floor(options.maxObservationsPerEntry ?? 512));
  }

  public registerEntry(identity: ProspectiveExitIdentity): boolean {
    if (this.entries.has(identity.entryId)) return true;
    if (this.entries.size >= this.maxEntries) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
        capacityDrops: this.metrics.capacityDrops + 1,
      };
      return false;
    }
    const horizonAtMs =
      identity.enteredAtMs + this.config.exitMaxHoldMs + this.config.exitMaxHoldExtensionMs;
    const baseStop = null;
    this.entries.set(identity.entryId, {
      identity,
      horizonAtMs,
      realPositionClosedAtMs: null,
      realFills: [],
      simulations: {
        CURRENT: {
          policy: 'CURRENT',
          status: 'ACTIVE',
          horizonAtMs,
          closedAtMs: null,
          closeDecision: null,
          stopPrice: baseStop,
          lastObservedPrice: null,
          state: initialMicroBurstExitEngineState(),
          decisions: [],
        },
        CANDIDATE: {
          policy: 'CANDIDATE',
          status: 'ACTIVE',
          horizonAtMs,
          closedAtMs: null,
          closeDecision: null,
          stopPrice: baseStop,
          lastObservedPrice: null,
          state: initialMicroBurstOfflineExitState(),
          decisions: [],
        },
      },
    });
    this.metrics = {
      ...this.metrics,
      registeredEntries: this.metrics.registeredEntries + 1,
      activeEntries: this.metrics.activeEntries + 1,
    };
    return true;
  }

  public markRealPositionClosed(entryId: string, closedAtMs: number): boolean {
    const entry = this.entries.get(entryId);
    if (!entry || !Number.isFinite(closedAtMs)) return false;
    entry.realPositionClosedAtMs = closedAtMs;
    return true;
  }

  public recordRealFill(entryId: string, fill: ProspectiveRealFill): boolean {
    const entry = this.entries.get(entryId);
    if (
      !entry ||
      entry.realFills.length >= this.maxObservationsPerEntry ||
      !Number.isFinite(fill.eventAtMs) ||
      !Number.isFinite(fill.receivedAtMs) ||
      fill.eventAtMs > fill.receivedAtMs ||
      !Number.isFinite(fill.price) ||
      fill.price <= 0 ||
      !Number.isFinite(fill.quantity) ||
      fill.quantity <= 0
    ) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
        validationFailures: this.metrics.validationFailures + 1,
      };
      return false;
    }
    if (entry.realFills.some((existing) => existing.fillId === fill.fillId)) return true;
    entry.realFills.push({ ...fill });
    return true;
  }

  public restoreEntry(snapshot: ProspectiveExitEntrySnapshot): boolean {
    if (
      this.entries.has(snapshot.identity.entryId) ||
      this.entries.size >= this.maxEntries ||
      !Number.isFinite(snapshot.identity.quantity) ||
      snapshot.identity.quantity <= 0
    )
      return false;
    if (
      snapshot.simulations.CURRENT.decisions.length > this.maxObservationsPerEntry ||
      snapshot.simulations.CANDIDATE.decisions.length > this.maxObservationsPerEntry
    )
      return false;
    this.entries.set(snapshot.identity.entryId, {
      identity: { ...snapshot.identity },
      horizonAtMs: snapshot.horizonAtMs,
      realPositionClosedAtMs: snapshot.realPositionClosedAtMs,
      realFills: snapshot.realFills.map((fill) => ({ ...fill })),
      simulations: {
        CURRENT: {
          ...snapshot.simulations.CURRENT,
          lastObservedPrice: snapshot.simulations.CURRENT.lastObservedPrice ?? null,
          decisions: [...snapshot.simulations.CURRENT.decisions],
        },
        CANDIDATE: {
          ...snapshot.simulations.CANDIDATE,
          lastObservedPrice: snapshot.simulations.CANDIDATE.lastObservedPrice ?? null,
          decisions: [...snapshot.simulations.CANDIDATE.decisions],
        },
      },
    });
    const completed = Object.values(snapshot.simulations).every(
      (simulation) => simulation.status !== 'ACTIVE',
    );
    this.metrics = {
      ...this.metrics,
      registeredEntries: this.metrics.registeredEntries + 1,
      activeEntries: this.metrics.activeEntries + (completed ? 0 : 1),
      completedEntries: this.metrics.completedEntries + (completed ? 1 : 0),
    };
    return true;
  }

  public observe(entryId: string, observation: ProspectiveExitObservation): boolean {
    const entry = this.entries.get(entryId);
    if (!entry || !this.validObservation(observation)) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
        validationFailures: this.metrics.validationFailures + 1,
      };
      return false;
    }
    const totalRecords =
      entry.simulations.CURRENT.decisions.length + entry.simulations.CANDIDATE.decisions.length;
    if (totalRecords >= this.maxObservationsPerEntry * 2) {
      this.markNoEvaluable(entry);
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
        capacityDrops: this.metrics.capacityDrops + 1,
      };
      return false;
    }
    const hasGap = observation.gap !== undefined;
    if (hasGap)
      this.metrics = { ...this.metrics, gapObservations: this.metrics.gapObservations + 1 };
    for (const policy of ['CURRENT', 'CANDIDATE'] as const) {
      const simulation = entry.simulations[policy];
      const record = this.advanceSimulation(simulation, policy, observation, entry.identity.side);
      simulation.decisions.push(record);
    }
    this.metrics = { ...this.metrics, observationsAccepted: this.metrics.observationsAccepted + 1 };
    if (observation.evaluatedAtMs >= entry.horizonAtMs) this.completeEntry(entry);
    return true;
  }

  public getEntry(entryId: string): ProspectiveExitEntrySnapshot | null {
    const entry = this.entries.get(entryId);
    return entry ? this.snapshot(entry) : null;
  }

  public getMetrics(): ProspectiveExitObserverMetrics {
    return { ...this.metrics };
  }

  private advanceSimulation(
    simulation: Simulation,
    policy: ProspectiveExitPolicy,
    observation: ProspectiveExitObservation,
    side: 'LONG' | 'SHORT',
  ): ProspectiveExitDecisionRecord {
    const economics = observation.context.executableEconomics;
    const economicAgeMs = economics ? observation.evaluatedAtMs - economics.observedAtMs : null;
    const evaluable = observation.gap === undefined && observation.depth?.quantityCovered === true;
    const previousPrice = simulation.lastObservedPrice;
    const currentPrice = observation.context.currentPrice;
    const crossedStopLevel = (level: number): boolean =>
      previousPrice !== null &&
      (side === 'LONG'
        ? previousPrice > level && currentPrice <= level
        : previousPrice < level && currentPrice >= level);
    const crossedTargetLevel = (level: number): boolean =>
      previousPrice !== null &&
      (side === 'LONG'
        ? previousPrice < level && currentPrice >= level
        : previousPrice > level && currentPrice <= level);
    const crossedStop = simulation.stopPrice !== null && crossedStopLevel(simulation.stopPrice);
    const crossedTarget = crossedTargetLevel(observation.context.destinationPrice);
    simulation.lastObservedPrice = currentPrice;
    if (simulation.status === 'ACTIVE' && evaluable && (crossedStop || crossedTarget)) {
      this.markNoEvaluableState(simulation);
      return {
        policy,
        observedAtMs: observation.eventAtMs,
        evaluatedAtMs: observation.evaluatedAtMs,
        decision: null,
        hypothetical: true,
        actualExecution: observation.actualExecution,
        economicObservedAtMs: economics?.observedAtMs ?? null,
        economicAgeMs,
        evaluable: false,
        gap: {
          kind: 'UNKNOWN',
          fromMs: observation.eventAtMs,
          toMs: observation.eventAtMs,
          reason: crossedStop
            ? 'STOP_CROSS_BETWEEN_OBSERVATIONS'
            : 'TARGET_CROSS_BETWEEN_OBSERVATIONS',
        },
        executionAssumptions: observation.executionAssumptions,
      };
    }
    if (simulation.status === 'ACTIVE' && evaluable) {
      simulation.stopPrice ??= observation.context.currentStopPrice;
      const context: MicroBurstExitContext = {
        ...observation.context,
        currentStopPrice: simulation.stopPrice ?? observation.context.currentStopPrice,
      };
      const transition =
        policy === 'CURRENT'
          ? advanceMicroBurstExit(
              simulation.state as MicroBurstExitEngineState,
              context,
              this.currentConfig,
              side,
            )
          : advanceMicroBurstOfflineExit(
              simulation.state as MicroBurstOfflineExitState,
              context,
              this.config,
              side,
            );
      simulation.state = transition.state;
      if (
        transition.decision.action === 'MOVE_STOP' &&
        transition.decision.requestedStopPrice !== undefined
      ) {
        simulation.stopPrice =
          side === 'LONG'
            ? Math.max(
                simulation.stopPrice ?? transition.decision.requestedStopPrice,
                transition.decision.requestedStopPrice,
              )
            : Math.min(
                simulation.stopPrice ?? transition.decision.requestedStopPrice,
                transition.decision.requestedStopPrice,
              );
      }
      if (transition.decision.action === 'CLOSE_MARKET') {
        simulation.status = 'CLOSED';
        simulation.closedAtMs = observation.evaluatedAtMs;
        simulation.closeDecision = transition.decision;
      }
      return {
        policy,
        observedAtMs: observation.eventAtMs,
        evaluatedAtMs: observation.evaluatedAtMs,
        decision: transition.decision,
        hypothetical: true,
        actualExecution: observation.actualExecution,
        economicObservedAtMs: economics?.observedAtMs ?? null,
        economicAgeMs,
        evaluable: true,
        gap: null,
        executionAssumptions: observation.executionAssumptions,
      };
    }
    if (observation.gap !== undefined || !evaluable) this.markNoEvaluableState(simulation);
    return {
      policy,
      observedAtMs: observation.eventAtMs,
      evaluatedAtMs: observation.evaluatedAtMs,
      decision: null,
      hypothetical: true,
      actualExecution: observation.actualExecution,
      economicObservedAtMs: economics?.observedAtMs ?? null,
      economicAgeMs,
      evaluable: false,
      gap: observation.gap ?? null,
      executionAssumptions: observation.executionAssumptions,
    };
  }

  private completeEntry(entry: EntryRecord): void {
    for (const simulation of Object.values(entry.simulations)) {
      if (simulation.status === 'ACTIVE') simulation.status = 'OPEN_AT_HORIZON';
    }
    if (Object.values(entry.simulations).some((simulation) => simulation.status === 'NO_EVALUABLE'))
      this.metrics = { ...this.metrics, noEvaluableEntries: this.metrics.noEvaluableEntries + 1 };
    this.metrics = {
      ...this.metrics,
      activeEntries: Math.max(0, this.metrics.activeEntries - 1),
      completedEntries: this.metrics.completedEntries + 1,
    };
  }

  private markNoEvaluable(entry: EntryRecord): void {
    for (const simulation of Object.values(entry.simulations))
      this.markNoEvaluableState(simulation);
  }

  private markNoEvaluableState(simulation: Simulation): void {
    if (simulation.status === 'ACTIVE') simulation.status = 'NO_EVALUABLE';
  }

  private validObservation(observation: ProspectiveExitObservation): boolean {
    return (
      Number.isFinite(observation.eventAtMs) &&
      Number.isFinite(observation.receivedAtMs) &&
      Number.isFinite(observation.evaluatedAtMs) &&
      observation.eventAtMs <= observation.receivedAtMs &&
      observation.receivedAtMs <= observation.evaluatedAtMs &&
      Number.isFinite(observation.context.observedAtMs) &&
      observation.context.observedAtMs === observation.eventAtMs &&
      [
        observation.executionAssumptions.roundTripCostBps,
        observation.executionAssumptions.feeBps,
        observation.executionAssumptions.slippageBps,
      ].every(Number.isFinite)
    );
  }

  private snapshot(entry: EntryRecord): ProspectiveExitEntrySnapshot {
    return {
      identity: entry.identity,
      horizonAtMs: entry.horizonAtMs,
      realPositionClosedAtMs: entry.realPositionClosedAtMs,
      realFills: entry.realFills.map((fill) => ({ ...fill })),
      simulations: {
        CURRENT: {
          ...entry.simulations.CURRENT,
          decisions: [...entry.simulations.CURRENT.decisions],
        },
        CANDIDATE: {
          ...entry.simulations.CANDIDATE,
          decisions: [...entry.simulations.CANDIDATE.decisions],
        },
      },
    };
  }
}
