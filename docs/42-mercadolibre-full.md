# 42 · Mercado Libre Full (ADR-142)

Control del stock que el negocio tiene en **Mercado Libre Full** (fulfillment) desde el POS: depósito virtual por cuenta, envíos a Full con tránsito y conciliación, etiquetas por unidad y por bulto, cobertura con alertas de quiebre y costos. Sigue la fase v2 de [`38-mercadolibre.md`](./38-mercadolibre.md) ("depósito virtual Full" y "planificador de envíos a Full").

Pedido del dueño: *"Ojo con Full: quiero tener control del stock de Full en el sistema y poder seguir el control de stock, transferir mercadería a Full, imprimir las etiquetas que Full exige, que sea robusto y bien explicado."*

Fuente: documentación oficial de developers.mercadolibre.com.ar (Envíos Fulfillment, Reportes de facturación, Convivencia Full y Flex), leída el 2026-10-15. Lo marcado **[confirmar]** hay que validarlo con una cuenta real que use Full.

---

## 1. Cómo lo ve el negocio

Mercado Libre > pestaña **Full** (dueño o encargado; feature `mercadolibre_full`):

| Sección | Qué muestra |
|---|---|
| Encabezado | Depósito Mercado Libre Full de la cuenta, "No se vende en el mostrador", última sincronización, **Sincronizar** y **Configuración** (días de llegada, cobertura objetivo, tamaño de etiqueta) |
| **Stock en Full** | Totales (disponible, no disponible, en camino, propio vinculado), alerta de quiebre con **Armar envío con lo sugerido**, y por producto: disponible, no disponible (con motivos y condiciones), en camino, stock propio, vendidas en 30 días, días de cobertura y cuánto conviene mandar |
| **Envíos a Full** | Historial con estado, número de ML, bultos y próximo paso; editar, cargar número de ML, etiquetas, despachar, recepción y cancelar |
| **Costos** | Cargos de Full del resumen de facturación de ML por período (sólo dueño o encargado) |
| **Cómo funciona** | Paso a paso de un envío (marca lo ya hecho), motivos de no disponible, glosario y "cómo comprobarlo vos" |

### 1.1 Reglas de stock

- El depósito Full **no es un depósito de ADR-085**: un depósito de ADR-085 es parte del stock de la sucursal y se puede vender en el mostrador; lo de Full está en el centro de ML y sólo lo vende ML. Por eso vive aparte (`ml_full_inventory`) y nunca suma al disponible del POS. Con el rediseño de depósitos en curso (rama `feat/depositos-entregas-remitos`, todavía no publicada al momento de esta rama), Full equivale a un depósito **no vendible** y de sólo lectura; se mantiene aparte porque su número lo decide Mercado Libre y no toca `warehouses` ni `warehouse_stock`, así que no choca con ese modelo.
- **Despachar** un envío descuenta el stock propio (`transfer_out` con la sucursal y, si el origen es un depósito que no es el salón, también del depósito) y las unidades quedan **En camino a Full** en el envío.
- **Cerrar la recepción**: lo recibido y lo dañado ya están en Full (el número real lo trae la sincronización); lo que faltó se marca **perdido** (ya había salido del stock: queda registrado) o **vuelve a mi depósito** (`transfer_return`). Siempre con motivo y auditado.
- **Cancelar** un envío en tránsito sin nada recibido devuelve todo al origen.
- **Venta por Full** (envío con `logistic_type = fulfillment`, o la publicación es Full si no vino el envío): entra como venta de Mercado Libre pero **no descuenta el stock propio**. Descuenta el depósito Full (`pending_sales`) hasta la próxima sincronización. Rige aunque el negocio no tenga `mercadolibre_full`: nunca se descuenta del mostrador lo que despachó ML. Cancelarla tampoco suma al stock propio.
- El push de stock a ML ya no tocaba Full (`stock_mode = full_only`, ADR-104). En Full + Flex (`selling_address`) el stock propio sigue empujándose para Flex.

### 1.2 Cobertura y alertas

`lib/mercadolibre/full.ts` (`coverage`), con las ventas de 30 días (operaciones de Full; si no hay, las órdenes de ML marcadas Full):

| Nivel | Condición |
|---|---|
| Sin stock en Full | disponible 0 con ventas |
| Se corta antes de reponer | días de cobertura < días que tarda un envío (configurable, 7 por defecto) |
| Cobertura baja | < la mitad del objetivo (30 días por defecto) |
| Cubierto | resto |
| Sin ventas en 30 días | no hay ritmo para calcular |

Sugerido = venta diaria × (objetivo + días de llegada) − disponible − en camino, hacia arriba.

### 1.3 Etiquetas

- **Por unidad**: código de inventario de ML (`inventory_id`, p. ej. `LCQI05831`) en **Code 128** con el código legible abajo, título acortado y variante. Va pegada en cada unidad tapando cualquier otro código de barras (el EAN de fábrica también). Code 128 B porque es el que leen los centros de Full y entra legible en 50 x 25 mm (Code 39 de H24 ocupa casi el doble). Generador propio sin dependencias: `lib/barcode/code128.ts` (tabla ISO/IEC 15417 verificada por test: 107 símbolos distintos, 11 módulos y barras pares).
- **Por bulto**: número del envío de ML (en Code 128), "Bulto i de N", cuenta, origen, número interno y fecha. **No reemplaza** la etiqueta oficial de bulto que ML entrega al crear el envío: sirve para ordenar la preparación.
- **Formatos** (`lib/mercadolibre/fullLabels.ts`): rollo térmico 50 x 25, 60 x 40 y 100 x 50 mm (una por página), A4 de 65 (38,1 x 21,2), 44 (48,5 x 25,4) y 24 (70 x 37). HTML con `@page` exacto, impresión al 100 %, hasta 5.000 por vez. Cada impresión queda contada y auditada (`ml_full_labels_printed`).
- **[confirmar]** con una cuenta Full: ML descarga desde el envío sus propias etiquetas (PDF) con el mismo código; las de acá usan el mismo `inventory_id`. Productos con EAN registrado en Full pueden no requerir etiqueta: lo indica ML en el envío.

---

## 2. API de Mercado Libre usada

Todas **GET**, con el token de la cuenta (cliente tipado con renovación, límite por cuenta y backoff de ADR-104). Nada escribe en ML.

| Endpoint | Para qué | Permiso funcional (DevCenter) |
|---|---|---|
| `GET /users/{id}/items/search?logistic_type=fulfillment&search_type=scan&scroll_id=` | Publicaciones en Full (se suman las del espejo `ml_items` con `logistic_type = fulfillment`). Si el filtro no se acepta, alcanza con el espejo **[confirmar]** | Publicación y sincronización (lectura) |
| `GET /items?ids=a,b&attributes=id,title,status,inventory_id,variations,shipping` | `inventory_id` de la publicación o uno por variación | Publicación y sincronización (lectura) |
| `GET /inventories/{inventory_id}/stock/fulfillment?include_attributes=conditions` | `total`, `available_quantity`, `not_available_quantity`, `not_available_detail` (status: `damaged`/`damage`, `lost`, `withdrawal`, `internal_process`, `transfer`, `no_fiscal_coverage`/`noFiscalCoverage`, `not_supported`) con `conditions` (`arrived_damaged`, `damaged_in_full`, `dimensions_exceeds`, `empty_identifier`, ...), `external_references` | **Ventas y envíos: Full** (lectura). Sin él, 403 `missing_permission` |
| `GET /stock/fulfillment/operations/search?seller_id=&inventory_id=a,b&date_from=&date_to=&type=&scroll=` | Operaciones (rango máx. 60 días, 12 meses de historia): ventas (`sale_confirmation`, `sale_cancelation`) para la cobertura y `inbound_reception` con `external_references` `inbound_id` para conciliar | **Ventas y envíos: Full** (lectura) |
| `GET /billing/integration/monthly/periods?group=ML&document_type=BILL` y `GET /billing/integration/periods/key/{key}/summary/details?group=ML` | Cargos del período; se guardan los de Full por nombre (almacenamiento, stock antiguo, retiro, descarte). ML no publica un `type` fijo para Full **[confirmar]** | **Facturación** (lectura). Sin él, la sección Costos lo avisa y el resto sigue |

**Lo que la API pública NO permite:** crear el envío a Full (inbound), pedir retiros ni descargar las etiquetas oficiales del envío. El POS guía a crearlo en Mercado Libre (Ventas › Full › Enviar productos) y registra su número.

Tópico relacionado: `fbm_stock_operations` (ya se guarda como `ignored`, ADR-104). No se usa: la sincronización cada 15 minutos más la marca `stale_at` de cada venta Full alcanzan, y no suma carga al webhook.

Verificación con la cuenta conectada (Punto Express): la consulta de la cuenta al espejo muestra 6 publicaciones y ninguna con `logistic_type = fulfillment`. Los GET reales a la API desde esta sesión no se ejecutaron (el entorno no permitió usar el token): **[confirmar]** con una cuenta que use Full antes del piloto.

---

## 3. Datos

Migraciones `20261209100000_features_mercadolibre_full`, `20261209100100_mercadolibre_full` y `20261209100200_mercadolibre_full_cron`.

| Tabla / columna | Contenido | Acceso de clientes |
|---|---|---|
| `ml_full_inventory` | Depósito virtual: una fila por `inventory_id` (vinculada a la publicación, variación y producto), disponible, no disponible por motivo, condiciones, `pending_sales`, `stale_at`, baja lógica si deja de estar en Full | lectura del negocio |
| `ml_full_stock_ops` | Operaciones de Full (idempotentes por id) | lectura del negocio |
| `ml_full_inbounds`, `ml_full_inbound_items` | Envíos a Full: número correlativo por negocio, cuenta, origen, estado, número de ML (único vigente por cuenta), bultos, fecha, recepción leída de ML, contadores de etiquetas; ítems con enviado, recibido, dañado, faltante y qué pasó | lectura del negocio |
| `ml_full_costs` | Cargos de Full por período | dueño o encargado |
| `ml_accounts.full_*` | Días de llegada, cobertura objetivo, formato de etiqueta, última sincronización, error y nota | lectura del negocio |

Escrituras sólo por RPC SECURITY DEFINER (`ml_full_assert`: rol + `mercadolibre` + `mercadolibre_full`) o service_role (Edge). `role_write_guard` en todas. Policies con `(select current_tenant_id())`, sin `is_internal()`.

### 3.1 RPC

| RPC | Quién | Qué hace |
|---|---|---|
| `ml_full_overview(account)` | rol operativo | Tablero: filas del depósito con propio, en camino, ventas 30 días y configuración |
| `ml_full_settings_save(account, p)` | dueño o encargado | Días de llegada y objetivo, formato de etiqueta (auditado) |
| `ml_full_inbound_save(id, p)` | dueño o encargado | Alta o edición en borrador; valida sucursal y depósito del negocio, acceso a la sucursal, productos con stock, **habilitados para Full** (`not_full_enabled`) y cantidades enteras; suma líneas repetidas |
| `ml_full_inbound_set_ml(id, nro, bultos)` | dueño o encargado | Número del envío de ML |
| `ml_full_inbound_dispatch(id)` | dueño o encargado | Exige número de ML, bloquea el stock, valida el disponible (menos reservas) y lo saca; `insufficient_stock` con el detalle si no alcanza |
| `ml_full_inbound_receive(id, líneas, cerrar)` | contar: rol operativo; cerrar: dueño o encargado | Recibido y dañado; al cerrar, cada faltante con `lost` o `returned` y motivo |
| `ml_full_inbound_cancel(id, motivo)` | dueño o encargado | Borrador, o en tránsito sin recepción (devuelve el stock) |
| `ml_full_labels_printed(id, tipo, cantidad)` | rol operativo | Contador y auditoría |
| `ml_full_inventory_upsert`, `ml_full_ops_save`, `ml_full_costs_save`, `ml_full_reception_save`, `ml_full_sync_done`, `ml_full_accounts_due`, `ml_full_edge_guard` | service_role | Ingesta y gating de la Edge |

Auditoría: `ml_full_inbound_created`, `_updated`, `_ml_id_set`, `_dispatched`, `_counted`, `_received`, `_closed_with_diff`, `_cancelled`, `ml_full_labels_printed`, `ml_full_settings_saved`; la venta suma `full_lines` en `ml_sale_ingested`.

---

## 4. Despliegue

1. Migraciones en orden (después de las de ADR-104 y ADR-085): `20261209100000_features_mercadolibre_full` → `20261209100100_mercadolibre_full` → `20261209100200_mercadolibre_full_cron` (ésta necesita `pg_cron`, `pg_net` y `platform_secrets('internal_cron')`; sin ellos se omite). La segunda recrea `ml_ingest_pack` (copia de `20261110400200` + bloque ADR-142).
2. Edge nueva **`ml_full`** (JWT; el cron entra con `X-Cron-Secret`). Sin cambios en `ml_api`, `ml_worker` ni `ml_webhook`.
3. DevCenter: tildar el permiso funcional de **Full** (lectura) y **Facturación** (lectura) si se quieren los costos.
4. Front (Vercel): pestaña Full en `/mercadolibre`.

## 5. A confirmar con una cuenta que use Full

- Filtro `logistic_type=fulfillment` en `/users/{id}/items/search` (si no, se usa el espejo).
- Nombres de los cargos de Full en el resumen de facturación de MLA.
- `scroll` de `/stock/fulfillment/operations/search` y su `limit` máximo.
- Que `inbound_id` de `inbound_reception` sea el mismo número que muestra ML al crear el envío.
- Formato exacto de la etiqueta oficial de unidad en MLA (tamaño y contenido) frente a la de acá.

## 6. Referencia de negocio

En `ANDESMAR` (sólo lectura) no hay gestión de Full: el informe de Flex (`docs/Informe-Gestion-Flex-MercadoLibre.docx`) y `logistica-inversa.md` sólo mencionan que la devolución de Full la gestiona ML. Del informe de Flex se tomaron dos ideas: el **vocabulario mínimo** en pantalla y la sección **"cómo comprobarlo vos"** con chequeos que el dueño puede hacer sin saber de sistemas.
