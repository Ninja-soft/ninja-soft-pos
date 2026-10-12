# Terminal integrada Getnet: posnet y pinpad conectados a la caja · relevamiento 2026-10

> Fecha: 2026-10-12. Decisión: ADR-053 (Payway primero; Getnet con adaptador placeholder). Ver también [`terminal-integrada-payway.md`](terminal-integrada-payway.md) y [`research-points-2026-10.md`](research-points-2026-10.md) §3.
>
> Notación: **[V]** verificado en la fuente enlazada; **[I]** inferido o sin confirmar.

## Qué hay público

- **Get POS Integrado (Getnet Argentina)** [V] <https://www.getnet.net/ar/ayuda/terminales-getpos/get-pos-integrado>: "Get POS Integrado es una solución que conecta tu sistema de gestión con la terminal de cobro de Getnet". Conexión por "conexión local (USB o Wi-Fi)" o "Cloud to Cloud (C2C)", con una "clave comercio". Contacto: comercios@getnet.com.ar.
- **Integrated POS (portal global)** [V] <https://docs.globalgetnet.com/en/products/in-store-payments/integrated-pos>: una "Integrated POS Library" más una "Connector App" en la terminal. Modos `CreateUsb` (serie), `CreateHttp` (Wi-Fi / Ethernet, host y puerto, ejemplo `Connector.CreateHttp("192.168.0.10", 8080)`) y `CreateCloud` (Cloud2Cloud, "no hostname or port is required"). Operaciones Sale, Refund, GetReports, PreAuth, Polling y Close. Respuesta: `Code` ("0" = éxito), `Message`, `CommerceCode`, `TerminalId`, `AuthorizationCode`, `Amount`, `AccountingDate`, `RealDate`, `SaleType`, `OperationMode`, `OriginalAmount`. Ejemplos sólo en C#; no dice países, modelos, cómo se obtiene la librería ni la certificación.
- **Integrador en producción** [V] <https://intercom.help/defontanaerp/es/articles/13789703-integracion-con-getnet>: Cloud to Cloud con "Credencial Cliente" y "Credencial Secreta" que entrega Getnet, más "ID del POS Getnet", "ID de Sucursal Getnet" y "Número de Serie del POS Getnet" por caja.

## Qué no es público

- El **formato de los mensajes** por USB o por HTTP local (lo encapsula la librería).
- La **API REST de Cloud2Cloud** (endpoints, auth, webhook o sondeo).
- Respuesta con lote, cupón, marca, últimos 4 y cuotas: la lista pública no los menciona [I: pueden venir en otros campos].

## Conclusión

- **[I]** Para una web app, **Cloud2Cloud es la mejor vía** si Getnet da acceso: se haría desde una Edge Function (como Clover, ADR-047), sin cable ni puente. La vía local (USB / HTTP) sirve con el puente o Web Serial, pero necesita el protocolo de la librería.
- En NinjaPOS: `GetnetAdapter` placeholder (`lib/payments/terminal/adapters/getnet.ts`), con la conexión física lista y las operaciones `spec_pending`; el registro de terminales ya acepta Getnet como "Posnet integrado" o "Pinpad".

## Qué pedirle a Getnet

1. Acceso a la **Integrated POS Library** para Argentina: lenguajes (¿sólo C#?, ¿JS o REST?), licencia y si se puede usar desde un navegador o un puente local.
2. **Cloud2Cloud:** endpoints REST, autenticación (client credentials), sandbox, webhook o sondeo, y si está habilitado en Argentina para Get POS.
3. **Modo local:** el protocolo por USB y por HTTP (o si la librería es obligatoria), puerto, TLS y emparejamiento.
4. **Modelos** de Get POS y pinpads soportados, cómo se habilita una terminal para "POS Integrado" y de dónde sale la "clave comercio".
5. **Certificación:** pasos, terminales y tarjetas de prueba, ids de comercio, POS y sucursal de prueba, lista completa de campos de respuesta (marca, últimos 4, cuotas, lote, cupón) y cobertura de anulación, devolución y cierre.
6. **Contacto técnico:** comercios@getnet.com.ar o el programa de partners, si existe.
