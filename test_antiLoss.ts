// test_antiLoss.ts
import { predictLoss } from './src/ml/antiLoss';
(async () => {
  const p = await predictLoss({ adx: 20, mlMargin: 0.08, vRatio: 0.9, distTopPct: 0.001, hour: 3 });
  console.log('pLoss =', p); // debería ser un número entre 0 y 1 con decimales (no 0/1 fijo)
})();
