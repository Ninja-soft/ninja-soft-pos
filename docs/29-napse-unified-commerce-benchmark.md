# Benchmark Napse/TOTVS — comercio unificado

Documento de referencia para F16. Usa Napse/TOTVS como inspiracion de producto enterprise para cerrar brechas de comercio unificado en NinjaSoft POS.

Fuentes de referencia:

- Napse/TOTVS home: https://napse.global/
- Bridge / punto de venta omnicanal: https://napse.global/soluciones/punto-de-venta/
- Promo / promociones y fidelizacion: https://napse.global/soluciones/promociones-y-fidelizacion/
- VTOL / medios de pago: https://napse.global/soluciones/medios-de-pago/
- Fiscal Flow / facturacion electronica: https://napse.global/soluciones/facturacion-electronica/
- Omni / e-commerce y marketplace: https://napse.global/soluciones/integracion-con-soluciones-de-e-commerce-y-marketplace/

## 1. Principio

NinjaSoft no debe copiar Napse modulo por modulo. Debe tomar la vara funcional:

- [ ] Comercio unificado, no solo POS.
- [ ] Operacion centralizada y tiempo real.
- [ ] Canales fisicos y digitales conectados.
- [ ] Pagos orquestados con trazabilidad.
- [ ] Fiscal robusto con contingencia.
- [ ] Promociones/fidelizacion omnicanal.
- [ ] Integraciones con colas, health y replay.
- [ ] Demos enterprise para vender cadenas y franquicias.

## 2. Matriz de paridad

| Referencia Napse/TOTVS | Capacidad observada | NinjaSoft objetivo |
|---|---|---|
| Bridge | Operacion retail centralizada: inventario, ventas, pedidos, promociones, pagos, fiscal y fidelizacion | F16/H76 + F14 |
| Bridge | Stock Lookup, Click & Collect, Ship from Store, mobile POS y reglas unificadas | F16/H77-H78 + H81 |
| Promo | Simulador, coexistencia de promociones, cupones, puntos, gift cards, cashback y automatizaciones | F9/H53-H56 + F16/H80 |
| VTOL | Gateway multiproposito, pagos por canal, conciliacion, ruteo, alarmas y alta disponibilidad | F8/H21b + F16/H85 |
| Fiscal Flow | Emision, almacenamiento, envio, diseno PDF, contingencia, multi-negocio y multi-pais | F3 + F16/H79 |
| Omni | Click & Collect, Ship from Store, devoluciones cross-channel, stock centralizado e integracion ERP/POS | F16/H77-H78 + H84 |

## 3. Gaps agregados al roadmap

### 3.1 Unified Commerce Cockpit

- [ ] Ventas por canal.
- [ ] Pedidos pendientes.
- [ ] Stock comprometido.
- [ ] Pagos pendientes de conciliacion.
- [ ] Facturas pendientes/bloqueadas.
- [ ] Devoluciones cross-channel.
- [ ] Promociones activas y performance.
- [ ] Alertas por SLA.

### 3.2 Journeys omnicanal

- [ ] Comprar online y retirar en tienda.
- [ ] Comprar en tienda y enviar a domicilio.
- [ ] Comprar en marketplace y surtir desde deposito/sucursal.
- [ ] Reservar online y probar/pagar en tienda.
- [ ] Comprar online y devolver/cambiar en cualquier tienda.
- [ ] Vender en salon usando stock de otra tienda.

### 3.3 OMS y fulfillment

- [ ] Reserva de stock.
- [ ] Asignacion de origen.
- [ ] Picking.
- [ ] Packing.
- [ ] Entrega.
- [ ] Cancelacion.
- [ ] Reembolso.
- [ ] Split fulfillment.
- [ ] SLA y capacidad por sucursal/deposito.

### 3.4 Orquestador de pagos

- [ ] Router por proveedor/adquirente/terminal/canal.
- [ ] Fallback autorizado.
- [ ] Conciliacion por lote/cupon/autorizacion/liquidacion.
- [ ] Alarmas de terminal/proveedor.
- [ ] Recuperacion automatica.
- [ ] Auditoria por transaccion.
- [ ] Disputas, chargebacks y reversas.
- [ ] Estado unico de pago para POS/e-commerce/marketplace.

### 3.5 Fiscal hub

- [ ] Emision multi-canal.
- [ ] Cola fiscal.
- [ ] Contingencia offline.
- [ ] Almacenamiento XML/PDF.
- [ ] Envio automatico al cliente.
- [ ] Reimpresion.
- [ ] Nota de credito/debito.
- [ ] Disenador PDF.
- [ ] Alertas 24/7.
- [ ] Preparacion multi-pais.

### 3.6 Promo y fidelizacion enterprise

- [ ] Simulador antes de activar.
- [ ] Reglas de coexistencia.
- [ ] Conflictos entre promociones.
- [ ] Presupuesto por campana.
- [ ] Cupones.
- [ ] Vales.
- [ ] Gift cards.
- [ ] Monedero.
- [ ] Cashback.
- [ ] Puntos/niveles.
- [ ] Automatizaciones por evento.
- [ ] Dashboard de performance.

### 3.7 Clienteling y mobile POS

- [ ] Atencion desde celular/tablet.
- [ ] Historial y preferencias del cliente.
- [ ] Recomendaciones de cross-selling/up-selling.
- [ ] Carrito persistente.
- [ ] QR de pago.
- [ ] Envio a domicilio desde tienda.
- [ ] Stock de otra sucursal.
- [ ] Evitar paso por caja cuando el negocio lo permita.

### 3.8 Riesgo y fraude

- [ ] Descuentos anormales.
- [ ] Anulaciones repetidas.
- [ ] Devoluciones sospechosas.
- [ ] Abuso de cupones.
- [ ] Gift cards/vales de riesgo.
- [ ] Chargebacks.
- [ ] Caja fuera de patron.
- [ ] Aprobacion por supervisor.
- [ ] Scoring y auditoria.

## 4. Arquitectura recomendada

Componentes:

- [ ] `commerce_cockpit`: vistas agregadas y health operacional.
- [ ] `oms_core`: pedidos, reservas, fulfillment y devoluciones.
- [ ] `payment_orchestrator`: ruteo, estados, conciliacion y fallback.
- [ ] `fiscal_hub`: comprobantes, colas, XML/PDF, contingencia y multi-pais.
- [ ] `promo_loyalty_engine`: promociones, fidelizacion, cupones y wallets.
- [ ] `integration_hub`: conectores, colas, dead-letter, replay y health.
- [ ] `risk_engine`: reglas y scoring operativo.

Reglas de implementacion:

- [ ] Cada operacion cross-channel tiene `external_reference`, `source_channel` y `idempotency_key`.
- [ ] Cada conector usa cola, retry, dead-letter y replay manual.
- [ ] El cockpit no escribe datos criticos directo; dispara comandos auditados.
- [ ] Pagos, fiscal y stock nunca dependen solo del frontend.
- [ ] Todo flujo soporta trazabilidad completa para soporte.

## 5. Modelo de datos objetivo

Tablas candidatas:

- [ ] `commerce_orders`.
- [ ] `commerce_order_items`.
- [ ] `commerce_reservations`.
- [ ] `fulfillment_tasks`.
- [ ] `fulfillment_shipments`.
- [ ] `cross_channel_returns`.
- [ ] `payment_transactions`.
- [ ] `payment_reconciliations`.
- [ ] `payment_terminal_health`.
- [ ] `fiscal_documents`.
- [ ] `fiscal_document_files`.
- [ ] `promo_campaigns`.
- [ ] `loyalty_accounts`.
- [ ] `loyalty_movements`.
- [ ] `gift_cards`.
- [ ] `customer_wallets`.
- [ ] `integration_connectors`.
- [ ] `integration_jobs`.
- [ ] `integration_dead_letters`.
- [ ] `risk_events`.
- [ ] `risk_rules`.

## 6. Demos enterprise

Datasets demo obligatorios:

- [ ] Supermercado: alto volumen, promociones, balanza, caja rapida, stock critico.
- [ ] Moda: talles/colores, stock lookup, devolucion cross-channel, clienteling.
- [ ] Farmacia: receta/stock critico futuro, fiscal, promociones reguladas, auditoria.
- [ ] Tienda departamental: multi-categoria, marketplace, OMS, click & collect.
- [ ] Franquicia: configuracion central, overrides locales, reportes por franquiciado.
- [ ] Mayorista: lista de precios, cuenta corriente, pedidos, despacho y reposicion.

Cada demo debe mostrar:

- [ ] Venta en POS.
- [ ] Pedido online.
- [ ] Retiro/cambio/devolucion cross-channel.
- [ ] Pago conciliado.
- [ ] Comprobante fiscal.
- [ ] Promocion/fidelizacion.
- [ ] Cockpit central.
- [ ] Alerta operativa.

## 7. Criterios de cierre

- [ ] La matriz de paridad se revisa antes de cerrar F16.
- [ ] Una demo enterprise ejecuta un flujo omnicanal completo sin datos preparados manualmente.
- [ ] Pagos, fiscal, stock y OMS tienen trazabilidad end-to-end.
- [ ] Todo conector tiene health, retry, dead-letter y replay.
- [ ] Soporte puede diagnosticar una falla cross-channel desde cockpit sin SQL.

