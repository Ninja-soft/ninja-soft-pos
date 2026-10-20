# IM5 cap. 04 (Clientes, Proveedores y Compras) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/04-clientes-proveedores-compras.md` (leído completo).
Repo comparado: `pos-deploy` main (30ca1316). Verificado con grep en `supabase/migrations`, `components/purchases`, `lib/purchases`, `app/(app)/compras`, `docs/02-roadmap.md`.

Estados: HECHO, PARCIAL, ROADMAP (pendiente en 02-roadmap), FALTA, NO APLICA.

## 1. Cuenta corriente de clientes

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Saldo = suma de comprobantes, nunca un campo | HECHO | `customer_account_movements` (ledger con `kind`), `account_balance`, `account_reconcile` (20261011200000/200100, ADR-037) | - |
| Imputación de cobros a cargos, parcial, re-control | HECHO | `customer_account_allocations`, `account_collect` (FIFO o elegida, idempotente) | - |
| Cta. cte. Debe/Haber/Saldo acumulado, saldo anterior, PDF | HECHO | H31b completado ADR-169 (cuenta Debe/Haber con saldo corrido y PDF) | Roadmap tiene subitems [ ] desactualizados en H31b |
| Saldos de clientes a fecha de corte, deudores/acreedores, aging | HECHO | `account_aging(p_as_of)`, `AccountsReceivableModal` | Falta agrupar por rubro/cuenta contable y multimoneda (menor) |
| Intereses por mora | HECHO (mejor) | `account_accrue_interest` diario (simple/compuesto, gracia, tope, mínimo) y condonación auditada; IM5 sólo informa | MEJORA: tramos por días (0-30 x%, 31-60 y%) y días por fecha valor del cheque |
| Alta rápida con lookup ARCA por CUIT/DNI | HECHO | ADR-133 Edge `arca_padron`, clientes verificados | - |
| Baja lógica si tiene movimientos | HECHO | `deleted_at` / principio 6 | - |
| Alícuotas desde padrón (percepción) | HECHO | ADR-068 padrones ARBA/AGIP | - |
| Alta de cliente offline provisoria | PARCIAL | venta offline ADR-077; alta de cliente offline no verificada | Cola de alta de cliente offline (H65) |
| Consolidado intersucursal / tarea "bloquea consolidar" | HECHO | cuenta única por tenant, alcance de sucursal en 360 | - |
| Moneda extranjera en cta. cte. y dif. de cambio automática | FALTA | ledger en pesos | NC/ND por diferencia de cambio (P3) |
| Columnas configurables por usuario, embudo por columna | PARCIAL | filtros por pantalla, XLSX | Preferencia de columnas por usuario (TX) |

## 2. Proveedores ABM

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Alta con CUIT + dígito verificador, condición IVA | HECHO | `suppliers.cuit` con `cuit_is_valid`, `iva_condition` (20261016100100) | - |
| CUIT único | HECHO | índice `suppliers_tenant_cuit_key` | - |
| Traer datos de ARCA por CUIT | ROADMAP | H104 "Falta la re-validación periódica y proveedores" | Reusar `arca_padron` en `SupplierFormModal` |
| Plazo, moneda, CBU/alias, contacto, WhatsApp | HECHO | columnas de `suppliers` | - |
| Perfil impositivo de retención (categoría Ganancias, IIBB, alícuota padrón) | HECHO | `supplier_tax_profiles`, ADR-079 | - |
| Cuenta contable por proveedor / cuenta de gasto | PARCIAL | `acc_account_for('compras', supplier_id)` (mapeo por proveedor, ADR-066) | Cuenta de gasto por renglón de factura (servicios, alquiler, luz) |
| Proveedor-cliente (cliente asociado) y saldo neto | FALTA | `suppliers` sin `customer_id` | Vincular y consulta de neto |
| Artículos que provee, precios viejos >N días | PARCIAL | `supplier_products` (código, último costo, mínimo, unidad) | Filtro "precios de más de N días" y "otros proveedores" |
| Alícuotas de retención desde padrón con vista antes/después | PARCIAL | import de padrones con historial (ADR-068/105) | Vista comparativa por proveedor |

## 3. Cta. cte. y saldos de proveedores

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Cta. cte. con saldo acumulado, aging, XLSX | HECHO | `SupplierDetailModal` (`ledgerWithRunning`, `supplierAging`) | - |
| Saldo abierto por comprobante | HECHO | vista `supplier_invoice_open` | Sólo descuenta OP; NC y anticipos no se imputan, se aplican FIFO en front |
| Imputación explícita de NC y anticipos en la OP (negativos, por partes) | PARCIAL | OP imputa facturas/ND; excedente queda "a cuenta" | Aplicar NC y anticipo a facturas concretas con línea "cancela anticipo" |
| Saldos de todos los proveedores a fecha de corte | PARCIAL | listado de proveedores con saldo | Fecha de corte, filtro con deuda / a favor, totales |
| Previsión de pagos editable que alimenta cash flow | PARCIAL | `/tesoreria/flujo` proyecta por vencimiento de facturas (`lib/treasury/cashflow.ts`) | Override manual de cuánto/cuándo pagar por proveedor |
| Saldo inicial de proveedor y ajustes manuales | FALTA | no hay kind de ajuste ni saldo inicial | Migración de saldos al arrancar |
| Moneda local histórica vs moneda origen | PARCIAL | `amount_ars` con TC de carga | Vista en moneda original + dif. de cambio (H101 [~]) |
| Refresco automático de cta. cte. al grabar en otra pestaña | NO APLICA | TanStack Query invalida | - |

## 4. Circuito de compras

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Orden de compra con estados, recepción parcial | HECHO | `purchase_orders` draft/sent/partially_received/received/cancelled; `purchase_receive` | - |
| OC sugerida por stock mín/máx con tránsito | HECHO | `purchase_suggestions`, `lib/purchases/suggest.ts` | MEJORA: sumar comprometido (pedidos reservados) y vendido 7/30/60/90 |
| OC desde pedidos de venta sin stock | FALTA | reservas ADR-091/129 no alimentan OC | P2 |
| Nota de pedido interna con autorización por renglón | FALTA | sin tabla | P3 |
| Solicitud de precio / cotización a varios proveedores | FALTA | sin tabla | P3 |
| Autorización de OC por monto (acumulado del usuario, tope por usuario, firma de tercero, separación de funciones) | FALTA | permiso único `purchases.manage`; ni en roadmap | P2 |
| Vigencia de OC | FALTA | `expected_date` sólo informativo | P3 |
| Remito de compra que ingresa stock | HECHO | `goods_receipts` + `purchase_receive`, anulación con reversa (ADR-059) | - |
| Stock entra una sola vez (remito o factura) | HECHO por diseño | sólo la recepción mueve stock; factura se vincula (`goods_receipts.invoice_id`) | Comprar sin remito obliga a cargar recepción aparte: falta "factura con renglones que recibe" en un paso |
| Control de tres vías OC-remito-factura | ROADMAP | H101 "falta control de tres vías automático" | - |
| Factura de compra: neto por alícuota, percepciones, no gravado, exento | HECHO | `supplier_invoices.vat_lines/other_taxes`, `supplier_invoice_save` | Sin renglones por artículo ni cuenta por renglón |
| Duplicado proveedor+letra+PV+número, ignora anulados | HECHO | índice `supplier_invoices_doc_key ... where status='posted'` | - |
| Letra según condición IVA proveedor vs empresa | PARCIAL | `suggestedLetter` en front | No se valida en servidor |
| Vencimientos en cuotas | FALTA | sólo `due_date` único | P2 |
| F. imputación distinta de F. comprobante, fecha valor | ROADMAP | H108 "falta el período de imputación de compras" | - |
| CAE/CAI del proveedor y constatación | FALTA | sin columna | P2 |
| Bloquear edición/anulación de factura ya pagada o con posteriores | FALTA | `supplier_invoice_save` y `supplier_invoice_void` no miran `supplier_payment_allocations` | P1, integridad |
| NC de compra devolución/financiera con tope por factura asociada | PARCIAL | `purchase_returns` + `purchase_return_link_credit_note`; NC libre | Tope de NC contra lo facturado y factura asociada obligatoria por config |
| ND de compra | HECHO | `kind='debit_note'` | - |
| Actualizar costo del maestro desde la compra | HECHO | `purchase_settings.sync_product_cost`, `cost_basis`, `product_cost_history` | MEJORA: por rol permitir/forzar y "mantener margen vs precio" al recibir |
| Liquidación de compra (consignación) | FALTA | sin modelo | P3 |
| Números de serie y lote en recepción | HECHO | lotes con vencimiento (ADR-050/059), `product_serials` | Pistoleo de series en la recepción a verificar |
| Centro de costo por comprobante | HECHO | asientos por sucursal (ADR-066) | CC1/CC2 NO APLICA |
| Asiento por comprobante | HECHO | `acc_sync_supplier_invoice`, `acc_sync_supplier_payment` | - |
| Permisos ver_solo_propios / editar_propios | FALTA | `purchases.manage` único | P2 |

## 5. Órdenes de pago y retenciones

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| OP con imputación parcial, varios medios | HECHO | `supplier_payment_order_create`, `supplier_payment_lines`, `supplier_payment_allocations` | - |
| Efectivo, transferencia, cheque propio/echeq, cheque de terceros de cartera | HECHO | `cheques` own/third_party, endoso, reversa al anular | - |
| Anticipo a proveedor | PARCIAL | OP con excedente "on_account" | Aplicación posterior explícita |
| OP sobre cuenta contable (gasto sin proveedor) | FALTA | tesorería tiene movimientos, no OP a cuenta | P3 |
| OP múltiple (varios proveedores) | FALTA | - | P3 |
| Aviso de cheque propio con número repetido | FALTA | insert en `cheques` sin control | P2 |
| Ajuste por redondeo | FALTA | - | P3 |
| Retenciones calculadas (Ganancias acumulado mensual, MNI, escalas, IIBB, IVA, SUSS) y certificado | HECHO | ADR-079, `tax_withholdings`, SICORE | - |
| Número de certificado inicial confirmable y reinicio anual | PARCIAL | `max(certificate_number)+1` por régimen | Número inicial por régimen (migración desde otro sistema) |
| "Generar OP por saldo" desde la factura | HECHO a verificar | `PaymentOrderModal` | - |

## 6. Masivos e IA

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Import de lista de precios del proveedor con mapeo guardado y vista previa | HECHO | `supplier_price_list_apply`, `PriceListImportModal`, `supplier_price_list_imports` | MEJORA: CSV/PDF, detección de columnas con IA, crear artículos faltantes, cruce normalizado de códigos, aviso de archivo ya importado (hash) y de variación absurda |
| Importar comprobantes de "Mis Comprobantes Recibidos" de ARCA | FALTA | no hay import en compras | P1 |
| Leer facturas PDF/foto con IA y precargar | FALTA | `ai_assistant` existe (Claude/Gemini) pero no para facturas | P1 |
| Bandeja de fotos desde el celular | FALTA | - | P2 |
| Envío masivo de OC y OP por email con historial | PARCIAL | envío individual por mail/WhatsApp de OC (`OrderDetailModal`) | Envío de OP/certificado y lote con historial |

## 7. Consultas cruzadas

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Cta. cte. de intermediarios (corredores) | NO APLICA | - | Mayorista con corredores, nicho |
| Saldos proveedores-clientes | FALTA | - | ver §2 |

## 8. Configuraciones generales de compras

| Parámetro IM5 | Estado | Evidencia |
|---|---|---|
| Modo simple/pro, base de costo, sincronizar costo | HECHO | `purchase_settings` |
| Permitir recepción libre / sobre-recepción / motivo de diferencia | HECHO | `purchase_settings` |
| Trabajar con OC, vigencia, autorización por monto | FALTA | - |
| Ocultar precios en remito (para depositero) | FALTA | `cashier_can_receive` existe, precios visibles |
| NC sin comprobante asociado (switch) | FALTA | - |
| Descuento por ítem vs global incompatibles | PARCIAL | `purchase_order_items.discounts[]` + `discount_pct` global en OC |

## Conteo

HECHO 30 · PARCIAL 18 · ROADMAP 3 · FALTA 24 · NO APLICA 4 (intermediarios, CC1/CC2, refresco entre pestañas, tareas numeradas IM4).
