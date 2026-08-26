import fs from 'node:fs';

const file = 'src/app/services/TradingService.ts';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(label, before, after) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`migration anchor not found: ${label}`);
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

replaceOnce(
  'history logger imports',
  `import {\n    AegisTurboHistoryLogger,\n    generateSignalId,\n    generateTradeId,\n    getPortfolioSessionId\n} from '../../infra/logging/AegisTurboHistoryLogger';`,
  `import {\n    AegisResearchStrategy,\n    AegisTurboHistoryLogger,\n    generateSignalId,\n    generateStrategyTradeId,\n    generateTradeId,\n    getPortfolioSessionId\n} from '../../infra/logging/AegisTurboHistoryLogger';`
);

replaceOnce(
  'strategy runtime imports',
  `import {\n    AegisConsecutiveLossState,\n    AegisConsecutiveLossStateStorePort\n} from '../../infra/state/AegisConsecutiveLossStateStore';`,
  `import {\n    AegisConsecutiveLossState,\n    AegisConsecutiveLossStateStorePort\n} from '../../infra/state/AegisConsecutiveLossStateStore';\nimport { PositionManagerRouter } from '../strategy/PositionManagerRouter';\nimport { LegacyPositionManagerAdapter } from '../strategy/LegacyStrategyCompatibility';\nimport { StrategyIdentity } from '../../domain/strategy/StrategyIdentity';\nimport { resolveStrategyOwnership } from '../../domain/strategy/StrategyPositionOwnership';\nimport { createAegisMigrationIdentity } from '../../domain/strategies/aegis/AegisIdentity';\nimport { createMomentumRideLegacyIdentity } from '../../domain/strategies/momentum-ride/MomentumRideIdentity';`
);

replaceOnce(
  'runtime properties',
  `    private readonly aegisTelegramBlockNotifier = new AegisTelegramBlockNotifier();\n\n    constructor(`,
  `    private readonly aegisTelegramBlockNotifier = new AegisTelegramBlockNotifier();\n    private readonly positionManagerRouter = new PositionManagerRouter<{ symbol: string; botState: BotState; symbolState: StateStore }>();\n    private readonly aegisStrategyIdentity: StrategyIdentity;\n    private readonly momentumStrategyIdentity: StrategyIdentity;\n\n    constructor(`
);

replaceOnce(
  'constructor setup',
  `    ) {\n        this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });\n    }`,
  `    ) {\n        this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });\n        this.aegisStrategyIdentity = createAegisMigrationIdentity();\n        this.momentumStrategyIdentity = createMomentumRideLegacyIdentity();\n\n        this.positionManagerRouter.register(new LegacyPositionManagerAdapter(\n            'AEGIS_TURBO',\n            async (_identity, context) => {\n                await this.managePositionLegacy(context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`AEGIS-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'legacy_aegis_position_manager_completed',\n                    diagnostics: { compatibilityAdapter: true }\n                };\n            }\n        ));\n        this.positionManagerRouter.register(new LegacyPositionManagerAdapter(\n            'MOMENTUM_RIDE',\n            async (_identity, context) => {\n                await this.managePositionLegacy(context.symbol, context.botState, context.symbolState);\n                return {\n                    tradeId: context.botState.lastTradeId ?? \`MOMENTUM-LEGACY-\${context.symbol}\`,\n                    decision: 'NO_ACTION',\n                    reason: 'legacy_momentum_position_manager_completed',\n                    diagnostics: { compatibilityAdapter: true }\n                };\n            }\n        ));\n    }`
);

replaceOnce(
  'process position through router',
  `            if (botState.mode !== 'IDLE') {\n                await this.managePosition(symbol, botState, symbolState);`,
  `            if (botState.mode !== 'IDLE') {\n                await this.managePositionByOwner(symbol, botState, symbolState);`
);

replaceOnce(
  'insert owner routing methods',
  `    private async scanShadowOnly(symbol: string): Promise<void> {`,
  `    private strategyIdentityForState(botState: BotState): StrategyIdentity | null {\n        const ownership = resolveStrategyOwnership(botState);\n        if (ownership.status !== 'OWNED') return null;\n        if (ownership.strategyId === 'AEGIS_TURBO') return this.aegisStrategyIdentity;\n        if (ownership.strategyId === 'MOMENTUM_RIDE') return this.momentumStrategyIdentity;\n        return null;\n    }\n\n    private async managePositionByOwner(symbol: string, botState: BotState, symbolState: StateStore): Promise<void> {\n        const identity = this.strategyIdentityForState(botState);\n        if (!identity) {\n            await this.managePositionLegacy(symbol, botState, symbolState);\n            return;\n        }\n\n        const routed = await this.positionManagerRouter.route(identity, { symbol, botState, symbolState });\n        if (routed.status === 'RECOVERY_REQUIRED') {\n            this.deps.logger.error('strategy_position_manager_recovery_required', {\n                symbol,\n                tradeId: botState.lastTradeId,\n                strategyId: identity.strategyId,\n                reason: routed.reason\n            });\n            return;\n        }\n    }\n\n    private strategyFromTradeId(tradeId?: string): AegisResearchStrategy | undefined {\n        if (!tradeId) return undefined;\n        if (tradeId.startsWith('MOMENTUM-RIDE-')) return 'MOMENTUM_RIDE';\n        if (tradeId.startsWith('AEGIS-TURBO-')) return 'AEGIS_TURBO';\n        return undefined;\n    }\n\n    private strategyIdentity(strategy: AegisResearchStrategy): StrategyIdentity {\n        return strategy === 'MOMENTUM_RIDE' ? this.momentumStrategyIdentity : this.aegisStrategyIdentity;\n    }\n\n    private strategyForSymbol(symbol: string, tradeId?: string): AegisResearchStrategy {\n        const fromTrade = this.strategyFromTradeId(tradeId);\n        if (fromTrade) return fromTrade;\n        const stateStrategy = this.stateForSymbol(symbol).get().lastStrategy;\n        return stateStrategy === 'MOMENTUM_RIDE' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';\n    }\n\n    private async scanShadowOnly(symbol: string): Promise<void> {`
);

replaceOnce(
  'signal logger extras',
  `            executed?: boolean;\n            metadata?: Record<string, unknown>;\n        } = {}\n    ): Promise<void> {\n        const aegis = signal.metadata?.aegis ?? signal.aegis;`,
  `            executed?: boolean;\n            strategy?: AegisResearchStrategy;\n            identity?: StrategyIdentity;\n            metadata?: Record<string, unknown>;\n        } = {}\n    ): Promise<void> {\n        const aegis = signal.metadata?.aegis ?? signal.aegis;`
);

replaceOnce(
  'signal logger strategy',
  `        const turbo = aegis?.turbo as any;\n        const raw = turbo?.raw;\n        const gated = turbo?.gated;\n        await this.historyLogger.logSignal({`,
  `        const turbo = aegis?.turbo as any;\n        const raw = turbo?.raw;\n        const gated = turbo?.gated;\n        const inferredMomentum = signal.metadata?.momentum_stacking_replica === true;\n        const strategy = extras.strategy ?? (inferredMomentum ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO');\n        const identity = extras.identity ?? this.strategyIdentity(strategy);\n        await this.historyLogger.logSignal({`
);

replaceOnce(
  'signal logger hardcoded attribution',
  `            symbol,\n            strategy: 'AEGIS_TURBO',\n            mode: this.getTradingMode(),`,
  `            symbol,\n            strategy,\n            strategy_version: identity.strategyVersion,\n            strategy_hash: identity.strategyHash,\n            config_hash: identity.configHash,\n            code_commit_sha: identity.codeCommitSha,\n            mode: this.getTradingMode(),`
);

replaceOnce(
  'trade event input',
  `            reason?: string;\n            metadata?: Record<string, unknown>;\n        } = {}\n    ): Promise<void> {\n        await this.historyLogger.logTradeEvent({`,
  `            reason?: string;\n            strategy?: AegisResearchStrategy;\n            identity?: StrategyIdentity;\n            metadata?: Record<string, unknown>;\n        } = {}\n    ): Promise<void> {\n        const strategy = input.strategy ?? this.strategyForSymbol(symbol, input.tradeId);\n        const identity = input.identity ?? this.strategyIdentity(strategy);\n        await this.historyLogger.logTradeEvent({`
);

replaceOnce(
  'trade event hardcoded attribution',
  `            portfolio_session_id: getPortfolioSessionId(),\n            symbol,\n            strategy: 'AEGIS_TURBO',\n            mode: this.getTradingMode(),\n            event,`,
  `            portfolio_session_id: getPortfolioSessionId(),\n            symbol,\n            strategy,\n            strategy_version: identity.strategyVersion,\n            strategy_hash: identity.strategyHash,\n            config_hash: identity.configHash,\n            code_commit_sha: identity.codeCommitSha,\n            mode: this.getTradingMode(),\n            event,`
);

replaceOnce(
  'entry selected strategy',
  `            const standaloneMomentum = await this.findStandaloneMomentumCandidate(symbol);\n            const signal = standaloneMomentum\n                ? this.withStandaloneMomentumCandidate(baseSignal, standaloneMomentum)\n                : baseSignal;\n            const signalId = generateSignalId(symbol);`,
  `            const standaloneMomentum = await this.findStandaloneMomentumCandidate(symbol);\n            const selectedStrategy: AegisResearchStrategy = standaloneMomentum ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';\n            const signal = standaloneMomentum\n                ? this.withStandaloneMomentumCandidate(baseSignal, standaloneMomentum)\n                : baseSignal;\n            const signalId = generateSignalId(symbol);`
);

replaceOnce(
  'signal received strategy',
  `            await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', { metadata: { signalId } });`,
  `            await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', {\n                strategy: selectedStrategy,\n                identity: this.strategyIdentity(selectedStrategy),\n                metadata: { signalId }\n            });`
);

replaceOnce(
  'trade id and opener strategy',
  `            const tradeId = generateTradeId(symbol);\n            await this.openAegisTurboPosition(symbol, signal, gateDecision, tradeId, signalId);`,
  `            const tradeId = generateStrategyTradeId(selectedStrategy, symbol);\n            await this.openAegisTurboPosition(symbol, signal, gateDecision, tradeId, signalId, selectedStrategy);`
);

replaceOnce(
  'open function signature',
  `        gate: AegisMicroLiveGateDecision,\n        tradeId: string,\n        signalId?: string\n    ): Promise<void> {`,
  `        gate: AegisMicroLiveGateDecision,\n        tradeId: string,\n        signalId?: string,\n        requestedStrategy: AegisResearchStrategy = 'AEGIS_TURBO'\n    ): Promise<void> {`
);

replaceOnce(
  'final strategy identity state',
  `            const guardianConfig = this.getAegisGuardianConfig(symbol, regimeConfig);\n            const finalStrategyLabel = entryDecision.finalStrategy === 'momentum_ride' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';\n            symbolState.set({`,
  `            const guardianConfig = this.getAegisGuardianConfig(symbol, regimeConfig);\n            const finalStrategyLabel: AegisResearchStrategy = requestedStrategy === 'MOMENTUM_RIDE' || entryDecision.finalStrategy === 'momentum_ride'\n                ? 'MOMENTUM_RIDE'\n                : 'AEGIS_TURBO';\n            const finalStrategyIdentity = this.strategyIdentity(finalStrategyLabel);\n            symbolState.set({`
);

replaceOnce(
  'persist strategy provenance',
  `                currentRegime: 'AEGIS_TURBO',\n                lastStrategy: finalStrategyLabel,\n                lastTradeId: tradeId,`,
  `                currentRegime: 'AEGIS_TURBO',\n                lastStrategy: finalStrategyLabel,\n                lastStrategyVersion: finalStrategyIdentity.strategyVersion,\n                lastStrategyHash: finalStrategyIdentity.strategyHash,\n                lastConfigHash: finalStrategyIdentity.configHash,\n                lastCodeCommitSha: finalStrategyIdentity.codeCommitSha,\n                lastStrategyFreezeState: finalStrategyIdentity.freezeState,\n                lastTradeId: tradeId,`
);

replaceOnce(
  'trade open provenance',
  `                symbol,\n                strategy: finalStrategyLabel,\n                mode: this.getTradingMode(),`,
  `                symbol,\n                strategy: finalStrategyLabel,\n                strategy_version: finalStrategyIdentity.strategyVersion,\n                strategy_hash: finalStrategyIdentity.strategyHash,\n                config_hash: finalStrategyIdentity.configHash,\n                code_commit_sha: finalStrategyIdentity.codeCommitSha,\n                mode: this.getTradingMode(),`
);

replaceOnce(
  'rename legacy manager',
  `    private async managePosition(symbol: string, botState: BotState, symbolState: StateStore): Promise<void> {`,
  `    private async managePositionLegacy(symbol: string, botState: BotState, symbolState: StateStore): Promise<void> {`
);

replaceOnce(
  'close strategy identity',
  `        const tradeId = botState.lastTradeId ?? generateTradeId(symbol, new Date(botState.lastEntryAt ?? Date.now()));\n        const durationMinutes = durationMs / 60000;\n\n        await this.historyLogger.logTradeClose({`,
  `        const closeStrategy: AegisResearchStrategy = botState.lastStrategy === 'MOMENTUM_RIDE' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';\n        const closeIdentity = this.strategyIdentity(closeStrategy);\n        const tradeId = botState.lastTradeId ?? generateStrategyTradeId(closeStrategy, symbol, new Date(botState.lastEntryAt ?? Date.now()));\n        const durationMinutes = durationMs / 60000;\n\n        await this.historyLogger.logTradeClose({`
);

replaceOnce(
  'close hardcoded attribution',
  `            portfolio_session_id: getPortfolioSessionId(),\n            symbol,\n            strategy: 'AEGIS_TURBO',\n            mode: this.getTradingMode(),`,
  `            portfolio_session_id: getPortfolioSessionId(),\n            symbol,\n            strategy: closeStrategy,\n            strategy_version: botState.lastStrategyVersion ?? closeIdentity.strategyVersion,\n            strategy_hash: botState.lastStrategyHash ?? closeIdentity.strategyHash,\n            config_hash: botState.lastConfigHash ?? closeIdentity.configHash,\n            code_commit_sha: botState.lastCodeCommitSha ?? closeIdentity.codeCommitSha,\n            mode: this.getTradingMode(),`
);

fs.writeFileSync(file, source);
console.log(`Applied Strategy Runtime V2 migration to ${file}`);
