import fs from 'node:fs';

const file = 'src/app/services/TradingService.ts';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(label, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`anchor not found: ${label}`);
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

replaceOnce(
  'position manager imports',
  `import { PositionManagerRouter } from '../strategy/PositionManagerRouter';\nimport { LegacyPositionManagerAdapter } from '../strategy/LegacyStrategyCompatibility';`,
  `import { PositionManagerRouter } from '../strategy/PositionManagerRouter';\nimport { AegisPositionManager, MomentumRidePositionManager } from '../strategy/OwnedPositionManagers';`
);

replaceOnce(
  'lifecycle policy import',
  `import { strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';`,
  `import { StrategyLifecyclePolicy, strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';`
);

const oldRegistration = `        this.positionManagerRouter.register(new LegacyPositionManagerAdapter(\n            'AEGIS_TURBO',\n            async (_identity, context) => {\n                await this.managePositionLegacy(context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`AEGIS-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'legacy_aegis_position_manager_completed',\n                    diagnostics: { compatibilityAdapter: true }\n                };\n            }\n        ));\n        this.positionManagerRouter.register(new LegacyPositionManagerAdapter(\n            'MOMENTUM_RIDE',\n            async (_identity, context) => {\n                await this.managePositionLegacy(context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`MOMENTUM-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'legacy_momentum_position_manager_completed',\n                    diagnostics: { compatibilityAdapter: true }\n                };\n            }\n        ));`;

const newRegistration = `        this.positionManagerRouter.register(new AegisPositionManager(\n            async (_identity, policy, context) => {\n                await this.managePositionLifecycle(policy, context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`AEGIS-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'aegis_position_manager_completed',\n                    diagnostics: { lifecyclePolicy: policy }\n                };\n            }\n        ));\n        this.positionManagerRouter.register(new MomentumRidePositionManager(\n            async (_identity, policy, context) => {\n                await this.managePositionLifecycle(policy, context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`MOMENTUM-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'momentum_position_manager_completed',\n                    diagnostics: { lifecyclePolicy: policy }\n                };\n            }\n        ));`;
replaceOnce('owned manager registration', oldRegistration, newRegistration);

replaceOnce(
  'unowned fallback',
  `        if (!identity) {\n            await this.managePositionLegacy(symbol, botState, symbolState);\n            return;\n        }`,
  `        if (!identity) {\n            // Legacy/manual compatibility remains isolated from strategy-owned managers.\n            await this.managePositionLifecycle(strategyLifecyclePolicy('AEGIS_TURBO'), symbol, botState, symbolState);\n            return;\n        }`
);

replaceOnce(
  'lifecycle signature',
  `    private async managePositionLegacy(symbol: string, botState: BotState, symbolState: StateStore): Promise<void> {\n        const { exchange, logger, notifier } = this.deps;\n        const side = botState.lastSide as Side;\n        const lifecycleOwner = resolveStrategyOwnership(botState);\n        const lifecycleStrategy = lifecycleOwner.status === 'OWNED' ? lifecycleOwner.strategyId : 'AEGIS_TURBO';\n        const lifecyclePolicy = strategyLifecyclePolicy(lifecycleStrategy);\n        let entryPrice = botState.lastEntryPrice || 0;\n        let leverage = botState.lastActualLeverage || botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;\n        const requireBrackets = this.getAegisTurboYamlConfig()?.require_brackets !== false;`,
  `    private async managePositionLifecycle(\n        lifecyclePolicy: StrategyLifecyclePolicy,\n        symbol: string,\n        botState: BotState,\n        symbolState: StateStore\n    ): Promise<void> {\n        const { exchange, logger, notifier } = this.deps;\n        const side = botState.lastSide as Side;\n        let entryPrice = botState.lastEntryPrice || 0;\n        let leverage = botState.lastActualLeverage || botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;\n        const requireBrackets = lifecyclePolicy.requireStopBracket || lifecyclePolicy.requireTakeProfitBracket;`
);

replaceOnce(
  'quantity reconciliation policy',
  `            if (isBotOwned) {\n                const quantityChangeResult = await this.reconcileManualPositionSizeIncrease({`,
  `            if (isBotOwned && lifecyclePolicy.allowManualQuantityReconciliation) {\n                const quantityChangeResult = await this.reconcileManualPositionSizeIncrease({`
);

replaceOnce(
  'strategy time limit',
  `            const maxHoldMs = regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;\n            if (tradeDuration > maxHoldMs && currentRoe > 0.02) {\n                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AEGIS_TIME_LIMIT');\n                symbolState.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_TIME_LIMIT', probeModeActive: false });\n                const pnl = this.pnlFromRoe(this.entryMargin(botState), currentRoe);\n                await this.notifyExit(symbol, side, 'TIME_LIMIT', botState, { exitPrice: markPrice, finalRoe: currentRoe, pnl });\n                return;\n            }`,
  `            const maxHoldMs = regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;\n            if (tradeDuration > maxHoldMs && currentRoe > 0.02) {\n                const timeLimitReason = lifecyclePolicy.strategyId === 'MOMENTUM_RIDE'\n                    ? 'MOMENTUM_TIME_LIMIT'\n                    : 'AEGIS_TIME_LIMIT';\n                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, timeLimitReason);\n                symbolState.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: timeLimitReason, probeModeActive: false });\n                const pnl = this.pnlFromRoe(this.entryMargin(botState), currentRoe);\n                await this.notifyExit(symbol, side, timeLimitReason, botState, { exitPrice: markPrice, finalRoe: currentRoe, pnl });\n                return;\n            }\n\n            if (!lifecyclePolicy.useLegacyProfitGuardian) {\n                logger.debug('strategy_position_guardian_disabled', {\n                    symbol,\n                    strategyId: lifecyclePolicy.strategyId,\n                    tradeId: botState.lastTradeId\n                });\n                return;\n            }`
);

replaceOnce(
  'break even armed policy',
  `            if (previousPeakRoe < guardianConfig.beTriggerRoe && updatedPeakRoe >= guardianConfig.beTriggerRoe) {`,
  `            if (lifecyclePolicy.useBreakEven\n                && previousPeakRoe < guardianConfig.beTriggerRoe\n                && updatedPeakRoe >= guardianConfig.beTriggerRoe) {`
);

replaceOnce(
  'trailing armed policy',
  `            if (\n                guardianConfig.trailingActivationRoe !== undefined`,
  `            if (\n                lifecyclePolicy.useTrailing\n                && guardianConfig.trailingActivationRoe !== undefined`
);

replaceOnce(
  'break even execution policy',
  `            if (action.type === 'MOVE_SL_BE' && action.price) {`,
  `            if (lifecyclePolicy.useBreakEven && action.type === 'MOVE_SL_BE' && action.price) {`
);

replaceOnce(
  'trailing execution policy',
  `            } else if (action.type === 'MOVE_SL_TRAILING' && action.price) {`,
  `            } else if (lifecyclePolicy.useTrailing && action.type === 'MOVE_SL_TRAILING' && action.price) {`
);

replaceOnce(
  'manager error ownership',
  `        } catch (error) {\n            logger.warn('Aegis management error', { symbol, error: String(error) });\n        }\n    }\n\n    private async notifyExit(`,
  `        } catch (error) {\n            logger.warn('strategy_position_management_error', {\n                symbol,\n                strategyId: lifecyclePolicy.strategyId,\n                error: String(error)\n            });\n        }\n    }\n\n    private async notifyExit(`
);

fs.writeFileSync(file, source);
console.log('Applied strategy-owned position managers');
