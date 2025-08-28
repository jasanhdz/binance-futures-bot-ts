import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';

export async function syncStateGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE') return;

  const hasAny = await ex.hasOpenPosition(symbol, 'ANY');
  if (!hasAny) {
    // Limpia brackets huérfanos y resetea
    try {
      await (ex as any).cancelCloseOrdersForSide?.(symbol, 'LONG');
      await (ex as any).cancelCloseOrdersForSide?.(symbol, 'SHORT');
    } catch (e: any) {
      log.warn('sync_cancel_orders_fail', { err: e?.message || String(e) });
    }
    st.set({ mode: 'IDLE', lastExitReason: s.lastExitReason ?? 'sync_reset' });
    log.info('sync_reset_to_idle');
  }
}
