# 42 · Listas de precios, costos y actualización por dólar

Fecha: 2026-10-15 · Decisión: [ADR-140](./17-decision-log.md) · Base: [ADR-056](./17-decision-log.md) (precio en el servidor), [ADR-058](./17-decision-log.md) (listas PRO), [ADR-050](./17-decision-log.md) (costos de compra), [ADR-068](./17-decision-log.md) (IVA e internos), [ADR-135](./17-decision-log.md) (cotización del dólar).

> Pedido del dueño: "En la configuración de listas de precios ofrecer actualizar precios en las listas que quiero o categorías que quiera por costo del dólar usando la API de dólar. Debo poder configurar costo de producto, costo final, utilidad calculada; bien robusto las listas de precios y configurable fácil y con configuración avanzada. Auditá en ERP robustos cómo lo hacen."

---

## 1. Cómo lo resuelven los ERP que miramos

| ERP | Cómo arma el precio | Actualización masiva | Moneda extranjera | Lo que tomamos |
|---|---|---|---|---|
| **Odoo** (Sales, Pricelists) | Una lista tiene **reglas** ordenadas por alcance (producto, variante, categoría, todo) con cantidad mínima y vigencia. Cada regla calcula: precio fijo, % de descuento, o **fórmula** sobre una base (precio de venta, **costo** u **otra lista**): `base × (1 − descuento) + recargo`, **redondeo** (`price_round`, p. ej. a 10 con recargo de −0,01 para terminar en 9,99) y **margen mínimo y máximo** sobre la base. | No hay "lote": se cambia la regla y todo se recalcula. El costo se actualiza por compras o a mano. | La lista tiene moneda; convierte con la tasa de la compañía al día. | Lista **derivada de otra** o **sobre costo** con fórmula (ya en ADR-058), redondeo con terminación, **margen mínimo** como piso (se suma un piso global sobre el costo final), **vigencia** y escalas por cantidad. |
| **Tango Gestión** (Ventas, Listas de precios) | Listas con o sin IVA incluido, en **moneda local o extranjera**. Precio por artículo; listas "vinculadas" a una lista base con un % o coeficiente. Costo de reposición del artículo y **utilidad** por lista. | **Actualización masiva de precios** por rango de artículos, familia o proveedor: por %, por importe, o **por costo + utilidad**; con vista previa y redondeo. Actualización por **cotización** cuando la lista es en dólares. | Listas en USD que se convierten a la cotización del día al facturar, o costos en USD que se pasan a pesos con la cotización. | Asistente con **filtros** (categorías, marcas, proveedores), **modo "por costo y utilidad"**, **por dólar**, **vista previa** con antes y después, y **redondeo**. Costo en USD con la cotización. |
| **Bejerman** | Lista base y listas con **coeficiente** sobre la base. Costo de reposición con **componentes** (flete, gastos) para el costo final y margen por lista. | Actualización por % o coeficiente por rubro o proveedor; recalcular desde costo de reposición. | Costos en moneda extranjera con cotización. | **Componentes del costo** (flete, gastos, impuestos no recuperables) → **costo final**; recalcular desde costo. |
| **SAP Business One** (Price Lists) | Cada lista tiene **lista base + factor** (`precio = base × factor`) y **método de redondeo** (a entero, a 10, terminación). Precios especiales por socio de negocio, **descuentos por período y por volumen**. | "Actualizar lista por selección": recalcula las listas derivadas o cambia el factor; **precios manuales** que pisan el factor. | Precio primario y adicional en otra moneda; tipo de cambio del día. | **Base × factor** = lista derivada con % (ya en ADR-058), **precio fijo que pisa la regla** (ítem de lista), escalas por cantidad, precio por cliente (asignaciones). |
| **Dux Software / Xubio** (pymes argentinas) | Producto con **costo**, **% de utilidad** y precio calculado; listas con % sobre una lista base. | Actualización masiva por %, por rubro o proveedor, con redondeo; importación desde Excel del proveedor. | Costo en dólares con cotización (Dux trae la del BNA). | Modo **simple**: lista con % sobre costo o precio y redondeo, y un botón **Actualizar por dólar**. Explicar **markup vs margen** en pantalla. |

Patrones comunes que adoptamos:

1. **Separar costo de precio.** El costo (de compra, de reposición, final) vive en el producto; el precio sale de una regla (lista) o queda fijo. Una regla nunca pisa un precio fijo cargado a mano.
2. **Una sola resolución.** El precio que se cobra se calcula en un solo lugar (servidor) y la pantalla usa un espejo exacto. En NinjaSoft: `_resolve_unit_price` (SQL) y `resolveUnitPrice` (TS) con paridad probada (ADR-056, ADR-058).
3. **Cambios masivos con vista previa, auditoría y vuelta atrás.** Todos los ERP serios muestran antes y después; Tango y SAP guardan el lote. Acá el lote guarda precios y costos anteriores para deshacer.
4. **Moneda extranjera por cotización con fecha.** Se usa "la cotización del día o la última anterior", nunca una futura.
5. **Simple por defecto, avanzado opcional.** Odoo esconde las fórmulas detrás de "Configuración avanzada de listas"; Tango y Dux arrancan con % y redondeo.

## 2. Modelo de costos del producto

```
costo de compra (pesos)              products.cost (sigue a la base de costo de compras, ADR-050)
  o en dólares:  cost_usd × cotización = cost    (cost_currency = 'USD', cost_fx_rate, cost_fx_date)
+ componentes (cost_extras)           impuestos internos y percepciones no recuperables, flete, otros
                                      cada uno en % sobre el costo de compra o en $ (negativo = bonificación)
= costo final (final_cost)
utilidad objetivo (markup_mode, markup_pct)
  markup: precio neto = costo final × (1 + m)        costo 100, markup 50 % → 150
  margen: precio neto = costo final / (1 − m)        costo 100, margen 50 % → 200
precio sugerido = precio neto × (1 + IVA) si el negocio discrimina IVA
utilidad calculada = precio sin IVA − costo final, en $ y en % (markup y margen)
```

- **Markup vs margen**, como se explica en pantalla: el markup es cuánto le sumás al costo; el margen es qué parte del precio es ganancia. Para el mismo precio el markup siempre es mayor (markup 50 % = margen 33,3 %).
- Los costos son **netos de IVA** (el IVA de compra es crédito fiscal). El precio de venta del producto es **final con IVA**; la utilidad se mide sobre el precio sin IVA.
- **Costo en dólares.** Invariante `cost = round(cost_usd × cost_fx_rate, 2)`. Si una recepción o una carga en pesos cambia el costo, el costo en dólares la sigue (`cost / cotización`). La cotización del producto **sólo cambia con un lote** (manual o automático), así un movimiento del dólar nunca cambia en silencio lo que cobra el POS.

## 3. Listas de precios

Ya existía (ADR-058): lista fija (% y monto sobre el precio de venta, precios fijos por producto), **derivada** de otra (% y monto sobre la madre, hasta 4 niveles), **sobre costo** (markup o margen), **en moneda extranjera** (precio en USD × cotización), **redondeo** (múltiplo o terminación, arriba, abajo o al más cercano), **vigencia** desde y hasta, **escalas por cantidad**, **plazos** con recargo, **precio mínimo** y **margen mínimo** de la lista, asignación por **cliente, grupo, sucursal y grupo de sucursales**, elegibles en el POS, precios **programados**, lista **sin IVA** (el servidor suma el IVA).

Lo que suma ADR-140:

- **Base "costo final"** en las listas sobre costo y en el margen mínimo de la lista.
- **Piso global** (`price_settings.floor_margin_pct`, PRO, sólo el dueño): nadie vende por debajo de `costo final / (1 − m)` con IVA si la lista lo lleva. Aplica en el POS, el catálogo y Mercado Libre porque está en `_resolve_unit_price`.
- **Canales:** POS (mostrador y elegibles), catálogo público (lista del canal `catalogo`) y Mercado Libre (la lista elegida en la cuenta de ML) resuelven con la **misma función**. `_catalog_unit_price` ahora pasa por `_resolve_unit_price` con la lista explícita: el catálogo muestra exactamente lo que cobraría el POS con esa lista (derivadas, sobre costo, redondeo, mínimos e IVA incluidos).
- **Dólar de la plataforma** en las listas en moneda extranjera (fuente `oficial`): ver §5.

## 4. Asistente "Actualizar precios"

Cuatro pasos, todo calculado en el servidor (`price_bulk_v2_preview` / `price_bulk_v2_create`):

1. **Qué:** categorías en árbol (incluye subcategorías), marcas, proveedores, etiqueta, "sólo productos con costo en dólares". **Qué precios:** precio de venta y los precios fijos de las listas elegidas (las derivadas y sobre costo se recalculan solas).
2. **Cómo:**
   - **Dólar:** recalcula el costo en pesos de los productos en USD con la cotización oficial venta del día (o la del negocio, BNA, MEP, o una manual). El precio: **mantener la ganancia** (precio × costo final nuevo / costo final viejo), **utilidad objetivo** del producto, o **sólo el costo**.
   - **%** o **monto** (como antes).
   - **Markup** o **margen** nuevo sobre el costo final.
   - **Desde costo:** con la utilidad objetivo de cada producto.
   - **Índice** (IPC u otro, PRO, asistente v1).
   - **Redondeo** sobre lo calculado. Los precios fijos de listas y variantes acompañan al precio de venta en la misma proporción.
3. **Cuándo:** ahora o en una fecha (por dólar, siempre ahora). Motivo opcional, que queda en el historial de cada precio.
4. **Revisar:** tabla con miniatura, precio actual y nuevo, diferencia, costo final, margen resultante y alertas: **debajo del costo**, **debajo del mínimo** (el POS cobraría el mínimo) y **margen bajo** (umbral de Alertas de margen, 20 % por defecto). Filtro "Con alerta".

Al aplicar: lote auditado (`audit_logs`), historial de precios y de costos con **lote y motivo**, y **Deshacer** (vuelve precios y cotización de los costos que nadie cambió después). Con aprobación activa (PRO), el encargado lo deja pendiente y el dueño aprueba.

**Automático:** reglas `price_fx_rules` "cuando el dólar se mueva más de X %" con filtros, destino, modo de precio y redondeo. pg_cron `price-fx-auto` a las 9:45 y 18:45 de Argentina (30 minutos después de la sincronización de ADR-135) compara la cotización con la base de la regla; si supera el umbral arma el lote (aplicado o **pendiente de aprobación**, por defecto) y avisa al dueño. La base se mueve a la cotización nueva: cada salto se procesa una vez.

## 5. Cotización: plataforma y negocio

- **Plataforma (ADR-135):** `platform_fx_rates`, oficial venta de ArgentinaDatos todos los días, con carga manual del staff que manda sobre la de la API ese día.
- **Negocio (ADR-058):** `fx_rates` por negocio (oficial, BNA, MEP, manual), cargada a mano en Dólar e índices.
- **Regla (`fx_usd_quote`, espejo `pickFxQuote` y `fxRate` en TS):** para una fecha, se toma la cotización **del día o la última anterior** de cada origen; gana la **fecha más nueva**; si empatan, **la del negocio** (la fijó el dueño a mano). La de la plataforma sólo existe para la fuente `oficial`. Así el negocio usa la oficial de NinjaSoft por defecto y puede fijar la suya cuando quiera (por ejemplo, el dólar con el que le factura su proveedor).

## 6. Plan (CLAUDE.md §6)

| Key | Categoría | Planes | Gating server-side |
|---|---|---|---|
| `costo_final` | BASE (`is_basic`) | Todos salvo apagado explícito | `trg_products_costing` rechaza componentes o utilidad objetivo nuevos |
| `precios_usd` | OPTIONAL | Pro, Business, Enterprise | `trg_products_costing` (pasar a USD o cambiar el costo en USD), `_price_bulk_v2_assert` (modo dólar), `price_fx_rule_save` y `price_fx_auto_tick` |
| `listas_precios` | OPTIONAL (existe) | Business, Enterprise | listas destino del asistente (`_price_bulk_v2_assert`) |
| `listas_precios_pro` | OPTIONAL (existe) | Business, Enterprise | base "costo final" (`trg_price_lists_pro`), piso global (`price_settings_save`, y el resolver sólo lo aplica con PRO), aprobación |

## 7. Pendiente

- Costo en USD por variante (hoy el costo es por producto, como en ADR-050).
- Precio de lista en USD por producto sin lista en moneda (hoy: lista en moneda extranjera con ítems en USD).
- Simulación de listas derivadas y sobre costo en la vista previa (hoy se informan sólo los precios fijos que cambian; las reglas se recalculan solas al cobrar).
- Regla automática por otra moneda que no sea USD.
