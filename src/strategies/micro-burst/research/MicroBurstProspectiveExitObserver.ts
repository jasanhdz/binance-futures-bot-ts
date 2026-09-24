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
  isMicroBurstOfflineExitState,
} from './MicroBurstOfflineExitVariant';

export const PROSPECTIVE_EXIT_OBSERVER_VERSION = 'MICRO_PROSPECTIVE_EXIT_DUAL_V2' as const;

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  role?: 'ENTRY' | 'EXIT';
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
  economicEvaluable: boolean;
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
  lastObservedTargetPrice: number | null;
  lastObservedAtMs: number | null;
  noEvaluableAtMs: number | null;
  noEvaluableReason: string | null;
  resultEvaluable: boolean;
  resultNotEvaluableAtMs: number | null;
  resultNotEvaluableReason: string | null;
  state: MicroBurstExitEngineState | MicroBurstOfflineExitState;
  decisions: readonly ProspectiveExitDecisionRecord[];
}

export interface ProspectiveExitEntrySnapshot {
  identity: ProspectiveExitIdentity;
  horizonAtMs: number;
  realPositionClosedAtMs: number | null;
  realFills: readonly ProspectiveRealFill[];
  observations: readonly ProspectiveExitObservation[];
  completed: boolean;
  lastObservationEventAtMs: number | null;
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
  duplicateObservations: number;
  outOfOrderObservations: number;
  identityConflicts: number;
  schemaFailures: number;
}

interface Simulation {
  policy: ProspectiveExitPolicy;
  status: ProspectiveSimulationStatus;
  horizonAtMs: number;
  closedAtMs: number | null;
  closeDecision: MicroBurstExitDecision | null;
  stopPrice: number | null;
  lastObservedPrice: number | null;
  lastObservedTargetPrice: number | null;
  lastObservedAtMs: number | null;
  noEvaluableAtMs: number | null;
  noEvaluableReason: string | null;
  resultEvaluable: boolean;
  resultNotEvaluableAtMs: number | null;
  resultNotEvaluableReason: string | null;
  state: MicroBurstExitEngineState | MicroBurstOfflineExitState;
  decisions: ProspectiveExitDecisionRecord[];
}

interface EntryRecord {
  identity: ProspectiveExitIdentity;
  horizonAtMs: number;
  realPositionClosedAtMs: number | null;
  realFills: ProspectiveRealFill[];
  observations: ProspectiveExitObservation[];
  completed: boolean;
  lastObservationEventAtMs: number | null;
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
    duplicateObservations: 0,
    outOfOrderObservations: 0,
    identityConflicts: 0,
    schemaFailures: 0,
  };

  public constructor(options: MicroBurstProspectiveExitObserverOptions = {}) {
    this.config = options.config ?? defaultMicroBurstConfig();
    this.currentConfig = { ...this.config, contextualPolicyVersion: 'MICRO' as const };
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
    this.maxObservationsPerEntry = Math.max(1, Math.floor(options.maxObservationsPerEntry ?? 512));
  }

  public registerEntry(identity: ProspectiveExitIdentity): boolean {
    if (!this.validIdentity(identity)) {
      this.metrics = {
        ...this.metrics,
        validationFailures: this.metrics.validationFailures + 1,
        schemaFailures: this.metrics.schemaFailures + 1,
      };
      return false;
    }
    const existing = this.entries.get(identity.entryId);
    if (existing) {
      if (sameValue(existing.identity, identity)) return true;
      this.metrics = {
        ...this.metrics,
        validationFailures: this.metrics.validationFailures + 1,
        identityConflicts: this.metrics.identityConflicts + 1,
      };
      return false;
    }
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
      identity: deepClone(identity),
      horizonAtMs,
      realPositionClosedAtMs: null,
      realFills: [],
      observations: [],
      completed: false,
      lastObservationEventAtMs: null,
      simulations: {
        CURRENT: {
          policy: 'CURRENT',
          status: 'ACTIVE',
          horizonAtMs,
          closedAtMs: null,
          closeDecision: null,
          stopPrice: baseStop,
          lastObservedPrice: null,
          lastObservedTargetPrice: null,
          lastObservedAtMs: null,
          noEvaluableAtMs: null,
          noEvaluableReason: null,
          resultEvaluable: true,
          resultNotEvaluableAtMs: null,
          resultNotEvaluableReason: null,
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
          lastObservedTargetPrice: null,
          lastObservedAtMs: null,
          noEvaluableAtMs: null,
          noEvaluableReason: null,
          resultEvaluable: true,
          resultNotEvaluableAtMs: null,
          resultNotEvaluableReason: null,
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
    if (!entry || !Number.isFinite(closedAtMs) || closedAtMs < entry.identity.enteredAtMs)
      return false;
    if (entry.realPositionClosedAtMs !== null) return entry.realPositionClosedAtMs === closedAtMs;
    entry.realPositionClosedAtMs = closedAtMs;
    return true;
  }

  public recordRealFill(entryId: string, fill: ProspectiveRealFill): boolean {
    const entry = this.entries.get(entryId);
    if (
      !entry ||
      entry.realFills.length >= this.maxObservationsPerEntry ||
      !fill.fillId ||
      !fill.orderId ||
      !Number.isFinite(fill.eventAtMs) ||
      !Number.isFinite(fill.receivedAtMs) ||
      fill.eventAtMs > fill.receivedAtMs ||
      !Number.isFinite(fill.price) ||
      fill.price <= 0 ||
      !Number.isFinite(fill.quantity) ||
      fill.quantity <= 0 ||
      (fill.feeBps !== null && !Number.isFinite(fill.feeBps)) ||
      (fill.fundingBps !== null && !Number.isFinite(fill.fundingBps))
    ) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
        validationFailures: this.metrics.validationFailures + 1,
      };
      return false;
    }
    const role = fill.role ?? 'ENTRY';
    const duplicate = entry.realFills.find((existing) => existing.fillId === fill.fillId);
    if (duplicate) {
      if (sameValue({ ...duplicate, role: duplicate.role ?? 'ENTRY' }, { ...fill, role }))
        return true;
      this.metrics = { ...this.metrics, validationFailures: this.metrics.validationFailures + 1 };
      return false;
    }
    if (entry.completed) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
      };
      return false;
    }
    const sameRoleQuantity = entry.realFills
      .filter((existing) => (existing.role ?? 'ENTRY') === role)
      .reduce((sum, existing) => sum + existing.quantity, 0);
    if (sameRoleQuantity + fill.quantity > entry.identity.quantity) {
      this.metrics = { ...this.metrics, validationFailures: this.metrics.validationFailures + 1 };
      return false;
    }
    entry.realFills.push(deepClone({ ...fill, role }));
    return true;
  }

  public restoreEntry(snapshot: ProspectiveExitEntrySnapshot): boolean {
    if (!this.validateSnapshot(snapshot)) {
      this.metrics = { ...this.metrics, schemaFailures: this.metrics.schemaFailures + 1 };
      return false;
    }
    if (this.entries.has(snapshot.identity.entryId) || this.entries.size >= this.maxEntries)
      return false;
    if (
      snapshot.simulations.CURRENT.decisions.length > this.maxObservationsPerEntry ||
      snapshot.simulations.CANDIDATE.decisions.length > this.maxObservationsPerEntry
    )
      return false;
    this.entries.set(snapshot.identity.entryId, {
      identity: deepClone(snapshot.identity),
      horizonAtMs: snapshot.horizonAtMs,
      realPositionClosedAtMs: snapshot.realPositionClosedAtMs,
      realFills: [...deepClone(snapshot.realFills)],
      observations: [...deepClone(snapshot.observations)],
      completed: snapshot.completed,
      lastObservationEventAtMs: snapshot.lastObservationEventAtMs,
      simulations: {
        CURRENT: {
          ...snapshot.simulations.CURRENT,
          lastObservedPrice: snapshot.simulations.CURRENT.lastObservedPrice ?? null,
          lastObservedTargetPrice: snapshot.simulations.CURRENT.lastObservedTargetPrice ?? null,
          lastObservedAtMs: snapshot.simulations.CURRENT.lastObservedAtMs ?? null,
          noEvaluableAtMs: snapshot.simulations.CURRENT.noEvaluableAtMs ?? null,
          noEvaluableReason: snapshot.simulations.CURRENT.noEvaluableReason ?? null,
          resultEvaluable: snapshot.simulations.CURRENT.resultEvaluable,
          resultNotEvaluableAtMs: snapshot.simulations.CURRENT.resultNotEvaluableAtMs ?? null,
          resultNotEvaluableReason: snapshot.simulations.CURRENT.resultNotEvaluableReason ?? null,
          state: deepClone(snapshot.simulations.CURRENT.state),
          decisions: [...deepClone(snapshot.simulations.CURRENT.decisions)],
        },
        CANDIDATE: {
          ...snapshot.simulations.CANDIDATE,
          lastObservedPrice: snapshot.simulations.CANDIDATE.lastObservedPrice ?? null,
          lastObservedTargetPrice: snapshot.simulations.CANDIDATE.lastObservedTargetPrice ?? null,
          lastObservedAtMs: snapshot.simulations.CANDIDATE.lastObservedAtMs ?? null,
          noEvaluableAtMs: snapshot.simulations.CANDIDATE.noEvaluableAtMs ?? null,
          noEvaluableReason: snapshot.simulations.CANDIDATE.noEvaluableReason ?? null,
          resultEvaluable: snapshot.simulations.CANDIDATE.resultEvaluable,
          resultNotEvaluableAtMs: snapshot.simulations.CANDIDATE.resultNotEvaluableAtMs ?? null,
          resultNotEvaluableReason: snapshot.simulations.CANDIDATE.resultNotEvaluableReason ?? null,
          state: deepClone(snapshot.simulations.CANDIDATE.state),
          decisions: [...deepClone(snapshot.simulations.CANDIDATE.decisions)],
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
    const clonedObservation = deepClone(observation);
    const duplicate = entry.observations.find(
      (existing) => existing.eventAtMs === observation.eventAtMs,
    );
    if (duplicate) {
      if (sameValue(duplicate, clonedObservation)) {
        this.metrics = {
          ...this.metrics,
          duplicateObservations: this.metrics.duplicateObservations + 1,
        };
        return true;
      }
      this.metrics = {
        ...this.metrics,
        validationFailures: this.metrics.validationFailures + 1,
        outOfOrderObservations: this.metrics.outOfOrderObservations + 1,
      };
      return false;
    }
    if (
      entry.lastObservationEventAtMs !== null &&
      observation.eventAtMs < entry.lastObservationEventAtMs
    ) {
      this.metrics = {
        ...this.metrics,
        validationFailures: this.metrics.validationFailures + 1,
        outOfOrderObservations: this.metrics.outOfOrderObservations + 1,
      };
      return false;
    }
    if (entry.completed) {
      this.metrics = {
        ...this.metrics,
        observationsDiscarded: this.metrics.observationsDiscarded + 1,
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
    const depthCoherent = this.depthCoherent(observation, entry.identity.quantity);
    const normalizedObservation = depthCoherent
      ? clonedObservation
      : {
          ...clonedObservation,
          gap: clonedObservation.gap ?? {
            kind: 'DEPTH' as const,
            fromMs: clonedObservation.eventAtMs,
            toMs: clonedObservation.eventAtMs,
            reason: 'DEPTH_QUANTITY_INSUFFICIENT',
          },
        };
    const hasGap = normalizedObservation.gap !== undefined;
    if (hasGap)
      this.metrics = { ...this.metrics, gapObservations: this.metrics.gapObservations + 1 };
    for (const policy of ['CURRENT', 'CANDIDATE'] as const) {
      const simulation = entry.simulations[policy];
      const record = this.advanceSimulation(
        simulation,
        policy,
        normalizedObservation,
        entry.identity.side,
        depthCoherent,
      );
      simulation.decisions.push(record);
    }
    entry.observations.push(clonedObservation);
    entry.lastObservationEventAtMs = observation.eventAtMs;
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
    depthCoherent: boolean,
  ): ProspectiveExitDecisionRecord {
    const economics = observation.context.executableEconomics;
    const economicAgeMs = economics ? observation.evaluatedAtMs - economics.observedAtMs : null;
    const evaluable =
      observation.gap === undefined && observation.depth?.quantityCovered === true && depthCoherent;
    const economicEvaluable = evaluable && economics !== null;
    const previousPrice = simulation.lastObservedPrice;
    const previousObservedAtMs = simulation.lastObservedAtMs;
    const currentPrice = observation.context.currentPrice;
    const crossedStopLevel = (level: number): boolean =>
      previousPrice !== null &&
      (side === 'LONG'
        ? previousPrice > level && currentPrice < level
        : previousPrice < level && currentPrice > level);
    const targetPrice =
      policy === 'CURRENT' ? currentPrice : (economics?.exitPrice ?? currentPrice);
    const previousTargetPrice = simulation.lastObservedTargetPrice;
    const crossedTargetLevel = (level: number): boolean =>
      previousTargetPrice !== null &&
      (side === 'LONG'
        ? previousTargetPrice < level && targetPrice > level
        : previousTargetPrice > level && targetPrice < level);
    const crossedStop = simulation.stopPrice !== null && crossedStopLevel(simulation.stopPrice);
    const crossedTarget = crossedTargetLevel(observation.context.destinationPrice);
    if (evaluable) {
      simulation.lastObservedPrice = currentPrice;
      simulation.lastObservedTargetPrice = targetPrice;
      simulation.lastObservedAtMs = observation.eventAtMs;
    } else {
      simulation.lastObservedPrice = null;
      simulation.lastObservedTargetPrice = null;
      simulation.lastObservedAtMs = null;
    }
    if (simulation.status === 'ACTIVE' && evaluable && (crossedStop || crossedTarget)) {
      this.markNoEvaluableState(
        simulation,
        observation.evaluatedAtMs,
        crossedStop ? 'STOP_CROSS_BETWEEN_OBSERVATIONS' : 'TARGET_CROSS_BETWEEN_OBSERVATIONS',
      );
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
        economicEvaluable: false,
        gap: {
          kind: 'UNKNOWN',
          fromMs: previousObservedAtMs ?? observation.eventAtMs,
          toMs: observation.eventAtMs,
          reason: crossedStop
            ? 'STOP_CROSS_BETWEEN_OBSERVATIONS'
            : 'TARGET_CROSS_BETWEEN_OBSERVATIONS',
        },
        executionAssumptions: observation.executionAssumptions,
      };
    }
    if (!evaluable || !economicEvaluable)
      this.markResultNotEvaluable(
        simulation,
        observation.evaluatedAtMs,
        !evaluable
          ? (observation.gap?.reason ?? 'OBSERVATION_NOT_EVALUABLE')
          : 'EXECUTABLE_ECONOMICS_UNAVAILABLE',
      );
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
        economicEvaluable,
        gap: null,
        executionAssumptions: observation.executionAssumptions,
      };
    }
    if (observation.gap !== undefined || !evaluable)
      this.markNoEvaluableState(
        simulation,
        observation.evaluatedAtMs,
        observation.gap?.reason ?? 'OBSERVATION_NOT_EVALUABLE',
      );
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
      economicEvaluable: false,
      gap: observation.gap ?? null,
      executionAssumptions: observation.executionAssumptions,
    };
  }

  private completeEntry(entry: EntryRecord): void {
    if (entry.completed) return;
    entry.completed = true;
    for (const simulation of Object.values(entry.simulations)) {
      if (simulation.status === 'ACTIVE') {
        simulation.status = simulation.resultEvaluable ? 'OPEN_AT_HORIZON' : 'NO_EVALUABLE';
      }
    }
    if (Object.values(entry.simulations).some((simulation) => !simulation.resultEvaluable))
      this.metrics = { ...this.metrics, noEvaluableEntries: this.metrics.noEvaluableEntries + 1 };
    this.metrics = {
      ...this.metrics,
      activeEntries: Math.max(0, this.metrics.activeEntries - 1),
      completedEntries: this.metrics.completedEntries + 1,
    };
  }

  private markNoEvaluable(entry: EntryRecord): void {
    for (const simulation of Object.values(entry.simulations))
      this.markNoEvaluableState(simulation, null, 'CAPACITY_LIMIT');
  }

  private markNoEvaluableState(simulation: Simulation, atMs: number | null, reason: string): void {
    if (simulation.status === 'ACTIVE' && simulation.noEvaluableAtMs === null) {
      simulation.noEvaluableAtMs = atMs;
      simulation.noEvaluableReason = reason;
    }
    this.markResultNotEvaluable(simulation, atMs, reason);
  }

  private markResultNotEvaluable(
    simulation: Simulation,
    atMs: number | null,
    reason: string,
  ): void {
    if (simulation.status === 'ACTIVE' && simulation.resultEvaluable) {
      simulation.resultEvaluable = false;
      simulation.resultNotEvaluableAtMs = atMs;
      simulation.resultNotEvaluableReason = reason;
    }
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
      Number.isFinite(observation.context.currentPrice) &&
      Number.isFinite(observation.context.entryPrice) &&
      Number.isFinite(observation.context.structuralInvalidationPrice) &&
      Number.isFinite(observation.context.destinationPrice) &&
      observation.context.currentPrice > 0 &&
      observation.context.entryPrice > 0 &&
      observation.context.structuralInvalidationPrice > 0 &&
      observation.context.destinationPrice > 0 &&
      [
        observation.executionAssumptions.roundTripCostBps,
        observation.executionAssumptions.feeBps,
        observation.executionAssumptions.slippageBps,
      ].every(Number.isFinite) &&
      (observation.gap === undefined ||
        (Number.isFinite(observation.gap.fromMs) &&
          Number.isFinite(observation.gap.toMs) &&
          observation.gap.fromMs <= observation.gap.toMs &&
          typeof observation.gap.reason === 'string' &&
          ['EVENT_TIME', 'RECEIVE_TIME', 'DEPTH', 'BTC', 'FLOW', 'STRUCTURE', 'UNKNOWN'].includes(
            observation.gap.kind,
          ))) &&
      (observation.depth === null ||
        (Number.isFinite(observation.depth.observedAtMs) &&
          Number.isFinite(observation.depth.requiredQuantity) &&
          Number.isFinite(observation.depth.availableQuantity) &&
          Number.isInteger(observation.depth.levelsUsed) &&
          observation.depth.requiredQuantity >= 0 &&
          observation.depth.availableQuantity >= 0)) &&
      (observation.context.executableEconomics == null ||
        (Number.isFinite(observation.context.executableEconomics.observedAtMs) &&
          Number.isFinite(observation.context.executableEconomics.exitPrice) &&
          Number.isFinite(observation.context.executableEconomics.residualCostBps) &&
          Number.isFinite(observation.context.executableEconomics.volatilityBps) &&
          typeof observation.context.executableEconomics.quantityCovered === 'boolean'))
    );
  }

  private depthCoherent(observation: ProspectiveExitObservation, quantity: number): boolean {
    const depth = observation.depth;
    return (
      depth !== null &&
      Number.isFinite(depth.requiredQuantity) &&
      Number.isFinite(depth.availableQuantity) &&
      depth.requiredQuantity === quantity &&
      depth.availableQuantity >= quantity &&
      depth.quantityCovered
    );
  }

  private validIdentity(identity: ProspectiveExitIdentity): boolean {
    return (
      typeof identity.entryId === 'string' &&
      identity.entryId.length > 0 &&
      typeof identity.symbol === 'string' &&
      identity.symbol.length > 0 &&
      (identity.side === 'LONG' || identity.side === 'SHORT') &&
      Number.isFinite(identity.enteredAtMs) &&
      identity.enteredAtMs >= 0 &&
      Number.isFinite(identity.quantity) &&
      identity.quantity > 0 &&
      Number.isFinite(identity.entryPrice) &&
      identity.entryPrice > 0 &&
      [
        identity.strategyVersion,
        identity.codeCommitSha,
        identity.configHash,
        identity.currentPolicyVersion,
      ].every((value) => typeof value === 'string' && value.length > 0) &&
      identity.candidatePolicyVersion === MICRO_BURST_OFFLINE_EXIT_VARIANT
    );
  }

  public validateSnapshot(snapshot: ProspectiveExitEntrySnapshot): boolean {
    try {
      return (
        Boolean(snapshot) &&
        this.validIdentity(snapshot.identity) &&
        Number.isFinite(snapshot.horizonAtMs) &&
        (snapshot.realPositionClosedAtMs === null ||
          Number.isFinite(snapshot.realPositionClosedAtMs)) &&
        Array.isArray(snapshot.realFills) &&
        snapshot.realFills.every((fill) => this.validFill(fill, snapshot.identity.quantity)) &&
        ['ENTRY', 'EXIT'].every(
          (role) =>
            snapshot.realFills
              .filter((fill) => (fill.role ?? 'ENTRY') === role)
              .reduce((sum, fill) => sum + fill.quantity, 0) <= snapshot.identity.quantity,
        ) &&
        Array.isArray(snapshot.observations) &&
        snapshot.observations.length <= this.maxObservationsPerEntry &&
        snapshot.observations.every((observation) => this.validObservation(observation)) &&
        typeof snapshot.completed === 'boolean' &&
        (snapshot.lastObservationEventAtMs === null ||
          Number.isFinite(snapshot.lastObservationEventAtMs)) &&
        this.validSimulationSnapshot(snapshot.simulations.CURRENT) &&
        this.validSimulationSnapshot(snapshot.simulations.CANDIDATE)
      );
    } catch {
      return false;
    }
  }

  private validFill(fill: ProspectiveRealFill, quantity: number): boolean {
    return (
      typeof fill.fillId === 'string' &&
      fill.fillId.length > 0 &&
      typeof fill.orderId === 'string' &&
      fill.orderId.length > 0 &&
      Number.isFinite(fill.eventAtMs) &&
      Number.isFinite(fill.receivedAtMs) &&
      fill.eventAtMs <= fill.receivedAtMs &&
      Number.isFinite(fill.price) &&
      fill.price > 0 &&
      Number.isFinite(fill.quantity) &&
      fill.quantity > 0 &&
      fill.quantity <= quantity &&
      (fill.role === undefined || fill.role === 'ENTRY' || fill.role === 'EXIT') &&
      (fill.feeBps === null || Number.isFinite(fill.feeBps)) &&
      (fill.fundingBps === null || Number.isFinite(fill.fundingBps))
    );
  }

  private validSimulationSnapshot(simulation: ProspectiveExitSimulationSnapshot): boolean {
    return (
      Boolean(simulation) &&
      (simulation.policy === 'CURRENT' || simulation.policy === 'CANDIDATE') &&
      ['ACTIVE', 'CLOSED', 'OPEN_AT_HORIZON', 'NO_EVALUABLE'].includes(simulation.status) &&
      Number.isFinite(simulation.horizonAtMs) &&
      (simulation.closedAtMs === null || Number.isFinite(simulation.closedAtMs)) &&
      (simulation.stopPrice === null || Number.isFinite(simulation.stopPrice)) &&
      (simulation.lastObservedPrice === null || Number.isFinite(simulation.lastObservedPrice)) &&
      (simulation.lastObservedTargetPrice === null ||
        Number.isFinite(simulation.lastObservedTargetPrice)) &&
      (simulation.lastObservedAtMs === null || Number.isFinite(simulation.lastObservedAtMs)) &&
      (simulation.noEvaluableAtMs === null || Number.isFinite(simulation.noEvaluableAtMs)) &&
      (simulation.resultNotEvaluableAtMs === null ||
        Number.isFinite(simulation.resultNotEvaluableAtMs)) &&
      typeof simulation.resultEvaluable === 'boolean' &&
      Array.isArray(simulation.decisions) &&
      simulation.decisions.length <= this.maxObservationsPerEntry &&
      simulation.decisions.every((decision) => this.validDecisionRecord(decision)) &&
      typeof simulation.state === 'object' &&
      (simulation.policy === 'CANDIDATE' ? isMicroBurstOfflineExitState(simulation.state) : true)
    );
  }

  private validDecisionRecord(record: ProspectiveExitDecisionRecord): boolean {
    return (
      (record.policy === 'CURRENT' || record.policy === 'CANDIDATE') &&
      Number.isFinite(record.observedAtMs) &&
      Number.isFinite(record.evaluatedAtMs) &&
      record.hypothetical === true &&
      typeof record.evaluable === 'boolean' &&
      typeof record.economicEvaluable === 'boolean' &&
      (record.gap === null ||
        (typeof record.gap.reason === 'string' &&
          Number.isFinite(record.gap.fromMs) &&
          Number.isFinite(record.gap.toMs))) &&
      [
        record.executionAssumptions.roundTripCostBps,
        record.executionAssumptions.feeBps,
        record.executionAssumptions.slippageBps,
      ].every(Number.isFinite)
    );
  }

  private snapshot(entry: EntryRecord): ProspectiveExitEntrySnapshot {
    return deepClone({
      identity: entry.identity,
      horizonAtMs: entry.horizonAtMs,
      realPositionClosedAtMs: entry.realPositionClosedAtMs,
      realFills: entry.realFills,
      observations: entry.observations,
      completed: entry.completed,
      lastObservationEventAtMs: entry.lastObservationEventAtMs,
      simulations: {
        CURRENT: {
          ...entry.simulations.CURRENT,
          decisions: entry.simulations.CURRENT.decisions,
        },
        CANDIDATE: {
          ...entry.simulations.CANDIDATE,
          decisions: entry.simulations.CANDIDATE.decisions,
        },
      },
    });
  }
}

export function isValidProspectiveExitEntrySnapshot(
  snapshot: unknown,
  maxObservationsPerEntry = 512,
): snapshot is ProspectiveExitEntrySnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return new MicroBurstProspectiveExitObserver({ maxObservationsPerEntry }).validateSnapshot(
    snapshot as ProspectiveExitEntrySnapshot,
  );
}
