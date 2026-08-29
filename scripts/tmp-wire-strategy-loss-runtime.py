from pathlib import Path
import hashlib
import re

p = Path('src/app/services/TradingService.ts')
s = p.read_text()

anchor = """import type {
  StrategyLossStateStorePort,
  StrategyLossStateWrite,
} from '../../infra/state/StrategyLossStateStore';"""
if "StrategyLossStateRegistry" not in s:
    assert anchor in s
    s = s.replace(
        anchor,
        anchor + "\nimport type { StrategyLossStateRegistry } from '../../infra/state/StrategyLossStateRegistry';",
        1,
    )

dep = "  consecutiveLossStateStore?: StrategyLossStateStorePort;"
if "strategyLossStateRegistry?:" not in s:
    assert dep in s
    s = s.replace(dep, dep + "\n  strategyLossStateRegistry?: StrategyLossStateRegistry;", 1)

anchor2 = """    if (pnl !== undefined)
      this.strategyRiskLedger.recordClose(closeStrategy, tradeId, pnl, Date.now());
    if (closeStrategy === 'AEGIS_TURBO' && pnl !== undefined) {"""
insert = """    if (pnl !== undefined)
      this.strategyRiskLedger.recordClose(closeStrategy, tradeId, pnl, Date.now());
    if (pnl !== undefined && this.deps.strategyLossStateRegistry) {
      const lossStrategyId =
        botState.positionOwner === 'EXTERNAL' ||
        botState.tradeOrigin === 'MANUAL_EXTERNAL' ||
        tradeId.startsWith('MANUAL-')
          ? 'MANUAL'
          : closeStrategy;
      if (lossStrategyId !== 'AEGIS_TURBO') {
        await this.deps.strategyLossStateRegistry.record(lossStrategyId, this.getTradingMode(), {
          tradeId,
          closedAt: new Date().toISOString(),
          pnlUsdt: pnl,
        });
        logger.info('strategy_loss_streak_updated', {
          symbol,
          tradeId,
          strategyId: lossStrategyId,
          consecutiveLosses: this.deps.strategyLossStateRegistry.trackerValue(lossStrategyId),
        });
      }
    }
    if (closeStrategy === 'AEGIS_TURBO' && pnl !== undefined) {"""
if "strategy_loss_streak_updated" not in s:
    assert anchor2 in s
    s = s.replace(anchor2, insert, 1)
p.write_text(s)

# Refresh the explicitly owner-authorized TradingService digest after the observational/accounting wiring.
target = 'src/app/services/TradingService.ts'
digest = hashlib.sha256(Path(target).read_bytes()).hexdigest()
p = Path('src/restoration/original-operational-semantics.test.ts')
s = p.read_text()
pattern = r"('src/app/services/TradingService\.ts':\s*\n?\s*)'[0-9a-f]{64}'"
s, n = re.subn(pattern, lambda m: m.group(1) + "'" + digest + "'", s, count=1)
assert n == 1
p.write_text(s)
