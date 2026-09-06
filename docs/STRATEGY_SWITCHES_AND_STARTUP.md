# Desconexion Aegis e identidad de arranque

## Desactivar Aegis

Establecer en el entorno del proceso o su archivo .env seleccionado:

```dotenv
AEGIS_ENABLED=false
```

Sin esa variable, el default es true para conservar el comportamiento existente.
Tambien se admite 0 para apagar. Para volver a habilitar: AEGIS_ENABLED=true.
El cambio se aplica al siguiente arranque; no hay comando Telegram/hot reload nuevo.
Este documento no autoriza iniciar LIVE ni modifica ningun archivo de credenciales.

Con el interruptor apagado:

- No se evalua la entrada Aegis ni el scan Aegis SHADOW.
- No se solicita el warmup de predicciones al arrancar.
- No se crean productores/caches/observacion de Aegis en el coordinador runtime.
- ExitEye no consulta nuevas predicciones. La gestion protectora de posiciones
  existentes permanece separada del permiso de evaluar la estrategia.
- El cliente HTTP protege tambien llamadas auxiliares: predict/exit/health no
  hacen red. Su fallback defensivo indica aegis_disabled, no una prediccion real.
- Momentum y Micro conservan sus configuraciones y productores independientes.
  No se cambia su presupuesto, thresholds, stops ni politica de salida.

El enabled=false de la configuracion Aegis tambien evita sus evaluaciones y warmup
en TradingService. AEGIS_ENABLED=false es el corte de red adicional del cliente,
incluidas consultas auxiliares/manuales que lleguen a el.

## Identidad y Telegram

Cada arranque registra runtime_boot con platform, release, user y hostname obtenidos
de node:os. El usuario es el que ejecuta el proceso: en Ubuntu/systemd puede ser una
cuenta de servicio; en Docker, el usuario/host del contenedor, no necesariamente el
usuario de la maquina fisica. macOS se identifica como darwin y Ubuntu como linux;
release es la version del kernel, no la etiqueta comercial de la distribucion.

El resumen de arranque en Telegram muestra esos campos y las estrategias activas
con su modo. No incluye secciones de Aegis/Probe o Momentum cuando estan deshabilitadas.
Micro aparece si enabled=true y mode no es OFF. Si ninguna esta activa, informa
No active entry strategies; no se inventan estrategias activas por tener posiciones.

Se conserva el informe de posiciones existentes: desactivar entradas no debe ocultar
exposicion que aun requiere gestion. Los mensajes son texto plano y TelegramAdapter
aplica el escaping HTML existente. No se registran claves, firmas ni variables completas.
Hostname y usuario se enviaran al chat configurado: usar un destino autorizado.

Se implementa un unico resumen estructurado. Plantillas individuales por estrategia,
seleccion de uno o varios mensajes y controles Telegram en caliente quedan para otro
feature; no se simulan aqui ni se altera la notificacion de trades/incidentes existentes.

## Validacion

Ejecucion propia: npm run test:safety PASS, build y 2.354 tests principales
(190 archivos) + 46 ConfigLoader (1 archivo) = 2.400 tests, cero fallos.
Cobertura: cliente deshabilitado sin HTTP, startup/tick sin señales, productores
deshabilitados sin construccion, identidad OS con fallbacks y escaping Telegram,
resumen de estrategias activas. Regresion global de proteccion y recovery preservada.

No se arranco el bot, ni se enviaron mensajes Telegram/ordenes reales. Los archivos
LIVE y credenciales no se modificaron. Cambios locales pendientes de commit/publicacion.
