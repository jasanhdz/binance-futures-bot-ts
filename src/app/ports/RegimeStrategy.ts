/**
 * RegimeStrategy Port - Application Layer Interface
 *
 * Defines regime configuration types.
 * AEGIS_TURBO is the only active regime.
 */

export type RegimeType = 'AEGIS_TURBO';

export interface RegimeConfig {
  leverage: number;
  hardStopRoe: number;
  tpRoe: number;
  entryThreshold: number;
  maxHoldMs?: number;
  beRoe?: number;
  trailingActivationRoe?: number;
  trailingCallbackRoe?: number;
  forbiddenHours?: number[];
  forbiddenDays?: number[];
  useExitAgent?: boolean; // Toggles the V3 Exit Agent Double Confirmation and Panic Close. Default is true.
}
