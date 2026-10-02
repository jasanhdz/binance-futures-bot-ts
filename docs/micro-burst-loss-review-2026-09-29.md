# Micro: auditoría de dos pérdidas y protocolo de comparación

## Autoridad y alcance

Auditoría descriptiva de dos operaciones seleccionadas por su pérdida. No es una
muestra imparcial para estimar el valor esperado de la estrategia. Fuente económica:
liquidaciones persistidas `BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1`, verificadas,
con fills y funding completos. No se consultó ni modificó Binance.

En la lectura del ledger: revisión 33, epoch 1, streak 3, halted 1.

## Resultados con fills efectivos

| Campo                                        |                   SOL SHORT |                    AVAX LONG |
| -------------------------------------------- | --------------------------: | ---------------------------: |
| Trade ID (sufijo)                            | SOLUSDT-20260929-133110-473 | AVAXUSDT-20260929-154601-912 |
| Cantidad                                     |                        0.38 |                            3 |
| Entrada VWAP                                 |                      120.93 |                       11.285 |
| Salida VWAP                                  |                      120.98 |                        11.25 |
| Duración fill a fill                         |                    79.250 s |                     30.731 s |
| PnL bruto USDT                               |                      -0.019 |                       -0.105 |
| Comisiones USDT                              |                   0.0459629 |                    0.0338025 |
| Funding USDT                                 |                           0 |                            0 |
| PnL neto USDT                                |                  -0.0649629 |                   -0.1388025 |
| Retorno neto sobre notional de entrada (bps) |                    -14.1367 |                     -40.9991 |

Total neto: -0.2037654 USDT. Las comisiones representan aproximadamente 10 bps
del notional de entrada en ambas operaciones. En SOL superan la pérdida por precio.
Esto no demuestra que eliminar el cierre temprano hubiera mejorado el resultado.

### Corrección de interpretación temporal de SOL

- Observación de la decisión EARLY_FAILURE: 1790688748817.
- Fill de salida: 1790688753463.
- Diferencia observación a fill: 4646 ms.
- Registro APPLICATION_RESULT alrededor de 13:32:52 UTC.

Los aproximadamente 23 segundos hasta APPLICATION_RESULT no son latencia de
envío demostrada. Incluyen tiempo posterior al fill. Aún falta separar preparación,
envío, reconocimiento y reconciliación. Los timestamps openedAtMs/closedAtMs de
la identidad contable tampoco sustituyen los timestamps de fills.

### Evidencia que falta

Los fills no permiten reconstruir MFE/MAE ni demostrar continuidad entre muestras.
El auditor devuelve null explícitamente para esas métricas. Se necesitan trayectorias
archivadas con cobertura verificada y precios ejecutables para el lado de salida.
La presencia de campos peak/trough en estado no prueba cobertura continua.

## Auditor reproducible

`src/tooling/micro-burst/MicroBurstSettledEpisodeAudit.ts` abre el ledger SQLite en
modo read-only, dentro de una transacción de lectura. Rechaza episodios repetidos,
liquidaciones incompletas/conflictivas y cantidades de fills incompatibles.

```bash
npx ts-node src/tooling/micro-burst/MicroBurstSettledEpisodeAudit.ts <ledger.sqlite> MICRO-BURST-SOLUSDT-20260929-133110-473 MICRO-BURST-AVAXUSDT-20260929-154601-912
```

El hash de commit persistido no identifica por sí solo cambios locales sin commit;
la comparación futura debe incluir una huella del código efectivo.

## Protocolo shadow preregistrado

Referencia: política vigente y sus salidas reales, incluyendo EARLY_FAILURE,
stop, límites de tiempo, comisiones, funding y ejecución. No sustituir estas salidas
por un objetivo teórico ni confundir fuerza de momentum con probabilidad calibrada.

Comparar inicialmente por separado:

1. Persistencia: flujo y reacción de precio en observaciones nuevas, contabilizando
   el coste del retraso y oportunidades ganadoras descartadas.
2. Alcanzabilidad: recorrido compatible con volatilidad, obstáculos y horizonte.
   Calibrar únicamente con datos anteriores a cada decisión.
3. Contexto: segmentar continuación y reversión; primero medir, luego decidir si
   corresponde excluir un segmento.

Unidad estadística: episodio independiente. Todas las observaciones de un episodio
pertenecen al mismo bloque temporal. Duplicados no aumentan n. Incluir todas las
señales elegibles, no solo ejecuciones ni pérdidas. Mantener cohortes de código y
configuración separadas. Datos ausentes invalidan esa comparación, no cuentan como
retorno cero ni evidencia neutral.

Separar calibración, validación temporal y prueba final intacta; purgar horizontes
solapados en fronteras. Congelar variantes antes de la prueba final. Presentar n,
exclusiones, beneficio neto medio, ganancia/pérdida media, tasa de acierto,
drawdown, concentración por episodio y sensibilidad a costes. Intervalos mediante
bloques temporales, conservando dependencia de operaciones simultáneas.

Retorno LIVE: evidencia neta fuera de muestra con incertidumbre suficientemente
acotada (límite inferior positivo), resistencia a escenarios de ejecución peores,
sin dependencia de una sola ganadora y trazabilidad de fills/protección. Después,
piloto de riesgo pequeño definido por pérdida al stop, no por confidence=1.

## Pendiente

### Revisión de cobertura y resúmenes shadow

La configuración local revisada tiene `market_archive.enabled: false` y
`prospective_validation.enabled: false`. No se encontraron archivos del 29 de
septiembre en `data/`, ni segmentos solapados con ambas posiciones en el índice
`data/micro-burst/micro_burst_research.sqlite`. Esto no prueba que no exista otra
copia externa ni cuál era la configuración efectiva histórica.

Sí existen resúmenes en
`logs/micro-burst/shadow-outcomes/2026-09-29-1790674076168.jsonl`.
Son agregados por horizonte desde la señal; no son trayectorias crudas ni prueba
de cobertura. Su episodeId de investigación difiere del episodio LIVE: el enlace
utilizado es el shadowSignalId exacto, que contiene el episodio original.

- SOL: el resumen de 60 s registra 120.79 a 1790688699888, 25.675 s después
  del fill. Respecto a 120.93 supone 11.577 bps favorables brutos. Con 5 bps
  de comisión por lado, una salida hipotética a ese precio dejaría aproximadamente
  1.58 bps antes de cualquier diferencia entre trade y ask ejecutable/deslizamiento.
  No se demuestra que 0.38 SOL pudieran comprarse allí. La mejor observación de
  los primeros 15 s ocurrió antes del fill y no cuenta como oportunidad en posición.
- AVAX: el máximo registrado en horizontes de 15/30/60 s fue 11.286 a
  1790696766067, 270 ms antes del fill. No es una salida disponible tras entrar.
  El resumen registra 11.27 a 9.764 s y 11.252 a 18.098 s después del fill.
  La recuperación registrada en horizontes posteriores ocurrió tras la salida y
  no demuestra que el stop debiera ampliarse.

`MicroBurstObservedExcursionAudit.ts` produce estos enlaces temporales, deja
MFE/MAE de la posición como null y clasifica contrafactuales como no elegibles
sin inputs causales crudos y evidencia de ejecución. Los máximos de un horizonte
no permiten recuperar máximos de un subintervalo ni certificar profundidad.

Prioridad operativa: preparar captura nueva de aggTrade, snapshots y deltas con
secuencia, timestamps de recepción/evento, gaps y cantidades; verificar continuidad
antes de autorizar replay. Habilitar captura es distinto de reactivar entradas.
No se alteró la configuración ni el bloqueo en esta revisión.

- Verificar cobertura y reconstruir trayectorias de SOL/AVAX.
- Descomponer los 4646 ms de observación a fill de SOL.
- Ejecutar comparación shadow con salidas coherentes y cohortes independientes.
- Estimar ventaja fuera de muestra. Dos pérdidas no autorizan esa inferencia.

Esta auditoría no cambia umbrales, no restablece el ledger y no despliega variantes.
