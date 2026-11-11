# Captura: rechazos tras calentamiento y siguiente episodio

## Ventana y resultado

2026-10-01 06:23:55.313–18:39:29.090 UTC (filtro por recepción local).
170 archivos comprimidos seleccionados; 86 188 decisiones válidas dentro del rango.
No se interpretan como oportunidades independientes.

| Clasificación descriptiva                             | Observaciones |
| ----------------------------------------------------- | ------------: |
| Primeros 300 s de captura                             |           594 |
| Después del calentamiento, contexto evaluable         |        68 351 |
| Después del calentamiento, rechazo de datos al uso    |        13 336 |
| Después del calentamiento, contexto/datos incompletos |         3 907 |

El 79.85 % de las observaciones posteriores al calentamiento tenía contexto evaluable
según el registro. Esto no certifica cobertura cruda ni convierte los rechazos en
oportunidades económicas. Hubo mercado evaluable sin señales aceptadas en la muestra.

La categoría de calentamiento combina 300 s desde inicio de captura con calidad
registrada; no afirma que todos los indicadores necesiten exactamente 300 s.
Los recalentamientos/huecos posteriores quedan en datos incompletos.

| Símbolo | Contexto evaluable post-warmup | Datos rechazados al uso | Datos incompletos |
| ------- | -----------------------------: | ----------------------: | ----------------: |
| ETH     |                           6358 |                    1234 |               377 |
| BTC     |                           6349 |                    1260 |               350 |
| SOL     |                           6358 |                    1232 |               341 |
| BNB     |                           6302 |                    1238 |               364 |
| XRP     |                           6272 |                    1218 |               372 |
| DOGE    |                           6254 |                    1237 |               333 |
| ADA     |                           6197 |                    1213 |               354 |
| AVAX    |                           6155 |                    1202 |               351 |
| LINK    |                           6100 |                    1149 |               373 |
| SUI     |                           6041 |                    1169 |               348 |
| LTC     |                           5965 |                    1184 |               344 |

Motivos globales: REACTION_NO_QUALIFIED_SIDE 68 352 (incluye uno inicial),
REACTION_CONTEXT_INVALID 4500, BTC_UNAVAILABLE 3133, REACTION_FLOW_UNAVAILABLE 10 203.
El último motivo agrupa varios checks; no atribuirlo automáticamente a desconexión.

Ejemplos de motivos específicos por lado (todos los registros válidos del rango):
SOL LONG: nivel no confirmado 2355, dirección no confirmada 1877, lejos del nivel
1970, trigger ausente 156. SOL SHORT: nivel 2494, dirección 1997, lejos 1421,
trigger 437, defensa degradada 9. Los lados de una misma observación no se suman
como operaciones. La herramienta devuelve buckets por símbolo y hora, motivos de
calidad y motivos por lado, sin relajar ningún filtro.

## Línea malformada delimitada

Archivo decisions-v2.2026-10-01T23-59-09-052Z.1.jsonl.gz, línea 567, 98 469 bytes.
SHA-256 de línea: a63b8108981e0ad20efdfb636b784cc9b54bec6938647f8dfa4748cd664e1f6e.
Vecino anterior: línea 566, LINK, recepción 18:41:31.585 UTC.
Vecino siguiente: línea 568, BTC, recepción 23:57:01.473 UTC.
No se infiere el timestamp del contenido truncado ni su causa. Se pone el archivo
completo en cuarentena analítica (sin moverlo ni borrarlo). Contiene 319 observaciones
válidas en la ventana descrita: 297 evaluables, 12 rechazos al uso y 10 incompletas.
Los totales anteriores son descriptivos e incluyen esas filas; para un conjunto
elegible deben excluirse. Excluyéndolas quedan 85 869 observaciones parseables;
la integridad de parseo sigue sin certificar continuidad de mercado.

## Reproducción

```bash
npx ts-node src/tooling/micro-burst/MicroBurstCaptureReadinessAudit.ts \
  data/strategy-blackbox/strategy-decisions decisions-v2.2026-10-01T \
  1790835835313 1790879969090 --summary
```

Omitir --summary para detalle por símbolo/hora y hash de cada archivo.

## Preparación del próximo episodio

Se añadió MicroBurstEpisodeCapture como sumidero de un recolector observacional
dedicado. No importa adaptadores de órdenes. Acepta MARKET/DECISION/GAP y resultados
terminales CURRENT/PULLBACK, conserva decisiones rechazadas, inputs originales y
una sola identidad por episodio. El directorio de sesión debe ser nuevo.

Conserva config efectiva y bytes del código productor (incluidos cambios locales)
con hashes; una etiqueta git no basta. La identidad solo se considera verificada
si el recolector arranca desde esos bytes congelados. UNVERIFIED_PRODUCER permanece
visible si no existe esa prueba. El journal encadena hashes y sincroniza cada append.
No usar este escritor síncrono en el callback LIVE: requiere proceso de captura
separado y medición de throughput antes de conectarlo a todos los streams.

Al recibir ENTRY_INTENT conserva la referencia exacta al episodio y su contexto.
Rechazo de PULLBACK es un terminal válido: no se necesita orden real. Al terminar
la sesión sin los dos terminales queda INCOMPLETE, no se genera una salida ficticia.
Gaps y calentamiento crudo no verificado siguen explícitos incluso si hay cierres.

**Estado operativo:** es infraestructura preparada y probada, aún no un recolector
continuo desplegado. LIVE y su captura cruda desactivada no se modificaron.
Falta conectar un productor público en observación, lanzar desde código congelado,
verificar rendimiento, archivar contexto/velas/BTC desde calentamiento y conservar
todo hasta los terminales de ambas variantes. Hasta entonces no se promete que la
próxima señal vaya a quedar certificada automáticamente.

Los umbrales y la persistencia experimental de 2 s permanecen congelados.
