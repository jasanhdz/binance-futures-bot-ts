import { binanceClient } from '../api/binanceClient';
import { CONFIG } from './config';

export async function startupHealthCheck() {
  try {
    // 1) Ping (no requiere auth)
    const ok = await binanceClient.futuresPing();
    console.log(ok ? '✅ Ping Futures OK' : '⚠️ Ping Futures extraño');

    // 2) Tiempo del servidor (no auth)
    const serverTime = await binanceClient.futuresTime();
    console.log('⏱️ Server time:', serverTime);

    // 3) Llamada autenticada (requiere API KEY/SECRET):
    const info = await binanceClient.futuresAccountInfo();
    console.log(
      `🔐 Auth OK | canTrade=${info.canTrade} | posiciones=${info.positions?.length ?? 0}`,
    );

    console.log(
      '[Config] BYPASS_ENTRY_CHECKS=',
      CONFIG.BYPASS_ENTRY_CHECKS,
      'BYPASS_SIDE=',
      CONFIG.BYPASS_SIDE,
    );

    // await checkTakeProfit('XRPUSDT');
  } catch (e: any) {
    console.error('❌ Health check falló:', e?.message || e);
  }
}
