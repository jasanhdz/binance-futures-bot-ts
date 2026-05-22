#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import { NinjaConfigManager } from '../../src/infra/config/ConfigLoader';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortDeep(value: unknown): JsonValue {
    if (Array.isArray(value)) {
        return value.map((item) => sortDeep(item));
    }

    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, JsonValue>>((acc, key) => {
                acc[key] = sortDeep((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }

    if (value === undefined) return null;
    if (
        value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || typeof value === 'string'
    ) {
        return value;
    }

    return String(value);
}

function parseArgs(argv: string[]): { configPath: string; outPath?: string } {
    let configPath = 'regime_config.live.yaml';
    let outPath: string | undefined;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--config' && argv[index + 1]) {
            configPath = argv[++index];
        } else if (arg === '--out' && argv[index + 1]) {
            outPath = argv[++index];
        }
    }

    return {
        configPath: path.resolve(process.cwd(), configPath),
        outPath: outPath ? path.resolve(process.cwd(), outPath) : undefined
    };
}

function withSuppressedConfigLogs<T>(fn: () => T): T {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        return fn();
    } finally {
        console.log = originalLog;
    }
}

function buildDump(configPath: string): JsonValue {
    const config = withSuppressedConfigLogs(() => new NinjaConfigManager(configPath));
    const momentumRide = config.getAegisMomentumRideConfig();
    const symbols = Array.from(new Set([
        ...config.getSymbols(),
        ...config.getSymbolsWithOverrides(),
        ...Object.keys(config.getAegisSymbolConfigs()),
        ...Object.keys(momentumRide.symbols)
    ])).sort();

    const symbolDetails = Object.fromEntries(symbols.map((symbol) => [
        symbol,
        {
            aegisMode: config.getSymbolMode(symbol),
            capitalAllocation: config.getCapitalAllocation(symbol),
            regimeConfigs: {
                AEGIS_TURBO: config.getRegimeConfig('AEGIS_TURBO', symbol)
            },
            guardianConfigs: {
                AEGIS_TURBO: config.getGuardianConfig('AEGIS_TURBO', symbol)
            },
            turboPositionFractionOverrides: {
                long: config.getAegisPositionFractionOverride(symbol, 'LONG') || null,
                short: config.getAegisPositionFractionOverride(symbol, 'SHORT') || null
            },
            momentumRide: momentumRide.symbols[symbol] || null
        }
    ]));

    return sortDeep({
        source: {
            configPath,
            generatedBy: 'scripts/aegis/dump_effective_config.ts',
            schemaVersion: 1
        },
        global: {
            system: config.system,
            trading: config.trading,
            regimeDetector: config.regimeDetector,
            immuneSystem: config.immuneSystem,
            symbolAllocations: config.getSymbolAllocations()
        },
        symbols: {
            all: symbols,
            configured: config.getAegisSymbolConfigs(),
            activeAegis: config.getActiveAegisSymbols(),
            liveAegis: config.getLiveAegisSymbols(),
            shadowAegis: config.getShadowAegisSymbols(),
            withOverrides: config.getSymbolsWithOverrides(),
            details: symbolDetails
        },
        aegis: {
            turbo: config.getAegisTurboConfig() || null,
            portfolioRisk: config.getAegisPortfolioRiskConfig(),
            shortGate: config.getAegisShortGateConfig(),
            eventRisk: config.getAegisEventRiskConfig(),
            regimeGuard: config.getAegisRegimeGuardConfig(),
            regimeContext: config.getAegisRegimeContextConfig(),
            momentumRide,
            entryPolicy: config.getAegisEntryPolicyConfig(),
            probeMode: config.getAegisProbeModeConfig(),
            decisionEnforcement: config.getAegisDecisionEnforcementConfig(),
            cleanEntryGuard: config.getAegisCleanEntryGuardConfig(),
            telegramNotifications: config.getAegisTelegramNotificationsConfig(),
            entryQualityGate: config.getEntryQualityGateConfig(),
            exitEye: config.getAegisExitEyeConfig(),
            profitProtection: config.getAegisProfitProtectionConfig()
        }
    });
}

const { configPath, outPath } = parseArgs(process.argv.slice(2));
const body = `${JSON.stringify(buildDump(configPath), null, 2)}\n`;

if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body, 'utf-8');
} else {
    process.stdout.write(body);
}
