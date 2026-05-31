# Configuración retail avanzada

Documento de referencia para F11 del roadmap: medios de pago con recargo, garantías extendidas, devoluciones, cuenta corriente, pedidos de salón, despacho, depósitos, roles retail e importación masiva por Excel.

## 1. Principio

Todo dato maestro operativo que un comercio carga en volumen debe poder importarse por Excel con plantilla, validación previa, preview y errores por fila. Nada importante debe requerir SQL manual.

## 2. Importación masiva XLSX

Aplica a:

- [ ] Productos.
- [ ] Clientes.
- [ ] Depósitos.
- [ ] Sucursales.
- [ ] Stock inicial.
- [ ] Transferencias.
- [ ] Listas de precios.
- [ ] Medios de pago y variantes.
- [ ] Planes de financiación/cuotas.
- [ ] Garantías extendidas.
- [ ] Motivos de devolución.
- [ ] Grupos de clientes.
- [ ] Tipos de entrega.
- [ ] Proveedores, cuando exista el módulo.
- [ ] Configuración legal/comercial del tenant, cuando el onboarding masivo lo requiera.

Cada import debe tener:

- [ ] Plantilla descargable.
- [ ] Columnas obligatorias documentadas.
- [ ] Ejemplos válidos.
- [ ] Validación sin escribir datos (`dry-run`).
- [ ] Preview con filas válidas, errores y warnings.
- [ ] Confirmación final.
- [ ] Resultado descargable con errores por fila.
- [ ] Auditoría del usuario que importó, archivo, fecha y resumen.
- [ ] Reversión cuando sea técnicamente posible.

## 3. Medios de pago y recargos

- [ ] Medios visibles al cobrar.
- [ ] Variantes por medio: marca, plan, cuotas, recargo o descuento.
- [ ] Ejemplo: `Visa 3 cuotas +8%`.
- [ ] Recargo sumado automáticamente al ticket.
- [ ] Recargo registrado separado del subtotal.
- [ ] Datos de voucher obligatorios opcionales por configuración: lote, cupón, autorización.

## 4. Garantías extendidas

- [ ] Campo de garantía de fábrica en producto.
- [ ] Planes por categoría/producto.
- [ ] Meses adicionales.
- [ ] Prima como porcentaje del precio.
- [ ] Comisión del vendedor como porcentaje de la prima.
- [ ] Oferta contextual en el checkout.
- [ ] Reporte de garantías y comisiones.

## 5. Devoluciones y cambios

- [ ] Política: cajero elige, siempre saldo a favor o siempre efectivo.
- [ ] Vigencia del vale en meses.
- [ ] Motivos configurables con label/code/orden/estado.
- [ ] Destino de stock por motivo: depósito original, revisión, merma/descarte.
- [ ] Wizard de devolución/cambio.
- [ ] Auditoría completa.

## 6. Settings operativos

- [ ] Vender sin stock.
- [ ] Override por producto para venta en cero.
- [ ] Requerir cliente en venta.
- [ ] Señas que reservan stock.
- [ ] Descuento máximo.
- [ ] Redondeo del total.
- [ ] Arqueo ciego.
- [ ] Tolerancia sin justificación.
- [ ] SKU automático con prefijo.

## 7. Cuenta corriente

- [ ] Medio de pago cuenta corriente.
- [ ] Límite default de deuda.
- [ ] Límite por cliente.
- [ ] Plazo default de pago.
- [ ] Antigüedad de deuda.
- [ ] Grupos de clientes.

## 8. Pedidos, despacho y entrega

- [ ] Pedido de salón armado por vendedor.
- [ ] Cajera levanta y factura pedido.
- [ ] Reserva de stock con vencimiento.
- [ ] Despacho separado luego del cobro.
- [ ] Tipos de entrega: retiro inmediato, retiro pendiente en sucursal, envío a domicilio.
- [ ] Cross-branch por tipo de entrega.

## 9. Depósitos

- [ ] Depósito principal por sucursal.
- [ ] Depósito de reserva.
- [ ] Depósito de devolución/revisión.
- [ ] Depósito de merma.
- [ ] Depósito en tránsito.
- [ ] Transferencias entre depósitos.
- [ ] Recepción parcial.

## 10. Roles retail

Presets iniciales:

- [ ] Vendedor de salón.
- [ ] Expedicionista.
- [ ] Cajero plus.
- [ ] Gerente retail.

Reglas:

- [ ] Los presets de sistema se pueden editar pero no borrar.
- [ ] El tenant puede crear roles propios.
- [ ] Cada rol define permisos granulares.
- [ ] Cambios de permisos quedan auditados.

## 11. Datos comerciales, tickets y cliente requerido

- [ ] Razón social.
- [ ] Condición frente al IVA.
- [ ] CUIT/CUIL.
- [ ] Teléfono.
- [ ] Email.
- [ ] Dirección legal.
- [ ] Provincia.
- [ ] Ciudad/localidad.
- [ ] Modo del negocio/rubro.
- [ ] Logo del comercio.
- [ ] Título del comprobante.
- [ ] Texto al pie del ticket.
- [ ] Mostrar logo en ticket.
- [ ] Mostrar CUIT en ticket.
- [ ] Datos requeridos al cargar cliente: documento, condición IVA, teléfono, email, domicilio, fecha de nacimiento.
