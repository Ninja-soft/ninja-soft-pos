# Motor comercial enterprise

Documento de referencia para F14. Define el sistema central de configuracion comercial de NinjaSoft POS: planes, cuotas, add-ons, recargos, financiacion, reglas, inventario PRO, compras, offline, omnicanal, API y gobierno de cambios.

## 1. Principio

Toda configuracion comercial que cambie precio, acceso, limite, stock, cobro, comision, canal o riesgo operativo debe ser:

- [ ] Declarativa: se configura sin tocar codigo.
- [ ] Jerarquica: tiene alcance y precedencia claros.
- [ ] Simulable: se puede previsualizar impacto antes de activar.
- [ ] Versionada: guarda historial, diff y rollback.
- [ ] Auditada: registra actor, motivo, antes/despues y fecha efectiva.
- [ ] Transparente: el usuario ve recargos, limites y cambios relevantes antes de confirmar.

## 2. Jerarquia de configuracion

Orden recomendado de resolucion, de menor a mayor prioridad:

1. Default global de NinjaSoft.
2. Plan base.
3. Add-on o paquete contratado.
4. Tenant.
5. Rubro/modo de negocio.
6. Sucursal.
7. Caja/dispositivo.
8. Canal de venta.
9. Rol.
10. Usuario.
11. Regla temporal/campana.

Cada pantalla de configuracion debe mostrar:

- [ ] Valor efectivo.
- [ ] De donde viene el valor.
- [ ] Si esta heredado o sobrescrito.
- [ ] Que pasaria si se elimina el override.
- [ ] Conflictos activos o proximos.

## 3. Planes, cuotas y entitlements

### 3.1 Plan base

- [ ] Start.
- [ ] Pro.
- [ ] Business.
- [ ] Enterprise.

Cada plan define:

- [ ] Modulos incluidos.
- [ ] Limites por recurso.
- [ ] Soporte/SLA.
- [ ] Precio base.
- [ ] Flags default.
- [ ] Politica de exceso.

### 3.2 Plan custom

- [ ] Se clona desde un plan base.
- [ ] Tiene nombre interno y nombre visible.
- [ ] Puede cambiar limites, modulos, precio, moneda, ciclo, SLA y vigencia.
- [ ] Nunca modifica el plan base global.
- [ ] Requiere motivo y audit log.

### 3.3 Add-ons

Add-ons posibles:

- [ ] Sucursal adicional.
- [ ] Caja adicional.
- [ ] Usuario adicional.
- [ ] Paquete de ventas mensuales.
- [ ] AFIP/facturacion electronica.
- [ ] Gastronomia PRO.
- [ ] Servicios/agenda.
- [ ] Hardware avanzado.
- [ ] API/webhooks.
- [ ] Soporte prioritario.
- [ ] Almacenamiento extra.
- [ ] Mensajes/notificaciones extra.

### 3.4 Cuotas medibles

Cuotas minimas:

- [ ] Usuarios activos.
- [ ] Sucursales.
- [ ] Cajas.
- [ ] Productos activos.
- [ ] Clientes activos.
- [ ] Ventas mensuales.
- [ ] Comprobantes fiscales mensuales.
- [ ] Ordenes/comandas mensuales.
- [ ] Almacenamiento.
- [ ] Emails/notificaciones.
- [ ] API calls.
- [ ] Integraciones activas.

Politicas de limite:

- [ ] `soft_limit`: avisa y permite continuar.
- [ ] `grace_limit`: permite excedente temporal.
- [ ] `hard_limit`: bloquea crear nuevo recurso.
- [ ] `overage`: cobra excedente.
- [ ] `manual_review`: requiere aprobacion interna.

## 4. Recargos, financiacion y costos

El motor debe soportar recargos y descuentos por:

- [ ] Medio de pago.
- [ ] Tipo de tarjeta.
- [ ] Marca.
- [ ] Adquirente/procesador.
- [ ] Plan de cuotas.
- [ ] Cantidad de cuotas.
- [ ] Canal.
- [ ] Sucursal.
- [ ] Caja.
- [ ] Horario/dia.
- [ ] Ticket minimo/maximo.
- [ ] Segmento de cliente.
- [ ] Rubro o modo de negocio.

Tipos de cargo:

- [ ] Recargo porcentual.
- [ ] Recargo fijo.
- [ ] Descuento porcentual.
- [ ] Descuento fijo.
- [ ] Costo financiero por cuota.
- [ ] Service charge.
- [ ] Propina sugerida o libre.
- [ ] Fee de delivery.
- [ ] Cargo por packaging.
- [ ] Tasa/impuesto local configurable.
- [ ] Redondeo.

Guardrails:

- [ ] Mostrar el total antes de cobrar.
- [ ] Mostrar detalle de recargo en ticket/comprobante cuando corresponda.
- [ ] Prohibir recargos ocultos.
- [ ] Validar topes por tenant/pais/regla legal.
- [ ] Permitir simulacion con ventas historicas.
- [ ] Separar recargo comercial de impuesto fiscal.

## 5. Motor de reglas comerciales

El motor usa condiciones y acciones.

Condiciones:

- [ ] Producto, categoria, marca, proveedor, tag.
- [ ] Cantidad, subtotal, margen, costo.
- [ ] Cliente, grupo, deuda, historial, cumpleanos.
- [ ] Medio de pago, cuotas, canal.
- [ ] Sucursal, caja, usuario, rol.
- [ ] Dia, horario, temporada, feriado.
- [ ] Stock, lote, vencimiento, serie.
- [ ] Plan del tenant, feature activa, rubro.

Acciones:

- [ ] Cambiar precio.
- [ ] Aplicar descuento.
- [ ] Aplicar recargo.
- [ ] Bloquear venta.
- [ ] Pedir aprobacion.
- [ ] Sugerir upgrade.
- [ ] Generar notificacion.
- [ ] Cambiar comision.
- [ ] Reservar stock.
- [ ] Enviar a canal/estacion.

Reglas de evaluacion:

- [ ] Prioridad numerica.
- [ ] Exclusividad.
- [ ] Combinabilidad.
- [ ] Tope por venta/dia/cliente.
- [ ] Vigencia.
- [ ] Version activa.
- [ ] Simulacion antes de publicar.

## 6. Gobierno de cambios

Cambios sensibles que requieren circuito maker-checker:

- [ ] Precio base.
- [ ] Recargo.
- [ ] Regla fiscal.
- [ ] Medio de pago.
- [ ] Plan/cuota.
- [ ] Suspension/reactivacion.
- [ ] Permisos.
- [ ] Integracion externa.
- [ ] Export masivo.
- [ ] Import masivo.
- [ ] Offline policy.

Cada solicitud guarda:

- [ ] Actor creador.
- [ ] Actor aprobador.
- [ ] Motivo.
- [ ] Entidad afectada.
- [ ] Antes/despues.
- [ ] Fecha efectiva.
- [ ] Impacto estimado.
- [ ] Adjuntos opcionales.
- [ ] Estado.

## 7. Centro de configuracion PRO

Pantalla objetivo para owner/manager:

- [ ] Configuracion por rubro.
- [ ] Medios de pago.
- [ ] Recargos y cuotas.
- [ ] Tickets.
- [ ] Roles.
- [ ] Sucursales/cajas.
- [ ] Depositos.
- [ ] Tipos de entrega.
- [ ] Garantias/devoluciones.
- [ ] Mesas/salones.
- [ ] Comisiones.
- [ ] Import/export.
- [ ] Historial y rollback.

Pantalla objetivo para internal:

- [ ] Plantillas globales por rubro.
- [ ] Rollout gradual de defaults.
- [ ] Comparador entre tenants.
- [ ] Deteccion de configuraciones riesgosas.
- [ ] Aplicacion masiva con preview.
- [ ] Excepciones por cliente.

## 8. Inventario PRO y compras

Capacidades:

- [ ] Lotes.
- [ ] Vencimientos.
- [ ] Numeros de serie.
- [ ] Garantia por serie.
- [ ] Conteos ciclicos.
- [ ] Inventario fisico.
- [ ] Ajustes con aprobacion.
- [ ] Proveedores.
- [ ] Ordenes de compra.
- [ ] Recepcion parcial.
- [ ] Costos promedio/FIFO futuro.
- [ ] Reposicion sugerida.
- [ ] Cuenta corriente de proveedores.
- [ ] Transferencias recomendadas.

Reportes:

- [ ] Stock valorizado.
- [ ] Quiebres.
- [ ] Vencimientos proximos.
- [ ] Series vendidas.
- [ ] Compras por proveedor.
- [ ] Margen por producto/categoria/sucursal.

## 9. Offline-first

Politicas por tenant:

- [ ] Permitir venta offline.
- [ ] Permitir pagos offline.
- [ ] Permitir stock negativo offline.
- [ ] Monto maximo por venta offline.
- [ ] Tiempo maximo offline.
- [ ] Usuarios autorizados.
- [ ] Requiere caja abierta previa.
- [ ] Bloquea cambios de configuracion offline.

Colas locales:

- [ ] Ventas.
- [ ] Pagos.
- [ ] Caja.
- [ ] Stock.
- [ ] Comandas.
- [ ] Notificaciones.
- [ ] Fiscal/AFIP.

Resolucion al reconectar:

- [ ] Idempotencia por `client_operation_id`.
- [ ] Deteccion de duplicados.
- [ ] Conflictos de stock.
- [ ] Conflictos de caja.
- [ ] Reconciliacion fiscal.
- [ ] Reporte para manager.

## 10. Omnicanal y marketplace hub

Canales:

- [ ] POS mostrador.
- [ ] Catalogo publico.
- [ ] QR mesa.
- [ ] WhatsApp.
- [ ] Tienda Nube.
- [ ] Mercado Libre.
- [ ] Delivery propio.
- [ ] PedidosYa/Rappi futuro.

Reglas:

- [ ] Precio por canal.
- [ ] Stock reservado por canal.
- [ ] Estado de pedido por canal.
- [ ] Cancelacion/reembolso por canal.
- [ ] Mapeo de producto/modificador/categoria.
- [ ] Conciliacion de ventas externas.

## 11. API, webhooks y marketplace de apps

API:

- [ ] Versionada.
- [ ] Scopes por tenant.
- [ ] Rate limits.
- [ ] Logs por request.
- [ ] Rotacion de credenciales.
- [ ] Ambiente sandbox.

Webhooks:

- [ ] Venta creada/anulada.
- [ ] Pago aprobado/fallido.
- [ ] Stock actualizado.
- [ ] Cliente creado/actualizado.
- [ ] Turno abierto/cerrado.
- [ ] Factura aprobada/rechazada.
- [ ] Comanda creada/lista.
- [ ] Notificacion generada.
- [ ] Plan cambiado.

Marketplace:

- [ ] App aprobada por NinjaSoft.
- [ ] Permisos visibles antes de instalar.
- [ ] Instalacion/desinstalacion por owner.
- [ ] Health por app.
- [ ] Revocacion inmediata.

## 12. BI/AI operativo

Recomendaciones objetivo:

- [ ] Reponer producto antes de quiebre.
- [ ] Crear promocion por producto lento.
- [ ] Ajustar precio por margen bajo.
- [ ] Sugerir staff extra en horario pico.
- [ ] Detectar anomalia de caja.
- [ ] Detectar devoluciones excesivas.
- [ ] Sugerir compra a proveedor.
- [ ] Alertar vencimientos.

Cada recomendacion debe mostrar:

- [ ] Datos usados.
- [ ] Nivel de confianza.
- [ ] Impacto estimado.
- [ ] Accion sugerida.
- [ ] Opcion de descartar y motivo.

## 13. Criterios de cierre

- [ ] Una regla comercial se crea, simula, aprueba, publica y revierte.
- [ ] Un plan custom con add-ons y cuotas aplica en internal y en tenant.
- [ ] Un recargo por cuotas se aplica en POS, ticket y reporte.
- [ ] Un limite de uso dispara aviso, grace period y bloqueo/cargo segun politica.
- [ ] Una orden de compra actualiza stock/costo con recepcion parcial.
- [ ] Una venta offline se sincroniza sin duplicar venta, caja ni stock.
- [ ] Toda configuracion sensible queda en audit log con antes/despues y motivo.

