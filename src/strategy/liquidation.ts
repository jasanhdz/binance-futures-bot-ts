import { binanceClient } from '../api/binanceClient';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Devuelve la liquidationPrice real del lado activo (BOTH/LONG/SHORT). */
export async function getRealLiqPrice(symbol: string, side: 'LONG' | 'SHORT'): Promise<number> {
  // A veces tarda unos ms en actualizarse tras el fill. Reintenta.
  for (let i = 0; i < 5; i++) {
    const risks = await binanceClient.futuresPositionRisk(); // array
    const cand = risks.find((p: any) => {
      if (p.symbol !== symbol) return false;
      const amt = parseFloat(p.positionAmt);
      if (p.positionSide === 'BOTH') return side === 'LONG' ? amt > 0 : amt < 0;
      return p.positionSide === side && Math.abs(amt) > 0;
    });
    const liq = cand ? parseFloat(cand.liquidationPrice) : NaN;
    if (cand && isFinite(liq) && liq > 0) return liq;
    await sleep(200);
  }
  throw new Error('No pude leer liquidationPrice real.');
}
