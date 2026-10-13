# 31 · Contabilidad (F18 · H109, ADR-066)

> Documento vivo del módulo de contabilidad: modelo, eventos que generan asientos, mapeos, cierres, libros y formatos de export para estudios contables. Decisión de arquitectura en [ADR-066](./17-decision-log.md). Auditoría de origen: [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md) §6.

## 1. Qué es y qué no es

NinjaPos **no reemplaza el sistema contable del estudio**: genera asientos **correctos, inmutables y trazables** desde los documentos del negocio (ventas, cobros, compras, pagos, caja, tesorería, liquidaciones) y los **exporta** en el formato del estudio. Se corrige siempre por contra-asiento, nunca editando.

- Feature de plan `contabilidad`: **OPTIONAL**, grupo reportes, **Business y Enterprise** (planes a medida heredan `tesoreria`).
- Pantallas: grupo de navegación **Contabilidad** (dueño y encargado): Resumen, Asientos, Libros, Plan de cuentas, Mapeos y Cierres (`/contabilidad/*`).
- Gating real: `acc_assert()` (rol dueño o encargado + feature) en todas las RPC; `acc_tenant_active()` (configurada, encendida y con la feature) en los triggers que generan asientos.

## 2. Modelo de datos

| Tabla | Para qué |
|---|---|
| `acc_settings` | Configuración por negocio: encendida, desde qué fecha se contabiliza, modo de IVA (`included_rate` / `none`), alícuota por defecto, CMV (`none` / `perpetual`), mes de inicio del ejercicio, preferencias de export. |
| `acc_accounts` | Plan de cuentas en árbol (`parent_id`), código jerárquico (`1.1.01.01`), tipo (`activo`, `pasivo`, `patrimonio`, `ingreso`, `egreso`), imputable, código externo (el del sistema del estudio), `system_key` de la plantilla, baja lógica. |
| `acc_cost_centers` | Centros de costo; uno por sucursal se crea solo (`S01`, `S02`…). También sin sucursal (unidad de negocio). |
| `acc_mappings` | Reglas evento → cuenta: `concept`, `qualifier` (`*` o detalle), `store_id` opcional. |
| `acc_periods` | Cierre mensual por negocio (`open` / `closed`) con quién cerró y reabrió y el motivo. |
| `acc_entries` | Cabecera del asiento: número interno, número oficial del Diario (al cerrar), fecha, período, tipo (`auto`, `manual`, `reversal`, `opening`), origen (`source_type`, `source_id`, `source_event`), leyenda, sucursal, vínculos de reversión, total, baja lógica. |
| `acc_entry_lines` | Renglones: cuenta, centro de costo, debe o haber (uno de los dos), leyenda del renglón. |
| `acc_issues` | Eventos que no se pudieron contabilizar (falta un mapeo, documento cambiado después del cierre) para reintentar o descartar. |
| Vista `acc_journal_lines` | Diario plano (`security_invoker`) para Asientos, Libros y exports. |

**Invariantes (en la base, no sólo en la pantalla):**

- Todo asiento balancea (debe = haber, al menos dos renglones): trigger diferido al commit.
- Los renglones no se modifican ni se borran; el asiento sólo se da de baja lógica (regeneración de un mes abierto).
- Un mes cerrado no acepta altas ni bajas de asientos (`acc_period_closed`).
- Un asiento automático es único por origen: `(tenant, source_type, source_id, source_event)` entre los vigentes. Generar dos veces no duplica.
- Lectura sólo para dueño o encargado (`tenant_id = current_tenant_id() or internal_scope()` + RESTRICTIVE de rol, ADR-052). Sin escritura por PostgREST: todo por RPC `SECURITY DEFINER` con `audit_logs`.

## 3. Asientos automáticos

Se generan con **triggers `DEFERRABLE INITIALLY DEFERRED`** sobre las tablas existentes: corren al commit, cuando la venta ya tiene sus renglones y cobros. **Nunca frenan la operación**: si falta un mapeo, el error queda en `acc_issues` y la venta se guarda igual. No se tocó `create_sale`, `close_cash_shift`, `_pc_complete` ni el resolutor de precios.

| Origen (`source_type`) | Evento | Debe | Haber |
|---|---|---|---|
| `sale` | `sale` | cada cobro (`cobro:medio[:adquirente]`); CMV si `perpetual` | ventas netas, IVA DF por alícuota, propina; vuelto contra caja o redondeo; mercaderías si `perpetual` |
| `sale` | `void` | contra-asiento de la venta, con la fecha de la anulación | |
| `sale_return` | `return` | devoluciones sobre ventas (neto) e IVA DF; mercaderías si `perpetual` y repone | cuenta corriente (lo acreditado) y el medio de reintegro (efectivo o saldo a favor); CMV |
| `cc_movement` | `main` | cobro: medio del cobro; interés y cargos manuales: deudores | cobro: deudores; interés: intereses ganados; ajustes |
| `cc_movement` | `void` | contra-asiento del cobro anulado | |
| `cash_shift` | `close` | faltante de caja o caja (sobrante) | caja o sobrante |
| `cash_movement` | `main` | ingresos y retiros manuales de la caja del POS (sin documento) contra `caja_movimiento` | |
| `supplier_invoice` | `invoice` | compras (neto, exento, no gravado), IVA CF por alícuota, percepciones e internos; NC al revés; al tipo de cambio | proveedores |
| `supplier_invoice` | `void` | contra-asiento | |
| `supplier_payment` | `payment` | proveedores | cada medio de la orden (cuenta de tesorería, efectivo de la caja, cheques) y retenciones practicadas |
| `supplier_payment` | `void` | contra-asiento | |
| `treasury_movement` | `movement` | cuenta de tesorería contra la contrapartida del tipo (o la otra cuenta en las transferencias) | |
| `treasury_movement` | `void` | contra-asiento | |
| `settlement_line` | `release` | neto acreditado, comisión, impuestos y diferencia | lo cobrado (bruto menos devuelto) en la cuenta del cobro |
| `payment_dispute` | `loss` | contracargos y devoluciones | la cuenta del cobro (o la de acreditación del procesador) |

Reglas:

- **Fecha:** la del documento (hora argentina). Si su mes está cerrado, el asiento va al **primer día del mes abierto siguiente** con la nota "fecha original …, período cerrado".
- **Desde:** sólo se contabiliza lo que tiene fecha desde `acc_settings.start_date`; lo anterior entra con un asiento de apertura.
- **IVA de ventas (hoy):** IVA incluido en el precio a la alícuota del producto (`products.tax_rate`), prorrateado sobre el total del comprobante (descuentos y redondeo incluidos) con `acc_vat_split` (espejo `splitVat` en `lib/accounting/vat.ts`). Sin IVA en monotributo o exento (`vat_mode = none`). La rama del motor de impuestos (H103) va a cambiar la fuente de alícuotas en un solo lugar.
- **CMV:** por defecto no se registra (el estudio lo calcula por diferencia de inventario). Con `perpetual`, en cada venta y devolución al costo vigente del producto (`products.cost`) al momento de generar.
- **Cobros con tarjeta y QR:** el calificador es el medio y, si se conoce, el adquirente del cupón (`card_voucher.adquirente`) o el proveedor del intent (sin el sufijo `_point`): `credit:payway`, `qr:mercadopago`, `debit:fiserv`.
- **Liquidaciones:** sólo las líneas `payment` acreditadas y vinculadas a un cobro del POS; los cobros sin venta se resuelven primero en Conciliación.
- **Contracargos:** contracargo perdido, reclamo perdido o devolución hecha desde el procesador (`origin = provider`); si después se gana, contra-asiento.
- **Regenerar:** `acc_generate(desde, hasta, rehacer)` trae lo que falte (idempotente) y, con rehacer, da de baja lógica los automáticos del rango en meses abiertos y los vuelve a armar con los mapeos de hoy.

## 4. Mapeos

Cada parte de un asiento se resuelve con `acc_account_for(concepto, calificador, sucursal)`. Búsqueda de lo más específico a lo general (espejo `resolveMapping` en `lib/accounting/mappings.ts`):

1. calificador exacto (`credit:payway`),
2. `*:` y el adquirente (`*:payway`: cualquier medio por Payway),
3. el medio (`credit`),
4. la regla general `*`.

En cada nivel gana la regla de la sucursal. Conceptos: `cobro`, `ventas`, `iva_df`, `devoluciones_ventas`, `propinas`, `redondeo`, `cmv`, `mercaderias`, `intereses_cc`, `ajustes_cc`, `faltante_caja`, `sobrante_caja`, `caja_movimiento`, `compras` (por proveedor), `iva_cf`, `percepcion`, `proveedores`, `pago`, `retencion_practicada`, `tesoreria` (por tipo o `*:<id de la cuenta>`), `tesoreria_mov`, `acreditacion`, `comision_procesador`, `impuestos_procesador`, `diferencia_procesador`, `contracargos`.

La plantilla `comercial_ar` trae el plan de cuentas argentino (Caja, Bancos, Valores a depositar, Mercado Pago, Deudores por ventas, Tarjetas a cobrar por adquirente, IVA DF y CF, percepciones y retenciones, Proveedores, Cheques diferidos, Mercaderías, CMV, Ventas, Devoluciones, Comisiones de procesadores, Gastos bancarios, Contracargos, Faltantes y sobrantes, etc.) y todas las reglas generales.

## 5. Cierre mensual

- `acc_period_close(mes)`: sólo meses terminados y en orden (los anteriores con asientos tienen que estar cerrados). Numera el Diario correlativo **por ejercicio** (`official_number`, ordenado por fecha y número interno) y bloquea el mes.
- `acc_period_reopen(mes, motivo)`: sólo el dueño, con motivo, y sólo el último mes cerrado. Al volver a cerrar, se renumera.
- Todo queda en `audit_logs` (`acc_period_closed`, `acc_period_reopened`).

## 6. Libros

- **Libro Diario** (vista `acc_journal_lines`), con XLSX.
- **Mayor** por cuenta con saldo anterior y saldo corrido.
- **Balance de sumas y saldos** (`acc_trial_balance`): saldo anterior (patrimoniales desde el inicio; resultados desde el comienzo del ejercicio), debe, haber y saldo; árbol con madres sumadas en `rollupTrialBalance`.
- **Estado de resultados** simple del rango.
- **IVA Ventas** (`acc_vat_sales`): por día, sucursal, tipo (venta, anulación, devolución) y alícuota. **IVA Compras** (`acc_vat_purchases`): un renglón por comprobante vigente con neto, IVA por alícuota, exento, no gravado, percepciones, internos y total, en pesos; las NC restan. Son resúmenes con los datos de hoy, no el Libro IVA Digital (H108).

## 7. Export a estudios contables

Desde Libros, Diario, "Exportar para el estudio": se elige el sistema, el detalle (un asiento por operación, resumido por día y sucursal o por mes y sucursal, sumando debe y haber de cada cuenta por separado) y si se usa el número del Diario. Se usa el **código externo** de la cuenta (el del plan del estudio) y, si falta, el código de NinjaPos. Hay vista previa del archivo.

> **Layouts propuestos, a validar con cada estudio.** Los sistemas permiten configurar la importación de distintas formas (y cambian entre versiones). Estos layouts siguen la estructura habitual de importación de asientos de cada uno; si el estudio usa otra, el **CSV a medida** permite elegir columnas, separador, decimales, formato de fecha y codificación.

| Sistema | Archivo | Separador / decimales / fecha | Codificación | Encabezado | Columnas (en orden) |
|---|---|---|---|---|---|
| Tango Gestión (Contabilidad) | `.txt` | `;` / `,` / dd/mm/aaaa | Windows (Latin-1) | Sí | Nro. asiento, Fecha, Leyenda, Cuenta, Debe, Haber, Centro de costo, Leyenda renglón |
| Holistor Contabilidad | `.txt` | `;` / `,` / dd/mm/aaaa | Windows (Latin-1) | No | Fecha, Número, Cuenta, Leyenda, Debe, Haber, Centro de costo |
| Xubio | `.csv` | `,` / `.` / dd/mm/aaaa, todo entre comillas | UTF-8 con BOM | Sí | Número de asiento, Fecha, Descripción, Cuenta contable, Debe, Haber, Centro de costo |
| Colppy | `.csv` | `,` / `.` / dd/mm/aaaa, todo entre comillas | UTF-8 con BOM | Sí | Fecha, Descripción, Cuenta, Debe, Haber, Centro de costo 1, Comentario |
| CSV a medida | `.csv` | configurable | configurable | configurable | elegidas de: N° de asiento, fecha, leyenda, código y nombre de cuenta, debe, haber, importe con signo, D/H, centro de costo, leyenda del renglón |

Un renglón por imputación; los asientos se reconocen por el número. Importes con 2 decimales sin separador de miles. La preferencia (sistema, detalle y CSV a medida) se guarda en `acc_settings.export_config`. Lógica pura en `lib/accounting/exporters.ts` (tests en `tests/unit/accounting.test.ts`).

Bejerman y los conectores con API (ADDON `integracion_erp`) quedan para una etapa siguiente.

## 8. Pendientes y límites conocidos

- **Motor de impuestos (H103):** el IVA de ventas sale de `products.tax_rate` con IVA incluido; exento, no gravado, internos y percepciones de ventas llegan con la rama de impuestos (cambiar `acc_vat_split` / la fuente de alícuotas).
- **Recepciones sin factura:** la compra se contabiliza con el comprobante del proveedor (no con el remito). Las devoluciones a proveedor sin NC no generan asiento (la NC es la que acredita).
- **Cheques de terceros recibidos de clientes** sin documento de cobro no generan asiento al entrar a cartera (los cobros con cheque se registran hoy como "Otro medio").
- **Saldos iniciales de tesorería** y bienes de uso: se cargan con un asiento de apertura.
- **CMV perpetuo** usa el costo vigente al generar: rehacer un mes después de cambiar costos cambia el CMV.
- **Diferencias de cambio** y **ajuste por inflación**: no se calculan (el POS exporta en pesos con fecha; el ajuste lo resuelve el sistema del estudio).
- **Impuestos de procesadores:** `settlement_lines.taxes` se registra entero en "Retenciones e impuestos sufridos en cobros" (incluye el IVA de la comisión); el desglose por concepto queda para cuando la liquidación lo traiga separado.
- **Libro IVA Digital, SICORE, SIRE y DDJJ:** H108.
