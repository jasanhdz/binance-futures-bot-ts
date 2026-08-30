from pathlib import Path
import hashlib
import re

root = Path('.')
trading = root / 'src/app/services/TradingService.ts'
policy = root / 'src/strategies/momentum/domain/MomentumRideEntryPolicy.ts'
restoration = root / 'src/restoration/original-operational-semantics.test.ts'

# 1) The Momentum policy remains the only place that evaluates the raw stacking pattern.
p = policy.read_text()
needle = """  const candleDiagnostics = {
    candleSource: context.candleSource,
    candleStatus: context.candleStatus,
    candleAgeMs: context.candleAgeMs,
    candleWebsocketObservedAtMs: context.candleWebsocketObservedAtMs,
    candleRestFallbackCount: context.candleRestFallbackCount,
    candleUsedRestFallback: context.candleUsedRestFallback,
  };
"""
replacement = needle + """  // Compute route ownership once inside the canonical strategy policy. The
  // application layer may use patternMatched to preserve fallback semantics,
  // but it must never call the raw momentum detector directly.
  const routePattern = evaluateMainStackingMomentum(context.candles, context.side);
  const patternRouteDiagnostics = {
    patternMatched: routePattern.allowed,
    pattern: routePattern.diagnostics,
  };
"""
assert needle in p
p = p.replace(needle, replacement, 1)

p = p.replace(
    '{ ...realtimeDiagnostics, ...candleDiagnostics },',
    '{ ...realtimeDiagnostics, ...candleDiagnostics, ...patternRouteDiagnostics },',
    1,
)
p = p.replace(
    '{ ...realtimeDiagnostics, ...candleDiagnostics, ...liquidityDiagnostics },',
    '{ ...realtimeDiagnostics, ...candleDiagnostics, ...liquidityDiagnostics, ...patternRouteDiagnostics },',
    1,
)
# Remove the old post-realtime duplicate evaluator and use the canonical result above.
old_pattern = "  const pattern = evaluateMainStackingMomentum(context.candles, context.side);\n"
assert old_pattern in p
p = p.replace(old_pattern, '', 1)
p = p.replace('if (!pattern.allowed) {', 'if (!routePattern.allowed) {', 1)
p = p.replace('return noTrade(context, pattern.reason, {', 'return noTrade(context, routePattern.reason, {', 1)
# Every post-pattern decision should carry the canonical route-claim marker.
p = p.replace('      pattern: pattern.diagnostics,\n', '      ...patternRouteDiagnostics,\n')
p = p.replace("return noTrade(context, 'momentum_long_disabled', { pattern: pattern.diagnostics });", "return noTrade(context, 'momentum_long_disabled', patternRouteDiagnostics);")
p = p.replace("return noTrade(context, 'momentum_short_disabled', { pattern: pattern.diagnostics });", "return noTrade(context, 'momentum_short_disabled', patternRouteDiagnostics);")
p = p.replace('      pattern: pattern.diagnostics,\n', '      ...patternRouteDiagnostics,\n')
policy.write_text(p)

# 2) TradingService loads data, asks StrategyRouter for both enabled sides, and never
#    calls evaluateMainStackingMomentum directly.
t = trading.read_text()
t = t.replace(
"""import {
  evaluateMainStackingMomentum,
  MainStackingMomentumDecision,
  MAIN_STACKING_MOMENTUM_AUTHORITY,
} from '../../strategies/momentum/domain/MainStackingMomentumStrategy';""",
"""import { MAIN_STACKING_MOMENTUM_AUTHORITY } from '../../strategies/momentum/domain/MainStackingMomentumStrategy';""",
)

start = t.index('  private async findStandaloneMomentumCandidate(')
end = t.index('  private async lookForEntry(', start)
old = t[start:end]

method_start = old.index('  private async lookForMomentumEntry(')
loader_old = old[:method_start]
executor_old = old[method_start:]
loader_new = loader_old.replace('findStandaloneMomentumCandidate', 'loadStandaloneMomentumData', 1)
loader_new = loader_new.replace(
"""  ): Promise<{
    decision: MainStackingMomentumDecision;
    candles: Candle[];
    candleState?: MomentumCandleSnapshot;
  } | undefined> {""",
"""  ): Promise<{
    candles: Candle[];
    candleState?: MomentumCandleSnapshot;
  } | undefined> {""",
1,
)
raw_loop = """    const sides: Side[] = ['LONG', 'SHORT'];
    for (const side of sides) {
      const sideConfig = side === 'LONG' ? symbolConfig.long : symbolConfig.short;
      if (!sideConfig.enabled) continue;
      const decision = evaluateMainStackingMomentum(candles, side);
      if (decision.allowed) return { decision, candles, candleState };
    }
    return undefined;
"""
assert raw_loop in loader_new
loader_new = loader_new.replace(raw_loop, '    return { candles, candleState };\n', 1)

executor = executor_old
executor = executor.replace(
"""  private async lookForMomentumEntry(
    symbol: string,
    candidate: { decision: MainStackingMomentumDecision; candles: Candle[]; candleState?: MomentumCandleSnapshot },
  ): Promise<void> {""",
"""  private async evaluateAndExecuteMomentumSide(
    symbol: string,
    side: Side,
    candidate: { candles: Candle[]; candleState?: MomentumCandleSnapshot },
  ): Promise<boolean> {""",
1,
)
executor = executor.replace('    if (!symbolConfig?.enabled) return;\n\n    const side = candidate.decision.side;\n', '    if (!symbolConfig?.enabled) return false;\n\n', 1)
router_marker = "    const decision = await this.momentumStrategyRouter.evaluate('MOMENTUM_RIDE', strategyContext);\n"
assert router_marker in executor
executor = executor.replace(
    router_marker,
    router_marker + "    const patternMatched = decision.diagnostics.patternMatched === true;\n    if (!patternMatched) return false;\n",
    1,
)
pos = executor.index('    const patternMatched =')
prefix, suffix = executor[:pos], executor[pos:]
suffix = suffix.replace(' return;\n', ' return true;\n')
suffix = suffix.replace('      return;\n', '      return true;\n')
last = suffix.rfind('  }\n')
assert last >= 0
suffix = suffix[:last] + '    return true;\n' + suffix[last:]
executor = prefix + suffix

wrapper = """  private async lookForMomentumEntry(symbol: string): Promise<boolean> {
    const candidate = await this.loadStandaloneMomentumData(symbol);
    if (!candidate) return false;
    const config = this.getAegisMomentumRideConfig();
    const symbolConfig = config.symbols[symbol];
    if (!symbolConfig?.enabled) return false;

    for (const side of ['LONG', 'SHORT'] as Side[]) {
      const sideConfig = side === 'LONG' ? symbolConfig.long : symbolConfig.short;
      if (!sideConfig.enabled) continue;
      if (await this.evaluateAndExecuteMomentumSide(symbol, side, candidate)) return true;
    }
    return false;
  }

"""
new_region = loader_new + wrapper + executor
t = t[:start] + new_region + t[end:]

old_call = """      const standaloneMomentum = await this.findStandaloneMomentumCandidate(symbol);
      if (standaloneMomentum) {
        await this.lookForMomentumEntry(symbol, standaloneMomentum);
        return;
      }
"""
new_call = """      const standaloneMomentumHandled = await this.lookForMomentumEntry(symbol);
      if (standaloneMomentumHandled) return;
"""
assert old_call in t
t = t.replace(old_call, new_call, 1)
trading.write_text(t)

# 3) Owner-authorized operational checkpoint.
rt = restoration.read_text()
digest = hashlib.sha256(trading.read_bytes()).hexdigest()
pattern_re = re.compile(r"('src/app/services/TradingService\.ts':\s*\n\s*')([a-f0-9]{64})(')")
rt, count = pattern_re.subn(lambda m: m.group(1) + digest + m.group(3), rt, count=1)
assert count == 1
restoration.write_text(rt)

assert 'evaluateMainStackingMomentum' not in trading.read_text()
assert 'MainStackingMomentumDecision' not in trading.read_text()
print('removed Momentum direct pre-routing decision path')
print('TradingService sha256:', digest)
