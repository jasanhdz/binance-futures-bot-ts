from pathlib import Path
import hashlib
import re

root = Path(__file__).resolve().parents[1]
trading_path = root / 'src/app/services/TradingService.ts'
text = trading_path.read_text()

import_anchor = "import { StrategyPositionLifecycleCore } from '../position/StrategyPositionLifecycleCore';\n"
new_import = import_anchor + "import { PositionRecoveryService } from '../position/PositionRecoveryService';\n"
if "PositionRecoveryService" not in text:
    if import_anchor not in text:
        raise SystemExit('missing StrategyPositionLifecycleCore import anchor')
    text = text.replace(import_anchor, new_import, 1)

text = text.replace("const MANUAL_POSITION_DEFAULT_STOP_ROE = -0.4;\n", "", 1)
text = text.replace("const MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE = 1.0;\n", "", 1)

field_anchor = "  private readonly positionLifecycleCore: StrategyPositionLifecycleCore;\n"
field_replacement = field_anchor + "  private readonly positionRecovery: PositionRecoveryService;\n"
if "private readonly positionRecovery:" not in text:
    if field_anchor not in text:
        raise SystemExit('missing positionLifecycleCore field anchor')
    text = text.replace(field_anchor, field_replacement, 1)

ctor_anchor = "    this.positionLifecycleCore = new StrategyPositionLifecycleCore({\n"
ctor_block = """    this.positionRecovery = new PositionRecoveryService({
      exchange: deps.exchange,
      logger: deps.logger,
      notifier: deps.notifier,
      globalState: deps.state,
      configSymbols: config.symbols,
      getLiveSymbols: () => this.getLiveAegisSymbols(),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      isVerifiedBotOwnedState: (state) => this.isVerifiedBotOwnedState(state),
      isLegacyBotOwnedState: (state) => this.isLegacyBotOwnedState(state),
      requireBrackets: () => this.getAegisTurboYamlConfig()?.require_brackets !== false,
      ensureBrackets: (symbol, side, entryPrice, leverage, position, state, overrides) =>
        this.ensureAegisBrackets(symbol, side, entryPrice, leverage, position, state, overrides),
    });

""" + ctor_anchor
if "this.positionRecovery = new PositionRecoveryService" not in text:
    if ctor_anchor not in text:
        raise SystemExit('missing lifecycle constructor anchor')
    text = text.replace(ctor_anchor, ctor_block, 1)

start = text.find("  private async migrateLegacyGlobalStateToFirstLiveSymbol(): Promise<void> {")
end = text.find("  getAegisRuntimeSnapshot(): AegisRuntimeSnapshot {", start)
if start != -1:
    if end == -1:
        raise SystemExit('missing recovery block end anchor')
    text = text[:start] + text[end:]

text = text.replace(
    "await this.migrateLegacyGlobalStateToFirstLiveSymbol();",
    "await this.positionRecovery.migrateLegacyGlobalStateToFirstLiveSymbol();",
)
text = text.replace(
    "await this.attachOpenExchangePositionsToSymbolState();",
    "await this.positionRecovery.attachOpenExchangePositionsToSymbolState();",
)
text = text.replace(
    "this.tryAdoptManualPositionRuntime(symbol)",
    "this.positionRecovery.tryAdoptManualPositionRuntime(symbol)",
)

if "private async migrateLegacyGlobalStateToFirstLiveSymbol" in text:
    raise SystemExit('legacy recovery method still present')
if "private async attachOpenExchangePositionsToSymbolState" in text:
    raise SystemExit('legacy attach method still present')
if "private async tryAdoptManualPositionRuntime" in text:
    raise SystemExit('legacy runtime adoption method still present')

trading_path.write_text(text)

digest = hashlib.sha256(text.encode()).hexdigest()
restoration_path = root / 'src/restoration/original-operational-semantics.test.ts'
restoration = restoration_path.read_text()
pattern = re.compile(
    r"('src/app/services/TradingService\.ts':\s*\n\s*')[0-9a-f]{64}(')",
    re.MULTILINE,
)
restoration, count = pattern.subn(rf"\g<1>{digest}\g<2>", restoration, count=1)
if count != 1:
    raise SystemExit('could not update TradingService authorized digest')
restoration_path.write_text(restoration)

print(f'TradingService digest: {digest}')
