from pathlib import Path

p = Path('src/app/services/TradingService.ts')
t = p.read_text()

anchor = "import { TradingRuntimeConfigService } from '../config/TradingRuntimeConfigService';\n"
addition = anchor + "import {\n  StrategyHistoryService,\n  type HistoryAccountSnapshotInput,\n  type HistoryTradeEventInput,\n} from '../logging/StrategyHistoryService';\n"
if 'StrategyHistoryService' not in t:
    if anchor not in t: raise SystemExit('history import anchor missing')
    t = t.replace(anchor, addition, 1)

prop_anchor = "  private readonly runtimeConfig: TradingRuntimeConfigService;\n"
if 'private readonly strategyHistory: StrategyHistoryService;' not in t:
    if prop_anchor not in t: raise SystemExit('history property anchor missing')
    t = t.replace(prop_anchor, prop_anchor + "  private readonly strategyHistory: StrategyHistoryService;\n", 1)

ctor_anchor = "    this.microBurstIdentity = createMicroBurstV1Identity();\n"
ctor_add = ctor_anchor + "    this.strategyHistory = new StrategyHistoryService({\n      logger: deps.logger,\n      historyLogger: this.historyLogger,\n      tradingMode: () => this.getTradingMode(),\n      strategyIdentity: (strategy) => this.strategyIdentity(strategy),\n      strategyForSymbol: (symbol, tradeId) => this.strategyForSymbol(symbol, tradeId),\n      tradesToday: () => this.tradesToday,\n      consecutiveLosses: () => this.consecutiveLossTracker.value,\n    });\n"
if 'this.strategyHistory = new StrategyHistoryService' not in t:
    if ctor_anchor not in t: raise SystemExit('history ctor anchor missing')
    t = t.replace(ctor_anchor, ctor_add, 1)

start = t.find('  private logAegisScan(symbol: string, signal: AegisTradingSignal): void {')
end = t.find('  private async logEntryIntelligenceDispositionShadow(', start)
if start < 0 or end < 0: raise SystemExit('history signal/event block anchors missing')
wrappers = '''  private logAegisScan(symbol: string, signal: AegisTradingSignal): void {
    this.strategyHistory.logScan(symbol, signal);
  }

  private async logAegisTurboSignal(
    symbol: string,
    signal: AegisTradingSignal,
    extras: {
      signalId?: string;
      tradeId?: string;
      price?: number;
      gate?: AegisMicroLiveGateDecision;
      executed?: boolean;
      strategy?: AegisResearchStrategy;
      identity?: StrategyIdentity;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.strategyHistory.logTurboSignal(symbol, signal, extras);
  }

  private async logAegisTradeEvent(
    symbol: string,
    event: string,
    input: HistoryTradeEventInput = {},
  ): Promise<void> {
    await this.strategyHistory.logTradeEvent(symbol, event, input);
  }

'''
t = t[:start] + wrappers + t[end:]

start = t.find('  private async logAegisAccountSnapshot(')
end = t.find('  private evaluateAegisTurboGate(', start)
if start < 0 or end < 0: raise SystemExit('history account block anchors missing')
account_wrapper = '''  private async logAegisAccountSnapshot(
    input: HistoryAccountSnapshotInput = {},
  ): Promise<void> {
    await this.strategyHistory.logAccountSnapshot(input);
  }

'''
t = t[:start] + account_wrapper + t[end:]
p.write_text(t)
