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
- [ ] Comandas/cocina para perfil restaurante.
- [ ] Plantillas con logo, datos fiscales, QR, redes y leyendas.
- [ ] Cantidad de copias por tipo de documento.
- [ ] Corte de papel y apertura de cajón cuando el hardware lo soporte.
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

## 5. Balanzas y etiquetas

- [ ] Parsing configurable de etiquetas de balanza.
- [ ] Soporte para código con peso embebido.
- [ ] Soporte para código con precio embebido.
- [ ] WebSerial para balanzas compatibles.
- [ ] Fallback por código de barra impreso.

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

Debe existir una pantalla `/configuracion/hardware` con:

- [ ] Ticket de prueba.
- [ ] Prueba de scanner.
- [ ] Prueba de cajón.
- [ ] Prueba de pantalla cliente.
- [ ] Prueba de balanza.
- [ ] Export de diagnóstico para soporte.

## 8. Criterios de cierre

- [ ] Una venta imprime ticket por el destino configurado.
- [ ] Si la impresora falla, la venta queda completada y el ticket queda pendiente de reimpresión.
- [ ] Un scanner USB lee 100 códigos seguidos sin duplicar ni perder foco.
- [ ] La pantalla cliente muestra carrito, total, QR y vuelto en tiempo real.
- [ ] Soporte puede exportar diagnóstico sin acceder manualmente a la máquina del cliente.
