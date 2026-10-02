# Reconciliación ADA/AVAX y explicación de racha

## Evidencia consultada

Consultas autenticadas GET mediante BinanceUsdmReadOnlyAuditClient, ventana
2026-09-30 00:00:00 UTC a 23:59:59.999 UTC. Siete solicitudes, cero mutaciones,
cero fallos de autenticación. Consulta actual: positions=[], openOrders=[],
openAlgoOrders=[]. No se dedujo la reconciliación únicamente de estar flat.

| Símbolo | Entrada FILLED | clientOrderId | Cierre FILLED reduceOnly | Cantidad entrada/salida |
| --- | --- | --- | --- | --- |
| ADAUSDT | 68676950881 | se_bd863f646aacc6b138e9fdff84138ca1f | 68676975058 | 166 / 166 |
| AVAXUSDT | 40889213012 | se_4850c48e8e5bc10b51ecb05e90ddc9490 | 40889221117 | 3 / 3 |

ADA: fills entrada 1933751445–1933751450, fills cierre 1933751819–1933751820.
AVAX: fill entrada 1446313132, fill cierre 1446313330.
Los clientOrderId coinciden exactamente con el journal durable de entradas:
ADA CLOSED en línea 50 y AVAX CLOSED en línea 60. Las liquidaciones permanecen
en el ledger (epoch 1), netos -0.04042099 y -0.050739 USDT, sin conflicto.

Ambos estados estaban IDLE, sin PnL sin verificar ni bloqueo de protección;
marketOpenAmbiguous=true permanecía como flag residual. Se detuvo PM2 antes de
corregir exclusivamente ese flag a false y se releerá tras reiniciar.
Los journals y el historial de fills/liquidaciones no se modifican.

## Por qué desapareció el bloqueo de tres pérdidas

No fue necesario un reset firmado ni un reinicio del proceso: el código actual
`MicroBurstNetLossLedger.ts` (refresh de calendario, líneas 484–505) recalcula
racha y halted usando solo operaciones cerradas dentro del día UTC actual.

Evidencia persistida en micro_loss_rollovers:

- Revisión 34: cambio al 2026-09-30, observado 1790726400298 (00:00:00.298 UTC).
- Revisión 42: cambio al 2026-10-01, observado 1790812803886 (00:00:03.886 UTC).
- Revisión 43: cambio al 2026-10-02, observado 1790899205468 (00:00:05.468 UTC).

Estado consultado: revisión 43, epoch 1, racha 0, halted 0. La tabla de comandos
solo contiene INITIALIZE del epoch, no un RESET para este intervalo. Las pérdidas
del 29 y 30 siguen almacenadas en micro_loss_trades, con sus netos e identidades.

La configuración dice reset_mode SIGNED_OPERATOR, pero el comportamiento efectivo
incluye reinicio diario automático del gate. No describirlo como un bloqueo
indefinido hasta firma. Esa diferencia semántica requiere una decisión posterior;
esta reconciliación no cambia la política de riesgo ni borra resultados.

## Verificación posterior al reinicio

PID 11301, RUNNING/LOOP_READY, liveExecution=true y liveAuthority=true.
Después del calentamiento: 880 evaluaciones, 80 por cada uno de los 11 símbolos,
cero fallos de evaluación. Los 11 símbolos estaban FRESH y las listas de
symbolBlockers vacías. Los estados de ADA/AVAX conservan marketOpenAmbiguous=false
y sus lastOrderId originales. No se encontraron flags true de marketOpenAmbiguous,
microProtectionBlocked o microBurstPnlUnverified en los estados por símbolo.

Esto verifica la corrección persistida de los dos casos, no una solución general
a la causa que dejó flags residuales. Tampoco garantiza ausencia futura de
rechazos normales de estrategia, frescura o riesgo. Sigue pendiente investigar
la limpieza del flag en la ruta de recuperación durable sin debilitar UNKNOWN.
