# Journal: correccion de durabilidad e identidad

## Referencia y alcance

- Base historica: `19f4678359c7217273cb759c9cd030c2d4680a02`.
- Rama: `work/micro-burst-rider-v1-20260826`. Este almacenamiento fue PUBLICADO en
  `7d4c1605f2559c51b3f4d4e4f79002191734588a`, confirmado mediante fetch remoto
  durante la continuacion de datos/sizing. Las referencias anteriores a LOCAL quedaron obsoletas.
- 19f4678 incorporo JSONL y carga en constructor, pero la auditoria propia reprodujo
  fallos de lock, persistencia parcial/incierta, contadores, identidad y copias.
- Este bloque corrige esos contratos en `src/core/risk/ExecutionJournal.ts` y su test.
  No reemplaza servicios ni cambia composicion runtime, configuracion o aprobaciones.
- Los cuatro fallos historicos R1-R4 y el seguimiento de identidad del supervisor/
  migracion del ledger siguen corregidos y publicados mediante 2966821.

## Contrato de datos

- `JournalInput` excluye campos calculados. El journal asigna `schemaVersion: 1`,
  revision `version` por operacion y `sequence` global, empezando en 1.
- Validacion e indices son comunes a memoria, escritura y replay. Una entrada
  invalida no consume revision/secuencia, no aparece en indices y no toca los bytes.
- `operationId` es globalmente unico dentro del journal. Su cuenta, entorno, simbolo,
  lado y estrategia no pueden cambiar. Otra operacion del mismo simbolo usa otro ID.
- Event ID es globalmente unico. Duplicado con payload canonico identico devuelve
  el registro original; el mismo ID con otro dato es conflicto, incluso con igual evento.
- Client ID se vincula a operacion dentro de cuenta/entorno. No se reutiliza en otra
  operacion del mismo scope, ni se contradicen cantidades, precios, leverage u orderId
  conocidos. Campos opcionales ausentes pueden enriquecerse, no sobrescribirse.
- Los campos numericos de ejecucion presentes deben ser finitos y positivos;
  timestamps son enteros no negativos hasta fin de 9999 UTC. Metadata debe ser JSON
  plano y finito: sin ciclos, getters, funciones, Date o coerciones con perdida.
- Orden de claves no altera idempotencia; input y todas las consultas tienen copias
  profundas, incluidos scope, arrays y metadata anidada.

## Estados y evidencia

- Solo PREPARED inicia una operacion. CLOSED es terminal y nunca vuelve a PREPARED.
- UNKNOWN/RECOVERY_REQUIRED no reinician una intencion como si nunca se hubiera enviado.
- PREPARED, SUBMITTED y OPEN_CONFIRMED pueden pasar a CLOSE_PENDING sin fabricar
  un PROTECTED previo: permite registrar un cierre temprano de emergencia.
- PREPARED sigue pendiente al reconstruir. `isSubmitted` es un indice historico de
  ACKs SUBMITTED, no una autorizacion: false no permite enviar/reintentar; true no
  demuestra posicion abierta ni atribucion actual. Es una consulta sin scope, sobre
  el conjunto del journal; recovery debe usar la operacion y su evidencia completa.
- Las transiciones registran evidencia declarada por el caller. El journal no consulta
  el exchange ni certifica que un ACK/proteccion/flat sea real. CLOSED no verifica PnL.
- Este almacenamiento no modela por si solo todos los intentos de stop/cierre ligados
  a un trade. El protocolo de mutaciones y su atribucion deben definirse en la
  integracion posterior, conservando identidades distintas sin resetear operaciones.

## Persistencia y propiedad

- API asincrona con implementacion sincronica de fs: cada operacion se linealiza
  antes de devolver su Promise. No hay cola de escrituras asincronas oculta.
- Directorio padre existente obligatorio. Se resuelve su ruta real para que aliases
  como /var y /private/var compartan lock. No se crean arboles de directorios.
- Se rechazan symlinks y hardlinks del archivo de datos. Descriptor persistente
  O_APPEND/O_RDWR/O_NOFOLLOW; solo se escribe en el archivo bajo propiedad validada.
- Lock exclusivo `wx` ANTES de cargar datos; token aleatorio, PID e identidad de inode.
  Lock vacio, ilegible, antiguo o con PID muerto NO autoriza takeover ni se elimina.
- Escritura de Buffer en bucle hasta completar todos los bytes; progreso cero/invalido
  o error aborta. File fsync antes de publicar el evento y los indices en memoria.
- File fsync y directory fsync al crear las entradas de filesystem. Replay tambien
  estabiliza el descriptor con fsync antes de ofrecer datos recuperados al caller.
- Ante incertidumbre I/O se bloquean append, read, pendientes, isSubmitted y flush:
  no se devuelve un vacio que pueda confundirse con ausencia de ejecucion.
- Close bloquea admision y cierra recursos; propaga fallos incluso si logra liberar
  su lock. Si falla el cierre del descriptor de datos, conserva el lock. Nunca
  elimina otro inode/token. Un close sano repetido es idempotente.
- Reapertura explicita bajo lock valida bytes, schema, identidad, secuencias y
  transiciones. No hay truncamiento automatico de la ultima linea ni reparacion
  silenciosa. Linea sin LF final, vacia, corrupta o UTF-8 invalido se rechaza.

Alcance: procesos cooperativos sobre un filesystem local con las primitivas POSIX
usadas, probado aqui en macOS. No es fencing multihost/NFS ni defensa ante un operador
que modifique archivos/locks de un writer vivo. No se promete atomicidad de una linea
frente a crash: se promete no afirmar exito ante escritura incompleta, y rechazar una
cola incompleta en recovery. fsync no es una transaccion con Binance ni certificacion
de supervivencia a todo fallo de hardware.

## Formato anterior y recuperacion

- Los JSONL sin schemaVersion de 19f4678 y arrays antiguos se rechazan sin modificar
  sus bytes. No existe migracion implicita o atribucion sintetica. No apuntar un
  journal nuevo a archivos operativos antiguos para intentar "hacerlo arrancar".
- No se encontro consumidor runtime del nuevo journal. Por ello no se implemento
  un importador especulativo; si aparecen archivos que deban conservarse, su migracion
  requiere un contrato explicito y evidencia de identidades, no rellenar campos.
- Tras crash puede quedar lock huerfano. La recuperacion operativa debe detener y
  verificar TODOS los writers del scope, preservar archivo/lock y resolver propiedad
  fuera del proceso antes de una reapertura. Este bloque no automatiza ese procedimiento
  ni autoriza borrar locks o reparar archivos de produccion.
- Si fallo fsync despues de escribir una linea completa, close sigue reportando error.
  Una reapertura puede recuperar ese evento: el caller no debe interpretar el fallo
  anterior como prueba de que la intencion no existio ni reenviarla a ciegas.

## Validacion propia

Comando ejecutado al final del bloque:

```sh
npm run test:safety
```

- Build TypeScript: PASS.
- Grupo principal: 182 archivos, 2.110 tests PASS.
- ConfigLoader separado sin REGIME_CONFIG: 1 archivo, 46 tests PASS.
- Total: 183 archivos, 2.156 tests PASS, cero fallos.
- Journal: 264 tests compartidos entre backends y especificos de filesystem.
- El total 1.937 y 45 tests del journal en 19f4678 era reporte del otro agente.
  El incremento neto respecto a ese reporte es 219; no una ejecucion propia del baseline.
- Se corrigieron expectativas antiguas inseguras (CLOSED/UNKNOWN -> PREPARED,
  takeover huerfano y cambio de scope) en vez de conservarlas como contrato.
- Pruebas reales: restart de instancias, fs temporal, write parcial/progreso invalido,
  error tras bytes/fsync, estado bloqueado, cierre fallido, corrupcion, lock durante
  creacion, aliases, lock reemplazado, dos procesos y crash de un child journal-only.
- Primera ejecucion: build PASS y tres fixtures de inyeccion no activados por comparar
  ruta alias /var con ruta canonica /private/var. Se corrigio el fixture con realpath;
  no se relajaron assertions. La segunda ejecucion global anterior paso completamente.
- Una revision independiente estatica no encontro fallos definitivos dentro del alcance
  local cooperativo. La compilacion y los resultados de ejecucion son propios del coordinador.

No se inicio el bot, main.ts, PM2, testnet operativo ni exchange real. El SIGKILL del
test alcanza solo al subprocess creado por ese test, que importa unicamente el journal.
No se cambiaron parametros, credenciales, modos LIVE, trailing o TP Micro.

## Estado y siguiente bloque

| Area | Implementacion | Integracion | Tests | Publicacion | Siguiente pendiente |
| --- | --- | --- | --- | --- | --- |
| Almacenamiento del journal | Contratos auditados corregidos | No runtime | EJECUTADOS_PASS | PUBLICADO 7d4c160 | Protocolo de mutaciones y recovery con evidencia exchange |
| Fases 1/2/3/4 | Parciales | Servicios actuales conservados | Regresion global PASS | Sin nueva activacion | IDs/receipts/lookup, reservas, recovery antes de admision, cierre y contabilidad |
| Fase 9 | No cerrada | Sin reemplazo masivo de TradingService | Sin nueva garantia de paridad | No aplica en este bloque | Consolidar arquitectura despues de integracion vertical probada |

Siguiente trabajo: ampliar contratos identificables de aperturas/stops/cierres y
conectar persist-before-send, recovery antes de admision y shutdown con fixtures del
flujo real. Preservar reserva bajo incertidumbre y distinguir cierre operativo de
ACCOUNTING_PENDING. No reemplazar directamente PositionProtectionService o
StrategyRiskSessionService por modulos con responsabilidades diferentes.

VALIDACION_REAL: PENDIENTE_OPERADOR/PENDIENTE_DATOS. DESPLIEGUE: NO_AUTORIZADO.
