import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { roundToTick } from '../../core/risk/stop';

export async function ensureBracketsGuard(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  // STOP
  const stopOpen = await ex.openStopForSide(symbol, s.lastSide);
  if (!stopOpen) {
    const liq = (await ex.readLiquidationPrice(symbol, s.lastSide)) ?? s.lastEntryPrice;
    const filters = await ex.getSymbolFilters(symbol, pos.leverage);
    const ticks = CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT;

    // Reusa tu computeStopFromLiqTicks si prefieres; aquí lo simplificamos:
    let stop =
      s.lastSide === 'LONG' ? liq + ticks * filters.tickSize : liq - ticks * filters.tickSize;

    // Guardas para no ejecutarlo “ya”
    stop =
      s.lastSide === 'LONG'
        ? Math.min(stop, (await ex.getMarkPrice(symbol)) - filters.tickSize)
        : Math.max(stop, (await ex.getMarkPrice(symbol)) + filters.tickSize);

    stop = roundToTick(stop, filters.tickSize, filters.pricePrecision);
    await ex.placeStopClose(symbol, s.lastSide, stop);
    log.warn('rearmed_stop', { side: s.lastSide, stop });
  }

  // TP (recomputado por ROE)
  const mark = await ex.getMarkPrice(symbol);
  const filters = await ex.getSymbolFilters(symbol, pos.leverage);
  const r = CONFIG.TP_ROE;
  const fee = CONFIG.FEE_BUFFER_PCT;
  const tpRaw =
    s.lastSide === 'LONG'
      ? s.lastEntryPrice * (1 + r / pos.leverage + fee)
      : s.lastEntryPrice * (1 - r / pos.leverage - fee);
  const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);

  // (Binance no ofrece búsqueda directa por TP closePosition con positionSide en todas las cuentas.
  // Si quieres, puedes inspeccionar openOrders y buscar el TP igual que hiciste con STOP.)
  // Para mantenerlo simple, re-upsert siempre:
  await ex.placeTpClose(symbol, s.lastSide, tp);
  log.warn('rearmed_tp', { side: s.lastSide, tp });
}
