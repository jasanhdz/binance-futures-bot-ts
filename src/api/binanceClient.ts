import Binance from 'binance-api-node';
import { CONFIG } from '../utils/config';

export const binanceClient = Binance({
  apiKey: CONFIG.API_KEY,
  apiSecret: CONFIG.API_SECRET,

  // FUTURES endpoints según entorno
  httpFutures: CONFIG.HTTP_FUTURES,
  wsFutures: CONFIG.WS_FUTURES,
});

// Log de entorno
binanceClient
  .futuresPing()
  .then(() => {
    console.log(`[Binance] Conectado a ${CONFIG.IS_TESTNET ? 'TESTNET' : 'PROD'} ✅`);
    console.log(`[Binance] HTTP: ${CONFIG.HTTP_FUTURES} | WS: ${CONFIG.WS_FUTURES}`);
  })
  .catch((err) => console.error('[Binance] Error de conexión:', err.message));
