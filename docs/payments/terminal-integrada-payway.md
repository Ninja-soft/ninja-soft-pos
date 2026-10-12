# Terminal integrada Payway: posnet y pinpad conectados a la caja · relevamiento 2026-10

> Fecha: 2026-10-12. Decisión resultante: ADR-053. Objetivo del dueño: "lo que quiero es que la terminal cobre y envíe los datos al POS, ya sea posnet o pinpad". Alcance acordado: **posnet Payway clásico** (countertop o móvil, por ejemplo PAX S920, Ingenico Move/Desk) por cable (serie o USB) o por red local, y **pinpad Payway** conectado a la PC. La **Payway Smart (Android)** queda fuera de alcance (ver §4). Getnet en [`terminal-integrada-getnet.md`](terminal-integrada-getnet.md).
>
> Notación: **[V]** verificado en la fuente enlazada; **[I]** inferido o sin confirmar.

## Resumen

1. **Existe el "POS Integrado" de LaPos / Payway por cable** y lo usan sistemas de gestión del mercado (Tango, Maxirest y otros): la terminal se pone en "Modo POS Integrado", la caja le manda venta, anulación, devolución y cierre de lote, y la terminal devuelve el cupón [V].
2. **El protocolo en el cable no es oficialmente público**, pero hay **dos fuentes públicas no oficiales** con licencia MIT que lo describen: el protocolo "VPI PC" (IngStore) a 19200 8N1 con tramas STX / ETX / LRC, comandos de 3 letras y campos de ancho fijo [V las fuentes; I su vigencia]. NinjaPOS implementa ese formato como **adaptador `unverified`** (sin homologar).
3. **Pinpad (Lane/3000):** Payway lo ofrece "conectado a una PC o ECR" por USB o RS-232 [V], pero **no hay nada público** del protocolo entre la PC y el pinpad; hay que pedirlo [I: puede ser el mismo VPI o requerir middleware de Payway].
4. **Payway tiene además una API cloud "PayStore Terminals"** (REST, OAuth2, sandbox, con homologación obligatoria) para mandar el cobro a la terminal sin cable, a través de la app MobiTEF. Cubre la Smart; si cubre la Classic **no está confirmado** [V la API; I la cobertura].
5. **Qué se hizo:** base vendor-agnóstica en el navegador (Web Serial, WebUSB y puente local), simulador de punta a punta, adaptador Payway VPI según las fuentes públicas, placeholders Fiserv y Getnet, registro por caja, bitácora y validación en el servidor del cupón informado por la terminal (ADR-053).

## 1. Payway / LaPos "POS Integrado" por cable

### Que existe y cómo se usa (verificado en integradores)

- Manual de Tango "Tesorería Tarjetas, POS Integrado" [V] <https://net.axoft.com/images/asistencia/tesoreria/Tesoreria_Tarjetas_Modalidad-POS-Integrado.pdf>:
  - "Comunique a LaPos que desea trabajar en forma integrada con Tango, para que le suministren una terminal POS preparada para trabajar conectada a una computadora a través de un cable USB."
  - En la terminal: "Más" (o Menú), "Funciones", **"Modo POS Integrado"**.
  - "Cuando la Terminal POS esté operando en modo integrado, sólo podrá realizar operaciones desde el sistema Tango... Venta, Anulación, Devolución y Cierre de lote debe efectuarlas desde Tango."
  - Del lado del cajero se evita cargar "número de tarjeta, vencimiento, número de cupón, código de autorización"; del lado de la terminal, "número de comprobante, plan, cantidad de cuotas e importe".
  - Para Posnet (Fiserv) la terminal necesita la aplicación "TRANSACT", configurada por personal de Posnet.
- Ayuda de Tango "Terminales POS" [V] <https://ayudas.axoft.com/24ar/ayudas/sb/archivos_carp_sb/tarjetas_carp_sb/erminalespos_sb/>: tipos "LaPos", "Payway", "Posnet" o "Externo"; "Aunque el POS utilice un conector USB, indique el puerto COM que emula la conexión USB" (COM1 a COM256); se indica una **versión de protocolo**; en Payway las tablas de tarjetas y hosts se cargan a mano porque "por una limitación de Payway esa información no puede ser recuperada de la terminal".
- Novedad de Tango, diciembre 2021 [V] <https://ayudas.axoft.com/novedades/fecha_carp_nov/fechadiciembre_carp_nov/diciembre_t20_nov/gv_diciembre2021_2_nov/>: "Sumamos al equipo PAXs 920 a nuestra lista de dispositivos con los que nos integramos" y "Tango registra automáticamente los datos del cupón".
- Página de terminales de Payway [V] <https://www.payway.com.ar/terminales-punto-venta>: "Contamos con terminales integradas y dispositivos PINpad que se conectan a tu sistema de gestión". Partners que lo anuncian [V] <https://www.payway.com.ar/partners-0> (Tango, Maxirest, Napse, Hasar, Dragonfish, Flexxus, entre otros).

**[I]** Con eso, una Payway Classic (PAX S920) en "Modo POS Integrado" se ve en la PC como un **puerto COM virtual por USB**. Eso es exactamente lo que Web Serial puede abrir desde Chrome.

### El protocolo "VPI PC" (fuentes públicas no oficiales)

- `vpipc.c` en <https://github.com/gsaracca/LaPos> (MIT) [V]: "la comunicación utilizando el protocolo IngStore, entre una PC y un POS Ingenico con la aplicación de VISA con POS Integrado". Puerto "19200 bps, 8 bits, sin paridad, 1 bit de parada". Funciones `vpiPurchase`, `vpiVoid`, `vpiRefund`, `vpiRefundVoid`, `vpiBatchClose`, `vpiGetLastTrxData`, `vpiGetBatchCloseData`, `vpiGetIssuer`, `vpiGetPlan`, `vpiTestConnection`. Entrada de la venta: monto x100, número de factura, cuotas, código de tarjeta, código de plan, propina, código de comercio, razón social, CUIT y online/offline. Salida: código y mensaje del host, autorización, cupón, lote, nombre del titular, primeros 6, últimos 4, fecha, hora, id de terminal. Códigos de retorno (101 tarjeta inexistente, 201 cancelada por el usuario, 202 tarjeta distinta a la pedida, 301 sin comunicación con el host, 909 error general, etc.). Timeouts de 3, 10 y 60 s. **Ojo:** ese repo incluye `vpipc.dll` e `ingstore.dll` "provistas por el fabricante": no se usan ni se redistribuyen.
- `webserial-lapos-integrado` <https://github.com/leonelvsc/webserial-lapos-integrado> (MIT, 2022, npm 1.0.3) [V, leído el código]:
  - Web Serial con `requestPort({ usbVendorId: 0x1234, usbProductId: 0x0101 })` y `open({ baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none" })`.
  - Pedido: primero el byte **ENQ (0x05)** y después `STX, comando (3 ASCII), largo (2 bytes, little-endian), datos, ETX, LRC` con LRC = XOR de todo lo que sigue al STX, ETX incluido.
  - Respuesta: `STX, comando (3), status (3 ASCII), largo (2, LE), datos, ETX`; la PC contesta **ACK (0x06)**. Status "001" = hay más registros, "000" = último.
  - Comandos: `VEN` venta, `ANV` anulación, `DEV` devolución, `AND` anulación de devolución, `CIE` cierre, `ULT` última transacción, `TAR` tarjetas, `PLA` planes, `TES` prueba.
  - `VEN`: monto 12 (centavos), factura 12, cuotas 2, código de tarjeta 3, plan 1, propina 12, comercio 15, razón social 23, CUIT 23, online 1 byte.
  - Respuesta de transacción por posición: código 0 a 2, mensaje 2 a 34, autorización 34 a 40, cupón 40 a 47, lote 47 a 50, titular 50 a 76, últimos 4 76 a 80, primeros 6 80 a 86, fecha 86 a 96, hora 96 a 104, terminal 104 a 112. `ULT` antepone 1 byte de tipo (1 venta, 2 anulación, 3 devolución, 4 anulación de devolución).

**Lo que NO está confirmado [I]:** que Payway acepte integraciones nuevas sobre este protocolo; que sea el mismo en la Classic actual (PAX S920) y en el Lane/3000; el VID/PID USB (0x1234/0x0101 es de un equipo Ingenico LaPos de 2022); si la respuesta trae LRC (la librería no lo lee); el significado exacto del status de 3 dígitos fuera de "000"/"001"; que "00" en el código de host sea "aprobada" (convención ISO 8583); la tabla de códigos de tarjeta (Payway no la deja leer de la terminal).

### Cómo lo implementa NinjaPOS (adaptador `PaywayAdapter`, estado `unverified`)

- `lib/payments/terminal/adapters/payway.ts`: implementación propia del formato descripto (no se copió código). Arma `VEN`, `ANV`, `DEV`, `CIE`, `ULT`, `TES`; decodifica **por largo** (no por ETX: el largo binario puede valer 0x03) y acepta respuesta con o sin LRC; ACK automático; marca por BIN si la terminal no la informa.
- El protocolo pide el **código de tarjeta** antes de pasarla: el POS muestra las marcas y el código sale de la tabla que el dueño carga en Configuración, Terminales (la da Payway).
- Timeout de la terminal "sin respuesta" = estado incierto: el POS ofrece **"Consultar la terminal"** (`ULT`) para recuperar el cupón antes de reintentar.

## 2. Pinpad Payway (Lane/3000)

- Manual unificado de Payway [V] <https://payway-com-ar.s3.amazonaws.com/Manuales_Unificados_Uso_De_Terminal_Payway.pdf>: N910 (Smart), Lane/3000 y S920. "Lane/3000 es un PINPad... diseñado para aceptar pagos utilizando tarjetas con banda magnética, chip o contactless, así como para la validación de contraseñas (PIN), conectado a una PC o ECR. Utiliza la tecnología Telium Tetra"; conector "para cable de comunicación (USB, Serial RS232, etc....)".
- **No hay protocolo, SDK ni DLL públicos** del Lane/3000 para Payway [V la búsqueda; I la conclusión].
- **[I]** Dos escenarios posibles, a confirmar: (a) el pinpad corre la misma aplicación integrada (VPI) y habla con Payway por su cuenta (el POS sólo manda monto y recibe el cupón: es lo que NinjaPOS soporta); (b) el pinpad sólo lee la tarjeta y la PC tiene que hablar con el autorizador, lo que mete a la PC en alcance PCI y exige middleware y certificación de Payway (NinjaPOS **no** debe manejar datos de tarjeta).
- Del lado del navegador da igual el cable: el pinpad por USB-CDC o RS-232 se abre con Web Serial; si Windows lo ve como dispositivo USB sin puerto COM, con WebUSB; si el puerto lo tiene tomado un driver de Payway, con el puente local.

## 3. PayStore Terminals (API cloud de Payway)

- Catálogo del portal de desarrolladores [V] (`https://portal.developers.payway.com.ar/apiportal-api/products`): `paystore_terminals_payments_v1` ("flujo de pagos"), `paystore_terminals_reversals_v1`, `paystore_terminals_refunds_v1`, `paystore_terminals_settlements_v1` ("cierres de lotes") y `partners_merchant_administration_v1` ("solicitar el alta de Terminales"). Todas con OAuth2 y `requireHomologation: true`.
- Documento funcional [V] <https://apiportal-docs.s3.amazonaws.com/vertical_payment_platform/documentacion/Paystore_Terminals_docFuncional_v1.1.pdf>: "Solución wireless con interfaz de comunicación API REST... Ambiente de sandbox autogestionable"; "1 caja ECR + 1 POS" o "+ N POS"; la "APP" (MobiTEF) en la terminal hace de intermediaria.
- OpenAPI [V]: sandbox `https://api-sandbox.payway.com.ar/v1/paystore_terminals/terminal_payments`; `POST /payments`, `GET /payments/{id}`, `PUT /payments/{id}/cancellations`, `POST /settlements`. Respuesta con `payment_status`, `card_brand`, `last_four_digits`, `transaction_receipt` (cupón), `batch_number`, `authorization_code`, `installments_number`.
- **[I]** Cubre la Smart (N910). La S920 aparece como "POS tradicional" en la lista de PayStore Brasil [V] <https://www.paystore.com.br/en/terminais-compativeis>, así que quizá cubra la Classic: preguntar. No sirve para un pinpad por cable. Si cubre la Classic, sería la vía **sin cable y sin puente** (como Clover, ADR-047) y conviene evaluarla junto con el VPI.

## 4. Payway Smart (Android): fuera de alcance

Terminal Android (Newland N910). Su vía integrada es PayStore Terminals (§3) o una app propia en la terminal (App2App). No se relevó más por pedido del dueño.

## 5. Fiserv / Posnet integrado

- Sólo hay público que la terminal Posnet necesita la aplicación "TRANSACT" para hablar con la PC, configurada por Posnet (manual de Tango, §1) [V]. No hay especificación ni código abierto [V la búsqueda]. Adaptador `FiservPosnetAdapter` como placeholder (conexión física sí; operaciones `spec_pending`). Para Clover la vía es Cloud Pay Display (ADR-047).

## 6. Qué es público y qué requiere el kit

| Tema | Público | Requiere a Payway |
|---|---|---|
| Que existe el modo integrado y cómo se activa | Sí (Tango) | |
| Puerto 19200 8N1, ENQ, STX/ETX/LRC, comandos y anchos de campo | Sí, de fuentes **no oficiales** | Confirmación oficial y versión vigente |
| VID/PID USB de S920 y Lane/3000, driver COM | No | Sí |
| Tabla de códigos de tarjeta y planes | No (no se lee de la terminal) | Sí |
| Códigos de respuesta y status | Parcial (vpipc.c) | Tabla oficial |
| Protocolo del pinpad Lane/3000 | No | Sí |
| PayStore Terminals (REST) | Sí (OpenAPI, sandbox) | Credenciales, homologación, cobertura de la Classic |
| Homologación / certificación | No | Sí |

## 7. Qué pedirle a Payway (posnet integrado y pinpad)

Canal: ejecutivo comercial o Atención a comercios 0810 222 4440 (el número de la página de PINpad), Ventas 0810 333 0066; registrarse además en <https://developers.payway.com.ar> (abre una oportunidad comercial). No hay un mail público de integradores.

1. **Especificación oficial del protocolo "POS Integrado" (VPI PC / IngStore)**, versión vigente, para la **Payway Classic** (S920 y otros modelos clásicos que entreguen, como Ingenico Move/Desk) y para el **pinpad Lane/3000**. Confirmar si se puede hablar el protocolo directo por el puerto (Web Serial desde el navegador) o si es obligatoria su DLL (`vpipc.dll` / `ingstore.dll`) u otro middleware.
2. **Modelos soportados** en modo integrado, **VID/PID USB** de cada uno, si el USB es CDC (puerto COM) o necesita driver, y si alguno se integra por **red (TCP)** con su puerto.
3. **Pinpad:** ¿el Lane/3000 corre la aplicación integrada y habla solo con Payway (el POS manda monto y recibe el cupón), o la PC tiene que conectarse al autorizador? ¿Qué obligaciones PCI / EMV caen sobre el software en cada caso? ¿Hay otros pinpads homologados (Ingenico iPP / Lane, Verifone)?
4. **Homologación:** proceso, guion de pruebas, plazos, costo, quién aprueba, si se certifica por versión del software y si una web app (Chrome) es aceptable.
5. **Kit de pruebas:** terminal y pinpad de prueba con la aplicación integrada apuntando a un host de prueba, **tarjetas de prueba** (débito, crédito, chip, contactless, con PIN), número de comercio y de establecimiento de prueba, **tabla de códigos de tarjeta y de planes**, tabla de **códigos de respuesta** y de status.
6. **Operaciones:** venta con cuotas y planes (Cuota Simple, etc.), anulación, devolución, anulación de devolución, cierre de lote con totales por tarjeta (formato de `vpiGetBatchCloseData`), **última transacción para recuperar un timeout**, reimpresión, QR dentro del modo integrado, propina y cash back.
7. **PayStore Terminals:** ¿sirve para la Classic o sólo para la Smart? ¿Qué cambia comercialmente? Credenciales de sandbox y de homologación.
8. **Contrato:** requisitos para ser Payway Partner, costos, derechos sobre DLL o SDK, contacto técnico formal, y cómo pide el comercio que su terminal quede en "Modo POS Integrado".

## 8. Qué funciona hoy (sin el kit)

- **Simulador de punta a punta:** en Configuración, Terminales se da de alta una terminal Payway (o Fiserv, Getnet) tipo "Posnet integrado" o "Pinpad" con protocolo "Simulador", se prueba la conexión y una venta de prueba; en el POS, "Tarjeta en terminal" manda el monto, muestra la espera, aprueba (o rechaza con motivo, o no responde según los centavos: ,51 fondos insuficientes, ,05 no autorizada, ,91 cobra y no responde, ,96 corte), registra la operación en la bitácora y el pago con el cupón completo (lote, cupón, autorización, marca, últimos 4, cuotas, comercio, adquirente). El servidor valida ese cupón contra la bitácora.
- **Conexión física real:** emparejar un dispositivo por Web Serial o WebUSB, o el puente local (`tools/bridge`) por COM o TCP, y "Probar conexión" (`TES` en Payway).
- **Payway con una terminal real:** el adaptador VPI está listo para probarse con una Classic o un pinpad en modo integrado; hasta validarlo con Payway se marca "sin homologar" y conviene una venta chica y su anulación.
- **Respaldo:** desde el cobro con terminal siempre se puede pasar a "Tarjeta en posnet" y cargar el cupón a mano.
