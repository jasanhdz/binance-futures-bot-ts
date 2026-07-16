/**
 * Exit policy per owner — which execution modules each strategy is allowed to
 * use, and (critically) WHO manages the position. This is a selection layer over
 * the EXISTING mature modules (brackets, trailing, ProfitGuardian, TimeExit,
 * Telegram, reconciliation); it does NOT reimplement any of them.
 *
 * - PHASE_O: full original policy, managed by TradingService (unchanged).
 * - GEN2:    stop + take-profit + H12 time-exit + kill switch + Telegram +
 *            reconciliation ONLY. Managed by the Gen2 bridge, NOT by
 *            TradingService — so trailing/callback/ProfitGuardian/pyramid/
 *            scale-in never touch a Gen2 position (they would change the exit
 *            and exposure ECON1 measured).
 * - MANUAL:  ignored by every strategy — never auto-managed.
 * - UNKNOWN: never auto-managed; raises an incident.
 */
import { Owner } from './PositionOwnership';

export type ExitModule =
  | 'STOP'
  | 'TAKE_PROFIT'
  | 'H12_TIME_EXIT'
  | 'PHASE_O_TIME_LIMIT'
  | 'TRAILING'
  | 'CALLBACK'
  | 'PROFIT_GUARDIAN'
  | 'PYRAMID'
  | 'SCALE_IN'
  | 'KILL_SWITCH'
  | 'TELEGRAM'
  | 'RECONCILIATION';

export type ManagedBy = 'TRADING_SERVICE' | 'GEN2_BRIDGE' | 'NONE';

export interface ExitPolicyDescriptor {
  name: string;
  managedBy: ManagedBy;
  modules: ExitModule[];
}

export const PHASE_O_EXIT_POLICY: ExitPolicyDescriptor = {
  name: 'PHASE_O_FULL',
  managedBy: 'TRADING_SERVICE',
  modules: [
    'STOP', 'TAKE_PROFIT', 'PHASE_O_TIME_LIMIT', 'TRAILING', 'CALLBACK',
    'PROFIT_GUARDIAN', 'KILL_SWITCH', 'TELEGRAM', 'RECONCILIATION',
  ],
};

export const GEN2_EXIT_POLICY: ExitPolicyDescriptor = {
  name: 'GEN2_H12',
  managedBy: 'GEN2_BRIDGE',
  modules: ['STOP', 'TAKE_PROFIT', 'H12_TIME_EXIT', 'KILL_SWITCH', 'TELEGRAM', 'RECONCILIATION'],
};

export const MANUAL_EXIT_POLICY: ExitPolicyDescriptor = {
  name: 'MANUAL',
  managedBy: 'NONE',
  modules: [],
};

export const UNKNOWN_EXIT_POLICY: ExitPolicyDescriptor = {
  name: 'UNKNOWN',
  managedBy: 'NONE',
  modules: [],
};

export function exitPolicyForOwner(owner: Owner): ExitPolicyDescriptor {
  switch (owner) {
    case 'PHASE_O':
      return PHASE_O_EXIT_POLICY;
    case 'GEN2':
      return GEN2_EXIT_POLICY;
    case 'MANUAL':
      return MANUAL_EXIT_POLICY;
    default:
      return UNKNOWN_EXIT_POLICY;
  }
}

/** Does TradingService (the Phase O executor) own the management of this position? */
export function tradingServiceManages(owner: Owner): boolean {
  return exitPolicyForOwner(owner).managedBy === 'TRADING_SERVICE';
}
