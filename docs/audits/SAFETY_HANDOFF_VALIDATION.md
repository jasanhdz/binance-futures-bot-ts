# Validación del incremento de seguridad

## Referencia vigente del traspaso

- Último commit de código validado y publicado: `c5d4f60311e75fa838a41eeac039c1495d9f644b`.
- Incremento anterior: `fbc7f19e3bac96ac5008e587d6b2ed57702dd4b1`.
- Rama única: `work/micro-burst-rider-v1-20260826`.
- Última ejecución de `npm run test:safety`: build PASS; grupo principal 175 archivos,
  1.590 tests PASS; ConfigLoader 1 archivo, 46 tests PASS. Total: 176 archivos,
  **1.636 tests, 0 fallos**. Formato de TS modificados y `git diff --check`: PASS.
- Este resultado pertenece al código de `c5d4f60`. Una actualización sólo documental
  no constituye una nueva ejecución de la suite. Recontar tras cambios futuros.
- No hubo runtime LIVE, órdenes, soak, replay histórico ni validación económica.
- En entorno virtual: implementar código y crear tests sintéticos/deterministas;
  ejecutar validación técnica al final de cada bloque, no tras cada edición.
  Falta de datasets no impide esos tests. Las pruebas económicas quedan pendientes.
- Usar `CODEX_CONTINUE_SAFETY_PROMPT.md` y `SAFETY_PHASES_HANDOFF.md` para continuar.

## Registro histórico del primer incremento (no es el estado actual)

Baseline: `05b233963d7897dccb9912f82b76895270eeb3b0`.
Rama: `work/micro-burst-rider-v1-20260826`.
Alcance: incremento parcial y traspaso; no aprobación de despliegue LIVE.

## Resultado

- `npm run build`: PASS.
- Suite excluyendo `ConfigLoader.aegis-symbols.test.ts`, con `REGIME_CONFIG=regime_config.live.yaml`:
  174 archivos, 1.548 tests, todos PASS.
- `ConfigLoader.aegis-symbols.test.ts`, sin `REGIME_CONFIG`: 1 archivo, 46 tests, todos PASS.
- Total de ambos grupos disjuntos: **175 archivos, 1.594 tests, 0 fallos**.
- `git diff --check`: PASS.
- Baseline auditado: 1.575 tests, cuatro fallos preexistentes. Incremento: 19 tests nuevos.
- Ninguna orden Binance, ejecución de runtime LIVE, cambio de credenciales, PM2 o YAML LIVE.

## Pruebas nuevas

- 9 casos puros de integridad de velas: cadencia, duplicados, orden, OHLCV y timestamps.
- 4 casos de supervisor Micro: restauración confirmada, visibilidad pendiente, error de consulta,
  protección existente; no se coloca TP.
- 4 contratos de TradingService: exposición desconocida, bloqueo compartido, liberación tras error,
  supervisión previa al contexto técnico.
- 1 integración de reserva Micro retenida durante await que impide entrada competidora y se libera tras error.
- 1 ejecución Micro con stop rechazado: cierre de emergencia confirmado y ningún TP.

## Ajustes de pruebas anteriores

1. Fixture de cuarentena: simula provenance válida para llegar al guard de PnL, sin alterar la
   autorización de producción. El hash de configuración ignorado sigue pendiente en fase 6.
2. Brackets: se inyecta un error de listado en vez de una lista vacía con SL/TP aceptados.
   Se comprueba cierre y motivo de error. La política de retraso de visibilidad tiene tests separados.
3. Tamaño Micro: la expectativa se alinea con el default actual de 0.9, no 0.09. No se modifica
   sizing ni se declara económicamente adecuado; fase 8 requiere presupuesto autorizado.
4. Digest de fuente TradingService actualizado y documentado. Es un checkpoint de código,
   no una aprobación de modelo, configuración o despliegue LIVE.

## Límites

Pruebas deterministas con exchange simulado: no validan latencia real de recuperación, procesos
externos ni rentabilidad. No se hizo replay económico por falta de un dataset local seleccionado.
`SAFETY_PHASES_HANDOFF.md` enumera explícitamente las garantías aún pendientes y el orden de trabajo.

No publicar secretos al adjuntar logs/configuraciones. Al continuar, repetir los dos comandos de
test del traspaso; un `npm test` sin preparación no equivale todavía a este runner aislado.
