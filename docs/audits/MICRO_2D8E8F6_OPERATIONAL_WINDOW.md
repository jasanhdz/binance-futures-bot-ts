# Micro 2d8e8f6: Ventana Operativa

Fecha de analisis: 2026-09-13 UTC.

## Alcance Y Resultado

Se analizo unicamente la evidencia de la ventana solicitada, sin modificar

| Elemento                    | Evidencia                                                          |
| --------------------------- | ------------------------------------------------------------------ |
| Commit autorizado           | `2d8e8f6ef9bf2c30650a4a74008d9ddab2d57f28`                         |
| Configuracion autorizada    | `132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1` |
| Archivo observado           | `/tmp/opencode/micro-2d8e8f6-candidate/observation.jsonl`          |
| Inicio de muestras          | `2026-09-13T04:15:59.251Z`                                         |
| Fin de muestras             | `2026-09-13T04:45:59.588Z`                                         |
| Duracion entre muestras     | 30 minutos y 0.337 segundos                                        |
| Muestras                    | 31, cada aproximadamente 60 segundos                               |
| PID observado               | `28256` en las 31 muestras                                         |
| Filas de eventos capturadas | 0                                                                  |

La identidad del proceso se comprobo durante y despues de la ventana. El

## Estado Operativo

### Datos Observados

- PM2 informo `01-Trading-Bot` como `online`, en `fork_mode`, con un unico
  proceso `dist/main.js` y sin duplicados de ese archivo en `ps`.
- El PID `28256` permanecio en estado `Ssl` en las 31 muestras.
- El consumo RSS paso de 117904 KiB a 114456 KiB en las muestras; el minimo
  fue 111072 KiB y el maximo 114456 KiB. CPU observado: 0.2% a 0.6%.
- `AEGIS_ENABLED=false` durante la ejecucion.
- `02-Aegis-API` estaba detenido. Esto es consistente con Aegis deshabilitado.
- El log registro `binance_connected` con `net=PROD` a `04:14:36.537Z`, antes
  del inicio de la ventana, y no registro una desconexion posterior.
- El log de historial no registro ticks, evaluaciones, decisiones, fills ni
  rechazos durante la ventana.

### Anomalias Confirmadas

- PM2 conserva `exit_code=1` y `restart_time=1` en su metadata aunque el
  proceso actual aparece `online`. Esto corresponde al intento de transicion
  que registro `JOURNAL_WRITER_LOCKED`; no debe ocultarse como una ventana sin
  reinicios.
- A las `04:48:02Z`, despues de la ventana, una lectura GET de
  `/diagnostics/market-data` devolvio `503` y registro:
  `market_data_diagnostics_failed: Cannot read properties of null (reading
'orderBookDataPlane')`.
- El log de arranque contiene `shutdown_failed` y `JOURNAL_WRITER_LOCKED` a
  `04:14:35Z`, ambos en la transicion previa a la ventana.

### Duplicados Y Proteccion

No se encontraron procesos duplicados de `dist/main.js`. Los journals locales
de mutaciones no tienen filas nuevas atribuibles a la ventana: el journal de
entradas conserva cinco filas historicas, el de cierres esta vacio y el de
stops conserva cinco filas historicas. Por tanto, hay **0 mutaciones de entrada
registradas localmente en la ventana** y no hay indicios locales de ordenes
duplicadas ni de un nuevo ciclo de proteccion.

Esto no demuestra por si solo que Binance no recibiera una orden externa al
journal. No se realizo una consulta de cuenta o de ordenes para no ampliar el
alcance de esta auditoria.

## Embudo De Micro

El archivo de observacion solo contiene muestras de proceso y lineas filtradas
de los dos logs de PM2. No contiene un evento por evaluacion ni un snapshot de
las razones. En consecuencia, los siguientes valores distinguen ausencia de
evidencia de un conteo real:

| Etapa                                     | Observado en la ventana | Interpretacion                                                         |
| ----------------------------------------- | ----------------------: | ---------------------------------------------------------------------- |
| Evaluaciones unicas por `decisionId`      |            0 observadas | No hay `decisionId`; no se puede afirmar que no se evaluara            |
| Datos invalidos o vencidos                |                     N/D | No hubo evento de razon                                                |
| BTC no disponible                         |                     N/D | No hubo evento de razon                                                |
| Rechazo de niveles                        |                     N/D | No hubo evento de razon                                                |
| Rechazo de proximidad                     |                     N/D | No hubo evento de razon                                                |
| Falta de disparador                       |                     N/D | No hubo evento de razon                                                |
| Deterioro de defensa                      |                     N/D | No hubo evento de razon                                                |
| Recorrido o beneficio/riesgo insuficiente |                     N/D | No hubo evento de razon                                                |
| `ENTRY_INTENT`                            |            0 observados | No hubo evento en logs/evidencia capturada                             |
| Admision posterior                        |           0 registradas | No hubo nueva mutacion/journal observable                              |
| Ordenes realmente enviadas                | N/D por evidencia local | 0 entradas enviadas por el adaptador visibles; sin auditoria de cuenta |

No se puede producir un desglose veraz por simbolo ni por LONG/SHORT: para los
11 simbolos habilitados y ambas direcciones el valor es N/D, no cero. La lista
de simbolos configurados es ETHUSDT, BTCUSDT, SOLUSDT, BNBUSDT, XRPUSDT,
DOGEUSDT, ADAUSDT, AVAXUSDT, LINKUSDT, SUIUSDT y LTCUSDT.

## Frescura Y Latencia

No hubo snapshots de mercado durante la ventana en el archivo observado. La
ultima linea de `logs/history-2026-09-13.log` fue `ping_ok` de `04:14:36.537Z`.
Por ello no existen valores reales de edad para velas, BTC, flujo agregado o
libro, ni percentiles de latencia de construccion, evaluacion, ACK, PREPARED o
envio.

| Metrica                  | Resultado |
| ------------------------ | --------- |
| Edad de vela cerrada     | N/D       |
| Frescura BTC             | N/D       |
| Edad de flujo            | N/D       |
| Edad del libro           | N/D       |
| Latencia de construccion | N/D       |
| Latencia de evaluacion   | N/D       |
| Latencia ACK             | N/D       |
| Latencia PREPARED        | N/D       |
| Latencia de envio        | N/D       |

Los registros de `runtime-resource-profile.jsonl` y `runtime-monitor.json`
contienen ventanas historicas de otros PIDs y fechas; no se usan como datos de
esta ventana. La conexion Binance PROD prueba conectividad de arranque, no
frescura sostenida ni funcionamiento de la ruta de evaluacion.

## Cola Black Box

No se encontro un archivo Black Box nuevo ni una ruta de exportacion de
observaciones asociada al PID `28256`. Tampoco hubo eventos de cola en el
archivo de observacion.

| Metrica                  | Resultado        |
| ------------------------ | ---------------- |
| Aceptados                | N/D              |
| Escritos                 | N/D              |
| Descartados              | N/D              |
| Fallidos                 | N/D              |
| Bytes                    | N/D              |
| Pico de cola             | N/D              |
| Tiempo de escritura      | N/D              |
| Perdidas observacionales | No cuantificable |

La ausencia de filas no prueba que la cola estuviera vacia. Impide distinguir
entre cero decisiones, scheduler no ejecutado, sink no conectado y perdida de
telemetria. El `503` del endpoint de diagnostico hace que la ultima hipotesis
no pueda descartarse.

## Journal, Locks, Ledger Y Coordinacion

- Confirmado en la transicion: `JOURNAL_WRITER_LOCKED` y
  `shutdown_failed`.
- Durante la ventana no aparecieron nuevos errores de journal, recovery,
  reservas, ledger ni coordinacion en los logs capturados.
- La ausencia de nuevos errores no prueba que cada componente haya sido
  ejercitado.
- La base SQLite de net-loss, consultada en modo solo lectura, tenia siete
  tablas y datos historicos; `micro_loss_trades` tenia una fila. No hubo fila
  nueva atribuible a la ventana.
- No se realizaron escrituras, reparaciones, eliminacion de locks ni cambios
  de estado para resolver la anomalia.

## Comparacion Con 8c04b21

`8c04b21` era la revision declarada por el proceso antes del despliegue. La
revision desplegada cambia la identidad a `2d8e8f6` y contiene, entre otros
cambios ya auditados, propagacion de frescura de inputs y metrica de tiempos de
preparacion. La configuracion hash observada es la misma configuracion efectiva
`132879...` en esta ejecucion; no se debe confundir eso con que la version
anterior tuviera esta instrumentacion.

La comparacion operacional no es A/B: no existe una ventana de 30 minutos de
`8c04b21` con el mismo mercado y el mismo colector. La evidencia historica
anterior muestra que el sistema podia registrar diagnosticos de mercado y
mutaciones, pero no permite atribuir sus conteos a este intervalo. En esta
ventana nueva, el proceso conecta a Binance pero no produce la telemetria
necesaria para medir Micro.

## Conclusion

### Hechos

- La ventana temporal y las 31 muestras corresponden al PID `28256`.
- El artefacto compilado corresponde al commit autorizado y la configuracion
  efectiva coincide con el hash autorizado.
- PM2 mantuvo un unico proceso, con Binance PROD conectado al arranque y
  Aegis deshabilitado.
- No se registraron `decisionId`, `ENTRY_INTENT`, admisiones ni nuevas
  mutaciones de entrada en la evidencia local.
- El endpoint de diagnostico no pudo entregar datos y devolvio `503` despues
  de la ventana.

### Inferencias

La explicacion compatible con la evidencia es que Micro **no abrio una
operacion registrada localmente** durante la ventana. No es posible decidir si
la causa fue ausencia de setups, filtros normales, falta de ejecucion del
scheduler o una ruta de observacion rota, porque no existe el embudo por
decision.

El estado `online` de PM2 y `binance_connected` no bastan para declarar el
artefacto operativamente validado. La falta de telemetria vuelve la ventana
incompleta para frescura, latencia, cola, replay y motivos de rechazo.

### Limitaciones Y Accion

Esta ventana solo comprueba que el proceso permanecio vivo y que pudo conectar
al exchange. No es evidencia economica, no demuestra rentabilidad y no
justifica bajar filtros. Antes de usarla como evidencia de funcionamiento se
debe corregir o aislar la ruta de diagnostico y repetir una ventana con:

- un evento durable por evaluacion y `decisionId`;
- snapshots de frescura y latencias con dominios explicitos;
- contadores de Black Box y razones de descarte;
- evidencia de replay y coordinacion;
- confirmacion independiente de ordenes y protecciones, si se autoriza esa
  consulta.

La estrategia debe evaluarse despues con una muestra economica suficiente y
separada de esta prueba operacional.
