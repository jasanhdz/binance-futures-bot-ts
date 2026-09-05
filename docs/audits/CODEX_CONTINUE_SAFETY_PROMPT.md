# Prompt completo: terminar el endurecimiento de Micro/Aegis en entorno virtual

Actúa como ingeniero responsable de completar la implementación de TODAS las fases 0–10
de mi bot. No te limites a auditar, proponer un plan o resolver un único bug. Implementa
los pendientes, crea los tests necesarios, actualiza el traspaso y publica bloques
coherentes en GitHub. Nosotros revisaremos los incrementos conforme avances.

## 1. Repositorio, rama y punto de partida

Repositorio: https://github.com/jasanhdz/binance-futures-bot-ts
Rama única: work/micro-burst-rider-v1-20260826. No crear nuevas ramas.
Último commit de código validado: c5d4f60311e75fa838a41eeac039c1495d9f644b.
Incremento anterior: fbc7f19e3bac96ac5008e587d6b2ed57702dd4b1.
Puede haber commits documentales o nuevas correcciones posteriores: intégralos y revisa
sus diffs. No vuelvas la rama al SHA antiguo ni sobrescribas avances.

Primero:
1. Localiza el checkout correcto; inspecciona AGENTS.md, status, rama, remotos y log.
2. Si hay trabajo local, revísalo y consérvalo en un checkpoint pertinente antes de
   integrar. Nunca añadir secretos, .env, credenciales, node_modules o datos privados.
   No usar git add . a ciegas. No ejecutar reset --hard, checkout destructivo ni force push.
3. Haz fetch de origin. Verifica que el remoto corresponde al repositorio indicado.
   Usa fast-forward cuando proceda. Si diverge, conserva ambas historias, inspecciona
   los cambios y resuelve conscientemente. No encadenes merge y rebase automáticamente.
   Si no puedes preservar trabajo o resolver la intención de un conflicto, consulta.
4. Lee COMPLETOS estos archivos antes de modificar:
   - AGENTS.md.
   - docs/audits/SAFETY_PHASES_HANDOFF.md (checklists, rutas y pseudocódigo por fase).
   - docs/audits/SAFETY_HANDOFF_VALIDATION.md.
   - docs/audits/SAFETY_PHASE0_BASELINE.md.
   - docs/audits/CODEX_CONTINUE_SAFETY_PROMPT.md.
5. Revisa las implementaciones y el diff reciente, no sólo el resumen de otra IA.
   La referencia técnica registrada es build PASS y 1.590 + 46 = 1.636 tests PASS;
   no afirmes haberlos ejecutado tú hasta hacerlo. El número crecerá al añadir casos.

## 2. Alcance virtual y significado de terminar

No disponemos ahora de datasets reales, caja negra seleccionada ni entorno de producción.
Eso NO impide programar fases, completar integraciones y crear/ejecutar tests con fixtures,
exchange simulado, reloj inyectado, temporales y simulación de fallos.

Trabaja primero en el código del bloque y crea sus tests. Agrupa las ejecuciones para el
FINAL de cada bloque publicable, no después de cada cambio. Ejecuta también una regresión
global al final del trabajo. No pospongas indefinidamente los tests ni publiques un bloque
como validado si no corrieron. Si el entorno impide ejecutarlos, registra NO_EJECUTADOS;
no confundir test escrito con test aprobado y no dar la fase por validada.

No ejecutar replay con datos reales, entrenamiento, backtest económico, soak ni canary.
Completa el tooling de fase 10 y sus tests sintéticos. Deja un comando documentado y
esquema de entradas para cuando tengamos los datos; el estado será PENDIENTE_DATOS_REALES,
no rentable, aprobado, NO_EDGE o listo para LIVE.

No detener todo el trabajo por falta de datasets, supervisor externo o presupuesto
aprobado: termina los contratos, módulos y tests independientes. Una decisión pendiente
del propietario debe quedar explícita y conservadora; no inventes su respuesta.

## 3. Invariantes obligatorios

- Publicar código NO autoriza arrancar o desplegar. No main.ts, PM2, órdenes Binance,
  testnet operativo, servicios LIVE, credenciales ni cambios de YAML LIVE.
- Micro conserva su salida inteligente: stop obligatorio, sin TP obligatorio ni trailing.
  No trasplantar a Micro las salidas de Aegis ni modificar su estrategia bajo un refactor.
- OFF/SHADOW/ENFORCE deben mantener contratos explícitos: observar no es ejecutar.
  Deshabilitar entradas no deshabilita protección de posiciones reales existentes.
- Existe supervisor interno versionado. Reutilizarlo; no asumir que el externo está
  ausente o que nos garantiza cobertura universal sin evidencia.
- Desconocido no equivale a cero, flat, protegido ni PnL verificado. Sólo null conforme
  al contrato y evidencia suficiente pueden participar en confirmación de flat.
- No borrar marketOpenAmbiguous porque reaparezca un stop. Protección, ejecución,
  propiedad y contabilidad son estados diferentes.
- Una respuesta perdida puede corresponder a una orden ejecutada: consultar/reconciliar
  identidad estable antes de cualquier reenvío. No prometer exactly-once del exchange.
- Nunca cancelar órdenes ajenas, invertir una posición al intentar cerrarla ni crear
  métricas BOT para una posición manual/de propiedad incierta.
- Conservar límites y autoridad LIVE actuales. No cambiar 0.9 por 0.09, thresholds,
  apalancamiento o hashes aprobados para hacer pasar un test o habilitar entradas.
- No eliminar assertions, añadir skips, hacer mocks excesivamente permisivos ni cambiar
  digests a ciegas. Un checkpoint de fuente no es autorización de modelo o producción.
- No acceder a otras ramas experimentales (por ejemplo SUI Scout) ni integrarlas aquí.
- Respetar denegaciones de herramientas/permisos; no repetir la acción mediante otro
  mecanismo para eludirlas. Pedir dirección si falta autoridad.

## 4. Avances existentes que debes preservar

En fbc7f19 se corrigió el lease compartido: cada reserva tiene token y release propio;
una reserva antigua no libera la siguiente. Se reintentan lecturas transitorias de stops.
TradingService registra tareas de entrada/gestión y las espera antes del flush de apagado,
manteniendo la adquisición síncrona del lock. El timeout externo de 15 s sigue sin
garantizar recuperación durable de todas las órdenes.

En c5d4f60:
- microStopSubmission se persiste y se hace flush antes del stop de reposición runtime.
  Una respuesta perdida no autoriza reenvío; el intento sobrevive reinicios.
- Tras 30 s sin confirmación y con lecturas disponibles, se solicita recuperación.
  Con lecturas fallidas continúa UNKNOWN. El plazo es inyectable.
- microProtectionBlocked es independiente de marketOpenAmbiguous y del PnL pendiente.
- MISSING se reconcilia sin indicadores: dos lecturas flat, limpieza sólo BOT,
  verificación de supervivientes y nueva lectura de posición.
- El cierre reconciliado queda IDLE con identidad conservada y PnL no verificado;
  eso NO autoriza nuevas entradas. La cuarentena cubre estados configurados/cargados.
- FsStateStore valida y conserva el registro de intento.

Nada de esto es aún journal general, inventario universal, lock distribuido o
contabilidad verificada. No marques fases enteras como cerradas por esos incrementos.

## 5. Orden y entregables de implementación

Fase 0 — Contratos y baseline:
Actualizar documentación incoherente, matriz estrategia/modo/propiedad y runner aislado.
Verificar el cableado real del supervisor. La evidencia externa queda pendiente sin
bloquear código. Mantener resultados históricos claramente separados del estado vigente.

Ciclo crítico fases 1/2/3 — Resolverlo por incrementos verticales:
Primero journal y contratos de ejecución/recovery; después completar el supervisor,
inventario, reservas y arranque/apagado. No construir tres autoridades paralelas.

Fase 1 — Supervisor común:
Separar seguridad del scheduler/indicadores de estrategia. Recorrer posiciones de cuenta
y estados persistidos, incluidos símbolos retirados/OFF. Identificar propietario y
política antes de actuar; validar lado, hedge/BOTH, cantidad, filtros, trigger y cobertura.
Ampliar puertos/adaptadores para identificar órdenes de protección, confirmar por ID y
reconciliar visibilidad tardía. Conservar protección útil al reemplazar. Persistir
UNKNOWN/RECOVERY_REQUIRED y recuperación de cierres. No cerrar a ciegas por un timeout.
Extender contratos a Aegis/Momentum/manual sin aplicar TP/trailing a Micro.
Tests: ausencia de contexto, stop tardío/parcial/ajeno, reinicio, modos, filtros,
rechazos, respuesta perdida, cierre fallido y posición que reaparece.

Fase 2 — Admisión y exposición:
Un snapshot de cuenta completo con estado COMPLETE/PARTIAL/UNKNOWN y timestamp.
Incluir posiciones fuera de configuración y órdenes/intenciones pendientes; deduplicar
por símbolo/positionSide sin contar BOTH dos veces. Validar números y unidades.
Reservar margen/riesgo antes de enviar; conservar la reserva si el resultado es incierto.
Revalidar dentro del lock inmediatamente antes del envío. Definir un único escritor por
cuenta: un lock local no excluye otros hosts; documentar el alcance y usar fencing o
infraestructura adecuada si hay más de un proceso. No implementar takeover sólo por TTL
sin impedir que el escritor anterior siga enviando.
Tests: dos estrategias/símbolos, doble escritor, lease antiguo, NaN, cuenta parcial,
timeout de envío, presupuesto retenido, restart y exposición externa.

Fase 3 — Journal y recuperación:
Persistir identidad/intención antes de aperturas, stops y cierres; IDs estables y eventos
versionados. Cubrir PREPARED, SUBMITTED, OPEN_CONFIRMED, PROTECTED, CLOSE_PENDING,
CLOSED y estados UNKNOWN/RECOVERY_REQUIRED. Reconciliar al arrancar antes de habilitar
admisión; no perder propiedad ni presupuesto pendiente.
Completar tareas activas, agotamiento del plazo de apagado y errores de escritura.
No suponer que fsync de un archivo es transacción con Binance. Una falla de disco debe
bloquear nuevas entradas sin eliminar la obligación de proteger posiciones existentes.
Tests: fallos en cada frontera de persistencia/envío/acuse, respuestas perdidas, disco,
reinicio repetido y apagado durante ejecución. Usar simulación, no matar procesos LIVE.

Fase 4 — Reconciliación contable:
Reemplazar verificación débil basada sólo en que existe algún fill. Ampliar TradeFill y
puertos para IDs únicos, positionSide, paginación y evidencia de comisiones/funding
según el contrato. Correlacionar órdenes y cantidades de apertura/cierre, deduplicar,
verificar totalidad y convertir costes a moneda común con evidencia.
Separar cierre operativo de ACCOUNTING_PENDING/VERIFIED. Persistir resultado y ledger
idempotente para aplicar rachas/límites diarios una sola vez incluso tras reinicio.
Liberar cuarentena sólo por reconciliación verificable, no borrando flags.
Tests: más de 100 fills, parciales, duplicados, fills tardíos, hedge opuesto, comisión
no USDT, funding desconocido, medianoche y doble aplicación del mismo cierre.

Fase 5 — Datos:
Conectar un contrato de integridad común ANTES de indicadores, preservar orden original,
validar cadencia, OHLCV, cierre/frescura, reloj y sincronía BTC/ETH/símbolo.
Usar adaptadores explícitos para formatos diferentes; no exigir campos inexistentes
sin conversión documentada ni ordenar/rellenar silenciosamente.
Tests: candle abierto, gap, dato viejo recibido ahora, futuro, NaN, duplicados y desfases.

Fase 6 — Identidad/configuración:
Corregir hash efectivo ignorado y separar artefacto/build, contenido de estrategia y
manifiesto aprobado, sin hash circular. Canonicalización determinista y diferencias
sanitizadas. Config no aprobada deniega entradas, mantiene gestión de posiciones previas.
No aprobar manifiestos LIVE ni falsear el SHA del despliegue.
Tests: claves reordenadas, parámetro cambiado, manifiesto ausente y posición de versión previa.

Fase 7 — Régimen:
Verificar autoridad legacy runtime frente a V2 offline. Corregir EMA mid/slow, pendiente
real de EMA, ventanas configuradas y frescura. Mantener ADX Wilder común y validación.
Una autoridad de política; workflow no reinterpreta metadata ni revive filtro SHORT.
Resolver semántica de regime_context informativo y modos sin activar un veto inesperado.
Una migración de clasificador/política necesita contrato y paridad; no autoactivar LIVE.
Confidence heurística no es probabilidad calibrada.
Tests: ventanas efectivas, contexto inválido/ausente, modos y spies del puerto de ejecución.

Fase 8 — Riesgo y ejecución:
Terminar motor puro parametrizado de sizing por pérdida al stop + costes, límites de
margen/notional y filtros. Revalidar quote fresco, antigüedad original, geometría y fill.
Usar presupuestos sintéticos sólo en tests; dejar aprobación/activación real pendiente.
No cambiar los valores LIVE vigentes ni inventar cuánto acepta perder el propietario.
Tests: stops cercanos/lejanos, ambos lados, spread, minNotional, redondeo y señal caducada.

Fase 9 — Arquitectura:
Extraer de TradingService admisión, supervisión, reconciliación, journal y shutdown
con puertos tipados y ownership claro. El código debe quedar cableado, no sólo en tooling.
Conservar contratos externos y paridad de decisiones/intenciones bajo mismos inputs.
Evitar duplicaciones transitorias permanentes, any y ciclos de dependencias.

Fase 10 — Tooling, no rentabilidad:
Implementar loaders/esquemas, CLI, replay causal, comparación ON/OFF en población idéntica,
costes, completitud de horizontes, deduplicación de episodios, splits temporales, métricas
e incertidumbre por bloques. Separar episodios independientes de simulación de cartera.
Fixtures sintéticos demuestran mecánica y ausencia de lookahead; no edge económico.
Entradas faltantes deben producir PENDING_REAL_DATA/INSUFFICIENT_DATA sin números
inventados. Dejar README con formato, comando, salidas y procedimiento para evaluación real.

## 6. Esquema del ciclo seguro

    admisión:
        comprobar escritor autorizado y recovery/contabilidad pendientes
        adquirir reserva; obtener snapshot COMPLETE
        validar política vigente y reservar presupuesto
        persistir intención PREPARED con clientOrderId estable; flush
        enviar una vez
        si resultado incierto: persistir UNKNOWN; conservar reserva; reconciliar
        si confirmado: persistir identidad y ejecutar protección del propietario

    supervisión:
        cargar posiciones + estados + journal
        separar error de lectura de ausencia confirmada
        si abierta: confirmar protección / recuperar según evidencia y plazo
        si flat: confirmar, limpiar sólo órdenes propias y verificar supervivientes
        persistir cierre operativo; reconciliar contabilidad por separado

    contabilidad:
        paginar y atribuir fills; comprobar cantidades y costes
        si incompleto: conservar ACCOUNTING_PENDING
        si completo: persistir resultado y aplicar ledger idempotente
        liberar sólo las cuarentenas/reservas cuya causa esté resuelta

    arranque/apagado:
        arrancar sin admisión hasta reconciliar journal y escritor
        apagar productores; drenar tareas; conservar intenciones inciertas; flush
        timeout no equivale a operación cancelada ni a cierre confirmado

Adapta nombres al código existente. Este pseudocódigo fija invariantes, no autoriza
inventar garantías o duplicar servicios que ya resuelven una parte.

## 7. Validación y publicación al final de cada bloque

Crear tests de comportamiento en las implementaciones reales además de tests puros:
llamadas/prohibiciones al exchange simulado, estado persistido, restart y concurrencia.
Nada de asserts que sólo comprueban nombres de clases o logs.

Al terminar el bloque:
- Formatea sin cambios masivos ajenos.
- Ejecuta npm run test:safety: incluye build, grupo principal con REGIME_CONFIG,
  ConfigLoader sin esa variable y git diff --check.
- No sustituirlo por un npm test sin el entorno que requiere el repositorio.
- Si necesitas dependencias, usa lockfile y el mecanismo autorizado; no arrancar el bot.
- Corrige regresiones antes de publicar. Si una prueba necesita realmente datos ausentes,
  sepárala de las sintéticas y registra exactamente qué evidencia falta.
- Revisa el diff final, archivos nuevos, secretos, fixtures, digests y wiring.
- Haz commits por responsabilidad, con mensajes claros. Actualiza los tres documentos
  de estado/validación y el prompt si cambian contratos. No subir logs/datasets privados.
- Fetch antes de publicar; push normal a la misma rama. No overwrite ni force.
  Verifica que el SHA remoto contiene lo que afirmas haber publicado.
- Si falla acceso o autorización, conserva el trabajo y reporta el bloqueo; no eludirlo.

## 8. Autonomía, trazabilidad y entrega final

No pedir confirmación entre tareas técnicas ordinarias ni terminar tras una pequeña
corrección si quedan trabajos seguros y accionables. Continuar con las dependencias
siguientes. Publicar avances verificables para nuestra evaluación, sin esperar revisión
para avanzar en tareas independientes. No trabajar en segundo plano después de afirmar
que terminaste ni prometer continuaciones que no estés ejecutando.

Mantener en el handoff una tabla por fase con:
IMPLEMENTACION (pendiente/parcial/completa), TESTS (creados/ejecutados/fallidos),
VALIDACION_REAL (pendiente datos/operador/no aplica), COMMIT y SIGUIENTE_PENDIENTE.

Al finalizar: todas las partes implementables sin datos ni nuevas autorizaciones deben
quedar terminadas, con tests y documentación. No basta con checklists o stubs. Si una parte
no se completa, enumerar archivo, motivo y siguiente paso exacto; no ocultarlo bajo
“todas las fases terminadas”. La evidencia económica y la aprobación LIVE seguirán aparte.

Reporta en español y al grano cada bloque: qué cambió, fases cerradas/parciales,
tests ejecutados y no ejecutados, commit local/remoto, límites y siguiente tarea.
Distingue SIEMPRE implementado, probado, publicado y desplegado.
