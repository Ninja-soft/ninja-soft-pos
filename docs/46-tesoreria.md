# 46 · Tesorería ordenada: de la venta al asiento (F23, ADR-150)

> Documento vivo. Junta en un solo mapa lo que hoy está repartido entre Tesorería (ADR-059), Conciliación (ADR-044, ADR-061, ADR-064), Contabilidad (ADR-066, [`31-contabilidad.md`](./31-contabilidad.md)), Impuestos como sujeto (ADR-095) y NubCeo (ADR-062, [`30-nubceo.md`](./30-nubceo.md)). Decisión en [ADR-150](./17-decision-log.md). Fase en [`02-roadmap.md`](./02-roadmap.md) (F23).
>
> Pedido del dueño (2026-10-15): *"Ordename toda la parte de tesorería: que quede bien explicado, intuitivo, que esté relacionado, que se manejen bien los asientos contables, como lo mando yo, como lo devuelve NubCeo. Auditá que todo funcione."*

## 0. En una frase

**Cada peso tiene que poder seguirse desde la venta hasta el banco y hasta el asiento, en una sola pantalla y sin contarlo dos veces.** Hoy las piezas existen y por separado andan bien (los asientos balancean, la conciliación de Mercado Pago corre sola, NubCeo manda y trae), pero **no están unidas**: la Tesorería sólo ve lo que se carga a mano, la Contabilidad registra la plata en cuentas genéricas y NubCeo devuelve asientos que no se cruzan con los nuestros.

---

## 1. Auditoría (2026-10-15)

### 1.1 Cómo se auditó

- **Código:** migraciones, RPC y triggers de `treasury_*`, `acc_*`, `settlement_*`, `nubceo_*`; Edges `settlements` y `nubceo_sync`; pantallas de `/tesoreria`, `/reportes/conciliacion`, `/contabilidad/*`, `/impuestos/*` y Configuración > NubCeo.
- **Producción, sólo lectura** (transacción `read only`, sin secretos): definiciones vigentes de las 101 funciones `acc_*`, `treasury_*`, `settlement_*` y `nubceo_*`, triggers (todos los de contabilidad son `DEFERRABLE INITIALLY DEFERRED`), conteos y cruces de datos.
- **Tests del área:** 11 archivos unitarios, 177 tests en verde (`accounting`, `nubceo`, `nubceoLedgerCsv`, `processorReconciliation`, `reconciliationHub`, `reconciliationSelection`, `settlementMatch`, `treasuryCashflow`, `treasuryCheques`, `cardReconciliation`, `transferAccounts`). Los de integración RLS (`rls-contabilidad`, `rls-nubceo`, `rls-conciliacion-procesadores`, `rls-cobranza-ledger`) piden Supabase local y no se corrieron.
- **Referencia del dueño:** ANDESMAR (sólo lectura): `docs/nubceo.md`, `nubceo.html`, `railway/nubceo-sync/`, `Cruce de IVA/` y `docs/cierre-mensual-ml.md`.

### 1.2 Qué hay en producción hoy

| Dato | Valor | Lectura |
|---|---|---|
| Negocios | 5, todos con `tesoreria`, `contabilidad`, `conciliacion_procesadores` e `integracion_nubceo` habilitadas | La feature no es la traba. |
| `treasury_accounts` / `treasury_movements` | 0 / 0 | Nadie usa Tesorería todavía. |
| `acc_settings` / `acc_entries` | 0 / 0 | Nadie prendió la Contabilidad. |
| `nubceo_settings` / `nubceo_sync` / asientos de NubCeo | 0 / 0 / 0 | NubCeo sin configurar en NinjaPOS (el dueño lo usa desde ANDESMAR). |
| `settlement_imports` / `settlement_lines` | 5 / 3 (Mercado Pago por API, diario) | La conciliación automática de MP **sí corre**. |
| `payments` | 297: efectivo 163, transferencia 84 ($453.825), cuenta corriente 40, QR 7, crédito 2, débito 1 | Ningún cobro entra a una cuenta de Tesorería. |
| `transfer_accounts` | 2 | Cuentas para cobrar por transferencia, sin vínculo con Tesorería. |
| Turnos de caja cerrados | 4, tres con contado $0 y faltantes de $50.000, $112.999 y $25.900 | Datos de prueba, pero con Contabilidad prendida serían asientos de faltante. |

Como no hay asientos en producción, el chequeo "debe = haber por asiento, cuentas sin mapear, asientos huérfanos" se hizo sobre el código vigente: el balance lo garantiza la base (`acc_post` rechaza diferencias y el trigger diferido `acc_entry_balance_check` lo vuelve a controlar al commit), los mapeos faltantes van a `acc_issues` sin frenar la venta, y la unicidad por origen evita asientos duplicados.

### 1.3 Pantallas que existen hoy

| Dónde está en el menú | Ruta | Qué hace | Feature |
|---|---|---|---|
| Compras > Tesorería | `/tesoreria` | Pestañas Cuentas (caja general y bancos con saldo y saldo conciliado), Movimientos (manuales, transferencias entre cuentas, conciliar con referencia del extracto, anular), Cheques (propios y de terceros, depositar, debitar, rechazar) y Flujo (proyección por día, semana o mes). | `tesoreria` |
| Gestión > Conciliación | `/reportes/conciliacion` | Hub: Por procesador (MP por API, otros por archivo), Tarjetas por lote, Pendientes de revisar; vincular, ignorar, Excel. | nav con `conciliacion_tarjetas`; procesadores con `conciliacion_procesadores` |
| Contabilidad | `/contabilidad`, `/asientos`, `/libros`, `/plan-de-cuentas`, `/mapeos`, `/cierres` | Resumen con problemas (`acc_issues`), Diario, Mayor, Sumas y saldos, Resultados, IVA, export a estudios, plan, mapeos y cierre mensual. Mapeos y Cierres no están en el menú (sólo en pestañas). | `contabilidad` |
| Contabilidad > Retenciones sufridas, Ingresos Brutos | `/impuestos/sufridas`, `/impuestos/iibb` | Retenciones y percepciones sufridas (incluye las de cada liquidación), liquidación mensual de IIBB con asiento. | `percepciones_retenciones` |
| Configuración > Integraciones > NubCeo | `/configuracion?seccion=nubceo` | Configuración, Envíos (cola) y Asientos contables (traer por API o CSV, confirmar). | `integracion_nubceo` |
| Compras > Facturas y pagos | `/compras/facturas` | Órdenes de pago que debitan cuentas de Tesorería y cheques. | `compras` |
| POS > Caja | turnos, Z, ingresos y retiros | El efectivo del cajón; sus retiros no llegan a ninguna cuenta de Tesorería. | BASE |

### 1.4 Hallazgos

Severidad: **Alta** = la plata o los asientos pueden quedar mal o contados dos veces; **Media** = dato incompleto o confuso que obliga a trabajo manual; **Baja** = prolijidad.

| # | Sev. | Hallazgo | Evidencia | Qué se hace |
|---|---|---|---|---|
| T1 | **Alta** | **Tesorería desconectada de la operación.** El saldo de cada cuenta sólo suma movimientos manuales, transferencias entre cuentas, cheques y órdenes de pago. Los cobros por transferencia de las ventas, las acreditaciones de Mercado Pago y los retiros del cajón del POS no entran a ninguna cuenta. | `treasury_balances` = `opening_balance` + `treasury_movements`; ningún `insert` en `treasury_movements` desde ventas, `settlement_lines` ni `cash_movements`. `treasury_accounts.transfer_account_id` existe pero nada lo escribe ni lo lee (columna muerta). 84 cobros por transferencia en prod sin destino. | Fase H150 y H151. |
| T2 | **Alta** | **Contabilidad y Tesorería registran la misma plata en cuentas distintas.** El cobro por transferencia va a "Banco cuenta corriente" genérico (`cobro:transfer` → `banco`) y la acreditación de MP a "Mercado Pago (saldo en cuenta)"; los movimientos de Tesorería van a la cuenta contable de **cada** cuenta (`tesoreria:*:<id>`). El Mayor de Banco nunca va a coincidir con el saldo de ninguna cuenta de Tesorería. | `acc_install_template` (mapeos `cobro` y `acreditacion`) vs `acc_sync_treasury_movement`. | H150 (cada cuenta de dinero con su cuenta contable) y H151. |
| T3 | **Alta** (cuando se prendan las dos) | **Doble contabilización con NubCeo.** Con Contabilidad prendida, cada línea de liquidación acreditada genera su asiento (neto, comisión, impuestos contra el cobro). NubCeo devuelve **los asientos de esas mismas liquidaciones** (`ledgerCategory: settlement`). Hoy se guardan aparte (`nubceo_ledger_*`), sin cuenta de nuestro plan, sin control de balance y sin regla de cuál manda. Si el estudio importa los dos, la comisión se cuenta dos veces. | `acc_sync_settlement_line` + `nubceo_ledger_upsert` (no valida debe = haber ni vincula). | H153: una sola fuente por negocio para los asientos de liquidación. |
| T4 | Media | **Importación de asientos de NubCeo podía perder asientos.** Si había más de 20 páginas (4.000 asientos) cortaba y guardaba como "última importación" la hora de inicio: lo no traído quedaba con un `updatedAt` anterior y no volvía nunca. Además, una fila inválida en la página la hacía más corta y se tomaba como la última. | `supabase/functions/nubceo_sync/index.ts`, `importLedger`. | **Arreglado en esta rama** (cursor por el último `updatedAt` traído y fin de páginas por filas crudas, con tests). Falta desplegar la Edge. |
| T5 | Media | **Fechas por defecto en UTC.** La base corre en UTC; `_treasury_move` usa `coalesce(p_date, current_date)`, `cheque_transition` y la anulación de una orden de pago usan `current_date`. Un movimiento cargado entre las 21 y las 24 queda con fecha de mañana (la Contabilidad sí usa hora argentina). | `show TimeZone` = UTC; definiciones vigentes. | `_treasury_move` **arreglado en esta rama** (migración `20261217100000`, sin aplicar). Las otras dos, con T22 en H150. |
| T6 | Media | **El flujo de fondos no ve lo que los procesadores deben.** Proyecta cuenta corriente y cheques, pero no las liquidaciones pendientes de acreditar (`settlement_lines.released = false`) ni las tarjetas a cobrar. | `lib/treasury/cashflow.ts`. | H152. |
| T7 | Media | **Liquidaciones de MP con devolución parcial.** Las comisiones se toman netas de lo devuelto (`charges_details.amounts.refunded`) pero `net_received_amount` no siempre se actualiza: la diferencia va a "Diferencias de redondeo y conciliación". Con devolución total el asiento no se genera (bien). | 3 líneas en prod `refunded` con comisión 0 y neto distinto del bruto; ADR-064 ya lo anota. | H151 (validar con una devolución parcial real; si NubCeo es la fuente, lo resuelve H153). |
| T8 | Media | **Navegación dispersa.** Tesorería cuelga de Compras, Conciliación de Gestión, NubCeo de Configuración, Retenciones sufridas e IIBB de Contabilidad; Mapeos y Cierres no están en el menú. Nada explica cómo se relacionan. | `components/layout/AppShell.tsx`. | H155. |
| T9 | Media | **Asientos de NubCeo sin traducir.** Llegan con el código y nombre de cuenta de NubCeo; no hay tabla de equivalencias con nuestro plan, así que no entran al Diario, al Mayor ni al export al estudio. | `nubceo_ledger_entries` sin `account_id`. | H153. |
| T10 | Baja | **Saldo inicial sin asiento de apertura.** `treasury_accounts.opening_balance` suma en el saldo de Tesorería pero no genera asiento: el Mayor de la cuenta arranca en cero. | `acc_sync_*` no lo contempla; `31-contabilidad.md` §8 lo deja para un asiento manual. | H150 (asiento de apertura sugerido). |
| T11 | Baja | **Cierre de caja con contado $0 sin confirmar.** Tres turnos de prueba cerraron así con faltantes grandes. Con Contabilidad prendida generan asiento de faltante. | `cash_shifts` en prod. | H156 (confirmación al cerrar con contado 0 y esperado mayor a 0). |
| T12 | Baja | **Menú de Conciliación gateado por la feature de tarjetas.** Un plan con `conciliacion_procesadores` y sin `conciliacion_tarjetas` vería el ítem con candado (hoy los planes las traen juntas). | `AppShell.tsx`. | H155 (`featureAny`). |
| T14 | **Alta** | **Devolución reintegrada por Mercado Pago contabilizada contra la Caja.** `acc_sync_sale_return` mandaba todo reintegro que no fuera saldo a favor o cuenta corriente a `cobro:cash`; `refund_method = 'mercadopago'` se sumó después (ADR del reintegro MP) y quedó afuera. La caja contable bajaba sin que saliera efectivo. | Definición vigente en prod; `20261030100100_reintegro_mp.sql`. | **Arreglado en esta rama** (migración `20261217100000`, sin aplicar): va a `cobro:*:mercadopago`. |
| T15 | **Alta** | **El asiento de una liquidación no se corrige.** `acc_sync_settlement_line` contabiliza toda línea acreditada con cobro vinculado, también las marcadas "Ignorar" o con diferencia de monto; si después se desvincula, se vincula a otro cobro o cambia lo devuelto, el asiento queda como estaba. Además acredita "a cobrar" por bruto menos devuelto y no por el cobro del POS: con diferencia de monto queda un residuo. | Funciones vigentes; `settlement_line_resolve` no dispara reversión. | H151: contra-asiento al desvincular, ignorar o cambiar el importe; sólo `matched` contabiliza. |
| T16 | Media | **Contracargo que va y vuelve queda en cero.** Perdido → ganado → perdido deja el asiento de pérdida y su reversión; no se vuelve a contabilizar la pérdida. La baja lógica de una disputa no dispara nada. | `acc_sync_payment_dispute`. | H151 (evento por cambio de estado, no por existencia). |
| T17 | Media | **Señas y medios nuevos sin cuenta.** Los movimientos de caja `deposit_in` / `deposit_out` (señas) no se contabilizan y el medio `sena` cae en "Otros medios de cobro a cobrar", igual que `plataforma`, `mercadolibre` y `ualabis`: queda un saldo a cobrar que nunca se cancela. | `acc_sync_cash_movement` filtra `income` / `expense`; plantilla sin esos medios. | H150 (mapeos y asiento de la seña). |
| T18 | Media | **Cheques de terceros: "Valores a depositar" queda negativo.** Recibir un cheque en cartera no genera asiento, pero depositarlo o endosarlo acredita esa cuenta. El rechazo de un cheque **propio** usa la cuenta de cheques rechazados a cobrar (es un activo). | `cheque_register`, mapeo `tesoreria_mov:cheque_rejected`. | H154. |
| T19 | Media | **Monedas mezcladas.** La pestaña Cuentas sumaba "En caja general" en todas las monedas y sacaba "En bancos" por diferencia (una caja en USD daba bancos negativos) y contaba cuentas inactivas. Los asientos de Tesorería, órdenes de pago y liquidaciones no miran la moneda de la cuenta. | `app/(app)/tesoreria/page.tsx`; `acc_sync_treasury_movement`. | **Pantalla arreglada en esta rama** (`lib/treasury/totals.ts`, con tests). Asientos en otra moneda: H150 (bloquear o convertir con la cotización). |
| T20 | Media | **Regenerar un mes puede perder asientos corridos de un mes cerrado.** Se dan de baja por `entry_date` (ya corrida al mes abierto) pero se reconstruyen por la fecha del documento (del mes cerrado), que no entra en el rango. | `acc_generate(..., true)`. | H150 (regenerar por documento, no por fecha del asiento). |
| T21 | Media | **Archivos de Ualá, MODO, Transferencias y Directo no concilian solos** y pueden emparejar mal cobros con tarjeta por monto y día. | `supabase/functions/settlements/index.ts` (`INTENT_PROVIDERS`). | H152. |
| T22 | Baja | **Cierre de mes con la fecha de UTC.** `acc_period_close` compara contra `current_date`: el último día del mes, después de las 21, deja cerrar el mes en curso. Lo mismo `acc_entry_reverse`, `cheque_transition` y la anulación de la orden de pago. | Definiciones vigentes. | H150. |
| T23 | Baja | **Saldo inicial editable con movimientos.** `opening_balance` y `currency` se pueden cambiar con movimientos cargados; `treasury_balances` ignora `opening_date`. | `20261022100300_tesoreria.sql`. | H150. |
| T24 | Baja | **Tres fuentes de IVA de ventas.** Contabilidad usa `products.tax_rate` (`acc_vat_split`), el reporte del motor de impuestos y el Libro IVA Digital usan el comprobante, NubCeo usa `sales.tax_total`. | `31-contabilidad.md` §8 ya lo anota. | Se unifica con H103 (fuera de F23). |
| T13 | Info | **Mercado Pago devolvió pagos de ventas que siguen completadas** (2 QR de $1.400 en un negocio). La conciliación lo detecta bien (Diferencia de monto + disputa). | `settlement_lines` + `payment_disputes`. | Nada en código; es un aviso operativo para ese negocio. |

Lo que **está bien** y no se toca: el motor de asientos (balance en la base, triggers diferidos que nunca frenan la venta, `acc_issues` con reintento, unicidad por origen, contra-asiento al anular, mes cerrado que corre la fecha al mes abierto), la resolución de mapeos de lo específico a lo general, la cola de NubCeo (idempotencia por `venta_id`, lease, reintentos, borrado de anuladas) y el matching de liquidaciones por id, intent, lote y cupón.

---

## 2. El camino de la plata

```
VENTA (sales)
  │ cobros (payments: método + adquirente/proveedor)
  ▼
┌──────────────────────── ¿dónde queda la plata? ────────────────────────┐
│ Efectivo        → Caja del POS (turno) ──retiro──► Caja fuerte/general │
│                                                  └─depósito─► Banco    │
│ Transferencia   → Cuenta bancaria o billetera elegida en el cobro      │
│ QR / link / Point de MP → "A acreditar Mercado Pago" ──► Billetera MP  │
│ Tarjeta (posnet) → "A acreditar <adquirente>" ──liquidación──► Banco   │
│ Cuenta corriente → Deudores (no es plata hasta que el cliente paga)    │
│ Cheque de tercero → Cartera de cheques ──depósito──► Banco             │
└────────────────────────────────────────────────────────────────────────┘
  │ liquidación del procesador (settlement_lines: bruto, comisión, impuestos, neto)
  ▼
ACREDITACIÓN (neto en banco o billetera; comisión a gasto; impuestos a créditos fiscales)
  │ conciliación: la línea del procesador se vincula al cobro; el movimiento
  │ del banco o billetera se tilda contra el extracto
  ▼
ASIENTO (uno por hecho, en el momento en que pasa; nunca dos veces el mismo hecho)
```

Cada flecha es **un movimiento de dinero** (Tesorería) y **un asiento** (Contabilidad) que nacen del **mismo documento**. Esa es la regla que hoy falta.

| Momento | Documento | Movimiento de Tesorería | Asiento (debe / haber) |
|---|---|---|---|
| Venta cobrada | `sales` + `payments` | Efectivo: suma en la caja del POS. Transferencia: suma en la cuenta destino (**nuevo**, H150). Tarjeta y MP: suma en "a acreditar" del procesador (**nuevo**, cuenta virtual). | Medio del cobro / Ventas + IVA DF (existe) |
| Retiro del cajón | `cash_movements` (expense) | Resta en la caja del POS, suma en caja fuerte o "en tránsito" (**nuevo**, H151). | Caja general o fondos en tránsito / Caja (existe, contra `caja_movimiento`) |
| Depósito en el banco | `treasury_movements` (transfer) | Caja general → Banco (existe). | Banco / Caja general (existe) |
| Liquidación acreditada | `settlement_lines` | "A acreditar" baja por el bruto; banco o billetera sube por el neto (**nuevo**, H151). | Banco o billetera (neto) + Comisiones + Retenciones sufridas / A cobrar del procesador (existe; con la cuenta de la billetera concreta en H151) |
| Retención o percepción sufrida | `tax_suffered_entries` | No mueve plata (ya se descontó en la liquidación). | Reclasificación al impuesto (existe, ADR-095) |
| Contracargo o devolución desde el procesador | `payment_disputes` | Resta en "a acreditar" o en la billetera. | Contracargos / medio del cobro (existe) |
| Pago a proveedor | `supplier_payments` | Resta en la cuenta usada (existe). | Proveedores / medio + retenciones practicadas (existe) |
| Gasto | `treasury_movements` (withdrawal con categoría) | Resta en la cuenta (existe). | Cuenta de gasto elegida / cuenta de dinero (**mejora**, H154: categoría de gasto en lugar de la contrapartida genérica) |
| Impuestos bancarios (SIRCREB, débitos y créditos) | `tax_suffered_entries` con débito en cuenta | Resta en el banco (existe). | Impuesto / Banco (existe) |

---

## 3. Modelo unificado

### 3.1 Cuentas de dinero

`treasury_accounts` pasa a ser **el único lugar donde se define dónde está la plata**. Tipos:

| `kind` | Qué es | Saldo | Ejemplo |
|---|---|---|---|
| `pos_cash` (**nuevo**) | El cajón de cada caja registradora. Una por `cash_registers`, se crea sola. Sólo lectura: se mueve con turnos, ventas, ingresos y retiros. | Teórico del turno abierto, o el contado del último cierre. | "Caja 1 · Centro" |
| `cash` | Caja general, caja fuerte, fondo fijo. | Movimientos. | "Caja fuerte Centro" |
| `bank` | Cuenta bancaria. Puede vincularse a una o más `transfer_accounts` (lo que se cobra por transferencia a ese CBU entra acá). | Movimientos; saldo conciliado contra extracto. | "Galicia CC $" |
| `wallet` (**nuevo**) | Billetera de un procesador (Mercado Pago, Ualá Bis, MODO...). Se vincula a la credencial del proveedor (`provider_key` + `scope_store_id`). | Acreditaciones de liquidación, retiros a banco, pagos. | "Mercado Pago Centro" |
| `receivable` (**nuevo**, virtual) | Lo cobrado que el procesador todavía no liquidó, por proveedor o adquirente. Sólo lectura. | Cobros menos liquidaciones acreditadas, contracargos. | "A acreditar Payway" |

Columnas nuevas: `kind` ampliado, `provider_key`, `cash_register_id`, y una tabla puente `treasury_account_transfer_accounts` (reemplaza la columna muerta `transfer_account_id`, que permite una sola).

### 3.2 Movimientos

`treasury_movements` suma tipos con **origen** (`reference_type`, `reference_id`) y se generan **solos** desde el documento, por trigger diferido (como los asientos):

| Tipo nuevo | Origen | Cuándo |
|---|---|---|
| `sale_collection` | `payments` (transferencia con cuenta destino) | Al commit de la venta. Anular la venta lo anula. |
| `settlement_credit` | `settlement_lines` acreditada (neto) | Al marcarse `released`. |
| `processor_debit` | `payment_disputes` perdidos, devoluciones desde el procesador | Al resolverse. |
| `cash_drop` | `cash_movements` de retiro con destino (caja fuerte o en tránsito) | Al registrar el retiro. |

Los movimientos con origen **no generan asiento propio** (igual que hoy los de órdenes de pago): el asiento lo genera el documento. Así cada hecho tiene un movimiento y un asiento, nunca dos asientos.

### 3.3 Puente con la Contabilidad

- Cada cuenta de dinero resuelve su cuenta contable con el mapeo `tesoreria` calificado por `kind:<id>` (existe). Al crear una cuenta de Tesorería con la Contabilidad prendida, se ofrece crear la subcuenta contable (`1.1.01.05.01 Galicia CC $`) y su mapeo.
- Los mapeos `cobro:transfer` y `acreditacion:<proveedor>` pasan a resolver **primero** la cuenta de Tesorería vinculada (por `transfer_account_id` del cobro o por la billetera del proveedor) y sólo si no hay, la cuenta genérica. Resultado: el Mayor de cada banco y billetera coincide con su saldo en Tesorería.
- Saldo inicial: al guardar `opening_balance` con la Contabilidad prendida, se arma un asiento de apertura (cuenta de dinero / Resultados no asignados) en la fecha de apertura, editable antes de cerrar el mes.

---

## 4. Asientos contables

### 4.1 Reglas

1. **Un hecho, un asiento.** El asiento nace del documento que registra el hecho (venta, liquidación, pago, retiro). Los movimientos derivados no vuelven a contabilizar.
2. **Partida doble garantizada por la base.** `acc_post` rechaza diferencias; el trigger diferido controla al commit. Nada de esto cambia.
3. **Nunca frena la operación.** Si falta un mapeo, el problema queda en Contabilidad > Resumen (`acc_issues`) con el texto en castellano de qué cuenta falta y un botón para mapearla.
4. **Inmutables.** Se corrige con contra-asiento; un mes cerrado corre la fecha al primer día abierto.
5. **Una sola fuente por tipo de hecho.** En particular, las liquidaciones (ver 5.3).

### 4.2 Plan de cuentas y mapeos

Plantilla `comercial_ar` (existe). Se suman (H150, H154):

| Código | Cuenta | Para qué |
|---|---|---|
| 1.1.01.05.NN | Una subcuenta por cada banco de Tesorería | Mayor por banco. |
| 1.1.01.06.NN | Una subcuenta por cada billetera | Mayor por billetera (hoy hay una sola "Mercado Pago"). |
| 1.1.02.06 | Ualá Bis, MODO y otros procesadores a cobrar | Hoy caen en "Otros medios de cobro a cobrar". |
| 5.2.05 | IVA sobre comisiones de procesadores (si el negocio no es RI, va al gasto) | Hoy el IVA de la comisión se suma a "Retenciones e impuestos sufridos en cobros". |
| 5.3.06+ | Categorías de gasto (alquiler, servicios, sueldos...) ya existen como cuentas; se exponen como **categorías** al cargar un gasto. | Que un gasto de Tesorería no caiga en "Gastos bancarios" por defecto. |

Mapeos por medio de pago y por impuesto: siguen la búsqueda actual (`cobro:credit:payway` → `*:payway` → `credit` → `*`). Se suma el calificador por **cuenta de Tesorería** (`cobro:transfer:<treasury_account_id>`) y por **cuotas** (pendiente de H109).

### 4.3 Asientos por evento (estado objetivo)

| Evento | Debe | Haber | Estado |
|---|---|---|---|
| Venta | cada cobro (caja del POS, banco destino, a acreditar del procesador, deudores) | Ventas netas, IVA DF por alícuota, propina; vuelto | Existe; H150 cambia la cuenta de las transferencias. |
| Anulación de venta | contra-asiento | | Existe. |
| Devolución | Devoluciones sobre ventas + IVA DF | medio del reintegro | Existe. |
| Cobro de cuenta corriente | medio del cobro | Deudores | Existe. |
| Retiro o ingreso de caja | Caja general / en tránsito (o la cuenta del gasto) | Caja del POS | Existe; H151 usa la cuenta destino real. |
| Faltante o sobrante del Z | Faltante / Caja, o Caja / Sobrante | | Existe. |
| Liquidación acreditada | Banco o billetera (neto), Comisiones, IVA de comisiones, Retenciones sufridas | A acreditar del procesador (bruto menos devuelto); diferencia a Redondeo | Existe; H151 separa el IVA de la comisión y usa la billetera concreta. Con NubCeo como fuente, no se genera (5.3). |
| Retención o percepción sufrida | Impuesto (IIBB por jurisdicción, IVA, Ganancias, débitos y créditos) | Retenciones sufridas en cobros | Existe (ADR-095). |
| Contracargo | Contracargos | A acreditar o billetera | Existe. |
| Compra | Compras + IVA CF + percepciones | Proveedores | Existe. |
| Pago a proveedor | Proveedores | Cuenta de dinero + retenciones practicadas | Existe. |
| Transferencia entre cuentas | Cuenta destino | Cuenta origen | Existe. |
| Gasto | Categoría de gasto (+ IVA CF si hay comprobante) | Cuenta de dinero | H154 (hoy contra `tesoreria_mov:withdrawal` = fondos en tránsito). |
| Liquidación de IIBB | Impuesto IIBB | Retenciones usadas + IIBB a pagar | Existe. |
| Saldo inicial | Cuenta de dinero | Resultados no asignados | H150. |

---

## 5. NubCeo: ida y vuelta

### 5.1 Cómo lo hace el dueño hoy (ANDESMAR)

- **Ida:** un servicio en Railway manda **una venta por comprobante (FC A, FC B, TF A, TF B) con sus pagos adentro** a `POST /v1/tenants/:tenant/reconciler/sales`, cada 30 s, lunes a sábado de 8 a 21, con 2 minutos de espera. Idempotente por `venta_id` (número del bridge de Napse). Mercado Libre va todo como `mercadopago_ar`.
- **Vuelta:** **sólo la respuesta del envío** (insertada, ya existía, rechazada, no se puede borrar porque NubCeo ya la concilió). ANDESMAR **no lee** el estado de conciliación ni los asientos (`ledger-header` quedó explícitamente fuera de alcance).
- **Asientos:** el cierre mensual de Mercado Libre arma **minutas** a mano (comisiones de ML, Melilog y cuotas como minuta a proveedores; retenciones por provincia como recibo a clientes; percepciones y asesoría de las facturas de ML) y se copian al ERP. El Cruce de IVA controla factura contra Libro IVA y recibo contra Libro Caja; no genera asientos.

### 5.2 Cómo lo hace NinjaPOS (ya construido, ADR-062)

- **Ida:** igual que ANDESMAR pero nativo (Edge `nubceo_sync` + pg_cron): una venta completada con sus cobros incluidos (efectivo, débito, crédito, transferencia, QR, Directo; no cuenta corriente, vale ni otro), con plataforma por medio, proveedor o terminal del cupón, n° de comercio, lote, cupón y autorización. Ritmo y ventana configurables, solo simular, borrado al anular, nota de crédito en devoluciones en efectivo.
- **Vuelta, ya hecha:** respuesta del envío (como ANDESMAR) **y** los asientos de NubCeo por API (`GET /accounting/ledger-header`) o CSV, con confirmar y desconfirmar.
- **Vuelta, falta:** estado de conciliación por venta (`GET /reconciler/sales` con `reconciliationStatus`) y usar los asientos.

### 5.3 Una sola fuente para los asientos de liquidación (H153)

Configuración nueva en Contabilidad > Mapeos, sección "Liquidaciones de procesadores", con dos opciones:

| Opción | Quién arma el asiento de cada liquidación | Para quién |
|---|---|---|
| **NinjaPOS** (por defecto) | `acc_sync_settlement_line` desde la conciliación propia (MP por API, el resto por archivo). Los asientos de NubCeo se ven como control, no entran al Diario. | Negocios sin NubCeo, o con NubCeo sólo para conciliar. |
| **NubCeo** | Los asientos importados de NubCeo, traducidos a nuestro plan con una **tabla de equivalencias** (`nubceo_account_map`: código de cuenta y subcuenta de NubCeo → `acc_accounts`), entran al Diario como `source_type = 'nubceo_ledger'` (uno por cabecera, sólo los que balancean). `acc_sync_settlement_line` no genera nada para las líneas del período. | Negocios que ya tienen NubCeo armado con su estudio (como ANDESMAR). |

Controles en las dos: asiento de NubCeo que no balancea queda en `acc_issues` con el detalle; cuenta de NubCeo sin equivalencia queda en `acc_issues` con el botón "Mapear"; el cambio de opción sólo vale desde el primer día de un mes abierto.

### 5.4 Estado de conciliación de NubCeo (H153)

Una vuelta diaria pide `GET /reconciler/sales?getReconciledSales=true` del período enviado y guarda por venta y pago `reconciliationStatus` en `nubceo_sync` (`reconciled_status`, `reconciled_at`). Se muestra en Conciliación como una columna más ("NubCeo: conciliada / pendiente / con diferencia") y alimenta el estado del cobro cuando NubCeo es la fuente.

---

## 6. Navegación de Tesorería (H155)

Un grupo propio **Tesorería** en el menú, en este orden. Cada pantalla abre con una línea que dice qué es y un estado vacío que dice qué hacer.

| Ítem | Ruta | Qué muestra | Explicación corta (copy) | Estado vacío |
|---|---|---|---|---|
| **Posición** | `/tesoreria` | Cuánta plata hay y dónde: cajas del POS, caja fuerte, bancos, billeteras y "a acreditar" por procesador, con total y lo que entra en los próximos 7 días. | "Toda tu plata en un lugar: lo que está en las cajas, en el banco, en Mercado Pago y lo que todavía te tienen que acreditar." | "Todavía no cargaste cuentas. Sumá tu banco y tu billetera para ver tu plata junta." + "Agregar cuenta". |
| **Movimientos** | `/tesoreria/movimientos` | Todo lo que entró y salió, con origen (venta, liquidación, pago, gasto, manual) y link al documento y al asiento. | "Cada entrada y salida de plata, con el comprobante que la generó." | "Cuando cobres por transferencia o te acrediten una liquidación, aparece acá solo." |
| **A acreditar** | `/tesoreria/a-acreditar` | Cobros con tarjeta y billeteras pendientes de liquidar, por procesador y fecha estimada. | "Lo que ya vendiste y el procesador todavía no te depositó." | "No tenés cobros pendientes de acreditar. Conectá Mercado Pago o subí la liquidación de tu adquirente." |
| **Conciliación** | `/tesoreria/conciliacion` (hoy `/reportes/conciliacion`, con redirección) | Procesadores, tarjetas por lote, pendientes de revisar y, en H152, el extracto del banco. | "Controlá que lo vendido llegue a tu cuenta y que el banco diga lo mismo que el sistema." | "Para conciliar, conectá Mercado Pago o subí una liquidación." |
| **Cheques** | `/tesoreria/cheques` | Cartera y propios (la pestaña de hoy). | "Cheques que recibiste y que diste, con su vencimiento." | "No tenés cheques en cartera." |
| **Flujo de fondos** | `/tesoreria/flujo` | Proyección con a acreditar, cuenta corriente, cheques y pagos. | "Cuánta plata vas a tener los próximos días si todo se cobra y se paga a tiempo." | "Cargá tus cuentas para proyectar." |
| **NubCeo** | `/tesoreria/nubceo` (la configuración sigue en Configuración) | Envíos, estado de conciliación y asientos que devolvió. | "Lo que le mandás a NubCeo y lo que te devuelve conciliado." | Promo actual de NubCeo con "Configurar". |

**Contabilidad** queda como grupo propio con Resumen, Asientos, Libros, Plan de cuentas, **Mapeos** y **Cierres** (los dos últimos pasan al menú). **Impuestos** pasa a grupo propio con Retenciones sufridas, Ingresos Brutos, Retenciones practicadas y Libro IVA Digital. En cada pantalla de Tesorería, el renglón con asiento muestra "Ver asiento" y cada asiento muestra "Ver origen".

---

## 7. Fases (F23)

Toda función nueva sigue el checklist de §6 de `CLAUDE.md`: key en `features`, marcada en `plans.limits.modules`, gating server-side con `tenant_has_feature_for`, copy en `lib/saas/featureInfo.ts` y comparación de planes derivada.

| Hito | Qué | Migraciones / Edges | Feature | Criterio de cierre |
|---|---|---|---|---|
| **H150** · Cuentas de dinero unificadas | Tipos `pos_cash`, `wallet`, `receivable`; puente con `transfer_accounts`; cobros por transferencia a su cuenta; mapeo contable por cuenta de Tesorería; asiento de saldo inicial y saldo inicial bloqueado con movimientos (T10, T23); fechas en hora argentina (T5, T22); señas y medios sin cuenta (T17); moneda de la cuenta en los asientos (T19); regenerar por documento (T20). | `treasury_accounts` (kind, provider_key, cash_register_id), `treasury_account_transfer_accounts`, `treasury_movements` (tipos con origen), trigger diferido en `payments`, `_treasury_move`, `cheque_transition` y anulación de OP con fecha AR, `acc_payment_qualifier` con la cuenta de Tesorería. | `tesoreria` (OPTIONAL, existe). Las cuentas `pos_cash` se ven en BASE dentro de Caja. | Una venta por transferencia a "Galicia" suma en Galicia en Tesorería y en el Mayor de la subcuenta Galicia, al centavo; anularla resta en los dos. |
| **H151** · Liquidaciones a la billetera | Acreditación de `settlement_lines` como movimiento en la billetera o banco; retiros del cajón con destino; IVA de la comisión separado; asiento de liquidación sólo para líneas conciliadas y con contra-asiento al desvincular, ignorar o cambiar lo devuelto (T7, T15); contracargos por cambio de estado (T16). | Trigger diferido en `settlement_lines` y `cash_movements`; mapeos `acreditacion` por billetera; cuenta 5.2.05. | `conciliacion_procesadores` (existe). | Un mes de MP: saldo de la billetera en Tesorería = saldo del extracto de MP = Mayor de la billetera; comisión e IVA de comisión en cuentas separadas. |
| **H152** · A acreditar, extracto bancario y flujo | Pantalla A acreditar; import de extracto (CSV, XLSX, OFX) con matching contra movimientos; flujo de fondos con a acreditar (T6); presets y matching por intent para Ualá, MODO, Transferencias y Directo (T21). | `bank_statement_imports`, `bank_statement_lines`; RPC de matching. | `conciliacion_bancaria` (**nueva**, OPTIONAL, Business; existe en el roadmap H110). | El dueño sube el extracto de un mes y ve tildados los movimientos que coinciden; los que no, en "Pendientes de revisar". |
| **H153** · NubCeo integrado a la Contabilidad | Fuente de los asientos de liquidación; tabla de equivalencias; importación de asientos de NubCeo al Diario con control de balance; estado de conciliación por venta. | `nubceo_account_map`, `acc_settings.settlement_source`, `acc_sync_nubceo_ledger`, `nubceo_sync.reconciled_status`; Edge `nubceo_sync` con `reconciliation_pull`. | `integracion_nubceo` (existe) + `contabilidad` (existe). | Con fuente NubCeo, un mes importado da un Diario donde cada liquidación aparece una sola vez y Sumas y saldos cierra; con fuente NinjaPOS, los asientos de NubCeo se ven como control y no entran al Diario. |
| **H154** · Gastos con categoría | Cargar un gasto desde Tesorería con categoría (cuenta de gasto), comprobante opcional (IVA CF) y adjunto; asiento al recibir un cheque de tercero y rechazo de cheque propio contra la deuda (T18). | `treasury_movements.expense_account_id`, `proof_path`; mapeo `tesoreria_mov:withdrawal` deja de ser el destino por defecto. | `tesoreria` (existe). | Un gasto de alquiler pagado desde Galicia aparece en el Mayor de Alquileres, no en Gastos bancarios. |
| **H155** · Navegación y copy | Grupo Tesorería, rutas nuevas con redirecciones, Mapeos y Cierres en el menú, grupo Impuestos, "Ver asiento" y "Ver origen", estados vacíos de §6, `featureAny` para Conciliación (T12). | Sin migraciones. | Sin features nuevas. | Un dueño nuevo encuentra desde el menú dónde está su plata, qué falta acreditar y el asiento de una venta en menos de tres clics. |
| **H156** · Controles de caja | Confirmación al cerrar con contado 0 y esperado mayor a 0 (T11); conciliación del Z con motivo (pendiente de H110). | RPC de cierre (sin cambiar `close_cash_shift`, validación previa en la UI y RPC de confirmación). | BASE. | No se puede cerrar con contado 0 y esperado positivo sin confirmarlo. |
| **H157** · Prueba de punta a punta | Caso guionado: un día con efectivo, transferencia, QR de MP y tarjeta Payway; retiro y depósito; liquidación; cierre de mes; export al estudio. | Test de integración nuevo (`tests/integration/tesoreria-e2e.test.ts`). | | Los saldos de Tesorería, el Mayor y Sumas y saldos cuadran al centavo y el export abre en Xubio. |

**Orden:** H150 → H151 → H155 (se puede en paralelo desde H150) → H152 → H153 → H154 → H156 → H157.

---

## 8. Arreglado en esta fase

- **T4:** `importLedger` (Edge `nubceo_sync`) ahora sigue desde el `updatedAt` del último asiento traído cuando corta por el tope de páginas, y decide si hay más páginas por las filas crudas que devolvió NubCeo. Lógica pura en `ledgerNextCursor` y `parseLedgerPage` (`supabase/functions/_shared/nubceo.ts`), tests en `tests/unit/nubceo.test.ts`. **Requiere desplegar la Edge** (no se desplegó).
- **T14:** devolución reintegrada por Mercado Pago contra la cuenta del cobro de MP, no contra la Caja. Migración `20261217100100_tesoreria_fixes_auditoria.sql` (**sin aplicar**), test en `tests/unit/accounting.test.ts`. Hoy no hay negocios con Contabilidad prendida, así que no hay asientos para corregir.
- **T5 (parcial):** `_treasury_move` sin fecha toma el día de Argentina (misma migración).
- **T19 (pantalla):** totales de la pestaña Cuentas sólo en pesos y con cuentas activas; lo que está en otra moneda se muestra aparte. `lib/treasury/totals.ts`, tests en `tests/unit/treasuryTotals.test.ts`; el flujo de fondos usa la misma función.

### 8.1 H150, H154, H155 y H156 (ADR-158, `feat/tesoreria-cuentas-unificadas`)

Migraciones `20261227100000_tesoreria_cuentas_unificadas`, `20261227100100_tesoreria_asientos_por_cuenta` y `20261227100200_caja_controles_cierre` (sin aplicar, en ese orden). Sin Edges.

| Hallazgo | Qué quedó |
|---|---|
| T1 | Cajas del POS (`pos_cash`), billeteras (`wallet`) y "a acreditar" (`receivable`) son cuentas de Tesorería. Las cuentas de cobro por transferencia se vinculan a un banco o billetera (`treasury_account_transfer_accounts`) y cada cobro suma un movimiento `sale_collection` (la anulación, `sale_collection_void`). |
| T2 | El cobro por transferencia vinculado y los movimientos de cada cuenta van a la cuenta contable de esa cuenta (`acc_treasury_account`, subcuenta propia con "Crear su cuenta contable"). Mayor = saldo de Tesorería. |
| T5, T22 | Fechas de Argentina en cheques, anulación de órdenes de pago, cierre de mes, reversión manual y problemas de Contabilidad. |
| T10, T23 | Asiento de saldo inicial contra Resultados no asignados; saldo inicial, fecha y moneda fijos cuando hay movimientos. |
| T11 | Cierre con $0 contados y esperado positivo sólo con confirmación y motivo; revisión del Z con tipo y motivo. |
| T12 | Conciliación en el menú con cualquiera de sus dos features. |
| T17 | Señas cobradas, devueltas y aplicadas con su asiento (cuenta "Señas recibidas de clientes"); Ualá Bis, MODO, Mercado Libre y plataformas con cuenta propia. |
| T18 | Cheque de terceros con asiento al recibirlo y al rechazarlo sin depositar; cheque propio rechazado contra la deuda con el proveedor. |
| T19 | Movimientos y saldos en otra moneda pasados a pesos con la cotización del día (o un problema en Contabilidad > Resumen si no hay). |
| T20 | Regenerar un período da de baja sólo los asientos de los documentos del rango. |
| T3 (preparado) | `acc_settings.settlement_source` (`ninjapos` por defecto): con `nubceo` la conciliación propia no arma asientos de liquidación. Supuesto hasta la respuesta del dueño: todos en `ninjapos`, sin forma de cambiarlo (H153). |
| T8 (H155) | Grupo Tesorería (Posición, Movimientos, A acreditar, Conciliación, Cheques, Flujo de fondos, NubCeo), Mapeos y Cierres en Contabilidad, grupo Impuestos, "Ver asiento" y "Ver origen". |

Gasto (H154): en un retiro se elige la cuenta de gasto, el número de comprobante, el IVA y un adjunto (bucket privado `treasury-proofs`). El asiento va a la cuenta de gasto y el IVA a crédito fiscal (si el negocio discrimina IVA). El cheque de terceros cancela "Otros medios de cobro a cobrar": si paga una venta o una cuenta corriente, ese cobro se registra con el medio Otro.

## 9. Preguntas para el dueño

1. ¿Querés que NubCeo sea la fuente de los asientos de liquidación en los negocios que lo usen (como en ANDESMAR con su estudio), o preferís que NinjaPOS los arme y NubCeo quede como control?
2. ¿El estudio usa un plan de cuentas propio para las liquidaciones de NubCeo? Si nos pasás un export de asientos de NubCeo de un mes, armamos la tabla de equivalencias y confirmamos el signo de `amount` (hoy se asume positivo = Debe).
3. Las minutas del cierre de Mercado Libre de ANDESMAR (comisiones, Melilog, cuotas, retenciones por provincia, percepciones y asesoría): ¿las querés como asientos automáticos en NinjaPOS cuando se use Mercado Libre? Entrarían en H151 como liquidación de un procesador más.
4. ¿Las cajas del POS tienen que poder depositar directo al banco o siempre pasan por la caja fuerte?
