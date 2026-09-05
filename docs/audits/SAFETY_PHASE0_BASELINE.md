# Fase 0: baseline y contratos

## Evidencia capturada

- Checkout: `6ea9c364b6f69b623babf92e43dcdc92ac84f8ef`.
- Árbol versionado: 532 rutas (`/tmp/opencode/micro-tree-6ea9c36.txt`).
- Config efectiva sanitizada: `regime_config.live.yaml`, generada con
  `scripts/aegis/dump_effective_config.ts`; digest del dump: `02a5b7e1cead4131672568954336a96a6a4498880d7d4da47aa7b3ee5c9099a2`.
- No se guarda el dump efectivo en el repositorio porque contiene parámetros operativos LIVE.
- Validación previa a esta modificación: build PASS, 1.548/1.548 tests del grupo principal,
  46/46 tests del grupo `ConfigLoader`, y `git diff --check` PASS.

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

No existe un supervisor de brackets versionado en este repositorio. No se ha podido verificar
desde el checkout un proceso externo con propietario, frecuencia, símbolos, condiciones y
evidencia operativa; por tanto no se cuenta como cobertura de seguridad.

## Runner reproducible

`npm run test:safety` ejecuta build, los dos grupos disjuntos de Vitest y `git diff --check`.
El runner sólo prepara `REGIME_CONFIG` para el grupo que lo necesita y no modifica la precedencia
de configuración de producción.

## Limitaciones

- La existencia de un supervisor externo sigue sin evidencia local.
- La reserva de entrada sigue siendo local al proceso.
- Las fases 1 y 2 aún requieren supervisor común, reconciliación durable y snapshot de cuenta completo.
