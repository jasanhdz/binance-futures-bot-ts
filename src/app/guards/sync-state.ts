// src/app/guards/sync-state.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';

export async function syncStateGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();

  // 1) Si estamos IDLE pero hay una posición real → "attach" al estado
  if (s.mode === 'IDLE') {
    // Intentamos detectar posición en LONG y en SHORT (soporta one-way y hedge)
    const longPos = await ex.readActivePosition(symbol, 'LONG');
    const shortPos = await ex.readActivePosition(symbol, 'SHORT');

    if (longPos || shortPos) {
      const pos = longPos ?? shortPos!;
      const side = longPos ? ('LONG' as const) : ('SHORT' as const);

      st.set({
        mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
        lastSide: side,
        lastEntryPrice: pos.entryPrice,
        lastLeverage: pos.leverage,
        lastEntryAt: Date.now(),
        peakRoe: 0,
        bracketsArmedAt: 0, // ← forzar armado una sola vez por ensure-brackets
        posSideMode: pos.sideMode,
      });

      log.info('sync_attach_to_open_position', {
        side,
        entry: pos.entryPrice,
        lev: pos.leverage,
        qtyAbs: pos.qtyAbs,
      });
    } else {
      // Nada abierto realmente; no hacer ruido a nivel info
      log.debug('sync_idle_no_position');
    }
    return; // importante: no continúes al bloque 2
  }

  // 2) Si NO estamos IDLE pero ya NO hay posición → reset y limpiar órdenes
  const hasAny = await ex.hasOpenPosition(symbol, 'ANY');
  if (!hasAny) {
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
