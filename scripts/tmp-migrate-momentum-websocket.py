from pathlib import Path
import hashlib
import re

service_path = Path('src/app/services/TradingService.ts')
text = service_path.read_text()

def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:80]!r}')
    text = text.replace(old, new, 1)

if "realtimeMarket = this.momentumRealtimeMarketState?.read(symbol)" not in text:
    replace_once(
        "import { MomentumRideBlackBoxObservation } from '../../strategies/momentum/application/MomentumRideBlackBoxObservation';\n",
        "import { MomentumRideBlackBoxObservation } from '../../strategies/momentum/application/MomentumRideBlackBoxObservation';\n"
        "import { MomentumRealtimeMarketState } from '../../strategies/momentum/application/MomentumRealtimeMarketState';\n",
    )
    replace_once(
        "  private momentumBlackBoxObservation: MomentumRideBlackBoxObservation | null = null;\n",
        "  private momentumBlackBoxObservation: MomentumRideBlackBoxObservation | null = null;\n"
        "  private momentumRealtimeMarketState: MomentumRealtimeMarketState | null = null;\n",
    )
    replace_once(
        "    this.aegisBlackBoxObservation ??= new AegisBlackBoxObservation({\n",
        "    this.momentumRealtimeMarketState ??= new MomentumRealtimeMarketState({\n"
        "      sharedMarketData: this.sharedMarketDataRuntime,\n"
        "      clock: { now: () => Date.now() },\n"
        "    });\n"
        "    this.momentumRealtimeMarketState.start(startupSymbols);\n"
        "    this.aegisBlackBoxObservation ??= new AegisBlackBoxObservation({\n",
    )
    replace_once(
        "      this.momentumBlackBoxObservation?.close();\n      this.momentumBlackBoxObservation = null;\n",
        "      this.momentumBlackBoxObservation?.close();\n"
        "      this.momentumBlackBoxObservation = null;\n"
        "      this.momentumRealtimeMarketState?.close();\n"
        "      this.momentumRealtimeMarketState = null;\n",
    )
    replace_once(
        "    const strategyContext: MomentumRideStrategyContext = {\n      symbol,\n      timestamp: now,\n      candles: candidate.candles,\n      side,\n",
        "    const realtimeMarket = this.momentumRealtimeMarketState?.read(symbol) ?? {\n"
        "      source: 'SHARED_WEBSOCKET' as const, status: 'NO_DATA' as const,\n"
        "      orderBookHealth: 'UNAVAILABLE' as const, aggTradeGapFree: false,\n"
        "      aggTradeCount: 0, netTakerVolume: 0,\n"
        "    };\n"
        "    const strategyContext: MomentumRideStrategyContext = {\n"
        "      symbol, timestamp: now, candles: candidate.candles, side,\n"
        "      realtimeMarketSource: realtimeMarket.source,\n"
        "      realtimeMarketStatus: realtimeMarket.status,\n"
        "      realtimeMarketAgeMs: realtimeMarket.ageMs,\n"
        "      realtimeAggTradeAgeMs: realtimeMarket.aggTradeAgeMs,\n"
        "      realtimeAggTradeGapFree: realtimeMarket.aggTradeGapFree,\n"
        "      realtimeAggTradeCount: realtimeMarket.aggTradeCount,\n"
        "      realtimeNetTakerVolume: realtimeMarket.netTakerVolume,\n",
    )
    service_path.write_text(text)
else:
    print('TradingService websocket wiring already present; skipping patch')

restoration = Path('src/restoration/original-operational-semantics.test.ts')
rtext = restoration.read_text()
new_digest = hashlib.sha256(service_path.read_bytes()).hexdigest()
pattern = r"('src/app/services/TradingService\.ts':\s*\n\s*')[0-9a-f]{64}(')"
rtext, count = re.subn(pattern, rf"\g<1>{new_digest}\2", rtext, count=1)
if count != 1:
    raise SystemExit('failed to update TradingService restoration digest')
restoration.write_text(rtext)

test_path = Path('src/app/services/TradingService.aegis-live.test.ts')
t = test_path.read_text()
fresh = """
    (service as any).momentumRealtimeMarketState = {
      read: () => ({
        source: 'SHARED_WEBSOCKET', status: 'FRESH', orderBookHealth: 'HEALTHY',
        observedAtMs: Date.now(), ageMs: 0, aggTradeAgeMs: 0, aggTradeGapFree: true,
        aggTradeCount: 10, netTakerVolume: 1,
      }),
    };
"""
for title in [
    'enters on standalone momentum when Aegis signal is abstain/do-not-enter',
    'blocks standalone Momentum on a shared account-wide daily-loss veto',
]:
    marker = "(service as any).momentumRealtimeMarketState"
    title_start = t.find("it('" + title)
    if title_start < 0:
        raise SystemExit(f'test not found: {title}')
    next_test = t.find("\n  it('", title_start + 5)
    section_end = next_test if next_test >= 0 else len(t)
    section = t[title_start:section_end]
    if marker in section:
        continue
    tick = "\n    await service.tick('ETHUSDT');"
    pos = section.find(tick)
    if pos < 0:
        raise SystemExit(f'tick anchor not found: {title}')
    absolute = title_start + pos
    t = t[:absolute] + fresh + t[absolute:]
test_path.write_text(t)
print('TradingService digest:', new_digest)
