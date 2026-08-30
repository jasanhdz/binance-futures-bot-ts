import { StrategyId } from './StrategyIdentity';

export type StrategyLifecycleOwner = StrategyId | 'EXTERNAL';

export interface StrategyLifecyclePolicy {
  strategyId: StrategyLifecycleOwner;
  /** Legacy ProfitGuardian is allowed only while an owner explicitly declares it. */
  useLegacyProfitGuardian: boolean;
  useBreakEven: boolean;
  useTrailing: boolean;
  requireStopBracket: boolean;
  requireTakeProfitBracket: boolean;
  closeIfBracketFails: boolean;
  allowManualQuantityReconciliation: boolean;
}

const AEGIS_POLICY: StrategyLifecyclePolicy = {
  strategyId: 'AEGIS_TURBO',
  useLegacyProfitGuardian: true,
  useBreakEven: true,
  useTrailing: true,
  requireStopBracket: true,
  requireTakeProfitBracket: true,
  closeIfBracketFails: true,
  allowManualQuantityReconciliation: true,
};

const MOMENTUM_POLICY: StrategyLifecyclePolicy = {
  strategyId: 'MOMENTUM_RIDE',
  // Keep the existing deterministic protective mechanics during migration,
  // but they are Momentum-owned once routed through this policy.
  useLegacyProfitGuardian: true,
  useBreakEven: true,
  useTrailing: true,
  requireStopBracket: true,
  requireTakeProfitBracket: true,
  closeIfBracketFails: true,
  allowManualQuantityReconciliation: true,
};

const MICRO_BURST_RESERVED_POLICY: StrategyLifecyclePolicy = {
  strategyId: 'MICRO_BURST_V1',
  useLegacyProfitGuardian: false,
  useBreakEven: false,
  useTrailing: false,
  requireStopBracket: true,
  requireTakeProfitBracket: false,
  closeIfBracketFails: true,
  allowManualQuantityReconciliation: false,
};

const EXTERNAL_POLICY: StrategyLifecyclePolicy = {
  strategyId: 'EXTERNAL',
  // External/manual positions keep only the protective mechanics that were
  // historically provided by the Aegis fallback. They do not inherit Aegis authority.
  useLegacyProfitGuardian: true,
  useBreakEven: true,
  useTrailing: true,
  requireStopBracket: true,
  requireTakeProfitBracket: true,
  closeIfBracketFails: true,
  allowManualQuantityReconciliation: false,
};

export function strategyLifecyclePolicy(strategyId: StrategyId): StrategyLifecyclePolicy {
  switch (strategyId) {
    case 'AEGIS_TURBO':
      return AEGIS_POLICY;
    case 'MOMENTUM_RIDE':
      return MOMENTUM_POLICY;
    case 'MICRO_BURST_V1':
      return MICRO_BURST_RESERVED_POLICY;
  }
}

export function externalLifecyclePolicy(): StrategyLifecyclePolicy {
  return EXTERNAL_POLICY;
}
