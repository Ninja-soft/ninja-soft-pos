# H10 — Variantes de producto + listas de precios por canal

> Spec aprobada en diseño colaborativo (2026-06-06). Hito H10 del roadmap (F6).

## Objetivo

Productos con variantes (talle/color o cualquier par de ejes) con stock/SKU/precio propios, y listas de precios por canal (mostrador / catálogo / mayorista) que dejan la gancha lista para Mercado Libre (H87).

## Decisión de diseño

**Ejes genéricos + matriz de combinaciones** (no tablas fijas talle/color, no productos hijos duplicados): `products.variant_axes` define hasta 2 ejes con nombre libre; `product_variants` tiene una fila por combinación.

## Modelo de datos

### `products` (alter)

- `has_variants boolean default false`
- `variant_axes jsonb` — ej. `["Talle","Color"]` (máx. 2)

Con `has_variants`, el stock vive en las variantes; el padre muestra la suma (vista o cálculo en query).

### `product_variants` (tabla nueva)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | RLS por tenant |
| `product_id` | uuid FK | |
| `option1` | text | valor del eje 1 (ej. "M") |
| `option2` | text nullable | valor del eje 2 (ej. "Rojo") |
| `sku` | text | auto-sufijado del padre: `REM-001-M-ROJO` (editable) |
| `barcode` | text nullable | escaneable directo en POS |
| `price_override` | numeric nullable | null = precio del padre |
| `stock` | numeric default 0 | |
| `deleted_at` | | baja lógica |

Único parcial por `(product_id, option1, option2)` activo. RLS igual que `products`.

### `price_lists` + `price_list_items` (tablas nuevas)

`price_lists`: `tenant_id`, `name`, `channel` (`mostrador` | `catalogo` | `mayorista` | `custom`), `adjustment_pct numeric nullable` (ajuste % global opcional), `is_active`, baja lógica. RLS escritura owner/manager.

`price_list_items`: `price_list_id`, `product_id`, `variant_id nullable`, `price`. Único por (lista, producto, variante).

**Resolución de precio** (helper compartido): item de lista por variante → item de lista por producto → `adjustment_pct` de la lista sobre el precio base → precio base (con `price_override` de variante).

## Venta

- `create_sale` (RPC): `items[].variant_id` opcional. Si el producto `has_variants`, exige `variant_id` válido, descuenta stock de la variante (respeta `track_stock`/`allow_negative` del padre). Venta de padre sin variante → error claro.
- `sale_items.variant_id` (alter) + descripción de la variante en el nombre de línea (ej. "Remera básica — M / Rojo") para tickets y reportes.
- Devoluciones (`return_sale`): destino de stock repone a la variante.

## POS

- Producto con variantes → **picker de variante** al agregar (mismo patrón que el picker de serial), con stock visible por combinación.
- Scanner: barcode de variante matchea directo (extiende `productsApi.findByCode`).
- Precio mostrador: lista `mostrador` activa si existe, si no precio base.

## Editor de variantes (ProductFormModal)

Sección "Variantes" (patrón `SerialsEditor`/`KitComponentsEditor`):

1. Definir ejes y valores: "Talle: S, M, L" × "Color: Rojo, Negro".
2. Generar matriz de combinaciones.
3. Editar por fila: SKU (pregenerado), barcode, precio override, stock.

Incompatibilidades: un producto serializado o kit no puede tener variantes (validación en form y en DB vía constraint/trigger).

## Catálogo público

`/c/<slug>` (RPC `public_catalog`): muestra variantes disponibles (opciones + precio resuelto con lista `catalogo` si existe). Sin carrito (difiere a F12/F13 según roadmap).

## UI listas de precios

Configuración → **Listas de precios**: CRUD de listas, edición de precios por producto/variante (tabla con búsqueda), ajuste % global. Solo owner/manager.

## Testing

- Unit: generación de matriz, auto-SKU, resolución de precio (todas las precedencias).
- RLS: `product_variants`, `price_lists`, `price_list_items`.
- Integración: `create_sale` con variante (descuento de stock correcto, validaciones), devolución repone variante.

## Entrega

Un PR (`feature/h10-variants-price-lists`), después de H9b.

## Fuera de alcance

- Carrito/pedido en catálogo público (F12/F13).
- Stock por depósito (F11/H33).
- Canal Mercado Libre (H87) — esta spec solo deja `channel` extensible.
