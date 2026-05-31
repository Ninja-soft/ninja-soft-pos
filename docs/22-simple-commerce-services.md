# Comercios simples y servicios

Documento de referencia para F12 del roadmap: negocios con pocos productos o servicios que necesitan cobrar muy rápido o trabajar con agenda sin cargar una estructura de retail pesado.

## 1. Oportunidad

Este segmento es atractivo porque tiene baja fricción de onboarding, decisión de compra directa del dueño y alta repetición operativa. No siempre necesita inventario complejo, pero sí necesita velocidad, simplicidad visual y rutinas del rubro.

Oportunidades principales:

- [ ] **Heladerías, cafeterías simples, panaderías chicas y take away:** pocos productos base, muchas variantes por tamaño/sabor/topping, alto volumen de ventas rápidas. Si necesitan mesas, comandas o cocina/KDS, pasan a F13.
- [ ] **Peluquerías, barberías, estética, uñas y spa:** servicios con duración, profesional, turnos, comisiones, propinas, señas y productos complementarios.
- [ ] **Lavaderos, talleres livianos y reparación simple:** servicios repetibles, estados de trabajo, cobro rápido, cliente frecuente y seña.
- [ ] **Profesionales con turnos:** clases, consultas, terapias, entrenamiento, mantenimiento y packs de sesiones.

La ventaja comercial es vender una versión "empieza hoy" para negocios que no quieren configurar miles de SKUs. El producto debe poder demostrar valor en 3 minutos y permitir el primer cobro real en menos de 10 minutos.

Referencias de mercado usadas como inspiración:

- [Square Appointments](https://square.site/help/us/en/article/5354-square-appointments-guide) combina servicios, disponibilidad, reserva online y POS para rubros de belleza/salud.
- [Lightspeed Restaurant Fast Payment](https://o-series-support.lightspeedhq.com/hc/en-us/articles/31329430237851-Setting-up-Fast-Payment-on-the-POS) documenta fast payment optimizado para transacciones rápidas.
- [Toast POS ordering screens](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens) diferencia pantallas de quick order y usa modificadores obligatorios/opcionales en flujos de comida rápida.
- [Square Catalog modifiers](https://developer.squareup.com/docs/catalog-api/enable-modifiers-on-items) usa modificadores para casos como helado por sabores sin crear un producto por combinación.

## 2. Principios de UX

- [ ] La pantalla inicial depende del rubro: botones rápidos para heladería/cafetería; agenda para peluquería/estética.
- [ ] La búsqueda es secundaria cuando el catálogo es chico.
- [ ] El stock puede estar apagado por defecto en servicios.
- [ ] Todo flujo debe entrar en 2-3 taps hasta cobrar cuando el caso es repetitivo.
- [ ] Los botones se ordenan por frecuencia real de uso y se pueden fijar como favoritos.
- [ ] La complejidad se esconde: variantes/modificadores aparecen solo cuando el producto/servicio lo requiere.

## 3. Modo catálogo chico

- [ ] Grilla táctil de categorías y favoritos.
- [ ] Botones grandes con nombre corto, precio y color.
- [ ] Layout por caja/dispositivo: mostrador, tablet, celular.
- [ ] Cantidades rápidas: `+1`, `+2`, `x6`, `x12`.
- [ ] Venta libre con monto manual y motivo, controlada por permiso.
- [ ] Cobro express con efectivo exacto, efectivo con vuelto, QR, tarjeta y transferencia.
- [ ] Cierre de caja adaptado a alto volumen de tickets chicos.

## 4. Heladería / cafetería simple

Este modo cubre cobro rápido de mostrador. Para heladería/cafetería con mesas, comandas por estación, barra/cocina o delivery, ver [`23-restaurant-cafe-operations.md`](./23-restaurant-cafe-operations.md).

- [ ] Productos base: vasito, cucurucho, cuarto, medio, kilo, café, medialuna, promo.
- [ ] Tamaños con precio y cantidad máxima de sabores.
- [ ] Sabores como modificadores, no como productos duplicados.
- [ ] Toppings opcionales con precio.
- [ ] Reglas: sabor obligatorio, máximo por tamaño, topping opcional, envase/cucuruchos extra.
- [ ] Combos frecuentes: café + medialuna, kilo + cucuruchos, docena, promo familiar.
- [ ] Modo balanza opcional para precio/peso cuando aplique.
- [ ] Comanda de preparación opcional.

## 5. Peluquería / estética / barbería

- [ ] Servicios con duración, precio, categoría, profesional permitido y comisión.
- [ ] Agenda por profesional, silla/cabina/recurso y día.
- [ ] Walk-in sin turno y lista de espera.
- [ ] Cobro desde turno finalizado.
- [ ] Productos complementarios en el mismo ticket: shampoo, crema, cera, accesorios.
- [ ] Señas, cancelación, no-show y reprogramación.
- [ ] Propinas por profesional.
- [ ] Ficha de cliente con notas: color usado, preferencia, alergias, observaciones.

## 6. Packs, sesiones y membresías

- [ ] Pack de sesiones con saldo visible.
- [ ] Vencimiento opcional.
- [ ] Consumo parcial al cobrar.
- [ ] Transferencia o bloqueo de pack según política del comercio.
- [ ] Membresía mensual simple.
- [ ] Gift cards para servicios o monto libre.

## 7. Staff y comisiones

- [ ] Comisión por servicio.
- [ ] Comisión por producto.
- [ ] Comisión por extra/topping/garantía cuando aplique.
- [ ] Propina asociada a profesional.
- [ ] Reporte de productividad por día/semana/mes.
- [ ] Permisos para que cada profesional vea solo su agenda si corresponde.

## 8. Datos mínimos

Para estos rubros, el onboarding inicial debe pedir solo lo necesario:

- [ ] Nombre comercial.
- [ ] Rubro.
- [ ] Medios de pago.
- [ ] Servicios/productos rápidos.
- [ ] Profesionales si usa agenda.
- [ ] Horarios de atención.
- [ ] Ticket: logo opcional, texto al pie y datos fiscales si corresponde.

## 9. Métricas de activación

- [ ] Tiempo hasta primer cobro real.
- [ ] Cantidad de taps promedio por venta.
- [ ] Tiempo promedio de cobro.
- [ ] Primer turno agendado.
- [ ] Primer cliente recurrente.
- [ ] Primer pack vendido.
- [ ] Uso de botones favoritos.

## 10. Criterios de cierre F12

- [ ] Una heladería demo vende "1/2 kg, 3 sabores, 1 topping" sin crear combinaciones manuales.
- [ ] Una peluquería demo agenda, atiende y cobra un servicio con profesional y comisión.
- [ ] Un comercio de servicios vende un pack, consume una sesión y ve saldo restante.
- [ ] Un negocio nuevo realiza su primer cobro en menos de 10 minutos desde onboarding.
- [ ] La pantalla de cobro rápido permite cargar y cobrar una venta típica en menos de 15 segundos.
