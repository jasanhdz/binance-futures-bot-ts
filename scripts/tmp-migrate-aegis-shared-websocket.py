from pathlib import Path
import hashlib
import re

path = Path('src/app/services/TradingService.ts')
text = path.read_text()


def replace_once(old: str, new: str, label: str):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)

if "AegisRealtimeMarketState" not in text:
    replace_once(
        "import { AegisBlackBoxObservation } from '../../strategies/aegis/application/AegisBlackBoxObservation';\n",
        "import { AegisBlackBoxObservation } from '../../strategies/aegis/application/AegisBlackBoxObservation';\nimport { AegisRealtimeMarketState } from '../../strategies/aegis/application/AegisRealtimeMarketState';\n",
        'aegis realtime import',
    )
    replace_once(
        "  private aegisBlackBoxObservation: AegisBlackBoxObservation | null = null;\n",
        "  private aegisBlackBoxObservation: AegisBlackBoxObservation | null = null;\n  private aegisRealtimeMarketState: AegisRealtimeMarketState | null = null;\n",
        'aegis realtime property',
    )

anchor = """    this.sharedMarketDataRuntime ??= new SharedMarketDataRuntime({
      exchange: this.deps.exchange,
      logger: this.deps.logger,
      clock: { now: () => Date.now() },
    });
"""
if "this.aegisRealtimeMarketState ??=" not in text:
    replacement = anchor + """    this.aegisRealtimeMarketState ??= new AegisRealtimeMarketState({
      sharedMarketData: this.sharedMarketDataRuntime,
      logger: this.deps.logger,
      clock: { now: () => Date.now() },
    });
    this.aegisRealtimeMarketState.start(startupSymbols);
"""
    replace_once(anchor, replacement, 'aegis realtime startup')

if "this.aegisRealtimeMarketState?.close();" not in text:
    replace_once(
        "      this.aegisBlackBoxObservation?.close();\n      this.aegisBlackBoxObservation = null;\n",
        "      this.aegisBlackBoxObservation?.close();\n      this.aegisBlackBoxObservation = null;\n      this.aegisRealtimeMarketState?.close();\n      this.aegisRealtimeMarketState = null;\n",
        'aegis realtime shutdown',
    )

text = text.replace(
    "      this.deps.exchange.subscribeToCandles(symbol);",
    "      if (!this.aegisRealtimeMarketState) this.deps.exchange.subscribeToCandles(symbol);",
    1,
)
text = text.replace(
    "      this.detector[symbol] = new LiquidityVoidDetector(this.deps.logger);",
    "      this.detector[symbol] =\n        this.aegisRealtimeMarketState?.detectorFor(symbol) ?? new LiquidityVoidDetector(this.deps.logger);",
    1,
)
text = text.replace(
    "      if (this.deps.exchange.subscribeToPartialDepth) {",
    "      if (!this.aegisRealtimeMarketState && this.deps.exchange.subscribeToPartialDepth) {",
    1,
)

old_cache = "    const cachedCandles = this.deps.exchange.getCachedCandles?.(symbol, '5m', 160);\n"
if old_cache in text:
    new_cache = """    const sharedCandles = this.aegisRealtimeMarketState?.getCandles(symbol, 160) ?? [];
    const cachedCandles =
      sharedCandles.length > 0
        ? sharedCandles
        : this.deps.exchange.getCachedCandles?.(symbol, '5m', 160);
"""
    replace_once(old_cache, new_cache, 'aegis shared candle cache')

realtime_gate_anchor = """      if (
        momentumConfig.enabled === true &&
        momentumConfig.mode === 'ENFORCE' &&
        momentumConfig.aegisFallbackEnabled === false
      ) {
        return;
      }

      const signal = await mlService.getSignal(symbol);
"""
if "aegis_realtime_market_not_fresh" not in text:
    realtime_gate_replacement = """      if (
        momentumConfig.enabled === true &&
        momentumConfig.mode === 'ENFORCE' &&
        momentumConfig.aegisFallbackEnabled === false
      ) {
        return;
      }

      const realtimeMarket = this.aegisRealtimeMarketState?.read(symbol);
      if (realtimeMarket && realtimeMarket.status !== 'FRESH') {
        this.deps.logger.warn('aegis_realtime_market_not_fresh', {
          symbol,
          status: realtimeMarket.status,
          orderBookHealth: realtimeMarket.orderBookHealth,
          orderBookAgeMs: realtimeMarket.ageMs,
          aggTradeAgeMs: realtimeMarket.aggTradeAgeMs,
          aggTradeGapFree: realtimeMarket.aggTradeGapFree,
        });
        return;
      }

      const signal = await mlService.getSignal(symbol);
"""
    replace_once(realtime_gate_anchor, realtime_gate_replacement, 'aegis realtime gate')

path.write_text(text)

# Update the owner-authorized TradingService digest without weakening baseline files.
rest = Path('src/restoration/original-operational-semantics.test.ts')
r = rest.read_text()
digest = hashlib.sha256(path.read_bytes()).hexdigest()
pat = re.compile(r"('src/app/services/TradingService\.ts':\s*\n\s*')[0-9a-f]{64}(')")
if not pat.search(r):
    raise SystemExit('TradingService authorized digest not found')
r = pat.sub(rf"\g<1>{digest}\2", r, count=1)
rest.write_text(r)
