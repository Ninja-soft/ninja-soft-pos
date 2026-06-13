-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H53 — Núcleo del motor de promociones (definición declarativa)        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Una PROMOCIÓN declarativa: condiciones (vigencia por fecha, día de semana,
-- franja horaria, monto mínimo del carrito, alcance) → acción (% o monto fijo de
-- descuento sobre el alcance). El motor de evaluación (lib/promotions/engine.ts)
-- decide cuál aplica en el carrito; esta tabla las define. RLS por tenant:
-- lectura de miembros (el POS las consume), escritura sólo owner/manager.
--
-- v1: alcance = todo el carrito / una categoría / un producto; acción = percent
-- o amount. Productos bonificados (NxM), combinables, segmentos de cliente y la
-- INTEGRACIÓN en el POS/cobro son siguientes hitos (H54/H55 + wiring).

create table if not exists promotions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name              text not null,
  is_active         boolean not null default true,
  -- Mayor número = más prioridad ante empate de descuento.
  priority          int not null default 0,
  -- Vigencia por fecha (hora local AR). null = sin límite por ese lado.
  valid_from        date,
  valid_to          date,
  -- Días de semana válidos (0=domingo..6=sábado). null/[] = todos.
  days_of_week      smallint[],
  -- Franja horaria en minutos del día (0..1440). null = todo el día.
  time_from         int check (time_from is null or time_from between 0 and 1439),
  time_to           int check (time_to is null or time_to between 1 and 1440),
  -- Monto mínimo del subtotal del carrito.
  min_amount        numeric(12,2) not null default 0 check (min_amount >= 0),
  -- Alcance del descuento.
  scope             text not null default 'cart' check (scope in ('cart','category','product')),
  scope_category_id uuid references categories(id) on delete cascade,
  scope_product_id  uuid references products(id) on delete cascade,
  -- Acción.
  action_type       text not null default 'percent' check (action_type in ('percent','amount')),
  action_value      numeric(12,2) not null default 0 check (action_value >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  -- Coherencia: % no puede superar 100; el alcance por categoría/producto exige su id.
  check (action_type <> 'percent' or action_value <= 100),
  check (scope <> 'category' or scope_category_id is not null),
  check (scope <> 'product' or scope_product_id is not null)
);
create index if not exists promotions_tenant_idx on promotions(tenant_id) where deleted_at is null;

create trigger set_updated_at_promotions
  before update on promotions
  for each row execute function set_updated_at();

alter table promotions enable row level security;

-- Lectura: miembros del tenant (el POS las evalúa). Escritura: owner/manager.
create policy promotions_select on promotions
  for select using (tenant_id = current_tenant_id());
create policy promotions_write on promotions
  for all
  using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  )
  with check (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  );

create trigger audit_promotions
  after insert or update or delete on promotions
  for each row execute function write_audit_log();
