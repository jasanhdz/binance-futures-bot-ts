from pathlib import Path
import hashlib
import re

root = Path('.')
trading = root / 'src/app/services/TradingService.ts'
lifecycle = root / 'src/app/position/StrategyPositionLifecycleCore.ts'
restoration = root / 'src/restoration/original-operational-semantics.test.ts'

text = trading.read_text()
text = text.replace(
    "import { strategyLifecyclePolicy } from '../../core/strategy/StrategyLifecyclePolicy';",
    "import { externalLifecyclePolicy, strategyLifecyclePolicy } from '../../core/strategy/StrategyLifecyclePolicy';",
)

old_external = """      await this.positionLifecycleCore.manage(strategyLifecyclePolicy('AEGIS_TURBO'), {
        symbol,
        botState,
        symbolState,
      });"""
new_external = """      await this.positionLifecycleCore.manage(externalLifecyclePolicy(), {
        symbol,
        botState,
        symbolState,
      });"""
if old_external in text:
    text = text.replace(old_external, new_external, 1)
elif new_external not in text:
    raise AssertionError('external lifecycle route not found')

old_publish = """        await this.strategyTelemetry.publish({
          eventType,
          strategyId,
          symbol,
          occurredAtMs: Date.now(),
          tradeId: input?.tradeId ?? state.lastTradeId,
          side: state.lastSide as Side | undefined,
          status: event,
          reason: input?.reason,
          details: { ...input, lifecycleEvent: event },
        });"""
new_publish = """        if (strategyId !== 'EXTERNAL') {
          await this.strategyTelemetry.publish({
            eventType,
            strategyId,
            symbol,
            occurredAtMs: Date.now(),
            tradeId: input?.tradeId ?? state.lastTradeId,
            side: state.lastSide as Side | undefined,
            status: event,
            reason: input?.reason,
            details: { ...input, lifecycleEvent: event },
          });
        }"""
if old_publish in text:
    text = text.replace(old_publish, new_publish, 1)
elif new_publish not in text:
    raise AssertionError('telemetry publish block not found')
trading.write_text(text)

lt = lifecycle.read_text()
old_reason = """        const timeLimitReason =
          lifecyclePolicy.strategyId === 'MOMENTUM_RIDE'
            ? 'MOMENTUM_TIME_LIMIT'
            : 'AEGIS_TIME_LIMIT';"""
new_reason = """        const timeLimitReason =
          lifecyclePolicy.strategyId === 'MOMENTUM_RIDE'
            ? 'MOMENTUM_TIME_LIMIT'
            : lifecyclePolicy.strategyId === 'EXTERNAL'
              ? 'MANUAL_TIME_LIMIT'
              : 'AEGIS_TIME_LIMIT';"""
if old_reason in lt:
    lt = lt.replace(old_reason, new_reason, 1)
elif new_reason not in lt:
    raise AssertionError('time limit route not found')
lifecycle.write_text(lt)

rt = restoration.read_text()
digest = hashlib.sha256(trading.read_bytes()).hexdigest()
pattern = re.compile(r"('src/app/services/TradingService\.ts':\s*\n\s*')([a-f0-9]{64})(')")
rt, count = pattern.subn(lambda m: m.group(1) + digest + m.group(3), rt, count=1)
assert count == 1, 'restoration TradingService digest not found'
restoration.write_text(rt)

print('external Aegis lifecycle fallback removed')
print('TradingService sha256:', digest)
