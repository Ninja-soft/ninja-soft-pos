# Gastronomía PRO

Documento de referencia para F13 del roadmap: restaurantes, resto-bares, cafeterías, heladerías, panaderías, rotiserías, fast food, food trucks, dark kitchens y negocios híbridos con mesas, mostrador, comandas, cocina/barra y delivery/takeaway.

## 1. Oportunidad

La gastronomía no es un solo flujo. Un restaurante de salón necesita mesas y mozos; una cafetería necesita mostrador, nombre del cliente y barra rápida; una heladería necesita tamaños/sabores y a veces balanza; una rotisería necesita pedidos telefónicos, cocina y despacho. El producto debe permitir elegir el modelo sin crear forks.

Oportunidades principales:

- [ ] **Restaurante salón / resto-bar:** mesas, salones, mozos, comandas, división de cuenta, propina.
- [ ] **Cafetería / take away:** mostrador rápido, nombre del cliente, barra/cocina, combos y preparación.
- [ ] **Heladería:** tamaños, sabores, toppings, cucuruchos, balanza opcional y preparación por orden.
- [ ] **Panadería / rotisería:** venta por mostrador, productos preparados, pedidos para retirar, producción previa.
- [ ] **Fast food / food truck:** cobro antes, número de orden, pantalla de preparación y entrega.
- [ ] **Dark kitchen / delivery:** pedidos por canal, cocina, despacho y estados.

Referencias de mercado usadas como inspiración:

- [Lightspeed Restaurant tables](https://o-series-support.lightspeedhq.com/hc/en-us/articles/31329411093659) usa layouts visuales de mesas y cursos para organizar servicio y producción.
- [Lightspeed Kitchen Display System](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4418209500443-About-the-Lightspeed-Kitchen-Display-System) separa preparación en pantallas de cocina en tiempo real.
- [Square Table Management](https://squareup.com/gb/en/point-of-sale/restaurants/features/table-management-system) cubre turnos de mesa, cursos y KDS con timers/ruteo.
- [Toast ordering screens](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens) diferencia quick order/table order y muestra modificadores obligatorios u opcionales.

## 2. Principios

- [ ] El modo de venta define la pantalla inicial: mesas, mostrador, delivery o cocina.
- [ ] La comanda puede salir antes del pago cuando el rubro lo requiere.
- [ ] Cada ítem se manda a una estación, no a una impresora única.
- [ ] Modificadores y notas deben ser claros para cocina, no solo para caja.
- [ ] El pedido es auditable: quién agregó, quién anuló, quién reimprimió, cuándo se envió a cocina.
- [ ] Si falla una impresora/KDS, la venta no se pierde y la comanda queda en cola.

## 3. Tipos de negocio y variantes

| Tipo | Pantalla principal | Cobro | Comanda |
|---|---|---|---|
| Restaurante salón | Mapa de mesas | Después o parcial | Al enviar pedido/cursos |
| Resto-bar | Mesas + barra | Abierto/tab o al final | Cocina/barra separadas |
| Cafetería | Botones rápidos | Antes | Barra/cocina al cobrar o al enviar |
| Heladería | Botones + modificadores | Antes | Preparación opcional |
| Panadería | Mostrador + balanza opcional | Antes | Producción opcional |
| Rotisería | Mostrador + pedidos | Antes o seña | Cocina + despacho |
| Fast food | Quick order | Antes | KDS/cocina inmediata |
| Food truck | Quick order móvil | Antes | KDS local/simple |
| Dark kitchen | Pedidos por canal | Según canal | Cocina + despacho |

## 4. Mesas y salones

- [ ] Sectores/salones: principal, terraza, barra, patio, VIP.
- [ ] Mesas con número/nombre, capacidad, forma, posición y estado.
- [ ] Estados: libre, ocupada, esperando pedido, en cocina, servida, cuenta pedida, limpieza, reservada, bloqueada.
- [ ] Abrir mesa, mover mesa, unir mesas, transferir mozo, cerrar mesa.
- [ ] Control de tiempo abierta y alertas por demora.
- [ ] Cuenta por mesa, por comensal, por ítem, por porcentaje o por monto.

## 5. Comandas e impresión

- [ ] Comanda por estación: cocina caliente, cocina fría, barra, cafetería, heladería, parrilla, postres, despacho.
- [ ] Ruteo por producto, categoría, modificador, canal y modo de venta.
- [ ] Plantilla de comanda con mesa, sector, mozo/cajero, hora, prioridad, notas, alergias y cursos.
- [ ] Comandas separadas sin duplicar ítems.
- [ ] Reimpresión con marca visible.
- [ ] Cancelación parcial y comanda de anulación.
- [ ] Cola de impresión y fallback manual.

## 6. KDS / pantalla de cocina

- [ ] Vista por estación.
- [ ] Tarjetas con pedido, mesa/orden, tiempo, prioridad, notas y modificadores.
- [ ] Estados: nuevo, aceptado, preparando, listo, entregado, demorado, cancelado.
- [ ] Timers y SLA por estación.
- [ ] Filtro por canal: salón, mostrador, delivery, pickup.
- [ ] Sonido/alerta opcional para pedidos nuevos o demorados.
- [ ] Sincronización en tiempo real y recuperación al reconectar.

## 7. Menú, modificadores y cursos

- [ ] Menú por horario/canal: desayuno, almuerzo, merienda, cena, happy hour, delivery.
- [ ] Modificadores obligatorios/opcionales: punto de cocción, guarnición, salsa, tamaño, leche, topping, extra, sin TACC, sin sal.
- [ ] Notas por ítem y por pedido.
- [ ] Alergias destacadas en POS, comanda y KDS.
- [ ] Cursos: entrada, principal, postre, bebida.
- [ ] Enviar todo junto o "fire course" por etapa.
- [ ] Combos guiados y menús cerrados.

## 8. Cafetería y heladería

- [ ] Nombre del cliente o número de orden.
- [ ] Pedido para llevar/en taza.
- [ ] Barra con cola de preparación.
- [ ] Modificadores de café: tamaño, leche, temperatura, extra shot, syrup.
- [ ] Modificadores de helado: tamaño, sabores máximos, topping, cucuruchos, balanza opcional.
- [ ] Botones rápidos para productos más vendidos.
- [ ] Comanda corta para preparación cuando hay mucha rotación.

## 9. Delivery, take away y despacho

- [ ] Canal del pedido: mostrador, teléfono, WhatsApp, QR, delivery propio, marketplace futuro.
- [ ] Cliente, teléfono, dirección, referencia, horario prometido y costo de envío.
- [ ] Estados: recibido, aceptado, en preparación, listo, en camino, entregado, cancelado.
- [ ] Etiqueta/ticket para bolsa.
- [ ] Repartidor/cadete asignable.
- [ ] Conciliación de pago por canal.

## 10. Inventario gastronómico y recetas

- [ ] Recetas/escandallo por producto.
- [ ] Ingredientes, cantidades, unidades y costo estimado.
- [ ] Descuento de insumos al vender si el tenant lo activa.
- [ ] Producción previa por batch.
- [ ] Merma por vencimiento, preparación fallida, devolución o rotura.
- [ ] Margen estimado por plato/producto.

## 11. Reportes

- [ ] Ventas por mesa, sector, mozo, canal, estación, producto y horario.
- [ ] Tiempos de preparación por estación.
- [ ] Rotación de mesas.
- [ ] Cancelaciones, anulaciones, reimpresiones y descuentos.
- [ ] Productos/modificadores más vendidos.
- [ ] Margen por plato si hay recetas.

## 12. Criterios de cierre F13

- [ ] Un restaurante configura salón, abre mesa, envía comanda, divide cuenta y cobra.
- [ ] Una cafetería cobra antes, envía barra/cocina y marca pedido listo.
- [ ] Una heladería vende por tamaño/sabores/toppings sin crear combinaciones manuales.
- [ ] Un pedido se rutea a dos estaciones distintas sin duplicar ítems.
- [ ] Si una impresora/KDS falla, la comanda queda pendiente y se puede reimprimir.
- [ ] Un reporte muestra tiempos de preparación y rotación de mesa.
