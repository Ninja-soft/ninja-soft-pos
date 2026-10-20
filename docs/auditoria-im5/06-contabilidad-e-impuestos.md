# IM5 cap. 06 Contabilidad, Tesoreria e Impuestos vs NinjaSoft POS

Fuente: ANDESMAR/docs/auditoria-im5/06-contabilidad-e-impuestos.md. Repo comparado: pos-deploy main (HEAD 30ca1316). Verificado con grep sobre supabase/migrations, app/, components/, lib/, docs/.

Enfoque: NinjaPOS no reemplaza al sistema contable del estudio (docs/31-contabilidad.md §1, ADR-066). Varias capacidades de IM5 (balance clasificado, folios rubricados, formulas libres) son de ERP contable y se evaluan con ese criterio.

## 1. Circuito de asientos automaticos

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Asiento automatico por cada comprobante (venta, compra, cobro, pago, caja, tesoreria, liquidacion) | HECHO | `acc_sync_*` (sale, sale_return, cc_movement, cash_shift, cash_movement, supplier_invoice, supplier_payment, treasury_movement, settlement_line, payment_dispute, cheque, tax_suffered, iibb_liquidation), triggers diferidos, migr. 20261029100200 y 20261227100100 | - |
| Cuenta por maestro: articulo (venta/compra/CMV), cliente, proveedor, impuesto, medio, tarjeta y plan | PARCIAL | `acc_mappings` concepto + calificador + sucursal, `acc_account_for`; compras por proveedor; medio:adquirente | Falta cuenta de ventas/CMV por categoria o producto (resultado por rubro). Cuotas como calificador pendiente (H109) |
| Renglon sin cuenta valida: se descarta y queda desbalanceado, aviso en "Ver Asiento" | HECHO (mejor) | Trigger de balance `acc_entry_balance_check`, `acc_issues` con reintentar/descartar en Contabilidad > Resumen | NinjaPOS no deja asientos desbalanceados |
| "Ver Asiento" en todos los comprobantes | PARCIAL | `components/accounting/ViewEntryButton.tsx` usado solo en `components/treasury/MovementsView.tsx`, `PositionView.tsx`, `ChequesView.tsx` | Falta en detalle de venta, devolucion, factura y NC de proveedor, orden de pago, cobro de cuenta corriente y cierre de caja |
| Automaticos no editables; se corrige el comprobante | HECHO | Lineas inmutables, `acc_entry_reverse` solo manual/opening, `acc_generate` regenera mes abierto | - |
| Moneda y cotizacion por asiento, diferencia de cotizacion | PARCIAL | Moneda en asientos (H150, ADR-158), `acc_fx_rate` | Diferencia de cambio no se calcula (31-contabilidad §8; H101 y H109) |
| Asiento de venta con IVA por alicuota, exento, no gravado, internos y percepciones cobradas | PARCIAL | `acc_sync_sale` (20261227100100 l.502) y `acc_vat_sales` (20261029100300 l.158) usan `products.tax_rate` con `acc_vat_split`; no leen `sale_tax_lines` (ADR-068) | Percepciones de IVA/IIBB cobradas e internos no van a su pasivo; exento y no gravado no se separan. Declarado en 31-contabilidad §8, pero H109 figura [x] |

## 2. Cierres

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| "Balance cerrado hasta" que mira fecha vieja y nueva | HECHO | `acc_periods`, `acc_period_close/reopen` con motivo y auditoria, guardas `acc_entries_guard` | Criterio distinto: documento con fecha en mes cerrado se asienta en el primer dia del mes abierto. Tesoreria no bloquea movimientos con fecha en mes cerrado |
| Cierre de ejercicio / refundicion / apertura | FALTA | `acc_settings.fiscal_year_start_month`; Sumas y saldos reinicia resultados, pero no hay asiento de cierre/apertura | Asiento de refundicion y apertura opcional |
| Ajuste por inflacion | EN ROADMAP | 02-roadmap H109 "[ ] Ajuste por inflacion" | IM5 tampoco lo calcula: confirma dejarlo al estudio |
| Despreciar desbalanceos menores | NO APLICA | Balance obligatorio por trigger | - |

## 3. Asientos manuales

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Alta manual balanceada, renglon de un solo lado, solo imputables activas, centro de costo | HECHO | `acc_entry_manual_save` (20261029100200 l.1311) | - |
| Tipos A/G/R/S/O | PARCIAL | `kind` manual / opening / reversal | Faltan tipos (gastos bancarios, liquidacion IVA, saldo inicial de tercero) para filtrar |
| Renglon imputado a cliente/proveedor que entra a su cuenta corriente y se cancela con recibo/OP | FALTA | `acc_entry_lines` sin customer_id/supplier_id | Saldos iniciales y ajustes de CC desde contabilidad; el mayor de Deudores y la CC pueden separarse |
| Renglon con IVA CF/DF y alicuota; control "gasto con IVA" | PARCIAL | Gastos de tesoreria con IVA (H154, ADR-158) | Asiento manual sin marca IVA ni entrada al Libro IVA Compras |
| Cheques desde asiento manual | PARCIAL | `cheques` con estados y asiento al recibir (H154) | Se maneja desde Tesoreria, suficiente |
| Deteccion de cheque duplicado banco + numero | FALTA | Sin indice ni aviso en `cheques` (20261022100300) ni `lib/treasury/cheques.ts` | Aviso "ya ingresado: es otro valor / corregir" |
| Copiar asiento | FALTA | `components/accounting/EntryModals.tsx` | Boton copiar |
| Imprimir minuta contable | PARCIAL | Export XLSX del Diario | PDF de un asiento |
| Importacion masiva de asientos | PARCIAL | Solo asientos de NubCeo (H153) | Import XLSX de asientos (apertura) con motor TX-4 |
| Bloqueo de edicion si conciliado | HECHO | `movement_reconciled` (20261022100300 l.425) | - |
| Genera Orden de Pago desde asiento | NO APLICA | OP nace en Compras (ADR-059) | - |

## 4. Depositos y conciliaciones

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Deposito de efectivo y cheques en cartera | HECHO | `cheques.deposit_movement_id`, transferencias de tesoreria (H111/H154) | Falta "dinero en transito" (criterio H111) |
| Deposito conciliado no se edita | HECHO | `movement_reconciled` | - |
| Conciliacion de tarjetas: acreditacion estimada vs real, lote, liquidacion | HECHO (mejor) | `treasury_expected_release` (20261231100100), matching automatico ADR-061, A acreditar H152 | - |
| Conciliacion bancaria: tildar con fecha, import de extracto que propone | HECHO | `reconciled_at`, Tesoreria > Conciliacion > Extracto con 9 presets (ADR-162) | - |
| Fecha de conciliacion posterior a la anterior, saldo conciliado acumulado, partidas pendientes anteriores | PARCIAL | `treasury_balances` con saldo conciliado | Validar corte creciente y arrastre de pendientes |

## 5. Libros e informes

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Libro Diario con numeracion oficial | HECHO | `official_number` al cerrar | - |
| Folio rubricado / preimpreso | FALTA | - | Folio inicial en PDF del Diario |
| Diario resumido mensual | HECHO | Export resumido por mes y sucursal (31-contabilidad §7) | - |
| Mayor con saldo anterior y saldo corrido | HECHO | `app/(app)/contabilidad/libros/page.tsx` | - |
| Movimientos por unidad de negocio con vigencia | PARCIAL | `acc_cost_centers` con o sin sucursal | Sin vigencia ni informe por centro de costo |
| CMV (informe por mes o comprobante) | PARCIAL | `acc_settings` cmv none / perpetual | Sin informe; usa costo vigente al generar, no el de la venta |
| Libro IVA Compras/Ventas | HECHO | `acc_vat_purchases`, `acc_vat_sales`, Libro IVA Digital ADR-076 | Resumen de ventas no usa `sale_tax_lines` |
| Opciones: agrupar B CF por dia, ocultar no legales, retenciones de recibos, incluir B en compras | PARCIAL | IVA Ventas por dia | Filtro fiscal / no fiscal y columna de retenciones sufridas |
| Determinacion IVA DF/CF | PARCIAL | Resumenes IVA | Posicion mensual: DF - CF - percepciones y retenciones sufridas - saldo a favor = saldo, con asiento (existe para IIBB, ADR-095) |
| Estado de resultados | HECHO | Libros > Resultados | - |
| Estado de resultados comparativo y mensual (2 a 12 columnas) | FALTA | Solo rango | Columnas por mes y vs periodo anterior |
| Estado de resultados por centro de costo en columnas | FALTA | - | Columna por sucursal |
| Balance de sumas y saldos con madres | HECHO | `acc_trial_balance`, `rollupTrialBalance` | - |
| Balance general (patrimonial) | FALTA | - | Vista activo/pasivo/PN desde el arbol |
| Balance clasificado, consolidado multiempresa | NO APLICA | Estudio / multi-tenant | - |

## 6. Motor de impuestos

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Impuestos y configuracion por jurisdiccion, empresa, cuenta | HECHO | `tax_regimes`, `tax_jurisdictions`, `tax_parameters`, `tax_custom_values` (ADR-068, ADR-105), mapeos `percepcion:*` | - |
| Generador de formulas | HECHO (parametrico) | Regimenes con alicuota por condicion, minimos, escalas RG 830 | Formula libre NO APLICA |
| Columnas configurables del Libro IVA | NO APLICA | Formato RG 4597 fijo | - |
| Padrones con formato configurable | HECHO | `tax_padron_profiles`, `tax_padron_imports`, `tax_padron_entries` | Descarga programada (H104) |
| Percepciones de venta calculadas y guardadas con alicuota | HECHO | `sale_tax_lines`, `sale_tax_preview` | Reversa en NC (H105); no llegan al asiento |
| Percepciones de compra manuales | HECHO | Factura de proveedor (ADR-050) | - |
| Retenciones como agente (agente, Ganancias acumulado, minimo, grupal, certificado correlativo) | HECHO | ADR-079, 20261104200000/200100 | AGIP y otras provincias (H106) |
| Retenciones sufridas en recibo | HECHO | `tax_suffered_entries` origen cliente (ADR-095) | Cargarla dentro del cobro de CC como medio: a verificar en UI |
| SICORE, SIFERE, IIBB | EN ROADMAP | H108 | - |
| Alicuotas de IVA | HECHO | `tax_iva_rates` | - |
| Convenio Multilateral por jurisdiccion | EN ROADMAP | H105, F17 jurisdiccion por sucursal | - |

## 7. Tablas financieras y plan de cuentas

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Monedas con codigo ARCA e ISO | PARCIAL | `currency` ISO texto | Catalogo con MonId ARCA (H107) |
| Cotizaciones compra/venta, carga por rango BCRA | PARCIAL | `fx_rates` (oficial, mep, bna, manual), `platform_fx_sync` ArgentinaDatos dias habiles (ADR-135) | Compra y venta separadas, rango, bloqueo de factura sin cotizacion (H107) |
| Indices por inflacion | PARCIAL | Indices en listas de precios (ADR-058) | Uso contable con H109 |
| Plan de cuentas: arbol, imputable, reglas | HECHO | `acc_account_save` (acc_parent_has_entries, acc_parent_cycle, acc_account_has_entries) | - |
| Intercambio de codigos (reimputacion) | PARCIAL | Regenerar periodo abierto con mapeos nuevos | Periodos cerrados no |
| Grupos de cuentas por uso | NO APLICA | Mapeos concepto -> cuenta | - |
| Saldos acumulados con recalculo | NO APLICA | Calculo en linea | Vigilar performance |
| Rubro IVA / cuenta monetaria en la cuenta | NO APLICA | - | Solo con determinacion por rubro |

## Conteo

HECHO 27 · PARCIAL 21 · EN ROADMAP 3 · FALTA 8 · NO APLICA 9
