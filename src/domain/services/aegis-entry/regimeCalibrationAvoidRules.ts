import { Side } from '../../types';
import { AegisRegimeLabel } from '../AegisRegimeGuard';

export type RegimeCalibrationAvoidMode = 'SHADOW_ONLY';
export type RegimeCalibrationAvoidSource = 'calibration_20260522';

export type RegimeCalibrationAvoidRuleSet = {
    source: RegimeCalibrationAvoidSource;
    mode: RegimeCalibrationAvoidMode;
    not_live_enforced: true;
    rules: Record<string, Partial<Record<Side, AegisRegimeLabel[]>>>;
};

export const CALIBRATION_20260522_AVOID_RULES: RegimeCalibrationAvoidRuleSet = {
    source: 'calibration_20260522',
    mode: 'SHADOW_ONLY',
    not_live_enforced: true,
    rules: {
        ADAUSDT: {
            LONG: ['CHOP', 'TREND_UP'],
            SHORT: ['HIGH_VOL_RISK', 'UNKNOWN']
        },
        AVAXUSDT: {
            LONG: ['CHOP', 'MOMENTUM_UP', 'TREND_UP'],
            SHORT: ['HIGH_VOL_RISK', 'MOMENTUM_DOWN', 'TREND_DOWN', 'UNKNOWN']
        },
        BNBUSDT: {
            LONG: ['BREAKOUT_UP', 'CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_UP'],
            SHORT: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        },
        BTCUSDT: {
            LONG: ['CHOP', 'EXHAUSTION', 'MOMENTUM_UP'],
            SHORT: ['BREAKOUT_DOWN', 'CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        },
        DOGEUSDT: {
            LONG: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_UP', 'TREND_UP'],
            SHORT: ['MOMENTUM_DOWN', 'TREND_DOWN', 'UNKNOWN']
        },
        ETHUSDT: {
            LONG: ['CHOP', 'HIGH_VOL_RISK'],
            SHORT: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        },
        LINKUSDT: {
            LONG: ['MOMENTUM_UP', 'TREND_UP', 'UNKNOWN'],
            SHORT: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        },
        LTCUSDT: {
            LONG: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_UP', 'UNKNOWN'],
            SHORT: ['BREAKOUT_DOWN', 'CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN', 'UNKNOWN']
        },
        SOLUSDT: {
            LONG: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_UP', 'UNKNOWN'],
            SHORT: ['CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        },
        SUIUSDT: {
            LONG: ['BREAKOUT_UP', 'MOMENTUM_UP', 'TREND_UP'],
            SHORT: ['BREAKOUT_DOWN', 'CHOP', 'HIGH_VOL_RISK', 'TREND_DOWN', 'UNKNOWN']
        },
        XRPUSDT: {
            LONG: ['CHOP', 'MOMENTUM_UP', 'UNKNOWN'],
            SHORT: ['BREAKOUT_DOWN', 'CHOP', 'HIGH_VOL_RISK', 'MOMENTUM_DOWN']
        }
    }
};

export function getCalibrationAvoidRules(): RegimeCalibrationAvoidRuleSet {
    return CALIBRATION_20260522_AVOID_RULES;
}
