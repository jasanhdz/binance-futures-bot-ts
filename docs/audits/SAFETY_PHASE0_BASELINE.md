# Fase 0: baseline y contratos

## Referencia posterior: d341225

Publicacion verificada de las correcciones R1-R4 mediante `8306846` y `d341225`.
Ver `SAFETY_RECONCILIATION_LEDGER_FIX.md` para pruebas y seguimiento. Los fallos
de 389a6ff citados abajo ya no son pendientes; los limites de integracion permanecen.

## Actualización historica de referencia: 389a6ff

Código auditado: `389a6ff2cc6953b4628d3ab37a96a5054a1c5171`, rama micro.
Leer `CHAT_CONTINUITY_389A6FF.md` antes de usar los baselines históricos inferiores.
Hay cuatro fallos abiertos reproducidos y módulos nuevos todavía sin integración runtime.
No asumir fases 1–8/10 completas ni usar el total de tests como certificación.
Última auditoría propia: casos sintéticos dirigidos; no se repitió suite completa.
Build y 1.728 tests principales son reporte del usuario; ver SAFETY_HANDOFF_VALIDATION.md.

## Evidencia capturada

- Checkout: `6ea9c364b6f69b623babf92e43dcdc92ac84f8ef`.
- Árbol versionado: 532 rutas (`/tmp/opencode/micro-tree-6ea9c36.txt`).
- Config efectiva sanitizada: `regime_config.live.yaml`, generada con
  `scripts/aegis/dump_effective_config.ts`; digest del dump: `02a5b7e1cead4131672568954336a96a6a4498880d7d4da47aa7b3ee5c9099a2`.
- No se guarda el dump efectivo en el repositorio porque contiene parámetros operativos LIVE.
- Validación previa a esta modificación: build PASS, 1.548/1.548 tests del grupo principal,
  46/46 tests del grupo `ConfigLoader`, y `git diff --check` PASS.

## Baseline histórico del traspaso c5d4f60

- Código validado/publicado: `c5d4f60311e75fa838a41eeac039c1495d9f644b`.
- Rama: `work/micro-burst-rider-v1-20260826`.
- Build y 1.590 + 46 = 1.636 tests PASS (176 archivos entre ambos grupos).
- Fases 1/2/3/5/7 con incrementos parciales; fase 0 avanzada, sin evidencia del
  supervisor externo. No hay certificación operativa ni económica.
- El objetivo virtual actual es completar implementación y tests, manteniendo
  separados los pendientes de datos reales, parámetros aprobados y despliegue.

## Baseline histórico de revisión

- HEAD verificado: `c8244382aba8820a7112ae9499df754a8e4e081f`.
- `npm run test:safety`: build PASS; grupo principal `174/174` archivos y `1557/1557` tests
  PASS; grupo `ConfigLoader` `1/1` archivo y `46/46` tests PASS; `git diff --check` PASS.
- Este resultado es baseline de revisión y no implica que las fases 1 o 2 estén cerradas.

## Matriz de autoridad

| Propietario | Modo | Entrada nueva | Posición existente |
| --- | --- | --- | --- |
| Micro Burst | `LIVE` | Permitida sólo por su gate y autoridad vigente | Supervisor independiente; stop de posición completa, sin TP ni trailing; salida inteligente aparte |
| Micro Burst | `SHADOW`/`OFF` | Denegada | Se conserva la gestión de una posición persistida por símbolo |
| Aegis Turbo | `LIVE` | Permitida sólo por sus gates y límites actuales | Brackets SL+TP y manager Aegis |
| Aegis Turbo | `SHADOW`/`OFF` | Denegada | Se gestiona la posición atribuida, sin reabrir autoridad de entrada |
| Momentum Ride | `LIVE` | Permitida sólo por su coordinador y gates actuales | Manager Momentum y protección vigente |
| Momentum Ride | `SHADOW`/`OFF` | Denegada | Se gestiona la posición atribuida |
| Externa/manual | Cualquier modo | Nunca por la estrategia | Protección conservadora; sin autoridad de estrategia ni métricas de bot |
| Propiedad desconocida | Cualquier modo | Denegada | `RECOVERY_REQUIRED`/cuarentena; no resetear a `IDLE` |

La obligación de proteger una posición existente es independiente del permiso de entrada.
Micro no hereda TP ni trailing de Aegis.

## Supervisor externo

Sí existe supervisión interna versionada: `src/app/position/PositionProtectionService.ts`,
integrada con `TradingService`. Esto no equivale todavía a supervisión universal independiente.
El usuario también menciona un guard que repone brackets: no se ha podido verificar si existe
un proceso externo adicional, su propietario, frecuencia, símbolos y evidencia operativa.
No negar su existencia ni contar cobertura externa no verificada. Inspeccionar y reutilizar
el código existente antes de crear otro supervisor. La evidencia de producción queda pendiente.

## Runner reproducible

`npm run test:safety` ejecuta build, los dos grupos disjuntos de Vitest y `git diff --check`.
El runner sólo prepara `REGIME_CONFIG` para el grupo que lo necesita y no modifica la precedencia
de configuración de producción.

## Limitaciones

- La existencia de un supervisor externo sigue sin evidencia local.
- La reserva de entrada sigue siendo local al proceso.
- Las fases 1 y 2 aún requieren supervisor común, reconciliación durable y snapshot de cuenta completo.
