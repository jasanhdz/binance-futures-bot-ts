/**
 * RegimeStrategy Port - Application Layer Interface
 * 
 * Defines regime configuration types.
 * PHANTOM is the only active regime.
 */

export type RegimeType = 'PHANTOM';

export interface RegimeConfig {
    leverage: number;
    hardStopRoe: number;
    tpRoe: number;
    entryThreshold: number;
    maxHoldMs?: number;
}
