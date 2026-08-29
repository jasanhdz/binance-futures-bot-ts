from pathlib import Path

MOVES = {
    Path('src/strategies/micro-burst/domain/MicroBurstAggTradeBuffer.test.ts'): Path('src/core/market-data/RollingAggTradeBuffer.behavior.test.ts'),
    Path('src/strategies/micro-burst/domain/SynchronizedOrderBook.test.ts'): Path('src/core/market-data/SynchronizedOrderBook.behavior.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstSignalJournal.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstSignalJournal.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstOutcomeJournal.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstOutcomeJournal.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstPaperTrading.test.ts'): Path('src/strategies/micro-burst/research/MicroBurstPaperTrading.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstConfigLoader.test.ts'): Path('src/strategies/micro-burst/application/MicroBurstConfigLoader.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstReadiness.test.ts'): Path('src/strategies/micro-burst/application/MicroBurstReadiness.test.ts'),
    Path('src/strategies/micro-burst/domain/MicroBurstShadowEvaluator.test.ts'): Path('src/strategies/micro-burst/application/MicroBurstShadowEvaluator.test.ts'),
}

for old, new in MOVES.items():
    if not old.exists():
        continue
    text = old.read_text()
    new.parent.mkdir(parents=True, exist_ok=True)

    if new.parent == Path('src/core/market-data'):
        text = text.replace("../../../core/market-data/RollingAggTradeBuffer", "./RollingAggTradeBuffer")
        text = text.replace("../../../app/ports/MarketData", "../../app/ports/MarketData")
        text = text.replace('getSnapshotForPressure()', 'getSnapshot()')
    elif new.parent == Path('src/strategies/micro-burst/application'):
        replacements = {
            "./MicroBurstDuplicateSignalGuard": "../domain/MicroBurstDuplicateSignalGuard",
            "./MicroBurstStrategy": "../domain/MicroBurstStrategy",
            "./MicroBurstIdentity": "../domain/MicroBurstIdentity",
            "./MicroBurstTypes": "../domain/MicroBurstTypes",
            "./MicroBurstUnits": "../domain/MicroBurstUnits",
            "./MicroBurstBtcTypes": "../domain/MicroBurstBtcTypes",
            "./MicroBurstReferencePrice": "../domain/MicroBurstReferencePrice",
        }
        for source, target in replacements.items():
            text = text.replace(source, target)
    else:
        replacements = {
            "./MicroBurstTypes": "../domain/MicroBurstTypes",
            "./MicroBurstUnits": "../domain/MicroBurstUnits",
            "./MicroBurstBtcTypes": "../domain/MicroBurstBtcTypes",
            "./MicroBurstReferencePrice": "../domain/MicroBurstReferencePrice",
            "./MicroBurstIdentity": "../domain/MicroBurstIdentity",
            "./MicroBurstExitPolicy": "../domain/MicroBurstExitPolicy",
        }
        for source, target in replacements.items():
            text = text.replace(source, target)

    if new.exists():
        raise RuntimeError(f'collision: {new}')
    new.write_text(text)
    old.unlink()

# Eliminate the strategy-owned OrderBook subclass. Core already exposes the same
# causal OrderBookSnapshot used by the Micro Burst analyzers/runtime.
runtime = Path('src/strategies/micro-burst/application/MicroBurstRuntime.ts')
text = runtime.read_text()
text = text.replace(
    "import { SynchronizedOrderBook, SynchronizedOrderBookDeps } from '../domain/SynchronizedOrderBook';",
    "import { SynchronizedOrderBook, SynchronizedOrderBookDeps } from '../../../core/market-data/SynchronizedOrderBook';",
)
text = text.replace('getSnapshotForPressure', 'getSnapshot')
runtime.write_text(text)

wrapper = Path('src/strategies/micro-burst/domain/SynchronizedOrderBook.ts')
if wrapper.exists():
    wrapper.unlink()

for d in sorted([p for p in Path('src').rglob('*') if p.is_dir()], key=lambda p: len(p.parts), reverse=True):
    try:
        d.rmdir()
    except OSError:
        pass

print('post_convergence_cleanup_applied')
