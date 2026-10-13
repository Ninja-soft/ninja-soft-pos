# Puente local NinjaPOS (referencia)

Programa chico que corre en la PC de la caja y deja que el POS web hable con una terminal de tarjeta conectada a esa PC: posnet integrado por cable (puerto COM) o por red (TCP), o un pinpad. Sirve cuando el navegador no puede usar Web Serial / WebUSB (Firefox, Safari, el puerto lo usa otro programa, o la terminal está en la LAN). Ver ADR-053 y `docs/payments/terminal-integrada-payway.md`.

También lo usan la **balanza** (puerto serie de la PC) y el **cajón de dinero** (pulso ESC/POS a la impresora por puerto serie o por red en el 9100), configurados por caja en Configuración, Hardware (ADR-063). El token y la URL se guardan una vez por PC.

El puente **no entiende el protocolo** de la terminal: pasa bytes. El protocolo (Payway VPI, etc.) lo arma el adaptador en el navegador (`lib/payments/terminal/adapters`).

Esto es una implementación de referencia: no se distribuye un binario. Para producción hace falta empaquetarlo (servicio de Windows, arranque con la sesión, firma de código).

## Uso

```bash
node tools/bridge/bridge.mjs --origin https://<dominio-del-pos>     # escucha en ws://127.0.0.1:47800
node tools/bridge/bridge.mjs --list                                 # puertos serie de la PC
node tools/bridge/bridge.mjs --new-token                            # rota el token
```

- Puerto serie: `npm i serialport` dentro de `tools/bridge` (dependencia opcional, nativa). TCP no necesita nada.
- Al arrancar muestra el **token**. En NinjaPOS: Configuración, Terminales, la terminal, **Conectar**, pegar el token y guardar (queda en ese navegador y esa PC).
- Sin `--origin` sólo acepta páginas servidas desde `localhost` (desarrollo).

## Seguridad

- Escucha **sólo en 127.0.0.1**: no se expone a la red.
- Cualquier página abierta en la PC puede intentar conectarse a `127.0.0.1`, por eso hay dos barreras: **origen permitido** (header `Origin` del navegador contra `--origin`) y **token de emparejamiento** (24 bytes aleatorios en `~/.ninjapos-bridge.json`, comparación de tiempo constante). Un error de cualquiera cierra la conexión.
- Una sola conexión a la vez (`busy`): dos pestañas no pueden mandar a la misma terminal.
- No guarda ni registra datos de tarjeta; sólo pasa bytes. Los datos sensibles (PAN completo, PIN) nunca salen de la terminal en el modo integrado (la terminal devuelve últimos 4 y BIN).

## Protocolo (versión 1)

WebSocket con mensajes de texto JSON. Los bytes viajan en base64.

| Dirección | Mensaje | Notas |
|---|---|---|
| POS → puente | `{ "type": "hello", "token": "...", "client": "ninjapos-web", "version": 1 }` | Primer mensaje obligatorio |
| puente → POS | `{ "type": "welcome", "version": 1, "bridge": "ninjapos-bridge/0.1.0" }` | Token y origen ok |
| POS → puente | `{ "type": "open", "target": { "kind": "serial", "path": "COM3", "baudRate": 19200, "dataBits": 8, "stopBits": 1, "parity": "none", "flowControl": "none" } }` | O `{ "kind": "tcp", "host": "192.168.0.50", "port": 9000 }` |
| puente → POS | `{ "type": "opened" }` | Destino abierto |
| ambos | `{ "type": "data", "b64": "AgMEBQ==" }` | Bytes crudos |
| POS → puente | `{ "type": "close" }` | Cierra el destino |
| puente → POS | `{ "type": "closed", "reason": "client" \| "target_closed" }` | |
| POS → puente | `{ "type": "list" }` | |
| puente → POS | `{ "type": "devices", "serial": [{ "path", "manufacturer", "vendorId", "productId" }] }` | |
| puente → POS | `{ "type": "error", "code": "...", "message": "..." }` | Códigos: `bad_token`, `origin_not_allowed`, `busy`, `bad_target`, `open_failed`, `serial_unavailable`, `not_open`, `protocol` |

Cliente en el navegador: `BridgeTransport` en `lib/payments/terminal/transports.ts`.

## Pendiente para producción

- Instalador y servicio de Windows con arranque automático; ícono en la bandeja con estado.
- Emparejamiento con código corto mostrado en pantalla (en vez de copiar el token).
- WSS con certificado local si algún navegador deja de permitir `ws://127.0.0.1` desde `https`.
- Logs rotados sin datos de tarjeta.
