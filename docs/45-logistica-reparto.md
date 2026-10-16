# 45 · Logística y reparto: auditoría y plan de integración

> **Estado:** L0 (H143) hecho en código, sin aplicar (2026-10-15, ver ADR-149 § L0); L1 (H144, ADR-157) y L2 (H145, ADR-161) hechos en código, sin aplicar; L3 a L6 propuestas. Lo que no dice "hecho" no está construido todavía fuera de lo que la §2 marca como "existe". Decisión: [ADR-149](./17-decision-log.md). Hitos: F22 en [`02-roadmap.md`](./02-roadmap.md) (H143 a H149).
>
> **Para quién:** producto, backend, frontend, QA y el dueño (la §13 dice qué tiene que conseguir él).

---

## 0. Resumen ejecutivo

El dueño dice que el envío "está muy desordenado": remitos, envíos y reparto no están conectados, no hay cliente obligatorio, la dirección es texto libre, el COT es manual y no existe nada para repartir con camiones propios. La auditoría lo confirma: hoy hay **cinco circuitos distintos** para "llevarle algo a alguien" (Expedición, Delivery gastronómico, Envíos con logísticas, Canales de delivery y Mercado Libre), cada uno con sus estados, su campo de dirección y su "cadete" en texto libre, y **no existe** ningún concepto de vehículo, repartidor, hoja de ruta, coordenada ni mapa.

El plan propone:

1. **Un solo eje: la Entrega (`dispatches`)**. Todo lo que sale físicamente hacia un cliente o una sucursal es una entrega, venga de una venta del POS, de un pedido de delivery, de una transferencia entre sucursales o de un pedido del catálogo. Las logísticas externas (`shipments`) pasan a ser **un tramo** de una entrega, no un circuito aparte.
2. **Reparto propio encima de la entrega**: flota (`vehicles` con fotos), repartidores (personas del equipo con el rol de sistema **Repartidor**), **hojas de ruta** (`delivery_routes`) con **paradas** ordenadas en el mapa y **eventos** de entrega con geolocalización, foto, firma y motivo de no entrega.
3. **Direcciones estructuradas y geocodificadas** (`customer_addresses` con lat/lng) con autocompletar en la hoja de cobro, sobre **librerías y servicios gratuitos** usados dentro de sus términos: mapa con **MapLibre GL + OpenFreeMap**, autocompletar con **Photon** detrás de una Edge con caché, normalización argentina con **Georef AR**, ruteo y optimización con **OpenRouteService** (clave gratuita) y una heurística propia que funciona sin internet como respaldo.
4. **App del repartidor** mobile-first dentro de la PWA (ruta `/reparto`), con cola offline, cámara, firma en pantalla, escaneo y seguimiento de posición mientras la hoja está en curso.
5. **COT automático** con el web service de ARBA (también recibe los de CABA con las credenciales que da AGIP), disparado al cerrar la carga de una hoja de ruta, con respaldo manual.
6. **Configuración > Logística** en un solo lugar: si se emiten remitos y cuántas copias, modelos, escaneo obligatorio, qué se exige en cada entrega, motivos de no entrega, orígenes de reparto y zonas.

Se entrega en **siete fases** (L0 a L6). L0 arregla lo roto y ordena el menú sin agregar funciones; L1 hace obligatorio el cliente y estructura la dirección; L2 trae flota, hojas de ruta y la app del repartidor; L3 el mapa, la optimización y el seguimiento; L4 el COT automático; L5 la expedición robusta (escaneo, parciales, roturas y pedidos de stock); L6 Realtime, reportes y pulido.

---

## 1. Lo que pidió el dueño (trazabilidad)

Cada requisito tiene un código que se usa en las fases (§15).

| Código | Pedido | Dónde se resuelve |
|---|---|---|
| R1 | Para enviar tiene que haber un cliente cargado | §9.1, fase L1 |
| R2 | Dirección con búsqueda por mapa, autocompletar y sugerencias flotantes | §7.2, §9.1, L1 |
| R3 | Configurar el envío desde el modal de cobro, en otra pestaña | §9.1, L1 |
| R4 | Remitos, envíos y reparto conectados e intuitivos | §3, §4, L0 |
| R5 | COT automático | §8, L4 |
| R6 | Configurar en Configuración cómo se trabaja: remitos sí o no, original/duplicado/triplicado, modelos | §6, L2 |
| R7 | Planillas de reparto y hoja de ruta | §4.6, L2 |
| R8 | Marcar el origen del reparto | §4.5, §6, L2 |
| R9 | Armar la hoja de ruta por localidad y eficiencia en el mapa | §7.4, L3 |
| R10 | Usuario repartidor que sólo vea sus repartos y cargue estados ("no estaba en el domicilio") | §12, §10, L2 |
| R11 | Geolocalización de la entrega, firma en pantalla, foto del remito; todo configurable | §4.8, §6, §10, L2 |
| R12 | Seguir en el mapa la posición del camión y si respeta la ruta | §11, L3 |
| R13 | Ver en el mapa lo entregado y, por entrega, documentación, geo, foto, camión y repartidor | §4.8, L3 |
| R14 | Pestaña Pendientes para el expedicionista | §9.2, L0 y L5 |
| R15 | Escaneo de productos al entregar o cargar, configurable, para evitar cruces | §9.2, L5 |
| R16 | Marcar roto, no entregable o entrega parcial | §4.9, L5 |
| R17 | Pedir stock a otra sucursal desde la expedición | §9.3, L5 |
| R18 | En cada venta, marcar retiro en tienda o delivery | §9.4, L0 |
| R19 | Repartos locales, varios camiones, distribuir entre camiones | §4.6, §7.4, L3 |
| R20 | Detalle de camiones bien diseñado, con fotos | §4.4, L2 |
| R21 | Muy robusto, configurable e intuitivo desde Configuración | §6, todas |
| R22 | Auditar que todo funcione | §2 |

---

## 2. Auditoría del estado actual

### 2.1 Cómo se auditó

- **Código**: lectura de `app/(app)/{expedicion,pedidos,remitos,envios,delivery}`, `components/pos/checkout/CheckoutDeliveryBlock.tsx`, `components/pos/fulfillment/*`, `components/shipping/*`, `components/remitos/*`, `lib/stock/fulfillment.ts`, `lib/orders/logic.ts`, `lib/remitos/{logic,cot}.ts`, `modules/{orders,remitos,shipping}`, `components/layout/AppShell.tsx` y las migraciones `20261123100100_pedidos_despacho`, `20261202100100_depositos_venta_entregas`, `20261202100200_remitos`, `20261215100000_cobro_envio_costo`, `20261110300100_envios_nucleo`, `20260608720000_delivery_orders`, `20261013200200_traslados`.
- **Tests existentes** (2026-10-15, rama sobre `origin/main` `da618471`): 12 archivos, **196 tests, todos verdes**: `tests/unit/{entregasDepositos,remitos,cobroClienteEnvio,pedidosDespacho,stockTransfers,warehouses,shippingStatus,shippingWorker,deliveryChannels}` y `tests/components/{CobroClienteEnvio,EntregasDepositos,Remitos}`. Cubren la lógica pura y los formularios, no el circuito completo ni las RPC contra una base.
- **Producción, sólo lectura** (`begin read only`):
  - Tablas y funciones existen: `dispatches`, `dispatch_items`, `remitos`, `remito_items`, `remito_points`, `sale_orders`, `shipments`, `shipment_events`, `delivery_orders`, `delivery_zones`, `stock_transfers`, `warehouses`; RPC `dispatch_*`, `remito_*`, `sale_order_*`, `pos_sale_create_fulfilled` (ya con el renglón "Envío" y `shipping_fee`, o sea que `20261215100000_cobro_envio_costo` está aplicada aunque ADR-146 y el CHANGELOG digan "sin aplicar").
  - **Datos**: 0 entregas, 0 pedidos de salón, 0 remitos, 0 envíos, 0 transferencias; 1 pedido de delivery y 1 zona. El circuito **nunca se usó en producción**, así que se puede cambiar el modelo sin migrar datos reales.
  - **No hay ni una columna de coordenadas** fuera de `delivery_channel_orders` (posición del repartidor de las apps). `customers.address` es un único texto.
  - PostGIS está **disponible pero no instalado**. Ninguna tabla está publicada en `supabase_realtime`. `pg_cron` y `pg_net` instalados.
  - Features: `pedidos_despacho`, `entregas_remitos`, `envios` y `depositos` encendidas en Pro, Business y Enterprise; apagadas en Start.
  - Capacidades: **ninguna** de pedidos, expedición, remitos, envíos ni transferencias; todo eso se controla por nivel de rol (`role_write_guard`).

### 2.2 Qué existe

| Pieza | Qué hace | Archivos y funciones |
|---|---|---|
| Pedidos de salón (H32, ADR-129) | El vendedor arma un pedido, la caja lo cobra. Estados `abierto → tomado → cobrado`, `anulado`, `vencido` (cron cada minuto) | `app/(app)/pedidos/page.tsx`, `modules/orders/*`, RPC `sale_order_create/take/leave/cancel/complete`, `sale_orders_expire_due` |
| Expedición (H32, ADR-129/136) | Una tarjeta por entrega con pestañas Para armar, Listos, En camino, Entregados. Entregar con código de 6 dígitos o autorización | `app/(app)/expedicion/page.tsx`, `lib/orders/logic.ts` (`primaryDispatchAction`, `dispatchIsForStore`), RPC `dispatch_advance/deliver/ship/cancel/create_for_sale`, `_dispatch_can`, `_dispatch_lock` |
| Entregas repartidas (ADR-136) | Al cobrar, por renglón: se lo lleva, retira en otra sucursal o envío; puede salir de otra sucursal o depósito | `components/pos/fulfillment/FulfillmentModal.tsx`, `DeliveryBar.tsx`, `lib/stock/fulfillment.ts` (`suggestAllocations`, `checkAllocations`, `buildPlan`), RPC `pos_sale_create_fulfilled`, `warehouse_sources`, `transfer_move_stock` |
| Entrega en la hoja de cobro (ADR-146) | Bloque plegable "Entrega": ahora, retiro, envío con dirección y costo, o repartir | `components/pos/checkout/CheckoutDeliveryBlock.tsx`, montado en `app/(app)/pos/page.tsx` como `deliverySlot` |
| Remitos (ADR-136) | Remito X no fiscal A4, numeración propia por sucursal (`0001-00000001`), COT cargado a mano con aviso por umbral, anular con motivo | `app/(app)/remitos/page.tsx`, `components/remitos/*`, `lib/remitos/logic.ts`, `lib/remitos/cot.ts` (stub), RPC `remito_issue/update/void/config_get/config_save` |
| Envíos con logísticas (F19, ADR-103) | Andreani real y simulador; cotizar, crear, etiqueta, seguimiento | `app/(app)/envios/page.tsx`, `components/shipping/*`, `modules/shipping/*`, Edge `shipping`, RPC `shipment_*` |
| Delivery gastronómico (H49) | Pedidos de delivery y take away con zonas de costo fijo y cadete en texto libre | `app/(app)/delivery/page.tsx`, `components/delivery/*`, RPC `create_delivery_order`, `set_delivery_status`, `assign_courier` |
| Transferencias entre sucursales (F17 · H95) | Borrador, aprobación, despacho, recepción parcial con motivo de diferencia, escaneo, remito interno `R-000123` | `app/(app)/traslados/page.tsx`, `components/stock/transfers/*`, `lib/stock/transfers.ts`, RPC `transfer_*` |
| Escáner | Cámara (`BarcodeDetector`) y lector USB | `components/pos/BarcodeScanner.tsx`, `modules/pos/useScanner.ts` |
| PWA y cola offline | Sólo para el POS | `lib/pwa/sw.worker.js` (scope `/pos`), `lib/pos/offline/*` (IndexedDB a mano) |

### 2.3 Hallazgos: roto, desconectado o confuso

**Roto (falla o da un resultado incorrecto)**

- **A1. "Agregar una venta" a la expedición falla con ventas repartidas.** `dispatch_create_for_sale` rechaza con `sale_already_dispatched` si la venta tiene cualquier entrega no cancelada (verificado en producción). Toda venta repartida ya tiene su parte "se lo lleva ahora" entregada, así que nunca se le puede sumar una entrega posterior.
- **A2. Anular o devolver una venta no toca sus entregas ni sus remitos.** Quedan entregas abiertas y remitos emitidos de una venta anulada.
- **A3. Cancelar una entrega cruzada deja el stock en la sucursal equivocada.** `transfer_move_stock` ya movió el stock a la sucursal que vende y la cancelación no lo devuelve.
- **A4. La sucursal que vendió no ve sus entregas.** `dispatchIsForStore` (`lib/orders/logic.ts:214`) mira `store_id` y `fulfillment_store_id`, nunca `sale_store_id`, y `_dispatch_lock` tampoco la deja operar, aunque ADR-136 dice que "la ve en su lista".
- **A5. El envío equivocado queda enganchado a la entrega.** `ordersApi.dispatchShip` siempre manda `p_shipment_id: null` (`modules/orders/api.ts:258`) y `dispatch_ship` toma el último envío de la venta: con dos partes por envío se cruzan.
- **A6. "Despachado" marca `delivered_at` cuando el paquete sólo se entregó a la logística.** La entrega real vive en `shipments.status` y nunca vuelve a la entrega.
- **A7. El delivery gastronómico pasa a `entregado` al cobrarse**, aunque el pedido no salió.
- **A8. Defaults del remito que se pierden.** `RemitoIssueModal.tsx:56-67` inicializa sólo cuando cambian los ids; si la configuración llega después de abrir, la jurisdicción y "mostrar precios" no se aplican.
- **A9. El aviso de COT aparece tarde.** Antes de emitir sólo avisa si el usuario tipea un valor declarado (`RemitoIssueModal.tsx:70-72`); con el valor que calcula el servidor el aviso llega en el toast, cuando el remito ya se emitió.

**Desconectado**

- **A10. Cinco circuitos para lo mismo.** `dispatches` (POS), `delivery_orders` (gastronomía), `delivery_channel_orders` (apps), `shipments` (logísticas) y los envíos de Mercado Libre. Un delivery gastronómico nunca genera una entrega, y un envío del POS nunca aparece en el tablero de Delivery.
- **A11. Expedición no llega a Envíos.** "Crear el envío" (`expedicion/page.tsx:457`) es un link a `/envios` sin parámetros y `/envios` no lee ninguno: se pierde la venta, la dirección y los productos.
- **A12. Envíos usa la dirección fiscal, no la de entrega.** `ShipmentFormModal.findSale` (`components/shipping/ShipmentFormModal.tsx:126`) copia `customers.address` entero en `destination.street` e ignora la dirección que se cargó al cobrar (`dispatches.ship_address`); el código postal se vuelve a tipear.
- **A13. Remitos y entregas no se ven entre sí.** La tarjeta de la entrega no muestra el número de remito, `dispatch_ship` no exige remito ni COT, y un remito emitido desde `/remitos` por número de venta puede repetir los mismos productos varias veces (sólo hay unicidad por entrega, `remitos_dispatch_active_key`).
- **A14. Transferencias y entregas son mundos aparte.** Dos remitos con numeraciones distintas (`R-000123` y `0001-00000001`), dos "en tránsito" distintos, y la venta desde otra sucursal mueve stock sin dejar una transferencia.
- **A15. Dos costos de envío en la misma hoja de cobro.** `CheckoutSheetConnected` recibe `shippingFee` (renglón "Envío" en el servidor, ADR-146) y `deliveryFee` (renglón libre en el cliente, H49) (`pos/page.tsx:2311-2314`).

**Falta**

- **A16. El cliente no es obligatorio para un envío.** Alcanza con una dirección de 5 caracteres (`checkAllocations`, error del servidor `ship_address_required`).
- **A17. La dirección es texto libre en todos lados** (300 caracteres) y se precarga con la dirección fiscal de ARCA. No hay autocompletar, mapa, coordenadas, localidad ni código postal separados, y sin eso el COT automático es imposible (ARBA exige calle, número, localidad, provincia y código postal por separado, §8).
- **A18. No hay vehículos, repartidores, hojas de ruta, paradas, eventos con foto o firma, ni seguimiento.** El "cadete" es texto libre en `delivery_orders.courier_name`, `remitos.driver_name` y `remitos.vehicle_plate`.
- **A19. Sin escaneo, sin entrega parcial por producto y sin rotura** en la expedición: entregar o despachar cierra la entrega completa. Las transferencias sí tienen motivos de diferencia (`faltante`, `danado`, `vencido`, `error_despacho`, `sobrante`, `otro`).
- **A20. Remitos sin copias ni modelos.** Un único A4, sin original/duplicado/triplicado, punto de venta asignado solo (no configurable), sin remito en ticket térmico.
- **A21. La venta no dice cómo se entregó.** `sales` no tiene modo de entrega y Ventas no muestra si fue retiro o envío.
- **A22. Sin pestaña Pendientes ni filtros de lo que falta** (remitos sin COT, entregas sin remito, envíos sin etiqueta).
- **A23. Sin permisos finos.** Ninguna capacidad `logistics.*`; un rol que sólo reparta no se puede armar, y no hay guardas por ruta ni por capacidad en `app/(app)/layout.tsx` ni en `middleware.ts`.

**Confuso**

- **A24. Menú partido en seis.** Reservas y retiros, Pedidos de salón, Expedición, Remitos, Envíos y Delivery como entradas sueltas (`components/layout/AppShell.tsx:295-312`). Tres nombres para lo mismo: "Retira ahora", "Se lo lleva ahora" e "inmediato".
- **A25. "Entregados" mezcla todo.** La pestaña no filtra por sucursal (`expedicion/page.tsx:115`) y se llena con las partes "inmediato" de cada venta repartida, con botón Remito incluido.
- **A26. La hoja de cobro no tiene pestañas**, sólo pliegues: Cliente, Entrega y Propina. El envío queda escondido en un pliegue.

**Documentación desactualizada**

- **A27.** ADR-129, ADR-136, ADR-146 y el CHANGELOG dicen "migración sin aplicar", pero las tablas y funciones existen en producción. `docs/23-restaurant-cafe-operations.md` §9 tiene todo sin marcar aunque H49 está hecho.
- **A28. Código muerto** (sólo lo usan los tests): `useRemitoForDispatch` (`modules/remitos/api.ts:124`), `cotProviderFor`, `manualCotProvider`, `arbaCotProvider` (`lib/remitos/cot.ts`), `planSummary` (`lib/stock/fulfillment.ts:305`, duplica `deliverySummary`).

---

## 3. Principios del diseño

1. **La entrega es la unidad.** Una entrega es "estos productos, de este origen, a este destino, de esta forma". Todo lo demás (remito, envío con logística, parada de una hoja de ruta, COT, foto, firma) se cuelga de la entrega.
2. **El modo de entrega es un dato, no una pantalla.** Retiro en tienda, reparto propio, logística externa y "se lo lleva ahora" son valores de `dispatches.delivery_type`; la UI filtra por ese dato.
3. **La dirección se estructura una vez.** Se elige o se carga en la ficha del cliente o en la hoja de cobro, se geocodifica una sola vez y se copia (snapshot) en la entrega. El remito, el COT, la hoja de ruta y la logística leen la misma estructura.
4. **El servidor manda.** Cada transición pasa por una RPC SECURITY DEFINER que valida feature, capacidad, sucursal y estado, y escribe la auditoría. La UI nunca es la única barrera (CLAUDE.md §3 y §6).
5. **Eventos, no sólo estados.** Cada cosa que pasa en la calle (llegué, no estaba, entregué, rompí, foto, firma) es un evento inmutable con quién, cuándo, dónde y la evidencia. El estado se deriva y se guarda para consultar rápido.
6. **Offline y doble envío son normales.** Cada evento lleva un id que genera el teléfono; la RPC es idempotente por ese id.
7. **Gratis, pero dentro de los términos.** Ningún servicio gratuito se usa fuera de su política (§7). Siempre hay plan B y una heurística local que funciona sin servicios externos.
8. **Configurable con defaults sensatos.** Un negocio chico prende "Reparto propio" y funciona sin tocar nada más.

---

## 4. Modelo de datos unificado

Convenciones de [`04-database.md`](./04-database.md): `uuid` como PK, `tenant_id` con RLS, `created_at/updated_at`, `deleted_at` para baja lógica, escrituras sólo por RPC con `role_write_guard` más capacidades, lectura con `tenant_id = (select current_tenant_id())` más la política restrictiva por sucursal (`user_allowed_store_ids()`).

### 4.1 Mapa de conceptos

```
venta / pedido / delivery / transferencia
              │ genera
              ▼
        ENTREGA (dispatches) ──── ítems (dispatch_items) ── controles (dispatch_item_checks)
          │   │   │
          │   │   └── remito (remitos) ── COT (cot_submissions)
          │   └────── tramo con logística (shipments)               [delivery_type = logistica]
          └────────── PARADA (route_stops) ── HOJA DE RUTA (delivery_routes)
                                                  │        │
                                    VEHÍCULO (vehicles)   REPARTIDOR (tenant_users + rol)
                                                  │
                                    EVENTOS (delivery_events)  POSICIONES (route_positions)
```

| Hoy | Mañana |
|---|---|
| `dispatches` sólo del POS | `dispatches` recibe también delivery gastronómico con reparto propio, transferencias que se reparten y pedidos del catálogo (columna `source`) |
| `delivery_orders` con `courier_name` texto | sigue siendo la comanda gastronómica; al marcar "sale a reparto" crea su entrega y el cadete es un repartidor real |
| `shipments` como pantalla aparte | tramo de una entrega con `delivery_type = 'logistica'`; se crea desde la entrega con la dirección estructurada; su estado final vuelve a la entrega |
| `stock_transfers` aparte | sin cambio interno; si la transferencia sale en un camión propio, se crea una entrega `source = 'transfer'` que entra en la hoja de ruta |
| Mercado Libre | queda aparte (ML maneja la logística), salvo Flex: una venta Flex puede entrar a una hoja de ruta propia en L6 |

### 4.2 `customer_addresses` (nueva)

Direcciones de entrega del cliente, varias por cliente.

| Columna | Tipo | Nota |
|---|---|---|
| `id`, `tenant_id`, `customer_id` | uuid | |
| `label` | text | "Casa", "Depósito", "Obra Pilar" |
| `street`, `number`, `floor`, `apartment` | text | separados, como los pide ARBA |
| `locality`, `partido`, `province_code`, `postal_code` | text | `province_code` con el código de una letra de ARBA (`B`, `C`, `X`...) e id de Georef |
| `between_streets`, `reference` | text | "entre", "portón verde" |
| `lat`, `lng` | double precision | null si no se pudo geocodificar |
| `geo_source` | text | `photon`, `georef`, `nominatim`, `pin` (marcado a mano), `manual` |
| `geo_quality` | text | `exacta`, `calle`, `localidad`, `sin_geo` |
| `normalized` | jsonb | respuesta normalizada de Georef (ids de calle, localidad, departamento) |
| `contact_name`, `contact_phone` | text | quién recibe |
| `delivery_notes` | text | horario, timbre |
| `time_window` | jsonb | franjas aceptadas (opcional) |
| `is_default` | boolean | una por cliente (índice parcial único) |
| `deleted_at` | timestamptz | |

`customers.address` queda como domicilio fiscal (ARCA). Un backfill opcional crea una dirección por cliente con el texto actual y `geo_quality = 'sin_geo'`.

### 4.3 Snapshot de dirección en la entrega

`dispatches` suma `address_id` (FK opcional) y `ship_to jsonb` (copia estructurada con lat/lng, contacto y notas). `ship_address` queda como texto armado para compatibilidad. Si el cliente cambia su dirección después, la entrega no cambia.

### 4.4 Flota: `vehicles` y `vehicle_photos`

| `vehicles` | Tipo | Nota |
|---|---|---|
| `id`, `tenant_id`, `home_store_id` | uuid | sucursal o depósito donde duerme |
| `name`, `kind` | text | "Camión 1"; `moto`, `auto`, `utilitario`, `camion`, `bici`, `a_pie` |
| `plate`, `brand`, `model`, `year`, `color` | text/int | |
| `capacity_kg`, `capacity_m3`, `capacity_packages`, `max_stops` | numeric/int | para repartir entre camiones |
| `carrier_cuit`, `carrier_name` | text | si es de un tercero (para remito y COT) |
| `trailer_plate` | text | acoplado (COT) |
| `insurance_until`, `vtv_until`, `senasa_until` | date | avisos de vencimiento |
| `status` | text | `activo`, `en_taller`, `baja` |
| `cover_photo_path` | text | foto principal |
| `notes`, `deleted_at` | | |

`vehicle_photos` (`vehicle_id`, `path`, `kind` = `frente`, `lateral`, `carga`, `documento`, `otro`, `sort`) en el bucket privado **`logistics-media`** con la convención de `stock-adjustment-photos`: carpeta `${tenant_id}/vehicles/...`, lectura con URL firmada de 10 minutos y redimensión a WebP en el navegador (`lib/utils/image.ts`).

Ficha del vehículo: galería, capacidad con barras, vencimientos con semáforo, repartidor habitual, últimas hojas de ruta, kilómetros del mes y entregas por día.

### 4.5 Repartidores y orígenes

- **Repartidor = persona del equipo** (`tenant_users`) con el rol de sistema **Repartidor** (§5) o con la capacidad `logistics.deliver`. `driver_profiles` agrega lo que no es del usuario: `license_number`, `license_class`, `license_until`, `phone`, `default_vehicle_id`, `photo_path`, `active`.
- **Acompañante** opcional por hoja de ruta (`helper_user_id`).
- **Origen de reparto** (`logistics_origins`): `store_id` o `warehouse_id`, nombre, dirección estructurada con lat/lng, horario de carga y si se usa por defecto. Una sucursal puede tener varios orígenes (un depósito aparte). Es el punto de partida y de regreso de la hoja de ruta y el "origen" del COT.

### 4.6 Hojas de ruta: `delivery_routes`

| Columna | Nota |
|---|---|
| `id`, `tenant_id`, `number` | número por negocio, como las entregas |
| `plan_id` | agrupa las hojas del mismo día y origen cuando se reparte entre varios camiones (`route_plans`) |
| `origin_id`, `store_id` | |
| `service_date` | día del reparto |
| `vehicle_id`, `driver_user_id`, `helper_user_id` | |
| `status` | §5.2 |
| `optimize_mode` | `manual`, `heuristica`, `ors`, `vroom` |
| `planned_distance_m`, `planned_duration_s`, `planned_geometry` | polyline codificada de la ruta planificada |
| `return_to_origin` | boolean |
| `started_at`, `closed_at`, `actual_distance_m` | |
| `load_checked_by`, `load_checked_at` | quién controló la carga |
| `cot_status` | `no_aplica`, `pendiente`, `ok`, `parcial`, `error`, `manual` |
| `notes`, `deleted_at` | |

`route_plans`: `service_date`, `origin_id`, `status` (`borrador`, `confirmado`), parámetros de la distribución (`balance` por paradas, peso o tiempo).

### 4.7 Paradas: `route_stops` y `route_stop_dispatches`

Una parada es un lugar en un orden. Puede llevar varias entregas (dos ventas al mismo cliente, o una transferencia y una venta en la misma sucursal).

| `route_stops` | Nota |
|---|---|
| `route_id`, `seq` | orden en la hoja |
| `kind` | `entrega`, `retiro` (buscar algo), `sucursal` (transferencia), `pausa` |
| `ship_to` | jsonb con la dirección y lat/lng (copia de la entrega) |
| `customer_id`, `contact_name`, `contact_phone` | |
| `time_window_from/to` | |
| `eta`, `planned_service_s` | |
| `status` | §5.3 |
| `arrived_at`, `completed_at` | |
| `failure_reason_key` | |
| `attempt` | número de intento (reprogramaciones) |

`route_stop_dispatches(stop_id, dispatch_id)` con unicidad: una entrega activa sólo puede estar en una parada abierta a la vez.

### 4.8 Eventos de entrega: `delivery_events` (append-only)

| Columna | Nota |
|---|---|
| `id` | **lo genera el teléfono** (idempotencia offline) |
| `tenant_id`, `route_id`, `stop_id`, `dispatch_id` | |
| `type` | `salida`, `llegada`, `entregado`, `entregado_parcial`, `no_entregado`, `rechazado`, `rotura`, `foto`, `firma`, `escaneo`, `nota`, `desvio`, `regreso` |
| `reason_key` | motivo (catálogo configurable, §6) |
| `occurred_at` | hora del teléfono; `received_at` hora del servidor |
| `lat`, `lng`, `accuracy_m` | geolocalización del navegador |
| `distance_to_stop_m` | calculada en el servidor: alerta si se marcó "entregado" lejos de la dirección |
| `photo_paths` | text[] en `logistics-media/${tenant}/routes/${route}/...` |
| `signature_path` | PNG de la firma |
| `received_by_name`, `received_by_doc` | quién recibió |
| `actor_user_id`, `device_id` | |
| `payload` | jsonb (cantidades por ítem en un parcial, código escaneado) |

Sin UPDATE ni DELETE (revocados). La vista del panel lee el evento terminal de cada parada para mostrar en el mapa: documentación (remito con su PDF), geo, fotos, firma, camión y repartidor (R13).

### 4.9 Control por producto: `dispatch_item_checks`

Una fila por ítem y etapa (`carga`, `entrega`): `qty_expected`, `qty_scanned`, `qty_delivered`, `qty_damaged`, `qty_returned`, `difference_reason` (mismo catálogo que las transferencias: `faltante`, `danado`, `vencido`, `error_despacho`, `sobrante`, `otro`), `scanned_codes` y quién. Con esto:

- **Entrega parcial**: la entrega pasa a `entregado_parcial`; lo no entregado se reprograma (nueva entrega hija con `parent_dispatch_id`) o vuelve al stock.
- **Rotura**: lo dañado entra a un depósito de tipo `merma` o `devolucion` (ya existen en `warehouses.kind`) con un ajuste automático con motivo `rotura` y la foto del evento.

### 4.10 Seguimiento: `route_positions` y `route_positions_last`

- `route_positions`: `route_id`, `recorded_at`, `lat`, `lng`, `accuracy_m`, `speed`, `heading`, `battery` (si el navegador la da). Índice `(route_id, recorded_at)`. Retención: 90 días con borrado por `pg_cron` (posiciones), los eventos se conservan.
- `route_positions_last`: una fila por hoja en curso (upsert), para que el mapa en vivo lea una tabla chica.
- **Hecho en L3 (ADR-164):** `route_positions` con id del teléfono (idempotente), `user_id`, batería y carga; `route_positions_last` con el estado del desvío; `route_alerts` para los desvíos; escritura sólo por `route_positions_push`; retención configurable (7 a 365 días, 90 por defecto) con `route_positions_purge` y `pg_cron`.
- Sin PostGIS en L2. En L3 se instala PostGIS (gratis en Supabase) para zonas por polígono y distancia a la ruta planificada; si se decide no instalarlo, el cálculo se hace con haversine en SQL y punto en polígono en TS.

### 4.11 Remitos

- `remitos` suma `copies` (int 1 a 3), `model_key`, `route_id`, `stop_id`, `signed_copy_path` (foto del remito firmado) y `cot_submission_id`.
- `remito_points.pto_vta` pasa a ser configurable (hoy se asigna solo).
- Unicidad: un remito activo por entrega (ya existe) y **un remito activo por venta y producto** cuando no hay entrega (cierra A13).
- Remito de transferencia: las transferencias emiten un remito del mismo sistema (`kind = 'traslado'`) y dejan de tener numeración propia (cierra A14). El formato `R-000123` queda sólo para las ya emitidas.

### 4.12 COT: `cot_submissions` y `logistics_secrets`

- `cot_submissions`: `jurisdiction` (`pba`, `caba`), `file_name`, `sequence`, `status` (`pendiente`, `enviado`, `ok`, `parcial`, `error`), `receipt_number` (`numeroComprobante`), `integrity_code`, `request_txt` (guardado), `response_xml`, `errors jsonb`, `attempts`, `next_retry_at`.
- `remitos.cot_number`, `cot_valid_until`, `cot_source = 'arba_ws'` se completan con la respuesta.
- `logistics_secrets`: credenciales por negocio (usuario y clave de COT de ARBA; token y sign de AGIP), sólo `service_role`, cifradas igual que `shipping_secrets`.

### 4.13 Caché de geocodificación: `geocode_cache`

Clave: hash del texto normalizado o de la coordenada redondeada. Valor: resultado normalizado, proveedor y fecha. Sin `tenant_id` (dato público, como `ml_claim_reasons`), lectura sólo desde la Edge. Vence a los 180 días. Es obligatoria por los términos de Nominatim y conveniente para todos.

### 4.14 Zonas

`delivery_zones` se extiende (no se crea otra tabla): `polygon jsonb` (GeoJSON) o lista de `localities`, `origin_id`, `fee`, `min_order`, `free_from`, `eta_minutes`, `days` (qué días se reparte), `cutoff_time` (hasta qué hora entra para el día). Así las zonas del delivery gastronómico y las del reparto son las mismas.

---

## 5. Estados y transiciones

### 5.1 Entrega (`dispatches.status`)

Se suman estados; los actuales siguen valiendo.

```
pendiente → armando → listo ─┬─ (retiro) ───────────────────────────→ entregado
                             ├─ (reparto) → asignado → en_reparto ─┬→ entregado
                             │                                     ├→ entregado_parcial
                             │                                     ├→ no_entregado → (reprogramar) pendiente | devuelto
                             │                                     └→ rechazado → devuelto
                             ├─ (logística) → despachado → (tracking) entregado | no_entregado | devuelto
                             └─ (otra sucursal) en_transito → listo
cualquiera abierta → cancelado (con motivo; si movió stock entre sucursales, lo devuelve: cierra A3)
```

| Transición | RPC | Quién (capacidad) | Exige (según configuración) |
|---|---|---|---|
| pendiente → armando → listo | `dispatch_advance` | `logistics.prepare` | escaneo completo si `scan_on_pick` |
| listo → asignado | `route_add_dispatches` | `logistics.route.manage` | dirección con geo si `require_geo_address` |
| asignado → en_reparto | `route_start` | repartidor de la hoja | control de carga si `scan_on_load`; remito si `remito_required`; COT ok si `cot_blocks_departure` |
| en_reparto → entregado / parcial / no_entregado / rechazado | `delivery_event_record` | repartidor de la hoja | foto, firma, geo, nombre y DNI según configuración; motivo en no entregado |
| no_entregado → pendiente o devuelto | `dispatch_reschedule`, `dispatch_return` | `logistics.route.manage` | |
| listo → despachado | `dispatch_ship` con el `shipment_id` correcto (cierra A5) | `logistics.prepare` | etiqueta lista |
| despachado → entregado / no_entregado / devuelto | trigger desde `shipment_events` (cierra A6) | sistema | |

`delivered_at` se escribe sólo al entregar de verdad; "despachado" escribe `shipped_at`.

### 5.2 Hoja de ruta

```
borrador → planificada → cargando → en_curso → cerrada
        └─────────────── cancelada (sólo antes de en_curso)
```

- **planificada**: paradas ordenadas, vehículo y repartidor asignados, remitos emitidos.
- **cargando**: el expedicionista controla la carga (escaneo opcional). Al pasar a `en_curso` se pide el COT (si corresponde) y empieza el seguimiento.
- **cerrada**: todas las paradas en estado final; lo no entregado vuelve con su motivo a Pendientes. Al cerrar se calcula el resumen (km, tiempos, entregas, rendición de cobros si hubo cobro contra entrega en L6).

### 5.3 Parada

`pendiente → en_camino → en_el_lugar → entregada | parcial | no_entregada | saltada`. `saltada` exige motivo y la vuelve a poner al final o fuera de la hoja.

### 5.4 Vehículo

`activo`, `en_taller`, `baja`. Un vehículo en taller no se puede asignar. Una hoja en curso bloquea el vehículo para otra hoja del mismo día que se superponga.

---

## 6. Configuración > Logística

Una sola sección nueva en Configuración, con sub-pestañas. Se guarda en `logistics_settings` (una fila por negocio) con **override por sucursal** (`logistics_store_settings`), igual que el patrón de ADR-057. Reemplaza y absorbe `pos_settings.order_config.delivery_types` y `pos_settings.remito_config` (que se migran).

| Pestaña | Opciones | Default |
|---|---|---|
| **Cómo entregás** | Modos activos: retiro en tienda, reparto propio, logística externa, "se lo lleva ahora" por expedición (`immediate_via_dispatch`). Retiro y envío desde otra sucursal. Código de retiro. Cliente obligatorio para envío (sí, fijo; §9.1). Cliente obligatorio para retiro. | Retiro y reparto propio activos; cliente obligatorio en envío |
| **Orígenes y zonas** | Orígenes de reparto con dirección en el mapa y horario de carga. Zonas por polígono dibujado o por localidades, con costo, mínimo, envío gratis desde, días y hora de corte. | Un origen por sucursal con su dirección |
| **Remitos** | Emitir remito: nunca, a pedido, siempre en reparto propio, siempre en todo envío. Copias: 1, 2 o 3 con leyendas (Original: cliente, Duplicado: firmado vuelve, Triplicado: archivo). Modelo: A4 completo, A4 medio (dos por hoja), ticket 80 mm, preimpreso (coordenadas configurables para talonarios con CAI). Mostrar precios. Leyenda. Punto de venta por sucursal. Foto del remito firmado obligatoria. | A pedido, 2 copias, A4 completo |
| **COT** | Jurisdicciones (PBA, CABA). Credenciales (usuario de ARBA y clave de transporte; token y sign de AGIP) con **Probar**. Umbral de valor (el vigente por resolución lo carga el dueño o su contador). Planta y puerta. Código de producto ARBA por defecto y por categoría, unidad de medida. Si la falta de COT **bloquea la salida** o sólo avisa. Ambiente de prueba. | Apagado |
| **Expedición** | Escaneo al armar, al cargar y al entregar (cada uno: no, opcional, obligatorio). Permitir entrega parcial. Destino de lo roto (depósito de merma o devolución). Qué hacer con lo no entregado (volver a pendientes o devolver al stock). Pedir stock a otra sucursal: quién puede y si necesita aprobación (usa `stock_transfer_settings`). | Escaneo opcional, parcial permitido |
| **Entrega en la calle** | Qué exige cada entrega: geolocalización, foto, firma, nombre y DNI de quien recibe, foto del remito. Distancia máxima para marcar entregado sin aviso (metros). Motivos de no entrega (lista editable: "No estaba en el domicilio", "Dirección incorrecta", "Rechazó el pedido", "Cerrado", "Sin acceso", "Producto dañado", "Reprogramado por el cliente", "Otro"), cada uno con "pide foto" y "reprograma solo". Intentos máximos antes de devolver. | Geo y firma obligatorias; foto opcional; 300 m |
| **Seguimiento** | Activar seguimiento en vivo. Frecuencia (15, 30 o 60 s en movimiento). Alerta de desvío (metros y minutos). Retención de posiciones (30, 90 o 180 días). Aviso al cliente con link de seguimiento (L6). | Activo, 30 s, 500 m por 5 min, 90 días |
| **Flota y equipo** | Vehículos (alta, fotos, capacidades), repartidores (perfil, licencia, vehículo habitual). | |
| **Mapas y ruteo** | Proveedor de ruteo: heurística local, OpenRouteService (clave del negocio opcional) o servidor propio (L6). Respetar ventanas horarias. Volver al origen. Tiempo de servicio por parada. | Heurística local + ORS de NinjaSoft |

Cada pestaña tiene una línea que explica para qué sirve y un "¿Cómo queda?" con un ejemplo (patrón de ADR-145).

---

## 7. Mapas, geocodificación y ruteo con servicios gratuitos

### 7.1 Mapa base

| Opción | Costo y límites | Términos | Decisión |
|---|---|---|---|
| **MapLibre GL JS** (BSD-3) + **OpenFreeMap** (tiles vectoriales de OSM) | Sin clave, sin límite de pedidos publicado, sin costo | Atribución de OpenFreeMap y "© OpenStreetMap contributors" (ODbL) | **Elegida.** Vectorial, rápida en celulares, estilos claros y oscuros para los cuatro temas, una sola dependencia (`maplibre-gl`, cargada sólo en las pantallas con mapa) |
| Leaflet (BSD-2) + tiles raster `tile.openstreetmap.org` | Gratis | La política de tiles de OSM prohíbe uso intensivo y apps comerciales a escala; sin garantías | Descartada como principal: el uso de un SaaS con muchos negocios no entra en la política |
| **Protomaps** (PMTiles de Argentina en Storage o R2) | Costo de almacenamiento (un extracto de Argentina pesa del orden de 1 GB) y transferencia | ODbL, atribución | **Plan B** si OpenFreeMap se cae o cambia sus condiciones; MapLibre lo lee igual |
| Google Maps / Mapbox | Pagos por uso, tarjeta obligatoria | Restricciones de caché y de uso con otros mapas | Descartadas por costo |

Leaflet queda como alternativa liviana si el bundle de MapLibre complica a teléfonos muy viejos (el componente `Map` del repo abstrae la librería).

### 7.2 Autocompletar y geocodificar direcciones

| Servicio | Límites | Términos clave | Uso en el plan |
|---|---|---|---|
| **Photon** (Komoot, `photon.komoot.io`) | Uso justo, sin cupo publicado, sin SLA | Permite autocompletar; pide no abusar | **Autocompletar** mientras se tipea, con filtro a Argentina (`bbox`), idioma `es` y sesgo a la ubicación del origen |
| **Georef AR** (`apis.datos.gob.ar/georef`, Gobierno nacional) | Gratis; límite por IP, ampliable con token | Datos oficiales abiertos | **Normalizar** la dirección elegida: calle oficial, altura, localidad, departamento/partido, provincia con su código y coordenadas. Es la fuente para el COT y para las zonas por localidad |
| **Nominatim** (OSM) | **1 pedido por segundo como máximo** para toda la aplicación, caché obligatoria, User-Agent propio | **Prohíbe autocompletar** y la geocodificación masiva | Sólo **geocodificación inversa** puntual (el repartidor o el cliente marca el pin y queremos la dirección) y respaldo de búsqueda completa, siempre por la Edge, con caché y cola de 1 por segundo |
| OpenRouteService geocode | 1.000 por día con clave gratuita | Clave propia | Plan B del autocompletar si Photon no responde |
| Photon propio (self-host) | Servidor de unos 2 a 4 GB de RAM para Argentina | ODbL | Plan B de volumen (L6) |

**Cómo funciona** (componente `AddressAutocomplete`):

1. El usuario tipea; a partir de 3 caracteres y con 300 ms de pausa se llama a la Edge `geo` (`action: suggest`).
2. La Edge consulta `geocode_cache`; si no está, pregunta a Photon (o a ORS si Photon falla), limita a 5 resultados y guarda en caché.
3. Las sugerencias aparecen en una lista **flotante (position absolute)** debajo del campo, navegable con teclado, con la localidad en gris.
4. Al elegir, la Edge normaliza con Georef (`action: normalize`) y devuelve la dirección estructurada con lat/lng y calidad.
5. Se muestra un **mini mapa con el pin**, arrastrable para corregir (queda `geo_source = 'pin'`).
6. Si nada encuentra la dirección (barrios nuevos, rurales), se carga a mano por campos y se marca el pin en el mapa.

La Edge `geo` lleva rate limit por negocio, User-Agent "NinjaSoftPOS/1.0 (contacto)", atribuciones en la respuesta y un interruptor por proveedor para apagarlo sin desplegar (lo pide la política de Nominatim).

### 7.3 Ruteo (distancias y trazado)

| Opción | Límites | Decisión |
|---|---|---|
| OSRM público (`router.project-osrm.org`) | Servidor de demostración: **no es para producción**, sin garantías | Descartado |
| **OpenRouteService** con clave gratuita | Directions 2.000 por día (40 por minuto), Matrix 500 por día, **Optimization (VROOM) 500 por día** (40 por minuto) | **Elegido para L3**: una clave de NinjaSoft compartida con cupo por negocio, y la opción de que cada negocio cargue su propia clave gratuita si reparte mucho |
| **VROOM + OSRM propios** (BSD-2 y BSD-2) con el extracto de Argentina | Un VPS de 4 a 8 GB de RAM, del orden de USD 10 a 30 por mes | **Plan B y destino** cuando el volumen supere el cupo de ORS (L6) |
| **Heurística local** (TS, sin red) | Sin límites | Siempre disponible: distancias haversine con factor de corrección urbano, agrupado por localidad, vecino más cercano y mejora 2-opt. Se usa sin internet, sin cupo o para borradores |

### 7.4 Armado de hojas y reparto entre camiones (VRP simple)

1. **Entrada**: entregas `listo` del día y del origen, con lat/lng, ventana horaria, peso, volumen y bultos (de los productos; si faltan, 1 bulto por ítem).
2. **Agrupado**: por zona y localidad (R9). Las entregas sin geo quedan en una bandeja "Revisar dirección".
3. **Distribución entre camiones** (R19): VROOM (por ORS o propio) con vehículos con capacidad (`capacity_kg`, `capacity_m3`, `capacity_packages`, `max_stops`), horario de trabajo y ventanas de entrega. Sin VROOM: asignación golosa por zona al vehículo con más capacidad libre, después orden con la heurística.
4. **Orden de cada hoja**: el que devuelva el optimizador, con ETA por parada.
5. **Ajuste manual**: arrastrar paradas en la lista o entre camiones en el mapa; se recalcula la ETA y se marca `optimize_mode = 'manual'`.
6. **Confirmar**: genera las hojas de ruta, asigna repartidores y emite los remitos según configuración.

La pantalla **Planificar reparto** muestra el mapa con las paradas coloreadas por camión, una columna por camión con su carga contra su capacidad y el total de km y horas.

---

## 8. COT automático (ARBA y CABA)

### 8.1 Qué dice la especificación de ARBA

Fuente: instructivo "Remito electrónico automático" de ARBA (publicación vigente en `arba.gov.ar`).

- **Endpoint de producción**: `https://cot.arba.gov.ar/TransporteBienes/SeguridadCliente/presentarRemitos.do`. **Prueba**: `http://cot.test.arba.gov.ar/TransporteBienes/SeguridadCliente/presentarRemitos.do` (usuario de prueba en `cot.test.arba.gov.ar/TransporteBienes`, opción "Clave de transporte").
- **Pedido**: POST multipart con `user`, `password` (CUIT y clave de transporte) y `file`. **Si el pedido viene por AGIP (CABA)** no se manda `user`/`password` sino `token` y `sign` que entrega AGIP.
- **Archivo**: `TB_<CUIT>_<planta 3><puerta 3>_<aaaammdd>_<secuencia 6>.txt`. Registros separados por `|`, con fin de línea: un `01` (header con la CUIT), por cada remito un `02` y al menos un `03` (productos), y un `04` (footer con la cantidad de remitos).
- **Campos que obliga** (por los códigos de error): fecha de emisión, código único del remito, fecha y hora de salida del transporte (**no más de 30 minutos** desde la partida), destinatario (CUIT o, si es consumidor final con importe a partir del umbral del instructivo, tipo y número de documento y razón social), domicilio de destino y de origen con calle, número, localidad, provincia y código postal (y que provincia y CP coincidan), transportista CUIT, patente del vehículo y del acoplado, código único de producto, código de unidad de medida de Rentas, cantidad, importe. Al menos el origen o el destino tiene que ser provincia `B` para ARBA.
- **Respuesta**: XML `TBCOMPROBANTE` con número de comprobante, código de integridad MD5 y, por remito, `procesado` SI con su `cot` o NO con la lista de errores. Los remitos del archivo se procesan **independientes**. Error general: `TBError` con tipo, código y mensaje. Un archivo o remito ya procesado se rechaza (sirve como idempotencia).

### 8.2 Cómo se integra

1. **Cuándo**: al pasar la hoja de ruta a `en_curso` (salida). Un archivo por hoja con todos sus remitos que superan el umbral y tocan PBA o CABA. También a mano desde el remito ("Pedir COT").
2. **Quién**: Edge nueva `cot` (Deno). Arma el TXT con un generador puro y testeado (`_shared/cot/arba.ts`), lo firma con la secuencia del negocio (`cot_submissions.sequence`, con lock), lo envía, parsea el XML y guarda todo en `cot_submissions`.
3. **Resultado**: cada remito recibe `cot_number` y `cot_source = 'arba_ws'`; el número sale impreso en el remito (la app del repartidor lo muestra para una inspección en ruta). Si un remito vuelve con error, la hoja queda `cot_status = 'parcial'` con el detalle legible ("Falta el código postal del destino") y, según configuración, **bloquea la salida** de esa parada o sólo avisa.
4. **Reintentos**: errores de comunicación o "intente más tarde" se reintentan con espera creciente (cola con `pg_cron`, como `shipping_jobs`). Errores de datos no se reintentan: se corrigen y se vuelve a pedir.
5. **Respaldo manual**: botón "Descargar TXT" para subirlo en la web de ARBA y campo para cargar el COT a mano (lo de hoy, `cot_source = 'manual'`).
6. **Datos que hay que tener antes**: dirección estructurada (L1), código de producto ARBA y unidad por producto o categoría (nuevo campo `products.arba_product_code` y `arba_unit_code` con default por categoría), CUIT del transportista y patentes (flota, L2), planta y puerta del origen (configuración).
7. **CABA**: AGIP usa el mismo servicio con `token` y `sign`. Hay que confirmar con AGIP cómo se obtienen por contribuyente; hasta entonces CABA queda en manual con el TXT descargable.
8. **Pendiente de confirmar** con la especificación de campos vigente (el diseño de registro se publica aparte en la web de ARBA) y con una cuenta de prueba: posiciones exactas de cada campo del `02` y el `03`, el umbral de importe vigente, el plazo de validez del COT y el régimen de **confirmación de recepción** de ARBA (posible fase posterior).

---

## 9. Experiencia: hoja de cobro, expedición, ventas

### 9.1 Hoja de cobro con pestaña Envío (R1, R2, R3)

La hoja "¿Cómo paga?" pasa de pliegues a **pestañas** arriba: **Pago** (default), **Cliente**, **Envío**. El cobro rápido en efectivo no cambia: si el usuario no toca las pestañas, todo queda como hoy ("se lo lleva ahora").

Pestaña **Envío**:

1. Selector grande de modo: **Se lo lleva**, **Retira en tienda** (con sucursal y nombre), **Envío a domicilio** (reparto propio), **Logística** (Andreani y otras, si están conectadas), **Repartir** (abre el modal actual por renglón).
2. Al elegir envío o logística **pide cliente**: si no hay, muestra el buscador de clientes y "Nuevo cliente" inline (nombre y teléfono alcanzan; el CUIT sólo si es Factura A). El servidor lo exige: `pos_sale_create_fulfilled` rechaza una parte `envio` o `logistica` sin `customer_id` (`customer_required_for_shipping`).
3. **Dirección**: lista de direcciones del cliente (chips, la predeterminada marcada) y "Otra dirección" con `AddressAutocomplete` y mini mapa. Se puede guardar en el cliente con un toque.
4. **Costo**: se sugiere solo por la zona donde cae la dirección (polígono o localidad), editable; con logística, cotización (ADR-103). Un único costo de envío (cierra A15: el `deliveryFee` de H49 pasa a usar el mismo renglón "Envío").
5. **Cuándo**: día de entrega (el próximo día de reparto de la zona si pasó la hora de corte) y franja horaria opcional.
6. Notas para el repartidor.
7. El resumen de la pestaña Pago muestra una línea "Envío a Av. San Martín 1234, Pilar · mañana 9 a 13 · $ 3.500".

### 9.2 Expedición reordenada (R14, R15, R16)

Menú nuevo **Logística** con sub-páginas (cierra A24):

| Sub-página | Qué tiene |
|---|---|
| **Expedición** | Pestañas: **Pendientes** (todo lo que hay que preparar, con filtros por fecha de entrega, modo, zona y sucursal), **Armando**, **Listo** (con "Agregar a una hoja de ruta" o "Crear envío con logística" con todo precargado, cierra A11), **En camino**, **Con problemas** (no entregado, rechazado, parcial, rotura, sin dirección válida, sin remito o sin COT), **Entregados** (con filtro de sucursal; las partes "se lo lleva ahora" se ocultan por defecto, cierra A25). |
| **Reparto** | Planificar (mapa y camiones), hojas de ruta del día, mapa en vivo y detalle de cada hoja. |
| **Remitos** | Lista con filtros "sin COT", "sin firma", "sin foto", impresión por lote de una hoja de ruta. |
| **Envíos** | Lo de F19, ahora con el link a la entrega. |
| **Flota** | Vehículos y repartidores. |

Delivery gastronómico sigue en el menú de gastronomía, pero cuando sale a la calle aparece en Reparto.

**Escaneo**: en Armando y en Cargar, lista de productos con cantidades y la cámara o el lector USB (`BarcodeScanner`, `useScanner`). Cada código escaneado suma al ítem; si no pertenece a la entrega suena un error y queda registrado (evita cruces). Con escaneo obligatorio no se puede pasar a Listo o a En curso hasta completar o justificar la diferencia con motivo.

### 9.3 Pedir stock a otra sucursal (R17)

Desde una entrega en Pendientes que no tiene stock suficiente: botón **Pedir a otra sucursal**. Muestra el stock por sucursal (`stock_by_store`), arma una transferencia (`transfer_save` + `transfer_submit`) con los faltantes y la deja enlazada (`stock_transfers.dispatch_id`, columna nueva). La entrega queda "Esperando stock"; al recibir la transferencia, vuelve a Pendientes con aviso. Respeta la aprobación de `stock_transfer_settings`.

### 9.4 La venta dice cómo se entregó (R18)

- Columna generada o mantenida por trigger `sales.fulfillment_mode` (`en_mostrador`, `retiro`, `envio`, `logistica`, `mixto`) desde sus entregas.
- Chip en Ventas, filtro por modo, línea en el detalle con el estado de cada entrega, su remito y su hoja de ruta, y leyenda en el ticket ("Envío a domicilio · Entrega N° 123").

---

## 10. App del repartidor (PWA)

**Ruta** `app/(reparto)/reparto/*`, grupo propio como `app/(kds)`: sin el menú de la app, pensada para el celular. El service worker amplía su scope para cubrir `/reparto` (hoy sólo `/pos`) con su propio shell offline.

**Pantallas**

1. **Mis hojas**: hoy y próximas, con camión, cantidad de paradas y estado.
2. **Hoja**: mapa arriba con la ruta y las paradas numeradas; lista abajo. Botones: **Controlar carga** (escaneo si está configurado), **Salir** (pide permiso de ubicación, dispara el COT, empieza el seguimiento).
3. **Parada**: dirección, contacto con **Llamar** y **WhatsApp**, **Cómo llegar** (abre Google Maps o Waze con las coordenadas, gratis y sin API), productos, remito en PDF y el COT. Acciones grandes: **Llegué**, **Entregado**, **Entrega parcial**, **No se pudo entregar**.
4. **Entregado**: según configuración, foto (cámara del teléfono con `input capture` o `getUserMedia`, redimensionada a WebP), **firma en pantalla** (canvas con eventos de puntero, sin librería o con `signature_pad` MIT si hace falta suavizado), nombre y DNI de quien recibe, escaneo de los productos, foto del remito firmado. Se registra la geolocalización del momento y, si está lejos de la dirección más de lo configurado, pide confirmar.
5. **No se pudo entregar**: motivo de la lista configurable, foto si el motivo la pide, nota.
6. **Cerrar hoja**: resumen y lo que vuelve.

**Offline**: cada acción se guarda en IndexedDB (`ninja-reparto-offline`, mismo patrón que `lib/pos/offline`) con el id del evento generado en el teléfono; las fotos y firmas se suben al Storage cuando hay señal y el evento se envía con sus paths. La RPC `delivery_event_record` es idempotente por id y ordena por `occurred_at`. Un indicador muestra "3 entregas sin enviar".

**Permisos del navegador**: ubicación, cámara y (opcional) Wake Lock para que la pantalla no se apague durante el seguimiento.

---

## 11. Seguimiento en vivo (R12, R13)

- **Cómo**: con la hoja `en_curso` y la app abierta, `navigator.geolocation.watchPosition` con alta precisión. Se manda una posición cada **30 s en movimiento** (configurable 15 a 60) o cuando se movió más de 50 m; detenido, cada 2 minutos. Las posiciones se agrupan y se envían en lote (RPC `route_positions_push`) para gastar menos batería y datos; offline se encolan.
- **Límite honesto de una PWA**: con la pantalla apagada o la app en segundo plano, iOS y muchos Android **dejan de entregar la ubicación**. Mitigaciones: Wake Lock mientras está en ruta, recordatorio de no cerrar la app, y siempre la geolocalización de cada evento (que no depende del seguimiento). **Plan B** (L6, sólo si el dueño lo pide): empaquetar la misma app con Capacitor para tener ubicación en segundo plano en Android.
- **Mapa en vivo** en Logística > Reparto: camiones con su última posición y antigüedad ("hace 40 s"), ruta planificada en gris, recorrido real en color, paradas por estado (pendiente, entregada en verde, no entregada en rojo). Al tocar una parada: evento final con foto, firma, geo, remito, camión y repartidor.
- **Actualización**: en L3 con **polling cada 15 s** de `route_positions_last` (es lo que usa toda la app hoy). En L6 se pasa a **Supabase Realtime Broadcast** por canal de hoja de ruta (el repartidor publica, el panel escucha), que no requiere publicar tablas ni toca RLS de `postgres_changes`. El plan gratuito de Supabase tiene cupo de mensajes y conexiones concurrentes; con 30 s por camión el volumen es bajo, pero se mide antes de activarlo.
- **Desvío de ruta**: la Edge o un trigger calcula la distancia de la posición a la ruta planificada (polyline); si supera el umbral por más de N minutos genera un evento `desvio` y un aviso al encargado. Paradas fuera de orden también avisan.
- **Privacidad** (Ley 25.326): sólo se registra durante una hoja `en_curso`, el repartidor lo ve en pantalla ("Estás compartiendo tu ubicación") y lo acepta al primer uso; nunca fuera de horario; retención configurable con borrado automático; acceso sólo para quien tenga `logistics.track`. Se documenta en los términos del negocio con su personal.

---

## 12. Roles y capacidades

Módulo nuevo `logistica` en `lib/permissions/capabilities.ts` (fuente única, ADR-138) con seed por migración y el test `permissionsCatalog`.

| Capacidad | Para qué | Dueño | Encargado | Cajero | Vendedor | Expedicionista (plantilla) | **Repartidor** |
|---|---|---|---|---|---|---|---|
| `logistics.view` | Ver Logística | sí | sí | sí | sí | sí | no (ve sólo lo suyo) |
| `logistics.prepare` | Armar, escanear, marcar listo, despachar | sí | sí | sí | no | sí | no |
| `logistics.route.manage` | Planificar, crear hojas, asignar, reprogramar | sí | sí | no | no | sí | no |
| `logistics.deliver` | Usar la app de reparto en sus hojas | sí | sí | no | no | no | sí |
| `logistics.track` | Ver el mapa en vivo y posiciones | sí | sí | no | no | sí | no |
| `logistics.fleet.manage` | Vehículos y repartidores | sí | sí | no | no | no | no |
| `logistics.remito.void` | Anular remitos (hoy sólo dueño o encargado) | sí | sí | no | no | no | no |
| `logistics.cot.manage` | Credenciales y reintentos de COT | sí | no | no | no | no | no |
| `logistics.settings` | Configuración > Logística | sí | no | no | no | no | no |

**Rol de sistema "Repartidor"** (uuid `...0000000000a7`, nivel base `cashier` porque escribe, ícono `truck`), en todos los planes que tengan reparto propio:

- Sólo `logistics.deliver`. Su inicio (`lib/auth/redirect.ts`, `homePath`) es `/reparto`.
- `app/(reparto)/layout.tsx` valida en el servidor `has_capability('logistics.deliver')`; `app/(app)/layout.tsx` gana una guarda que, si el usuario tiene el rol Repartidor, lo redirige a `/reparto` (hoy no hay guardas por capacidad en el layout, A23).
- **Cuidado (deuda de ADR-138)**: como el nivel base es `cashier`, las RPC viejas que preguntan por nivel con `role_write_guard` le permitirían vender o abrir caja por API. Antes de habilitar el rol, las RPC de venta y caja tienen que pedir `sales.create` y `cash.open` (ya existen en el catálogo) además del nivel, y se agrega un test que pruebe que un Repartidor no puede llamar a `create_sale`.
- RLS: las tablas de reparto dejan leer a un repartidor sólo filas de hojas donde `driver_user_id` o `helper_user_id` es él (`auth.uid()`), y las entregas, clientes y direcciones **sólo a través de** la RPC `driver_route_detail` (no lee la tabla de clientes completa).

**Expedicionista**: plantilla de rol propio (ya prevista en `06-permissions-roles.md` §9.1) con `logistics.view/prepare/route.manage/track` y `stock.view`.

---

## 13. Qué necesita el dueño

| Qué | Para | Cuándo | Costo |
|---|---|---|---|
| Decidir los defaults de §6 (remito a pedido o siempre, copias, qué se exige en la entrega) | Configuración | Antes de L2 | |
| Un negocio piloto con reparto propio (idealmente PBA) con 1 o 2 camiones | Probar L2 y L3 en la calle | L2 | |
| Cuenta en **openrouteservice.org** (gratuita, mail de NinjaSoft) y su API key cargada como secret `ORS_API_KEY` | Ruteo y optimización | L3 | Gratis (cupo §7.3) |
| Mail de contacto para el User-Agent de Nominatim y Photon | Términos de uso | L1 | Gratis |
| (Opcional) token de **Georef AR** si el volumen lo pide | Normalización | L1 | Gratis |
| **Clave de transporte de ARBA** de prueba (desde `cot.test.arba.gov.ar`) y del piloto en producción (CUIT + CIT o clave de transporte del contribuyente) | COT automático | L4 | Gratis |
| Consulta a AGIP por `token` y `sign` para CABA | COT CABA | L4 | |
| El contador del piloto: umbral vigente del COT, códigos de producto y unidades de ARBA de sus rubros | COT | L4 | |
| (Más adelante) un VPS para VROOM + OSRM o Photon propios si se pasa el cupo | Escala | L6 | USD 10 a 30 por mes |
| Decidir si se quiere app nativa (Capacitor) para seguimiento en segundo plano | Seguimiento | L6 | Cuenta de Google Play USD 25 una vez; Apple USD 99 por año |

---

## 14. Features de plan (CLAUDE.md §6)

| Key | Categoría | Planes | Gating server-side | Nota |
|---|---|---|---|---|
| `entregas_remitos` (existe) | OPTIONAL | Pro+ | `pos_sale_create_fulfilled`, `remito_*` | Sigue cubriendo entregas repartidas, remitos manuales, copias y modelos |
| `pedidos_despacho` (existe) | OPTIONAL | Pro+ | `_order_assert`, `_dispatch_lock` | Expedición, retiro y envío |
| `direcciones_geo` (nueva) | **BASE** | Todos | Edge `geo` (cupo por plan), RPC de `customer_addresses` | Direcciones del cliente con autocompletar y mapa: mejora la calidad de datos de todos |
| `reparto_propio` (nueva) | OPTIONAL | Pro+ | `route_*`, `delivery_event_record`, policies de `delivery_routes`, `vehicles` | Hojas de ruta, flota, app del repartidor, eventos con foto y firma. El rol Repartidor sólo se puede asignar con esta feature |
| `reparto_optimizado` (nueva) | OPTIONAL | Business+ | `route_plan_optimize` (Edge `routing`) | Optimización con ORS o VROOM, varios camiones, mapa en vivo y desvíos. En Pro queda la heurística local y el orden manual |
| `cot_automatico` (nueva) | OPTIONAL | Pro+ | Edge `cot`, `cot_submit` | COT por web service; el COT manual sigue en `entregas_remitos` |
| `escaneo_expedicion` | **FLAG-OPERATIVO** | | `logistics_settings` | Elección del dueño, sin costo de plan |
| Exigir firma, foto, geo; motivos; copias; modelo de remito | **FLAG-OPERATIVO** | | `logistics_settings` | |
| `seguimiento_cliente` (link público de seguimiento) | **MARKETING-FUTURO** | Business+ | | No existe; deuda anotada en ADR-149 |
| App nativa con seguimiento en segundo plano | Sin feature hasta decidir | | | |

Cada key nueva: migración en `features` (`grupo = 'logistica'`), `plans.limits.modules`, copy en `lib/saas/featureInfo.ts`, aparece en la matriz del editor de planes y en `planComparison.ts`.

---

## 15. Fases de entrega

Cada fase cierra con el gate del roadmap (lint, typecheck, tests, guardarraíles RLS en 0 en PGlite, `db-audit-perf --strict`) más su criterio propio. Las migraciones van con fecha correlativa al momento de hacerlas; los nombres son indicativos.

### L0 · Ordenar y arreglar lo que hay (H143)

Sin funciones nuevas grandes; deja la base sana.

- Arreglar A1 (permitir agregar entregas a ventas con partes ya entregadas, controlando cantidades pendientes por producto), A2 (anular o devolver una venta cancela sus entregas abiertas y avisa de sus remitos), A3 (cancelar una entrega cruzada devuelve el stock), A4 (la sucursal que vende ve y opera), A5 (enganchar el envío correcto), A6 (`shipped_at` en lugar de `delivered_at`; estado de `shipments` vuelve a la entrega), A8, A9, A13 (unicidad del remito por venta y producto), A15 (un solo costo de envío), A25.
- A11 y A12: "Crear envío con logística" desde la entrega, con dirección y productos precargados.
- R18: `sales.fulfillment_mode` y chip en Ventas.
- Menú **Logística** con sub-páginas (A24) y pestaña **Pendientes** inicial (R14).
- Limpiar código muerto (A28) y documentación desactualizada (A27).
- **Migraciones**: `logistica_l0_arreglos` (RPC corregidas, `fulfillment_mode`, `shipped_at`, trigger `shipment_events → dispatches`).
- **Criterio**: test de integración en PGlite del circuito venta repartida → agregar entrega → anular venta → stock correcto en cada sucursal; las 196 pruebas actuales siguen verdes; el dueño recorre Logística y encuentra todo desde un solo menú.

### L1 · Cliente obligatorio y direcciones reales (H144)

> **Hecho (ADR-157).** Diferencias con este plan: mini mapa con **Leaflet + tiles de OSM** (pedido del dueño) en lugar de MapLibre + OpenFreeMap; el cliente obligatorio se valida con un trigger en `dispatches` y el envoltorio `pos_sale_create_delivery` (sin recrear `pos_sale_create_fulfilled`); las entregas de pedidos (catálogo y salón) quedan afuera de la exigencia hasta L2; zonas por localidad con `free_from`, sin `days` ni `cutoff_time` todavía.

- `customer_addresses`, `dispatches.address_id` y `ship_to`, `geocode_cache`.
- Edge `geo` (suggest con Photon, normalize con Georef, reverse con Nominatim) con caché, rate limit e interruptores.
- `AddressAutocomplete` con lista flotante y mini mapa (MapLibre + OpenFreeMap), en la ficha del cliente y en la hoja de cobro.
- Hoja de cobro con pestañas **Pago / Cliente / Envío** (R3) y cliente obligatorio en el servidor (R1).
- Zonas por localidad (polígono en L3) con costo sugerido.
- Feature `direcciones_geo` (BASE).
- **Criterio**: en un celular de 390 px, cobrar un envío a un cliente nuevo con dirección autocompletada en menos de 45 s; el servidor rechaza un envío sin cliente; 0 pedidos a Nominatim por tipeo (sólo inversa); tests de la Edge con fetch falso y de la caché.

### L2 · Flota, hojas de ruta y app del repartidor (H145)

> **Hecho (ADR-161).** Diferencias con este plan: las entregas no suman estados (salir = `despachado`, no entregado = vuelve a `listo` con `delivery_attempts` y `last_failure_reason`); el Repartidor queda aislado cortando `user_allowed_store_ids()` y con una policy restrictiva en las tablas de clientes; `remito_config` y `order_config` se quedan en `pos_settings` (la pantalla las junta) y no hay override por sucursal todavía; sin `route_plans` ni `dispatch_item_checks` (L3 y L5); remito de transferencia y punto de venta configurable quedan pendientes; la app sigue andando sin señal si ya estaba abierta (el service worker con alcance `/reparto` queda para después).

- `vehicles`, `vehicle_photos`, `driver_profiles`, `logistics_origins`, `delivery_routes`, `route_stops`, `route_stop_dispatches`, `delivery_events`, bucket `logistics-media`, `logistics_settings` y `logistics_store_settings` (migrando `order_config` y `remito_config`).
- Capacidades `logistics.*`, rol de sistema **Repartidor** y plantilla Expedicionista; guardas en el layout; RPC de venta y caja con capacidad (prerequisito del rol).
- Configuración > Logística completa salvo COT y seguimiento.
- Remitos: copias, modelos (A4, medio A4, ticket 80 mm, preimpreso), punto de venta configurable, remito de transferencia en el mismo sistema, impresión por lote de la hoja.
- Planilla de reparto e **hoja de ruta imprimible** (R7), orden manual o heurística local.
- App `/reparto` con offline, foto, firma, geo del evento, motivos de no entrega.
- Feature `reparto_propio`.
- **Criterio**: el piloto hace un reparto real de 10 paradas con un camión: cada entrega tiene evento con geo y firma (y foto si la exige), las no entregadas vuelven a Pendientes con motivo, en modo avión se cargan 3 entregas y se sincronizan sin duplicar; un Repartidor no puede vender ni ver clientes fuera de su hoja (test de RLS).

### L3 · Mapa, optimización, varios camiones y seguimiento (H146)

> **Hecho (ADR-164).** Diferencias con este plan: mapa con Leaflet + tiles de OSM (el de L1), no MapLibre; sin PostGIS (distancia plana local al recorrido, `_path_distance_m`); sin `reparto_optimizado`: la heurística reparte entre camiones dentro de `reparto_propio` y ORS es opcional (sólo con `ORS_API_KEY`); el desvío vive en `route_alerts` (no como evento de `delivery_events`) y la configuración del seguimiento en `route_tracking_settings` (no en `logistics_settings`) para no chocar con L5; sin zonas por polígono (siguen por localidad); los bultos salen de las cantidades de cada entrega porque los productos no tienen peso; ajuste a mano con subir, bajar y pasar a otro camión (sin arrastrar en el mapa).

- PostGIS (o haversine) para zonas por polígono y desvíos; `route_plans`, `route_positions`, `route_positions_last`.
- Edge `routing` (ORS Directions, Matrix y Optimization) con cupo por negocio y caída a la heurística local.
- Pantalla **Planificar reparto**: agrupar por localidad, repartir entre camiones por capacidad, ajustar arrastrando.
- Seguimiento con `watchPosition` y envío en lote; mapa en vivo con polling 15 s; desvíos; detalle de cada entrega en el mapa (R13).
- Feature `reparto_optimizado`.
- **Criterio**: 40 entregas en 3 camiones se planifican en menos de 10 s con ORS y en menos de 2 s con la heurística; el mapa muestra la posición con menos de 60 s de atraso en una prueba real; una salida de ruta de 600 m por 5 minutos genera el aviso.

### L4 · COT automático (H147)

- `cot_submissions`, `logistics_secrets`, campos ARBA en productos y categorías, Edge `cot` con generador TXT y parser XML puros y testeados contra los ejemplos del instructivo.
- Disparo al salir, reintentos, bloqueo configurable, TXT descargable y carga manual de respaldo.
- CABA por AGIP cuando se confirme `token`/`sign`.
- Feature `cot_automatico`.
- **Criterio**: en el ambiente de prueba de ARBA, una hoja con 5 remitos devuelve 5 COT y quedan impresos; un remito con CP inválido vuelve con el error legible y no bloquea a los otros; reenvío del mismo archivo no duplica.

### L5 · Expedición robusta (H148)

- `dispatch_item_checks`; escaneo al armar, cargar y entregar con su configuración (R15).
- Entrega parcial por producto, rotura con ajuste automático a merma con foto, devoluciones y reprogramación con entrega hija (R16).
- Pedir stock a otra sucursal desde la entrega con transferencia enlazada (R17).
- Pestaña **Con problemas** completa.
- **Criterio**: escanear un producto de otra entrega da error y queda registrado; una entrega de 5 ítems con 1 roto y 1 rechazado deja stock, merma y entrega hija correctos (test PGlite); una entrega sin stock pide la transferencia y vuelve sola a Pendientes al recibirla.

### L6 · Tiempo real y escala (H149)

- Realtime Broadcast para el mapa en vivo; link de seguimiento para el cliente (si se decide pasarlo de MARKETING-FUTURO a función).
- Delivery gastronómico y canales usando hojas y repartidores (cadete real, A10); ventas Flex de ML en hojas propias.
- Cobro contra entrega y rendición del repartidor.
- Reportes: entregas a tiempo, intentos, km por camión, costo por entrega, motivos de no entrega.
- VROOM/OSRM o Photon propios si el cupo no alcanza; Capacitor si se decide.
- **Criterio**: definido al iniciar la fase con datos del piloto.

---

## 16. Edge Functions

| Edge | Fase | Qué hace | Secrets |
|---|---|---|---|
| `geo` (nueva) | L1 | suggest, normalize, reverse con caché, rate limit e interruptores | `GEO_CONTACT_EMAIL`, `GEOREF_TOKEN` (opcional) |
| `routing` (nueva, ADR-164) | L3 | status, optimize (VROOM) y directions con cupo por negocio (`geo_usage`), turno global (`geo_providers` `ors`) y caída a la heurística local; verify_jwt = true | `ORS_API_KEY` (opcional), `ROUTING_SELFHOST_URL` (L6) |
| `cot` (nueva) | L4 | armar TXT, enviar a ARBA, parsear, reintentar | ninguno global; credenciales por negocio en `logistics_secrets` |
| `shipping` (existe) | L0 | crear envío desde una entrega con la dirección estructurada | los actuales |
| `send_receipt_email` (existe) | L2 | remito con copias y foto firmada | los actuales |

---

## 17. Riesgos y costos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Photon u OpenFreeMap cambian condiciones o se caen | Sin autocompletar o sin mapa | Interruptor por proveedor; ORS geocode y Protomaps como plan B; carga manual por campos siempre disponible |
| Cupo de ORS (500 optimizaciones por día compartidas) | Sin optimización en hora pico | Cupo por negocio, clave propia opcional, heurística local siempre; VROOM propio en L6 |
| Nominatim bloquea a NinjaSoft por abuso | Sin geocodificación inversa | Sólo inversa, 1 por segundo con cola, caché, User-Agent, interruptor |
| Seguimiento con la PWA en segundo plano | Huecos en el recorrido | Wake Lock, geo en cada evento, Capacitor como opción |
| Batería y datos del repartidor | Quejas, apagan el GPS | Envío en lote, frecuencia configurable, pausa al estar quieto |
| Especificación del COT incompleta o cambiante | Rechazos | Generador aislado y testeado, ambiente de prueba, TXT manual de respaldo, errores legibles |
| Credenciales fiscales de terceros | Seguridad | `logistics_secrets` sólo `service_role`, cifrado, auditoría, sin exponer al cliente |
| Privacidad del repartidor | Legal | Sólo en hoja en curso, aviso visible, retención y acceso restringidos |
| El rol Repartidor hereda permisos de cajero por nivel | Un repartidor podría vender por API | Prerequisito en L2: venta y caja con capacidad; test de RLS |
| Cambio grande de UX en la hoja de cobro | Cajeros confundidos | Pestaña Pago por defecto y cobro rápido igual; aviso de novedades |
| Volumen de posiciones | Tamaño de la base | Retención con `pg_cron`, tabla `last` para el mapa, índices |

**Costos externos**: L0 a L5 **sin costo** para NinjaSoft más allá de Supabase y Vercel actuales (Storage de fotos: con WebP de unos 150 KB, 1.000 entregas con 2 fotos y firma son del orden de 0,4 GB por mes; se puede configurar retención de fotos). L6 opcional: VPS de USD 10 a 30 por mes y cuentas de tiendas si se hace app nativa.

---

## 18. Pruebas

- **Puras (Vitest)**: generador y parser del COT con los ejemplos del instructivo, heurística de ruteo (orden, 2-opt, reparto entre camiones), transiciones de entrega, hoja y parada (espejo TS de `_dispatch_can`), validación de la configuración, normalización de direcciones, cola offline.
- **PGlite**: cada RPC nueva con la cadena completa de migraciones; RLS del repartidor; idempotencia de eventos; stock en parciales y roturas; guardarraíles `rls_*` en 0.
- **Componentes**: hoja de cobro con pestañas, `AddressAutocomplete` (lista flotante, teclado), app del repartidor (firma, foto con mock de cámara, offline).
- **Playwright**: circuito completo en 390 px y escritorio en los cuatro temas: venta con envío → expedición → hoja de ruta → app del repartidor → entregado con firma → mapa.
- **Campo**: piloto real por fase (L2, L3, L4).

---

## 19. Preguntas abiertas para el dueño

1. ¿El remito por defecto es "a pedido" o "siempre en reparto propio"? ¿Con precios o sin precios?
2. ¿El cobro contra entrega (el repartidor cobra en la puerta) entra en este proyecto o queda para después de L6?
3. ¿Hace falta app nativa para seguimiento en segundo plano, o alcanza con la PWA con la pantalla encendida?
4. ¿Se ofrece un link de seguimiento al cliente final (como una logística)? Hoy queda como MARKETING-FUTURO.
5. ¿Qué piloto usamos para L2 a L4 (rubro, cantidad de camiones, provincia)?
