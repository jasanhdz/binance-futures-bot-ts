from pathlib import Path
import re

root = Path('.')
trading = root / 'src/app/services/TradingService.ts'
lifecycle = root / 'src/app/position/StrategyPositionLifecycleCore.ts'

text = trading.read_text()

anchor = "import { JsonlMarketSnapshotSink } from '../../infra/logging/JsonlMarketSnapshotSink';\n"
imports = anchor + "import { JsonlStrategyTelemetrySink } from '../../infra/logging/JsonlStrategyTelemetrySink';\nimport { StrategyTelemetryBus } from '../../core/telemetry/StrategyTelemetryBus';\nimport { DecisionEvidenceTelemetrySink } from '../../core/telemetry/DecisionEvidenceTelemetrySink';\nimport { TelemetryStrategyExecutionPort } from '../../core/telemetry/TelemetryStrategyExecutionPort';\nimport type { StrategyExecutionPort } from '../../core/strategy/StrategyExecution';\n"
if 'JsonlStrategyTelemetrySink' not in text:
    assert anchor in text
    text = text.replace(anchor, imports)

text = text.replace(
    'private readonly sharedStrategyExecution: SharedStrategyExecutionService;',
    'private readonly sharedStrategyExecution: StrategyExecutionPort;',
)

property_anchor = '  private readonly strategyRiskLedger = new StrategyRiskLedger();\n'
properties = property_anchor + "  private readonly strategyTelemetry = new StrategyTelemetryBus([\n    new JsonlStrategyTelemetrySink('data/strategy-telemetry/events-v1.jsonl'),\n  ]);\n  private readonly decisionEvidenceSink = new DecisionEvidenceTelemetrySink(\n    new JsonlDecisionEvidenceSink('data/strategy-blackbox/strategy-decisions/decisions-v1.jsonl'),\n    this.strategyTelemetry,\n  );\n  private readonly marketSnapshotEvidenceSink = new JsonlMarketSnapshotSink(\n    'data/strategy-blackbox/market-snapshots/snapshots-v1.jsonl',\n  );\n"
if 'private readonly strategyTelemetry' not in text:
    assert property_anchor in text
    text = text.replace(property_anchor, properties)

start = '    this.sharedStrategyExecution = new SharedStrategyExecutionService(deps.exchange, deps.logger, {\n'
if start in text:
    text = text.replace(start, '    this.sharedStrategyExecution = new TelemetryStrategyExecutionPort(\n      new SharedStrategyExecutionService(deps.exchange, deps.logger, {\n', 1)
    close = "      clearMarketOpenAmbiguity: (symbol) =>\n        this.stateForSymbol(symbol).set({\n          marketOpenAmbiguous: false,\n          marketOpenClientOrderId: undefined,\n        }),\n    });"
    repl = "      clearMarketOpenAmbiguity: (symbol) =>\n        this.stateForSymbol(symbol).set({\n          marketOpenAmbiguous: false,\n          marketOpenClientOrderId: undefined,\n        }),\n      }),\n      this.strategyTelemetry,\n    );"
    assert close in text
    text = text.replace(close, repl, 1)

text = re.sub(
    r"decisionSink: new JsonlDecisionEvidenceSink\(\n\s*'data/strategy-blackbox/strategy-decisions/decisions-v1\.jsonl',\n\s*\),",
    'decisionSink: this.decisionEvidenceSink,',
    text,
)
text = re.sub(
    r"marketSnapshotSink: new JsonlMarketSnapshotSink\(\n\s*'data/strategy-blackbox/market-snapshots/snapshots-v1\.jsonl',\n\s*\),",
    'marketSnapshotSink: this.marketSnapshotEvidenceSink,',
    text,
)

old_log = "      logTradeEvent: (symbol, event, input) => this.logAegisTradeEvent(symbol, event, input),"
new_log = "      logTradeEvent: async (strategyId, symbol, event, input) => {\n        await this.logAegisTradeEvent(symbol, event, input);\n        const state = this.stateForSymbol(symbol).get();\n        const upper = event.toUpperCase();\n        const eventType =\n          upper.includes('EXIT') || upper.includes('CLOSED')\n            ? 'EXIT'\n            : upper.includes('GUARD') || upper.includes('STOP') || upper.includes('TRAIL') || upper.includes('BREAK_EVEN') || upper.includes('PROTECT')\n              ? 'GUARD_RESULT'\n              : 'POSITION_EVENT';\n        await this.strategyTelemetry.publish({\n          eventType,\n          strategyId,\n          symbol,\n          occurredAtMs: Date.now(),\n          tradeId: input?.tradeId ?? state.lastTradeId,\n          side: state.lastSide as Side | undefined,\n          status: event,\n          reason: input?.reason,\n          details: { ...input, lifecycleEvent: event },\n        });\n      },"
if old_log in text:
    text = text.replace(old_log, new_log, 1)

trading.write_text(text)

lt = lifecycle.read_text()
old_sig = "  logTradeEvent(symbol: string, event: string, input?: LifecycleTradeEventInput): Promise<void>;"
new_sig = "  logTradeEvent(\n    strategyId: StrategyLifecyclePolicy['strategyId'],\n    symbol: string,\n    event: string,\n    input?: LifecycleTradeEventInput,\n  ): Promise<void>;"
assert old_sig in lt or new_sig in lt
lt = lt.replace(old_sig, new_sig)
lt = lt.replace('this.ports.logTradeEvent(symbol,', 'this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol,')
lifecycle.write_text(lt)

print('telemetry migration applied')
