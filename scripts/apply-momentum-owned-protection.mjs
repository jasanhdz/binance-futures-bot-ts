import fs from 'node:fs';

function edit(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (before === after) throw new Error(`no changes produced for ${path}`);
  fs.writeFileSync(path, after);
}

function replaceOnce(source, label, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`anchor not found (${label})`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

edit('src/domain/types.ts', (source) => replaceOnce(
  source,
  'persist max hold',
  `  lastTrailingCallbackRoe?: number;\n`,
  `  lastTrailingCallbackRoe?: number;\n  lastMaxHoldMs?: number;\n`,
));

edit('src/domain/services/aegis-entry/AegisEntryDecisionTypes.ts', (source) => {
  source = replaceOnce(
    source,
    'momentum runtime protection',
    `    requireBtcEthConfirmation: boolean;\n    symbols: Record<string, AegisMomentumRideSymbolRuntimeConfig>;\n    safetyCaps: {`,
    `    requireBtcEthConfirmation: boolean;\n    symbols: Record<string, AegisMomentumRideSymbolRuntimeConfig>;\n    /**\n     * Strategy-owned protection. Optional only for backward-compatible test/fixture\n     * construction; ConfigLoader always normalizes it in production.\n     */\n    protection?: {\n        hardStopRoe: number;\n        takeProfitRoe: number;\n        breakEvenRoe: number;\n        trailingActivationRoe: number;\n        trailingCallbackRoe: number;\n        maxHoldMs: number;\n    };\n    safetyCaps: {`,
  );
  source = replaceOnce(
    source,
    'momentum runtime shared safety ownership',
    `        disableSymbolAfterStopLossMinutes: number;\n        requireBrackets: boolean;`,
    `        disableSymbolAfterStopLossMinutes: number;\n        /** Backward-compatible optional fields; ConfigLoader supplies defaults. */\n        maxLiquidityStress?: number;\n        dailyLossStopPct?: number;\n        requireBrackets: boolean;`,
  );
  return source;
});

edit('src/infra/config/ConfigLoader.ts', (source) => {
  source = replaceOnce(
    source,
    'momentum yaml protection',
    `    symbols?: Record<string, AegisMomentumRideSymbolYamlConfig>;\n    safety_caps?: {`,
    `    symbols?: Record<string, AegisMomentumRideSymbolYamlConfig>;\n    protection?: {\n        hard_stop_roe?: number;\n        take_profit_roe?: number;\n        break_even_roe?: number;\n        trailing_activation_roe?: number;\n        trailing_callback_roe?: number;\n        max_hold_ms?: number;\n    };\n    safety_caps?: {`,
  );
  source = replaceOnce(
    source,
    'momentum yaml safety limits',
    `        disable_symbol_after_stop_loss_minutes?: number;\n        require_brackets?: boolean;`,
    `        disable_symbol_after_stop_loss_minutes?: number;\n        max_liquidity_stress?: number;\n        daily_loss_stop_pct?: number;\n        require_brackets?: boolean;`,
  );
  source = replaceOnce(
    source,
    'momentum config protection normalization',
    `            requireBtcEthConfirmation: raw.require_btc_eth_confirmation === true,\n            symbols,\n            safetyCaps: {`,
    `            requireBtcEthConfirmation: raw.require_btc_eth_confirmation === true,\n            symbols,\n            protection: {\n                hardStopRoe: Math.min(-0.0001, this.finiteNumber(raw.protection?.hard_stop_roe, -0.40)),\n                takeProfitRoe: Math.max(0.0001, this.finiteNumber(raw.protection?.take_profit_roe, 0.50)),\n                breakEvenRoe: Math.max(0, this.finiteNumber(raw.protection?.break_even_roe, 0.08)),\n                trailingActivationRoe: Math.max(0, this.finiteNumber(raw.protection?.trailing_activation_roe, 0.15)),\n                trailingCallbackRoe: Math.max(0, this.finiteNumber(raw.protection?.trailing_callback_roe, 0.08)),\n                maxHoldMs: Math.max(60_000, Math.floor(this.finiteNumber(raw.protection?.max_hold_ms, 28_800_000)))\n            },\n            safetyCaps: {`,
  );
  source = replaceOnce(
    source,
    'momentum config safety normalization',
    `                disableSymbolAfterStopLossMinutes: Math.max(0, this.finiteNumber(safety.disable_symbol_after_stop_loss_minutes, 120)),\n                requireBrackets: safety.require_brackets !== false,`,
    `                disableSymbolAfterStopLossMinutes: Math.max(0, this.finiteNumber(safety.disable_symbol_after_stop_loss_minutes, 120)),\n                maxLiquidityStress: Math.max(0, this.finiteNumber(safety.max_liquidity_stress, 0.70)),\n                dailyLossStopPct: Math.max(0, this.finiteNumber(safety.daily_loss_stop_pct, 0.90)),\n                requireBrackets: safety.require_brackets !== false,`,
  );
  return source;
});

edit('regime_config.live.yaml', (source) => {
  source = replaceOnce(
    source,
    'momentum owned protection yaml',
    `    safety_caps:\n      max_leverage: 30`,
    `    protection:\n      # Strategy-owned lifecycle. Values intentionally match the pre-migration\n      # effective protection so ownership changes without changing economics.\n      hard_stop_roe: -0.40\n      take_profit_roe: 0.50\n      break_even_roe: 0.08\n      trailing_activation_roe: 0.15\n      trailing_callback_roe: 0.08\n      max_hold_ms: 28800000\n    safety_caps:\n      max_leverage: 30`,
  );
  source = replaceOnce(
    source,
    'momentum owned safety yaml',
    `      disable_symbol_after_stop_loss_minutes: 120\n      require_brackets: true`,
    `      disable_symbol_after_stop_loss_minutes: 120\n      max_liquidity_stress: 0.70\n      daily_loss_stop_pct: 0.90\n      require_brackets: true`,
  );
  return source;
});

edit('src/app/services/TradingService.ts', (source) => {
  source = replaceOnce(
    source,
    'remove Aegis gate dependency from Momentum safety',
    `        const gateConfig = this.getAegisTurboGateConfig(symbol);\n        const policy = {`,
    `        const policy = {`,
  );
  source = replaceOnce(
    source,
    'momentum safety config ownership',
    `            minCooldownMs: config.safetyCaps.cooldownAfterLossMinutes * 60_000,\n            maxLiquidityStress: gateConfig.maxLiquidityStress,\n            dailyLossStopPct: gateConfig.dailyLossStopPct,`,
    `            minCooldownMs: config.safetyCaps.cooldownAfterLossMinutes * 60_000,\n            maxLiquidityStress: config.safetyCaps.maxLiquidityStress ?? 0.70,\n            dailyLossStopPct: config.safetyCaps.dailyLossStopPct ?? 0.90,`,
  );
  source = replaceOnce(
    source,
    'momentum protection source',
    `        const protection = this.getAegisTurboGateConfig(symbol);`,
    `        const protection = config.protection ?? {\n            hardStopRoe: -0.40,\n            takeProfitRoe: 0.50,\n            breakEvenRoe: 0.08,\n            trailingActivationRoe: 0.15,\n            trailingCallbackRoe: 0.08,\n            maxHoldMs: 28_800_000\n        };`,
  );
  source = source.replaceAll(`stopRoe: protection.stopRoe`, `stopRoe: protection.hardStopRoe`);
  source = source.replaceAll(`takeProfitRoe: protection.takeProfitRoe`, `takeProfitRoe: protection.takeProfitRoe`);
  source = replaceOnce(
    source,
    'momentum protection metadata',
    `                protectionProfileSource: 'legacy_shared_protection_profile',`,
    `                protectionProfileSource: 'momentum_owned_protection_profile',`,
  );
  source = replaceOnce(
    source,
    'remove Aegis guardian dependency from Momentum open',
    `        const metadata = execution.metadata as Record<string, any>;\n        const guardianConfig = this.getAegisGuardianConfig(symbol, this.getAegisTurboRegimeConfig(symbol));\n        const symbolState = this.stateForSymbol(symbol);`,
    `        const metadata = execution.metadata as Record<string, any>;\n        const symbolState = this.stateForSymbol(symbol);`,
  );
  source = replaceOnce(
    source,
    'momentum state owned protection',
    `            lastStopRoe: protection.stopRoe,\n            lastTakeProfitRoe: protection.takeProfitRoe,\n            lastStopPrice: this.finiteNumber(metadata.stopPrice) ? metadata.stopPrice : undefined,\n            lastBreakEvenRoe: guardianConfig.beTriggerRoe,\n            lastTrailingActivationRoe: protection.trailingActivationRoe,\n            lastTrailingCallbackRoe: protection.trailingCallbackRoe,`,
    `            lastStopRoe: protection.hardStopRoe,\n            lastTakeProfitRoe: protection.takeProfitRoe,\n            lastStopPrice: this.finiteNumber(metadata.stopPrice) ? metadata.stopPrice : undefined,\n            lastBreakEvenRoe: protection.breakEvenRoe,\n            lastTrailingActivationRoe: protection.trailingActivationRoe,\n            lastTrailingCallbackRoe: protection.trailingCallbackRoe,\n            lastMaxHoldMs: protection.maxHoldMs,`,
  );
  source = replaceOnce(
    source,
    'momentum history protection values',
    `            stop_roe: protection.stopRoe,\n            take_profit_roe: protection.takeProfitRoe,`,
    `            stop_roe: protection.hardStopRoe,\n            take_profit_roe: protection.takeProfitRoe,`,
  );
  source = replaceOnce(
    source,
    'momentum history protection source',
    `                protectionProfileSource: 'legacy_shared_protection_profile'`,
    `                protectionProfileSource: 'momentum_owned_protection_profile'`,
  );
  source = replaceOnce(
    source,
    'Aegis persist max hold',
    `                lastTrailingCallbackRoe: effectiveGate.trailingCallbackRoe,\n                lastPositionFraction: executedPositionFraction,`,
    `                lastTrailingCallbackRoe: effectiveGate.trailingCallbackRoe,\n                lastMaxHoldMs: regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS,\n                lastPositionFraction: executedPositionFraction,`,
  );
  source = replaceOnce(
    source,
    'position lifecycle persisted max hold',
    `            const maxHoldMs = regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;`,
    `            const maxHoldMs = botState.lastMaxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;`,
  );
  return source;
});

console.log('Applied Momentum-owned protection and safety configuration');
