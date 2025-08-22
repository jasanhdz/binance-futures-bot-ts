import { binanceClient } from '../api/binanceClient';
import { logHistory } from '../utils/logger';

/**
 * Verifica si ya hay una posición abierta en el par indicado.
 * Por defecto valida LONG; soporta One-way (BOTH) y Hedge Mode (LONG/SHORT).
 *
 * @param symbol Ejemplo: "XRPUSDT"
 * @param side   'LONG' | 'SHORT' | 'ANY' (por defecto 'LONG')
 */
export async function hasOpenPosition(
  symbol: string,
  side: 'LONG' | 'SHORT' | 'ANY' = 'LONG',
): Promise<boolean> {
  try {
    const account = await binanceClient.futuresAccountInfo();
    const positions = account.positions || [];
    console.log('*************** HERE *******************');

    // ANY: cualquier posición abierta (long o short)
    if (side === 'ANY') {
      return positions.some((p) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
    }

    // LONG o SHORT: considerar One-way (BOTH con signo) y Hedge (positionSide == LONG/SHORT)
    return positions.some((p) => {
      if (p.symbol !== symbol) return false;

      const amt = parseFloat(p.positionAmt);
      if (p.positionSide === 'BOTH') {
        // One-way: signo define el lado
        return side === 'LONG' ? amt > 0 : amt < 0;
      }

      // Hedge Mode: usar positionSide explícito y que haya cantidad > 0
      return p.positionSide === side && Math.abs(amt) > 0;
    });
  } catch (error) {
    const errMsg = `❌ Error al verificar posición abierta: ${(error as Error).message}`;
    console.error(errMsg);
    logHistory(errMsg);
    return false;
  }
}
