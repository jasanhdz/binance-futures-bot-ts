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
  'bot owner semantics',
  `  positionOwner?: 'AEGIS' | 'EXTERNAL' | 'UNKNOWN';`,
  `  /** BOT is canonical. AEGIS remains readable only for persisted legacy state migration. */\n  positionOwner?: 'BOT' | 'AEGIS' | 'EXTERNAL' | 'UNKNOWN';`,
));

edit('src/app/services/TradingService.ts', (source) => {
  source = replaceOnce(
    source,
    'verified bot ownership accepts legacy and canonical',
    `    private isVerifiedBotOwnedState(state: BotState): boolean {\n        return state.positionOwner === 'AEGIS'\n            && state.tradeOrigin === 'BOT'\n            && state.ownershipStatus === 'VERIFIED'\n            && state.eligibleForBotMetrics === true;\n    }`,
    `    private isVerifiedBotOwnedState(state: BotState): boolean {\n        return (state.positionOwner === 'BOT' || state.positionOwner === 'AEGIS')\n            && state.tradeOrigin === 'BOT'\n            && state.ownershipStatus === 'VERIFIED'\n            && state.eligibleForBotMetrics === true;\n    }`,
  );

  // Every new/recovered bot-owned write becomes strategy-neutral BOT ownership.
  source = source.replaceAll(`positionOwner: 'AEGIS'`, `positionOwner: 'BOT'`);

  source = replaceOnce(
    source,
    'Aegis gate strategy-owned counters',
    `        const botState = this.stateForSymbol(symbol).get();\n        const timeSinceLastExitMs = Date.now() - (botState.lastExitAt || 0);\n        const liquidityStress = this.detector[symbol]?.getLiquidityStress() || 0;\n\n        return shouldEnterAegisTurboMicroLive(\n            {\n                symbol,\n                signal: { aegis: signal.metadata?.aegis ?? signal.aegis },\n                hasOpenPosition: botState.mode !== 'IDLE',\n                tradesToday: this.tradesToday,\n                consecutiveLosses: this.consecutiveLossTracker.value,\n                timeSinceLastExitMs,\n                liquidityStress,\n                dailyPnlPct\n            },`,
    `        const botState = this.stateForSymbol(symbol).get();\n        const now = Date.now();\n        const aegisRisk = this.strategyRiskLedger.snapshot('AEGIS_TURBO', now);\n        const timeSinceLastExitMs = this.strategyRiskLedger.timeSinceLastExitMs('AEGIS_TURBO', now);\n        const liquidityStress = this.detector[symbol]?.getLiquidityStress() || 0;\n\n        return shouldEnterAegisTurboMicroLive(\n            {\n                symbol,\n                signal: { aegis: signal.metadata?.aegis ?? signal.aegis },\n                hasOpenPosition: botState.mode !== 'IDLE',\n                tradesToday: aegisRisk.tradesToday,\n                consecutiveLosses: aegisRisk.consecutiveLosses,\n                timeSinceLastExitMs,\n                liquidityStress,\n                dailyPnlPct\n            },`,
  );

  source = replaceOnce(
    source,
    'portfolio exposure side validation',
    `                const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);\n                if (!position) continue;\n                openPositions++;`,
    `                const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);\n                if (!position) continue;\n                // Defensive adapter validation: a LONG object returned for a SHORT lookup\n                // (or vice versa) must not be counted as a second position. Hedge-mode\n                // adapters may still return BOTH and remain authoritative for their lookup.\n                if ((position.sideMode === 'LONG' || position.sideMode === 'SHORT') && position.sideMode !== side) {\n                    continue;\n                }\n                openPositions++;`,
  );

  source = replaceOnce(
    source,
    'Aegis entry context gets strategy risk snapshot',
    `        const lastStopLossAt = this.mostRecentStopLossAt();\n        const now = Date.now();\n        const sameSymbolPositionExists`,
    `        const lastStopLossAt = this.mostRecentStopLossAt();\n        const now = Date.now();\n        const aegisRisk = this.strategyRiskLedger.snapshot('AEGIS_TURBO', now);\n        const sameSymbolPositionExists`,
  );
  source = replaceOnce(
    source,
    'Aegis entry context strategy counters',
    `            operational: {\n                consecutiveLosses: this.consecutiveLossTracker.value,\n                tradesToday: this.tradesToday,`,
    `            operational: {\n                consecutiveLosses: aegisRisk.consecutiveLosses,\n                tradesToday: aegisRisk.tradesToday,`,
  );

  source = replaceOnce(
    source,
    'strategy-owned bracket requirement',
    `        const side = botState.lastSide as Side;\n        let entryPrice = botState.lastEntryPrice || 0;\n        let leverage = botState.lastActualLeverage || botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;\n        const requireBrackets = lifecyclePolicy.requireStopBracket || lifecyclePolicy.requireTakeProfitBracket;`,
    `        const side = botState.lastSide as Side;\n        let entryPrice = botState.lastEntryPrice || 0;\n        let leverage = botState.lastActualLeverage || botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;\n        const configuredRequireBrackets = lifecyclePolicy.strategyId === 'AEGIS_TURBO'\n            ? this.getAegisTurboYamlConfig()?.require_brackets !== false\n            : lifecyclePolicy.strategyId === 'MOMENTUM_RIDE'\n                ? this.getAegisMomentumRideConfig().safetyCaps.requireBrackets\n                : true;\n        const requireBrackets = configuredRequireBrackets\n            && (lifecyclePolicy.requireStopBracket || lifecyclePolicy.requireTakeProfitBracket);`,
  );

  return source;
});

// Remove package scripts whose source targets no longer exist. Keeping them makes the
// public runtime surface lie about capabilities and obscures the architecture.
edit('package.json', (source) => {
  const pkg = JSON.parse(source);
  const stale = [
    'verify:feats',
    'bt',
    'bt:ml',
    'bt:stack:file',
    'scan:mom',
    'scan:testnet',
    'export:trades',
    'audit:orders',
    'report:accuracy',
    'logs:table',
  ];
  for (const key of stale) delete pkg.scripts?.[key];
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

console.log('Applied runtime cleanup v1');
