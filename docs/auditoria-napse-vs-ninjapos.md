# Auditoría Napse vs NinjaPOS: multi-sucursal, pagos, clientes, productos y contabilidad

Fecha: 2026-10-12 · Fases nuevas en el roadmap: **F17** multi-sucursal (H89 a H99) y **F18** fiscal, contable, precios y compras (H100 a H112, ver [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md)) · Decisión: [ADR-043](./17-decision-log.md)

Fuentes:

- Relevamiento propio de **Napse Bridge Manager 7.9.17HF1** (253 pantallas, ambiente QA de Novogar, 12-10-2026): `ANDESMAR/docs/auditoria-napse-bridge-bmc.md` (documento de otro proyecto, sólo lectura).
- Benchmark público ya registrado en [`29-napse-unified-commerce-benchmark.md`](./29-napse-unified-commerce-benchmark.md) (Bridge, Omni, VTOL, Fiscal Flow, Promo en napse.global).
- Código de NinjaPOS en `main` (`1acb481`): migraciones en `supabase/migrations/`, Edge Functions, `modules/`, `components/`, `lib/`.

---

## 1. Resumen ejecutivo

1. **NinjaPOS hoy es mono-sucursal en la práctica.** La tabla `stores` existe desde el backbone (`20260530150000_operational_backbone.sql`) y `cash_registers.store_id` la referencia, pero **no hay ABM de sucursales ni de cajas** en la UI: `create_tenant` crea una sucursal y una caja, y nada más las crea después.
2. **Bug latente de sucursal:** `create_sale` (última versión en `20260609320000_create_sale_coupon.sql`, líneas 105-117) **elige siempre la sucursal default** (`order by is_default desc, created_at limit 1`) y busca el turno abierto en esa sucursal. Con dos sucursales, una venta de la caja de la sucursal B se registraría en A (o fallaría por "no hay turno"). Lo mismo replican `return_sale`, `exchange_sale` y los RPC de stock. **Hay que derivar la sucursal del turno de caja, no del default.**
3. **El stock es uno solo por producto** (`products.stock`), aunque `stock_movements.store_id` ya guarda la sucursal. No hay stock por sucursal, ni depósitos, ni transferencias.
4. **Toda la configuración es por negocio:** `tenant_payment_methods` (`unique(tenant_id, provider_key)`), `payment_secrets`, `payment_plans`, `pos_settings` (PK `tenant_id`), `ticket_templates`, `price_lists`, impresión y diseño del POS. No existe la capa "sucursal" ni "caja" para pisar valores.
5. **Terminales sin registro:** el lector Mercado Point se elige por caja en `localStorage` (`components/pos/PointCheckoutModal.tsx`), la caja QR de MP es una sola por ambiente (`tenant_payment_methods.config.mp_qr.prod/test`), los Point de Nave viven en un secret de texto (`point_pos_ids`). No hay tabla de terminales con sucursal, caja, adquirente y n° de comercio.
6. **Roles por negocio, no por sucursal:** `tenant_users.role` (owner, manager, cashier, viewer) aplica a todo el tenant. Napse asigna **roles distintos por tienda** y separa alcance CENTRAL y TIENDA.
7. **Indicador "dónde estoy":** el POS muestra "Caja X abierta" (`components/pos/screen/PosTopBar.tsx`) pero **en ningún lado dice la sucursal**, ni en el POS ni en el panel.
8. **La feature `multi_sucursal` está prometida pero no existe:** está en `features` (OPTIONAL, Business, `max_stores` 3 en Business) y en `lib/saas/featureInfo.ts`, pero no hay función que gatear. Hoy es de hecho MARKETING-FUTURO.
9. **Clientes ya son compartidos** (tabla `customers` a nivel tenant) y la cuenta corriente v2 es por cliente, así que se puede cobrar en cualquier sucursal. Los vales ya traen `store_credit_vouchers.allowed_branch_ids`. Falta sucursal de alta, historial por sucursal y fidelización.
10. **Contabilidad: casi nada.** Hay Cierre Z inmutable (`cash_z_closures`, con `store_id`) y export XLSX de ventas y reportes. No hay plan de cuentas, asientos, Libro IVA, mapeo de medios a cuentas o códigos ERP, ni conciliación de liquidaciones de tarjeta. El n° de comercio por cupón (`payments.card_voucher.comercio` + `tenant_payment_methods.config.merchant_numbers`) está **en curso** en otra rama, junto con un primer reporte de conciliación de tarjetas (`feat/conciliacion-tarjetas`: `payments.card_voucher` con comercio y `payments.reconciled_at`). Es el primer ladrillo de la conciliación; el bloque fiscal y contable completo está en [`auditoria-fiscal-contable-precios.md`](./auditoria-fiscal-contable-precios.md).

**Dirección propuesta (ADR-043):** antes de seguir sumando funciones "por negocio", hacer que la **sucursal y la caja sean contexto de primera clase** (H89 a H91), montar un **motor de herencia de configuración tenant → sucursal → caja** (H92, primer corte concreto de F14/H57) y colgar de él medios de pago, terminales, precios, tickets e impresión (H93, H94). Después stock por sucursal y transferencias (H94, H95), reportes consolidados (H97), fiscal por punto de venta (H98) y monitoreo (H99). El bloque fiscal, contable, de precios y compras va en F18 (H100 a H112).

---

## 2. Qué tiene NinjaPOS hoy (inventario concreto)

| Área | Existe | Parcial | Falta |
|---|---|---|---|
| **Sucursales** | Tabla `stores` (`name`, `address`, `phone`, `is_default`, `is_active`, `deleted_at`, RLS por tenant). `create_tenant` crea la primera (`supabase/functions/create_tenant/index.ts:215`). `branchesApi.list()` en `modules/sales/api.ts:451` (sólo para vales). | `max_stores` en `plans.limits` y `modules/saas/gating.ts`, sin trigger que lo haga cumplir. | ABM de sucursales, código, CUIT/razón social, punto de venta fiscal, horario, zona/grupo, estado online. |
| **Cajas** | `cash_registers(store_id, name, is_active)`. `posApi.defaultRegister()` toma **la primera caja activa** (`modules/pos/api.ts:407`). Cierres Z con `store_id` y `cash_shift_id`. | `cash_registers` sin `deleted_at` ni código. Display de cliente lee la caja (`app/(display)/customer-display/page.tsx`). | ABM de cajas, elegir caja al entrar al POS, cajero asignado a caja, una caja por dispositivo. |
| **Venta y sucursal** | `sales.store_id`, `stock_movements.store_id`. | Se completa con la sucursal default, no con la de la caja (ver §1.2). | Derivar `store_id` de `cash_shift → cash_register → store`. |
| **Stock** | `products.stock` (total), `stock_movements` append-only con `store_id`, `reason` incluye `transfer`. Mermas y producción. | | Stock por sucursal (y por depósito), reservado, en tránsito, transferencias, conteos por sucursal. |
| **Productos y precios** | Catálogo central (`products`, `product_variants`), `price_lists` por canal (`mostrador`, `catalogo`, `mayorista`, `custom`) con `price_list_items`. | `products.allow_negative` pisa el global. | Habilitación, precio y costo por sucursal (Napse `itemStore`), listas por sucursal o grupo, vigencia y franja horaria. |
| **Medios de pago** | `payment_providers` (catálogo global), `tenant_payment_methods` (uno por tenant y proveedor: `enabled`, `sandbox`, `surcharge_pct`, `config`), `payment_secrets` (sólo service_role), `payment_plans` (cuotas y recargos), gating `payment_method_plan_key` + trigger de `payments`. ADR-038 (por marca y canal), ADR-042 (tarjeta en posnet). | `config.mp_qr` guarda **una** caja QR de MP por ambiente. El modal de GO Cuotas pide "API Key de la sucursal" pero guarda una sola. Mobbex pide `store_id` opcional "si tenés varias sucursales". | Habilitar, recargo y credencial por sucursal, caja QR por caja, override por sucursal. |
| **Terminales** | Mercado Point vía Edge `mp_point` (devices, pdv, create, status, cancel), `mp_payment_intents.point_device_id`. Nave Point por `point_pos_ids` en el secret. | Lector elegido por caja en `localStorage`. | Registro de terminales (`payment_terminals`) con sucursal, caja, proveedor, id externo, n° de comercio y estado. |
| **N° de comercio** | `payments.card_voucher` (jsonb) con lote, cupón, marca, últimos 4. | **En curso:** `card_voucher.comercio` y `tenant_payment_methods.config.merchant_numbers`. | N° de comercio por sucursal y adquirente (cada local de una cadena tiene el suyo en Prisma/Fiserv). |
| **Clientes** | `customers` a nivel tenant, cuenta corriente v2 (ledger tipado, cobros por RPC, PIN supervisor), saldo a favor y vales con `allowed_branch_ids`. | | Sucursal de alta, historial y deuda filtrable por sucursal, límite de crédito global vs por sucursal, fidelización (F9/H80). |
| **Roles** | `tenant_users.role` ∈ owner, manager, cashier, viewer. `docs/06-permissions-roles.md` propone `retail_manager` "con stock de otras sucursales". | | Sucursales permitidas por usuario, rol por sucursal, alcance central vs sucursal en RLS. `docs/01-mvp.md` ya pedía "asignación de rol y sucursales permitidas". |
| **Tickets e impresión** | `ticket_templates` por tenant, perfiles de impresión por tipo de documento (H22). | `PrintSettingsCard` aclara "hoy esta configuración es por negocio". | Plantilla, datos fiscales y perfil de impresión por sucursal y caja. |
| **Reportes** | Reportes por día, medio, categoría, cajero, top productos y clientes; export XLSX con diseño (TX-2). | | Filtro global de sucursal, consolidado vs por sucursal, comparativo entre sucursales. |
| **Fiscal (ARCA)** | Nada emitido aún (F3 no iniciada). `docs/15-afip-integration.md` prevé `tenants.afip_pos_number` (uno por negocio). | | Punto de venta ARCA **por sucursal** (y por caja si se quiere), domicilio comercial por PV, CAEA de contingencia. |
| **Contabilidad** | Cierre Z inmutable, export XLSX. | | Plan de cuentas, asientos automáticos, Libro IVA Ventas, export a contador o ERP, conciliación de tarjetas y liquidaciones, tesorería. |

---

## 3. Matriz comparativa

Prioridad: **P0** bloquea vender a un cliente con 2+ locales · **P1** lo pide cualquier cadena chica · **P2** cadena mediana · **P3** enterprise. Esfuerzo: S (≤ 3 días), M (1-2 semanas), L (3-5 semanas), XL (más).

### 3.a Gestión de sucursales y "en qué sucursal estoy"

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| ABM de tiendas con código, región, zona, formato, cadena | Sí (`admin/business`) | Tabla sin UI | ABM + código + dimensiones mínimas (zona/grupo) | P0 | M | H89 |
| Terminales por tienda (LocalPos, Mobile) con categoría | Sí | Cajas sin UI | ABM de cajas, tipo (fija, móvil, autoservicio) | P0 | S | H89 |
| Usuario logueado en una tienda concreta | Sí (asignación tienda + rol) | Primera caja activa del tenant | Contexto sucursal + caja, persistido por dispositivo | P0 | M | H90 |
| Indicador visible de tienda y terminal | Cabecera BMC "Administrador · CENTRAL" | Sólo "Caja abierta" | Chip de sucursal en topbar, header del POS, ticket y display | P0 | S | H90 |
| Venta asignada a la tienda de la terminal | Sí (TLOG por terminal) | Sucursal default | Fix en `create_sale` y afines | P0 | S | H90 |
| Límite de sucursales por plan | n/a (on-premise) | `max_stores` sin enforcement | Trigger en `stores` y `cash_registers` | P0 | S | H89 |
| Estado online/ping de tienda y terminal | Sí (Estado de tiendas, Monitor de terminales) | No | Heartbeat de caja, última venta, versión | P2 | M | H99 |
| Grupos de tiendas (para configurar y reportar) | Sí | No | `store_groups` | P2 | S | H92 |

### 3.b Medios de pago y terminales en todas las sucursales ("compartir configuración")

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| Parámetros con alcance todas / grupo / tienda / terminal | Sí: 52 categorías en `systemProperty` | Todo por tenant | Motor de herencia tenant → grupo → sucursal → caja con "valor efectivo y de dónde viene" | P0 | L | H92 |
| Medios de pago centrales, habilitables por tienda | Sí (por canal y tienda) | `tenant_payment_methods` único | `store_payment_method_overrides` (enabled, recargo, config parcial) | P0 | M | H93 |
| Credenciales por sucursal (API key, store_id del proveedor) | Implícito (VTOL por tienda) | Una por tenant | `payment_secrets` con `store_id` opcional (null = del negocio) | P1 | M | H93 |
| Registro de terminales de cobro por tienda y caja | Sí (terminal + API de terminal) | `localStorage` y secret de texto | `payment_terminals` | P0 | M | H93 |
| Caja QR del proveedor por caja | VTOL | Una caja QR MP por ambiente | `mp_qr` por caja (external_pos_id por `cash_register`) | P1 | M | H93 |
| N° de comercio por adquirente y tienda | Sí (medios de exportación y conciliación) | En curso por tenant | `merchant_numbers` con override por sucursal | P1 | S | H93, F18/H110 |
| Cuotas y recargos por tienda | Sí | `payment_plans` por tenant | Override por sucursal (encaja en F14/H59) | P2 | M | H93, H59 |
| BIN de tarjeta → banco y medio | Sí (`storeConfigCardPrefix`) | No | Tabla de BIN (opcional) | P3 | M | F18/H110 |
| Medios de devolución permitidos por tienda | Sí | Global (F11) | Override por sucursal | P2 | S | H92 |
| Copiar configuración de una sucursal a otra | Por "todas las tiendas" | No | "Aplicar a todas", "Copiar desde", diff y revertir | P1 | M | H92, H62 |

### 3.c Clientes

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| Cliente único para toda la cadena (Party) | Sí | Sí (`customers` por tenant) | Ninguno estructural | ok | n/a | ya cubierto |
| Tipos de cliente múltiples, categoría impositiva, padrones | Sí | Grupos de clientes, condición IVA | Categoría impositiva por cliente para percepciones (F3/H79) | P2 | L | F3 |
| Cuenta corriente y crédito propio | Sí (2/7/15/30/60 días) | Cuenta corriente v2 | Límite global vs por sucursal, cobro y reporte por sucursal | P1 | S | H96 |
| Sucursal de alta e historial por tienda | Sí (reportes por tienda) | No | `customers.home_store_id`, filtros por sucursal | P2 | S | H96 |
| Fidelización (puntos, cupones, gift cards) | Napse Promo | F9 en progreso | Ya en F9/H53-H56 y F16/H80 | P2 | L | F9, H80 |

### 3.d Productos

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| Catálogo central replicado | Sí | Sí (catálogo por tenant, online) | Ninguno (no hay réplica: es SaaS) | ok | n/a | ya cubierto |
| Producto por tienda (habilitado, no a la venta, precio, costo) | Sí (`itemStore`) | No | `product_store_settings` | P1 | M | H94 |
| Stock por (tienda, depósito, estado) con reservado | Sí | Stock único | `stock_levels` por sucursal; depósitos y estados quedan en F11 | P0 | L | H94 |
| Listas de precios por tienda o grupo, vigencia, franja | Sí | Listas por canal | `price_lists.store_ids` / `store_group_id`, vigencia | P1 | M | H94 |
| Transferencias con estados y en tránsito | Sí | No | Documento de transferencia | P1 | L | H95 |
| Consulta de stock en otras tiendas desde el POS | Sí | No | "Ver en otras sucursales" en el buscador | P1 | S | H94 |
| OC, recepción, conteos, ajustes por tienda | Sí | Ajuste y merma globales | Ya en F14/H64 y F11; hacerlos por sucursal | P2 | L | H64 |

### 3.e Contabilidad y tesorería

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| Cuenta contable por cuenta externa y medio de pago | Sí | No | Plan de cuentas + mapeo medio → cuenta | P1 | M | F18/H109 |
| Código ERP por medio de pago y cuotas | Sí (medios de exportación) | No | `accounting_mappings` | P1 | S | F18/H109 |
| Export al ERP por colas | Sí (Rabbit, Teamplace, etc.) | No | Export diario por archivo; API/webhooks en H68 | P2 | M | F18/H109 |
| Libro IVA Venta y percepciones | Sí (reportes) | No | Depende de F3 (comprobantes fiscales) | P1 | M | F18/H109, F3 |
| Conciliación de período y turno | Sí (`tillHistory`) | Cierre Z | Marcar Z como conciliado, motivo | P2 | S | F18/H110 |
| Pagos con tarjeta y billetera, conciliados sí/no | Sí | Card voucher; reporte de conciliación y `payments.reconciled_at` en curso | Import de liquidaciones, matching por n° de comercio + lote + cupón | P1 | L | F18/H110 |
| Caja fuerte, retiros, rendiciones, cuentas por cajero | Sí | Ingresos y egresos del turno | Tesorería por sucursal | P2 | L | F18/H111 |
| Varias compañías que facturan (condiciones de facturación) | Sí | Una razón social por tenant | Razón social por sucursal (franquicias) | P3 | L | H98 |

### 3.f Transversal

| Capacidad (Napse) | Napse | NinjaPOS hoy | Gap | Prio | Esf. | Hito |
|---|---|---|---|---|---|---|
| Rol distinto por tienda, alcance CENTRAL/TIENDA | Sí | Rol por tenant | `tenant_user_stores` + RLS | P0 | L | H91 |
| Reportes por tienda con "Reporte offline" (cola) | Sí | Por tenant | Filtro sucursal, consolidado, comparativo; cola para pesados | P1 | M | H97 |
| Punto de venta fiscal por tienda y terminal, CAEA | Sí (centros emisores) | Un PV por tenant (doc) | `stores.afip_pos_number`, opcional por caja | P1 | M | H98 |
| Auditoría campo a campo | Sí | `audit_logs` con old/new | Ya cubierto; sumar `store_id` al log | P2 | S | H91 |
| Autorización de supervisor presencial o remota | Sí | PIN supervisor (cuenta corriente) | Remota y por sucursal: F11/F14 | P2 | M | H63 |

---

## 4. Diseño propuesto: herencia de configuración (tenant → sucursal → caja)

### 4.1 Principios

1. **Un solo lugar de verdad por nivel.** El negocio define el default. La sucursal **sólo guarda lo que pisa**. La caja sólo lo que pisa de la sucursal. Nada se copia por defecto, así un cambio central llega a todas las sucursales que no lo pisaron.
2. **Override por campo, no por fila.** Pisar el recargo de Visa en una sucursal no congela el resto de la configuración de Visa.
3. **Valor efectivo explicable.** Toda pantalla de configuración muestra, por campo, el valor efectivo y su origen: "Negocio", "Sucursal Centro" o "Caja 2", con "Volver al del negocio".
4. **Resolución en el servidor.** Los RPC (`create_sale`, Edges de pago) resuelven la configuración efectiva en SQL con la caja del turno. La UI sólo la muestra.
5. **Gating por plan intacto.** El override nunca habilita algo que el plan no tiene: `tenant_has_feature_for` se evalúa antes de la herencia.
6. **Compartir configuración** = tres acciones explícitas: "Aplicar a todas las sucursales" (borra overrides de ese campo), "Copiar desde otra sucursal" (con diff y confirmación) y "Plantilla de sucursal" (lo que se aplica al dar de alta una nueva).

### 4.2 Modelo genérico

Para no crear una tabla de override por dominio, una tabla de overrides con clave de dominio y JSON parcial:

```sql
create table config_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  scope       text not null check (scope in ('store_group','store','register')),
  scope_id    uuid not null,                 -- store_groups.id / stores.id / cash_registers.id
  domain      text not null,                 -- 'pos_settings' | 'payment_method' | 'ticket' | 'print' | 'pos_layout' | 'returns' ...
  domain_key  text not null default '',      -- p. ej. provider_key para 'payment_method'
  patch       jsonb not null default '{}',   -- sólo los campos pisados
  updated_by  uuid default auth.uid() references public.users(id),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (tenant_id, scope, scope_id, domain, domain_key)
);
-- RLS: lectura miembros del tenant; escritura owner/manager (o manager de esa sucursal, H91).
-- Trigger de auditoría (write_audit_log) y validación del patch por dominio (whitelist de campos).
```

Función de resolución (SQL, `stable`, `security definer` con `search_path` fijo):

```text
effective_config(domain, domain_key, register_id) → jsonb
  base   = fila del negocio (pos_settings / tenant_payment_methods / ticket_templates default ...)
  ⊕ patch de store_group (si la sucursal pertenece a un grupo)
  ⊕ patch de store (cash_registers.store_id)
  ⊕ patch de register
  + "_sources": { campo: 'tenant' | 'store_group:<id>' | 'store:<id>' | 'register:<id>' }
```

Para valores con estructura fija y alta frecuencia de lectura (por ejemplo `enabled` y `surcharge_pct` de un medio de pago, que se leen en cada venta) se puede materializar una vista `effective_payment_methods(register_id)`. Esto es el primer corte concreto de **F14/H57** (jerarquía de precedencia); el resto de niveles (rubro, canal, rol, usuario, horario) se suma después sobre la misma tabla.

### 4.3 Qué hereda cada dominio

| Dominio | Nivel negocio (hoy) | Sucursal puede pisar | Caja puede pisar | Notas |
|---|---|---|---|---|
| **Medios de pago** | `tenant_payment_methods` | `enabled`, `surcharge_pct`, `sort`, `config.merchant_numbers`, canales visibles | `enabled` (p. ej. caja sin posnet), favoritos | Nunca habilita una feature fuera del plan. |
| **Credenciales de proveedor** | `payment_secrets(tenant_id, provider_key)` | Credencial propia (`store_id` en `payment_secrets`, null = del negocio) | No | GO Cuotas, Mobbex, Nave y Payway trabajan con credencial o comercio por local. Sigue siendo sólo service_role. |
| **Planes de cuotas** | `payment_plans` | Activar o desactivar planes, recargo | No | Se combina con F14/H59. |
| **Terminales** | n/a | Sí (se registran en la sucursal) | Sí (terminal por defecto de la caja) | Tabla propia, ver §4.4. |
| **POS settings** | `pos_settings` | Redondeo, venta en negativo, cierre ciego, tolerancia, descuento máximo por rol | Cierre ciego, tolerancia | `sku_*` queda sólo en negocio. |
| **Diseño del POS** | `pos_layout` (negocio + usuario) | Preset, cobro (`checkout`) | Preset (caja rápida vs mostrador) | Hoy pisa el usuario; el orden queda negocio → sucursal → caja → usuario. |
| **Tickets** | `ticket_templates` default + branding | Plantilla por tipo, encabezado (dirección, teléfono, PV fiscal), leyenda | No | Datos fiscales de la sucursal salen de `stores`, no se tipean dos veces. |
| **Impresión** | Perfiles por tipo de documento (H22) | Perfil | Perfil (impresora de esa caja) | Cierra el pendiente de H22 "por sucursal/caja". |
| **Precios** | `products.price`, `price_lists` | Lista asignada a la sucursal, precio por producto (`product_store_settings`) | No | Ver H94. |
| **Devoluciones y garantías** | F11 | Plazo, medios de devolución permitidos | No | |
| **Display de cliente** | Por tenant | Branding, mensajes | Sí | Cierra el pendiente de H25. |

### 4.4 Terminales de cobro

```sql
create table payment_terminals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id),
  cash_register_id uuid references cash_registers(id),   -- null = flotante en la sucursal
  provider_key     text not null references payment_providers(key), -- mercadopago (Point/QR), nave, payway, fiserv, posnet_manual ...
  kind             text not null check (kind in ('point','qr_pos','posnet_manual','pinpad')),
  external_id      text,          -- device_id de Point, external_pos_id de la caja QR, pos_id de Nave, n° de terminal del posnet
  label            text not null, -- "Point mostrador", "Posnet Visa Caja 1"
  merchant_number  text,          -- n° de comercio del adquirente para esa terminal (cupón)
  acquirer         text,          -- prisma, fiserv, getnet, mp ...
  is_default       boolean not null default false,
  status           text not null default 'active' check (status in ('active','inactive','lost')),
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (tenant_id, provider_key, external_id)
);
-- Un default por (cash_register_id, kind). RLS por tenant + acceso a la sucursal (H91).
```

- El POS ofrece **la terminal default de su caja**; si no hay, las flotantes de la sucursal. Se elimina el `localStorage` de `PointCheckoutModal`.
- Las Edges (`mp_point`, `nave`, `mp_qr`) validan que la terminal sea de la sucursal de la caja del turno (no se cobra en un Point de otro local).
- `payments.card_voucher.comercio` se completa solo desde `payment_terminals.merchant_number` (o desde `merchant_numbers` efectivo de la sucursal) y queda editable. Eso alimenta la conciliación (F18/H110).
- Alta asistida: "Detectar lectores" (Point `devices`) muestra los no asignados y los asigna a sucursal y caja.

### 4.5 Pantalla de configuración (UX)

- Selector de alcance arriba de cada pantalla de Configuración: **"Configurando: Todo el negocio ▾"** con las sucursales (y cajas donde aplique). Con alcance de sucursal, cada campo muestra un punto "Pisado en esta sucursal" y el valor del negocio en gris debajo, con "Volver al del negocio".
- Vista **"Diferencias por sucursal"**: tabla campo × sucursal con los valores pisados resaltados, para que el dueño vea de un golpe qué local es distinto.
- Acciones: "Aplicar a todas" (por campo o por sección), "Copiar desde…" (con diff), "Plantilla para nuevas sucursales".
- Plan sin `multi_sucursal`: el selector de alcance no aparece y todo sigue como hoy.

---

## 5. UX: indicador y selector de sucursal

Objetivo del pedido: **que siempre se vea claro en qué sucursal estoy**.

1. **Chip de sucursal en el topbar del panel** (`components/layout/DashboardHeader.tsx` / `AppShell.tsx`): ícono de local + nombre corto ("Centro"), color de acento propio de la sucursal (opcional, elegido en el ABM). Al tocarlo abre el selector: "Todas las sucursales" (vista consolidada, sólo para quien tiene alcance central) o una sucursal. El valor filtra reportes, ventas, stock y caja. Se recuerda por usuario (`users.settings.active_store_id`) y se muestra también en el título de la pestaña ("Ventas · Centro").
2. **Cabecera del POS** (`components/pos/screen/PosTopBar.tsx`): el estado de caja pasa de "Caja 1 abierta" a **"Centro · Caja 1 · abierta"**. En mobile se abrevia "Centro · C1". El POS **no** permite cambiar de sucursal con un carrito en curso ni con turno abierto: para cambiar hay que cerrar el turno o pasar a otra caja.
3. **Entrada al POS:** si el usuario tiene acceso a más de una caja libre, una pantalla "¿Dónde vendés hoy?" con tarjetas por sucursal y sus cajas (libre, ocupada por X, cerrada). El dispositivo recuerda su caja (`localStorage` + `cash_registers.device_label` opcional). Con una sola caja posible, entra directo como hoy.
4. **Confirmación al abrir caja:** el modal de apertura dice "Abrís **Caja 1** en **Sucursal Centro**". El cierre Z y el ticket imprimen sucursal y caja.
5. **Display de cliente y ticket:** usan los datos de la sucursal (`lib/pos/customerDisplay.ts` ya tiene el campo "Caja 1 · Sucursal Centro").
6. **Alerta de contexto cruzado:** si el usuario mira "Sucursal Norte" en el panel pero su turno abierto es en "Centro", el botón "Vender" lleva al POS de Centro y lo dice.
7. Negocio con una sola sucursal: el chip no se muestra (cero ruido para kioscos), salvo que lo active en Configuración.

---

## 6. Esquema de datos (borrador) e implicancias de RLS

### 6.1 Tablas y columnas

| Cambio | Detalle |
|---|---|
| `stores` + columnas | `code text` (único por tenant), `legal_name`, `cuit` (null = el del negocio), `afip_pos_number int`, `address_*` estructurado, `timezone`, `color`, `store_group_id`, `opening_hours jsonb`. |
| `store_groups` | `id, tenant_id, name, deleted_at`. Zona o región para configurar y reportar. |
| `cash_registers` + columnas | `code`, `kind` ('fixed','mobile','self'), `deleted_at`, `afip_pos_number` opcional (si cada caja factura con su PV). |
| `tenant_user_stores` | `(tenant_id, user_id, store_id, role)`; ausencia de filas = acceso a todas (compatibilidad). `role` opcional pisa el rol del tenant en esa sucursal. |
| `config_overrides` | §4.2. |
| `payment_terminals` | §4.4. |
| `payment_secrets` | Agregar `store_id uuid null`; PK pasa a `(tenant_id, provider_key, coalesce(store_id))` vía índice único. |
| `stock_levels` | `(tenant_id, store_id, product_id, variant_id, qty, reserved, in_transit)`, mantenida por trigger sobre `stock_movements`; `products.stock` queda como suma (vista o columna derivada) para no romper pantallas. |
| `product_store_settings` | `(product_id, store_id, is_enabled, sellable, price, cost, allow_negative, stock_min)`, todo nullable = hereda. |
| `price_lists` + columnas | `store_ids uuid[]` o `store_group_id`, `valid_from`, `valid_to`. |
| `stock_transfers` + `stock_transfer_items` | Estados `draft → confirmed → in_transit → partially_received → received / cancelled`; movimientos `transfer_out` / `transfer_in`. |
| `customers` + columna | `home_store_id`. |
| `accounting_accounts`, `accounting_mappings`, `accounting_entries`, `accounting_entry_lines` | F18/H109. |
| `card_settlements`, `card_settlement_lines` | F18/H110 (liquidaciones importadas y su matching con `payments`). |

### 6.2 RLS

- Hoy toda policy es `tenant_id = current_tenant_id()`. Con H91 se suma un helper `user_can_access_store(store_id) returns boolean` (`stable`, `security definer`, cacheado con `(select ...)` en la policy, como ya se hace con `current_tenant_id()`).
- **Tablas con `store_id` directo** (`sales`, `cash_z_closures`, `stock_levels`, `stock_transfers`, `payment_terminals`, `cash_registers`): policy `tenant_id = current_tenant_id() and user_can_access_store(store_id)`.
- **Tablas hijas** (`sale_items`, `payments`, `cash_shifts`, `cash_movements`): o se desnormaliza `store_id` (recomendado: es inmutable y simplifica índices y reportes) o la policy hace `exists` contra el padre. Recomendación: **agregar `store_id` a `payments`, `cash_shifts` y `cash_movements`** con default por trigger desde la caja.
- **Maestros centrales** (`products`, `customers`, `price_lists`, `tenant_payment_methods`) siguen por tenant: son compartidos. Su escritura queda para alcance central (owner o manager sin restricción de sucursal).
- Índices: `(tenant_id, store_id, created_at desc)` en `sales` y `payments`.
- Riesgo: cambiar policies de `sales` y `payments` toca el camino caliente del POS. Hay que medir con `EXPLAIN` y tener tests RLS por rol y sucursal antes de activar.

### 6.3 Compatibilidad

- Tenants actuales: una sucursal y una caja; sin filas en `tenant_user_stores` = acceso total. Nada cambia para ellos.
- La migración que corrige `create_sale` es **segura y se puede hacer ya** (P0 independiente): la sucursal pasa a salir del turno de caja; con una sola sucursal el resultado es idéntico.

---

## 7. Plan por fases

| Etapa | Hitos | Entrega | Por qué en este orden |
|---|---|---|---|
| **0. Fix inmediato** | H90 (parte) | `create_sale`, `return_sale`, `exchange_sale` y stock toman la sucursal de la caja del turno. Test con 2 sucursales. | Es un bug latente; desbloquea todo lo demás y no cambia nada visible. |
| **1. Sucursal como contexto** | H89, H90 | ABM de sucursales y cajas, `max_stores` cumplido, chip de sucursal, header del POS "Centro · Caja 1", elección de caja al entrar. Gating real de `multi_sucursal`. | Es lo que el dueño pidió primero y lo que un cliente con 2 locales ve el día 1. |
| **2. Permisos por sucursal** | H91 | Sucursales permitidas por usuario, rol por sucursal, RLS con `user_can_access_store`. | Sin esto un cajero de un local ve ventas del otro. |
| **3. Configuración heredable** | H92, H93 | `config_overrides`, selector de alcance en Configuración, "Diferencias por sucursal", medios de pago y credenciales por sucursal, registro de terminales, n° de comercio por sucursal. | Responde "cómo configuro medios y terminales en todas las sucursales". |
| **4. Productos y stock por sucursal** | H94, H95 | Stock por sucursal, producto por sucursal, listas por sucursal, consulta en otras sucursales, transferencias. | Lo segundo que pide una cadena. |
| **5. Clientes y reportes** | H96, H97 | Sucursal de alta, cuenta corriente por sucursal, reportes consolidados y comparativos. | Barato una vez que hay `store_id` en todo. |
| **6. Fiscal por sucursal** | H98 | PV ARCA por sucursal y caja, datos fiscales en ticket. | Va junto con F3 (ARCA). |
| **7. Contabilidad** | F18/H109, F18/H110, F18/H111 | Export contable, plan de cuentas y asientos, conciliación de tarjetas, tesorería. | Necesita datos por sucursal y medios con n° de comercio. |
| **8. Monitoreo** | H99 | Estado de cajas y terminales, alertas. | Cuando haya cadenas en producción. |

---

## 8. Clasificación según la convención de features de plan

| Función | Key | Categoría | Plan sugerido | Dependencias |
|---|---|---|---|---|
| Primera sucursal y caja, indicador, fix de `create_sale` | (ninguna) | BASE | Todos | Ninguna |
| Varias sucursales y cajas, selector, consolidado | `multi_sucursal` (existe) | OPTIONAL | Business | H89, H90 |
| Varias cajas en una sucursal | `multi_caja` (nueva) | OPTIONAL | Pro | H89 |
| Roles y acceso por sucursal | dentro de `multi_sucursal` | OPTIONAL | Business | H91 requiere sucursales |
| Configuración por sucursal y caja | dentro de `multi_sucursal` (caja: `multi_caja`) | OPTIONAL | Business | H92 requiere sucursales |
| Registro de terminales | (ninguna) | BASE | Todos | H89; cada terminal sigue gateada por su medio (`mercadopago_point`, `nave`...) |
| Stock y precio por sucursal | dentro de `multi_sucursal` | OPTIONAL | Business | H94 requiere sucursales |
| Transferencias entre sucursales | `transferencias_stock` (nueva) | OPTIONAL | Business | H94 |
| Export contable (Libro IVA, asientos resumidos XLSX) | `export_contable` (nueva) | OPTIONAL | Pro | F3 para Libro IVA |
| Plan de cuentas y asientos automáticos | `contabilidad` (nueva) | OPTIONAL | Business | F18/H109 |
| Conciliación de tarjetas y liquidaciones | `conciliacion_tarjetas` (nueva) | OPTIONAL | Business | n° de comercio (en curso), H93 |
| Integración ERP (Tango, Bejerman, Xubio, Colppy) | `integracion_erp` (nueva) | ADDON | Por negocio | F18/H109 |
| Tesorería (caja fuerte, retiros a banco, rendiciones) | `tesoreria` (nueva) | OPTIONAL | Business | H89 |
| Varias razones sociales que facturan | `multi_razon_social` (nueva) | OPTIONAL | Enterprise | F3, H98 |
| Color y nombre corto de sucursal, chip visible con una sola | (pos_settings) | FLAG-OPERATIVO | Todos | H90 |
| Monitor de cajas y terminales | `monitoreo_sucursales` (nueva) | OPTIONAL | Enterprise | H93 |

Cada key nueva sigue el checklist de `CLAUDE.md`: migración en `features` (con `is_basic` y `grupo`), marca en `plans.limits.modules`, gating server-side con `tenant_has_feature_for` en el RPC o trigger que escribe, copy en `lib/saas/featureInfo.ts` y aparición en `lib/saas/planComparison.ts`. Mientras `multi_sucursal` no tenga función real sigue siendo MARKETING-FUTURO y conviene decirlo así en la comparación de planes.

---

## 9. Lo que conviene copiar de Napse y lo que conviene hacer mejor

**Copiar:** parámetros con alcance (todas, grupo, tienda, terminal), producto por tienda, rol por tienda con alcance central/tienda, terminal como entidad con su API, centros emisores (PV fiscal por tienda y terminal), código ERP por medio de pago, cuenta contable por cuenta externa, conciliación por período y turno, documentos de inventario con la misma máquina de estados.

**Hacer mejor:** mostrar siempre el valor efectivo y su origen (Napse no lo explica), no duplicar medios de pago por modo online/offline (ya resuelto con ADR-038), configuración visual con diff entre sucursales en lugar de 52 categorías de propiedades sueltas, y toda acción que cambia estado por POST/RPC con auditoría (nunca por GET).
