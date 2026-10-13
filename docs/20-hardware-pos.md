# Hardware y mostrador PRO

Documento de referencia para impresoras, scanners, balanzas, cajón de dinero y doble pantalla del POS. Complementa `02-roadmap.md` F10.

## 1. Principio

El POS debe funcionar primero con navegador estándar y mejorar progresivamente cuando el cliente tenga hardware compatible. Ninguna integración de hardware puede bloquear la venta si falla: debe haber fallback manual o cola de reintento.

## 2. Seguimiento

Todo avance se marca en `02-roadmap.md` F10 con checkboxes. Al marcar `- [x]`, agregar evidencia: ruta implementada, migración, PR, test, demo o hardware probado.

## 3. Impresión

### Objetivo

Permitir impresión configurable por tenant, sucursal y caja.

### Alcance

- [ ] Ticket térmico 58mm.
- [ ] Ticket térmico 80mm.
- [ ] Cierre Z en ticket y A4.
- [ ] Etiquetas de producto.
- [ ] Comandas/cocina para perfil gastronómico.
- [ ] Comandas separadas por estación: cocina, barra, cafetería, heladería, parrilla, postres, despacho.
- [ ] KDS/pantalla de cocina como destino alternativo o complementario de impresión.
- [ ] Plantillas con logo, datos fiscales, QR, redes y leyendas.
- [ ] Cantidad de copias por tipo de documento.
- [ ] Corte de papel cuando el hardware lo soporte.
- [x] Apertura de cajón por pulso ESC/POS de la impresora de la caja (ADR-063, ver §5b).
- [ ] Cola de impresión: pendiente, impreso, fallido, reimprimir.

### Estrategia técnica

1. **Web print nativo:** `window.print()` como fallback universal.
2. **Conector local ESC/POS:** servicio local para impresoras USB/LAN/Bluetooth.
3. **WebUSB/WebSerial/QZ Tray:** evaluar por compatibilidad real antes de comprometer soporte productivo.

## 4. Scanners

### Objetivo

La lectura de códigos debe ser rápida y confiable, sin perder foco durante la venta.

### Alcance

- [ ] Lector USB HID tipo teclado.
- [ ] Cámara móvil con `BarcodeDetector` cuando esté disponible.
- [ ] Entrada manual.
- [ ] Scanner Bluetooth.
- [ ] Perfil por caja: prefijo, sufijo, Enter automático, delay entre caracteres.
- [ ] Normalización EAN, UPC, Code128 y QR.
- [ ] Prevención de lecturas duplicadas.
- [ ] Diagnóstico de scanner.

## 5. Balanzas y etiquetas (ADR-063)

- [x] Parsing configurable de etiquetas de balanza. · *`lib/barcode/scaleLabel.ts`: EAN-13 con prefijos 20 a 29, código de 4 a 6 dígitos, decimales, DV del EAN y DV del valor (GS1).*
- [x] Soporte para código con peso embebido.
- [x] Soporte para código con precio embebido. · *Cantidad = importe / precio por kg con 3 decimales.*
- [x] WebSerial para balanzas compatibles. · *O el puente local (`tools/bridge`) para puertos que maneja otro programa o navegadores sin Web Serial.*
- [x] Fallback por código de barra impreso y por gramos tipeados: la balanza nunca traba la venta.
- [ ] Validar los presets Systel, Kretz y Moretti con equipos reales.

### Qué se configura dónde

| Qué | Dónde | Por qué |
|---|---|---|
| Vende productos pesables | Negocio, grupo o sucursal (`pos_settings.scale_enabled`, heredable) | Es una regla del negocio |
| Formato de la etiqueta de balanza | Negocio, grupo o sucursal (`scale_label`) | Cada sucursal puede tener otra etiquetadora |
| Balanza conectada (modelo, conexión, protocolo) | Caja (`register_hardware.scale`) | Es el equipo enchufado ahí |
| Puerto USB emparejado y token del puente | Esta PC (navegador) | El permiso es del navegador |

### Protocolos

Tramas ASCII terminadas en CR, LF o ETX (STX opcional). Presets: Systel (a pedido con ENQ, gramos), Kretz (continuo, kg con 3 decimales), Moretti (a pedido con P, kg) y genérico (continuo o a pedido, comando con escapes, expresión regular propia). Marcas: ST estable, US en movimiento, OL sobrecarga. Sin marca de estabilidad, el POS la calcula (3 lecturas dentro de ±2 g durante 400 ms). "Probar balanza" muestra la trama cruda para ajustar la expresión.

## 5b. Cajón de dinero (ADR-063)

- [x] Pulso ESC/POS `ESC p m t1 t2` (pin 2 o 5, tiempos en ms) por Web Serial, WebUSB o el puente local (puerto serie o impresora de red en el 9100).
- [x] Abrir al cobrar en efectivo (política de la sucursal).
- [x] Abrir sin venta con motivo: permitido, con PIN de supervisor (acción `abrir_cajon`) o prohibido (política de la sucursal, nunca por caja).
- [x] "Esta caja no tiene cajón".
- [x] Cada pedido pasa por `cash_drawer_open`: decide, registra en `cash_drawer_events` y audita (usuario, caja, turno, motivo, supervisor, venta), permitido o rechazado. El navegador manda el pulso sólo si el servidor lo permite.
- [ ] Mostrar las aperturas sin venta en el arqueo de la caja.

| Qué | Dónde |
|---|---|
| Abrir al cobrar en efectivo, abrir sin venta | Negocio, grupo o sucursal (`drawer_open_on_cash`, `drawer_no_sale`) |
| Impresora que abre el cajón, pulso, "sin cajón" | Caja (`register_hardware.drawer`) |
| Puerto USB emparejado | Esta PC |

## 6. Doble pantalla / display cliente

Sí, se puede implementar en web, con límites claros.

### Modos soportados

- [ ] **Ventana secundaria:** ruta `/customer-display` abierta en segundo monitor.
- [ ] **Tablet/celular dedicado:** display cliente sincronizado con la caja.
- [ ] **Display hardware futuro:** pantalla serial/USB de dos líneas para total y mensajes básicos.

### Contenido permitido

- [ ] Logo/nombre del negocio.
- [ ] Caja/sucursal.
- [ ] Ítems del carrito.
- [ ] Subtotal, descuentos, total y vuelto.
- [ ] QR de pago.
- [ ] Mensajes de cierre y promociones.

### Seguridad

- [ ] No mostrar datos internos.
- [ ] No mostrar tokens, emails administrativos ni panel interno.
- [ ] No mostrar datos privados de otros clientes.
- [ ] Sin acciones administrativas desde la pantalla cliente.

### Limitación

El navegador no controla monitores como una app nativa. La solución robusta es abrir una URL de pantalla cliente y sincronizar estado desde el POS.

## 7. Diagnóstico

Pantalla `/configuracion/hardware` (sección "Diagnóstico de hardware" en Configuración del POS) — implementada en H26 (`components/dashboard-team/HardwareCard.tsx`, PR #261):

- [x] Ticket de prueba. — *Render oculto del ticket de muestra + `window.print()` (web print, reusa `TicketRenderer`/`.ticket-print`).*
- [x] Prueba de scanner. — *Captura en vivo con `useScanner` (mismo motor del POS): últimas lecturas con código/largo/duración/formato/duplicado.*
- [x] Prueba de cajón. · *"Abrir cajón de prueba" de la caja elegida: pasa por `cash_drawer_open` (tipo `test`, dueño o encargado), queda registrada y manda el pulso por la impresora de la caja (ADR-063).*
- [x] Prueba de pantalla cliente. — *"Abrir pantalla de prueba" (`window.open('/customer-display')`) + "Probar sincronización" (round-trip real de `BroadcastChannel`).*
- [x] Prueba de balanza. · *"Probar balanza" de la caja elegida: peso neto, estable o en movimiento, tara y trama cruda; simulador para probar sin balanza (ADR-063).*
- [x] Export de diagnóstico para soporte. — *XLSX o JSON con tenant/caja, capacidades reales del navegador (BroadcastChannel/WebUSB/WebSerial/Web Bluetooth/BarcodeDetector/web print), entorno (userAgent, resolución, origen seguro…) y log de pruebas. Sin tokens ni datos de clientes. `lib/hardware/export.ts`.*

## 8. Criterios de cierre

- [ ] Una venta imprime ticket por el destino configurado.
- [ ] Si la impresora falla, la venta queda completada y el ticket queda pendiente de reimpresión.
- [ ] Una comanda gastronómica se rutea a dos estaciones distintas sin duplicar ítems.
- [ ] Un scanner USB lee 100 códigos seguidos sin duplicar ni perder foco.
- [ ] La pantalla cliente muestra carrito, total, QR y vuelto en tiempo real.
- [ ] Soporte puede exportar diagnóstico sin acceder manualmente a la máquina del cliente.
