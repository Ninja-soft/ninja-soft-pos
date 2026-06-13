-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H47: Menús por horario / franja (daypart)             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Un negocio gastronómico ofrece distinta carta según la hora: desayuno por la
-- mañana, almuerzo al mediodía, happy hour a la tarde, cena a la noche. Un MENÚ
-- agrupa productos y vale en VENTANAS horarias (día de semana + rango horario).
-- El resolver `active_menu_ids()` dice qué menús están vigentes AHORA (hora local
-- de Argentina) para que el POS pueda filtrar la carta al menú del momento.
--
-- ADITIVO: tablas nuevas, RLS por tenant, gateado por el modo gastronómico
-- (pos_settings.dining_enabled) en la UI. Sin menús, nada cambia. La asignación
-- de productos a menús es opcional; un producto sin menú está siempre disponible.
--
-- Convención de día: weekday 0..6 = domingo..sábado (igual que extract(dow)).
-- Horario: minutos del día 0..1440 (00:00..24:00) en hora local AR. Un menú SIN
-- ventanas = siempre disponible (carta única). Ventana que cruza medianoche
-- (ej. happy hour 22→02): follow-up — hoy end_min > start_min (no cruza).

-- ── 1) menus ──────────────────────────────────────────────────────────────────
create table if not exists menus (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null,
  is_active   boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists menus_tenant_idx on menus(tenant_id) where deleted_at is null;

create trigger set_updated_at_menus
  before update on menus
  for each row execute function set_updated_at();

-- ── 2) menu_windows: ventana horaria (día + rango en minutos, hora local AR) ───
create table if not exists menu_windows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  menu_id     uuid not null references menus(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_min   int not null check (start_min between 0 and 1439),
  end_min     int not null check (end_min between 1 and 1440),
  created_at  timestamptz not null default now(),
  check (end_min > start_min)
);
create index if not exists menu_windows_menu_idx on menu_windows(menu_id);
create index if not exists menu_windows_tenant_idx on menu_windows(tenant_id);

-- ── 3) product_menus: a qué menús pertenece un producto ───────────────────────
create table if not exists product_menus (
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  menu_id     uuid not null references menus(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (product_id, menu_id)
);
create index if not exists product_menus_menu_idx on product_menus(menu_id);
create index if not exists product_menus_tenant_idx on product_menus(tenant_id);

-- ── 4) RLS: lectura por miembro del tenant; escritura sólo owner/manager ──────
-- (config comercial — mismo criterio que delivery_zones; la DB lo enforcea).
alter table menus enable row level security;
create policy menus_select on menus
  for select using (tenant_id = current_tenant_id());
create policy menus_write on menus
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

alter table menu_windows enable row level security;
create policy menu_windows_select on menu_windows
  for select using (tenant_id = current_tenant_id());
create policy menu_windows_write on menu_windows
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

alter table product_menus enable row level security;
create policy product_menus_select on product_menus
  for select using (tenant_id = current_tenant_id());
create policy product_menus_write on product_menus
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

-- Auditoría del CRUD de menús (config comercial). Las ventanas/asignaciones son
-- detalle del menú; auditamos el padre (mismo criterio acotado que otras config).
create trigger audit_menus
  after insert or update or delete on menus
  for each row execute function write_audit_log();

-- ── 5) active_menu_ids: menús vigentes en un instante (hora local AR) ─────────
-- SECURITY INVOKER: se apoya en la RLS de `menus`/`menu_windows` (sólo ve los del
-- tenant del que llama). Un menú activo SIN ventanas = siempre disponible; con
-- ventanas, vale si alguna matchea el día de semana + minuto del día local.
create or replace function active_menu_ids(p_at timestamptz default now())
returns setof uuid
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with local as (
    select (p_at at time zone 'America/Argentina/Buenos_Aires') as ts
  ),
  nowparts as (
    select extract(dow from ts)::int as wd,
           (extract(hour from ts) * 60 + extract(minute from ts))::int as minutes
    from local
  )
  select m.id
  from menus m
  where m.deleted_at is null
    and m.is_active
    and (
      not exists (select 1 from menu_windows w where w.menu_id = m.id)
      or exists (
        select 1 from menu_windows w, nowparts n
        where w.menu_id = m.id
          and w.weekday = n.wd
          and n.minutes >= w.start_min
          and n.minutes <  w.end_min
      )
    );
$$;
revoke all on function active_menu_ids(timestamptz) from public, anon;
grant execute on function active_menu_ids(timestamptz) to authenticated;
