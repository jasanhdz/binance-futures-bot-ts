import { StrategyIdentity, StrategyMode } from '../../domain/strategy/StrategyIdentity';
import {
  LegacyEntryEvaluator,
  LegacyEntryStrategyAdapter,
  LegacyPositionEvaluator,
  LegacyPositionManagerAdapter,
} from './LegacyStrategyCompatibility';
import { PositionManagerRouter } from './PositionManagerRouter';
import { StrategyRouter } from './StrategyRouter';

export interface LegacyStrategyBinding<TEntryContext, TPositionContext> {
  identity: StrategyIdentity;
  mode: StrategyMode;
  evaluateEntry: LegacyEntryEvaluator<TEntryContext>;
  managePosition: LegacyPositionEvaluator<TPositionContext>;
}

export interface LegacyStrategyRuntimeBindings<TEntryContext, TPositionContext> {
  aegis: LegacyStrategyBinding<TEntryContext, TPositionContext>;
  momentum: LegacyStrategyBinding<TEntryContext, TPositionContext>;
}

export function createLegacyStrategyRuntime<TEntryContext, TPositionContext>(
  bindings: LegacyStrategyRuntimeBindings<TEntryContext, TPositionContext>,
) {
  if (bindings.aegis.identity.strategyId !== 'AEGIS_TURBO') {
    throw new Error('AEGIS_BINDING_REQUIRES_AEGIS_TURBO_IDENTITY');
  }
  if (bindings.momentum.identity.strategyId !== 'MOMENTUM_RIDE') {
    throw new Error('MOMENTUM_BINDING_REQUIRES_MOMENTUM_RIDE_IDENTITY');
  }

  const strategyRouter = new StrategyRouter<TEntryContext>();
  strategyRouter.register(
    new LegacyEntryStrategyAdapter(
      bindings.aegis.identity,
      bindings.aegis.mode,
      bindings.aegis.evaluateEntry,
    ),
  );
  strategyRouter.register(
    new LegacyEntryStrategyAdapter(
      bindings.momentum.identity,
      bindings.momentum.mode,
      bindings.momentum.evaluateEntry,
    ),
  );

  const positionManagerRouter = new PositionManagerRouter<TPositionContext>();
  positionManagerRouter.register(
    new LegacyPositionManagerAdapter('AEGIS_TURBO', bindings.aegis.managePosition),
  );
  positionManagerRouter.register(
    new LegacyPositionManagerAdapter('MOMENTUM_RIDE', bindings.momentum.managePosition),
  );

  return { strategyRouter, positionManagerRouter };
}
