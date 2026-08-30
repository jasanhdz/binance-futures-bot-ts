from pathlib import Path
import hashlib
import re

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'src/app/services/TradingService.ts'
text = path.read_text()

import_anchor = "import { StrategyPositionLifecycleCore } from '../position/StrategyPositionLifecycleCore';\n"
import_line = "import { PositionRecoveryService } from '../position/PositionRecoveryService';\n"
if import_line not in text:
    if import_anchor not in text:
        raise SystemExit('missing lifecycle import anchor')
    text = text.replace(import_anchor, import_anchor + import_line, 1)

text = text.replace("const MANUAL_POSITION_DEFAULT_STOP_ROE = -0.4;\n", "")
text = text.replace("const MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE = 1.0;\n", "")

field_anchor = "  private readonly positionLifecycleCore: StrategyPositionLifecycleCore;\n"
field_line = "  private readonly positionRecovery: PositionRecoveryService;\n"
if field_line not in text:
    if field_anchor not in text:
        raise SystemExit('missing positionLifecycleCore field anchor')
    text = text.replace(field_anchor, field_anchor + field_line, 1)

constructor_anchor = "    this.microBurstIdentity = createMicroBurstV1Identity();\n"
constructor_block = """    this.positionRecovery = new PositionRecoveryService({
      exchange: deps.exchange,
      logger: deps.logger,
      notifier: deps.notifier,
      globalState: deps.state,
      configSymbols: this.config.symbols,
      getLiveSymbols: () => this.getLiveAegisSymbols(),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      isVerifiedBotOwnedState: (state) => this.isVerifiedBotOwnedState(state),
      isLegacyBotOwnedState: (state) => this.isLegacyBotOwnedState(state),
      requireBrackets: () => this.getAegisTurboYamlConfig()?.require_brackets !== false,
      ensureBrackets: (symbol, side, entryPrice, leverage, position, state, overrides) =>
        this.ensureAegisBrackets(symbol, side, entryPrice, leverage, position, state, overrides),
    });
"""
if constructor_block not in text:
    if constructor_anchor not in text:
        raise SystemExit('missing identity constructor anchor')
    text = text.replace(constructor_anchor, constructor_anchor + constructor_block, 1)

start_marker = "  private async migrateLegacyGlobalStateToFirstLiveSymbol(): Promise<void> {"
end_marker = "  getAegisRuntimeSnapshot(): AegisRuntimeSnapshot {"
if start_marker in text:
    start = text.index(start_marker)
    if end_marker not in text[start:]:
        raise SystemExit('missing recovery removal end marker')
    end = text.index(end_marker, start)
    removed = text[start:end]
    required = [
        'attachOpenExchangePositionsToSymbolState',
        'tryAdoptManualPositionRuntime',
        'aegis_manual_external_position_adopted',
    ]
    for token in required:
        if token not in removed:
            raise SystemExit(f'recovery block missing expected token: {token}')
    text = text[:start] + text[end:]

text = text.replace(
    "    await this.migrateLegacyGlobalStateToFirstLiveSymbol();\n    await this.attachOpenExchangePositionsToSymbolState();",
    "    await this.positionRecovery.migrateLegacyGlobalStateToFirstLiveSymbol();\n    await this.positionRecovery.attachOpenExchangePositionsToSymbolState();",
)
text = text.replace(
    "this.tryAdoptManualPositionRuntime(symbol)",
    "this.positionRecovery.tryAdoptManualPositionRuntime(symbol)",
)

for forbidden in [
    'private async migrateLegacyGlobalStateToFirstLiveSymbol',
    'private async attachOpenExchangePositionsToSymbolState',
    'private async tryAdoptManualPositionRuntime',
    'MANUAL_POSITION_DEFAULT_STOP_ROE',
    'MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE',
]:
    if forbidden in text:
        raise SystemExit(f'legacy recovery responsibility remains: {forbidden}')

if 'this.positionRecovery.tryAdoptManualPositionRuntime(symbol)' not in text:
    raise SystemExit('runtime adoption was not delegated')
if 'this.positionRecovery.attachOpenExchangePositionsToSymbolState()' not in text:
    raise SystemExit('startup recovery was not delegated')

path.write_text(text)

# Owner-authorized architecture checkpoint: update only TradingService digest.
test_path = ROOT / 'src/restoration/original-operational-semantics.test.ts'
test = test_path.read_text()
digest = hashlib.sha256(text.encode()).hexdigest()
pattern = re.compile(r"('src/app/services/TradingService\.ts':\s*\n\s*)'[0-9a-f]{64}'")
new_test, count = pattern.subn(lambda m: m.group(1) + repr(digest), test, count=1)
if count != 1:
    raise SystemExit(f'expected one TradingService digest replacement, got {count}')
test_path.write_text(new_test)

print(f'TradingService sha256={digest}')
print(f'TradingService bytes={len(text.encode())}')
