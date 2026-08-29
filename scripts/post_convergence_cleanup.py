from pathlib import Path
import os

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

# Move tests and rewrite only their first-party relative imports by known ownership.
REWRITES = {
    "./SynchronizedOrderBook": "./SynchronizedOrderBook",
    "../../../core/market-data/RollingAggTradeBuffer": "./RollingAggTradeBuffer",
    "../../../app/ports/MarketData": "../../app/ports/MarketData",
}

for old, new in MOVES.items():
    if not old.exists():
        continue
    text = old.read_text()
    new.parent.mkdir(parents=True, exist_ok=True)
    # Rebase selected imports for tests moved into core.
    if new.parent == Path('src/core/market-data'):
        text = text.replace("../../../core/market-data/RollingAggTradeBuffer", "./RollingAggTradeBuffer")
        text = text.replace("import { SynchronizedOrderBook } from './SynchronizedOrderBook';", "import { SynchronizedOrderBook } from './SynchronizedOrderBook';")
        text = text.replace("../../../app/ports/MarketData", "../../app/ports/MarketData")
    else:
        # application/research are siblings of domain; existing './X' imports may target old facade names.
        replacements = {
            "./MicroBurstSignalJournal": "./MicroBurstSignalJournal",
            "./MicroBurstOutcomeJournal": "./MicroBurstOutcomeJournal",
            "./MicroBurstPaperTrading": "./MicroBurstPaperTrading",
            "./MicroBurstConfigLoader": "./MicroBurstConfigLoader",
            "./MicroBurstReadiness": "./MicroBurstReadiness",
            "./MicroBurstShadowEvaluator": "./MicroBurstShadowEvaluator",
            "./MicroBurstTypes": "../domain/MicroBurstTypes",
            "./MicroBurstUnits": "../domain/MicroBurstUnits",
            "./MicroBurstBtcTypes": "../domain/MicroBurstBtcTypes",
            "./MicroBurstReferencePrice": "../domain/MicroBurstReferencePrice",
        }
        for a,b in replacements.items():
            text = text.replace(a,b)
    if new.exists():
        raise RuntimeError(f'collision: {new}')
    new.write_text(text)
    old.unlink()

# Eliminate the strategy-owned OrderBook subclass. Core already exposes the exact snapshot shape.
runtime = Path('src/strategies/micro-burst/application/MicroBurstRuntime.ts')
text = runtime.read_text()
text = text.replace(
    "import { SynchronizedOrderBook, SynchronizedOrderBookDeps } from '../domain/SynchronizedOrderBook';",
    "import { SynchronizedOrderBook, SynchronizedOrderBookDeps } from '../../../core/market-data/SynchronizedOrderBook';",
)
text = text.replace('book.getSnapshotForPressure.bind(book) as any', 'book.getSnapshot.bind(book) as any')
text = text.replace('state.book.getSnapshotForPressure() as any', 'state.book.getSnapshot() as any')
runtime.write_text(text)

wrapper = Path('src/strategies/micro-burst/domain/SynchronizedOrderBook.ts')
if wrapper.exists():
    wrapper.unlink()

# Remove empty directories if any.
for d in sorted([p for p in Path('src').rglob('*') if p.is_dir()], key=lambda p: len(p.parts), reverse=True):
    try:
        d.rmdir()
    except OSError:
        pass

print('post_convergence_cleanup_applied')
