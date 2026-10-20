-- =============================================================================
-- 20270114100000_h162_alertas  (F24 · H162, ADR-176)
--
-- Motor de alertas programadas. El negocio arma reglas sobre un catálogo fijo
-- (stock bajo, ventas bajo costo, deuda vencida, cheques y facturas de compra
-- por vencer, cajas sin cerrar, comprobantes sin CAE, mercadería parada,
-- ajustes grandes, descuentos altos, presupuestos por vencer, clientes que
-- dejaron de comprar, aumentos de costo, certificado de ARCA y anulaciones)
-- con umbrales, frecuencia (cada hora, diaria o semanal, a la hora de
-- Argentina), sucursal, canales (campana y mail) y a quién le llega.
--
--   A) Feature OPTIONAL `alertas_programadas` (grupo reportes, Pro+).
--   B) Tablas alert_rules, alert_events y alert_seen (RLS, escritura sólo por
--      RPC). alert_seen guarda qué casos ya se vieron por regla: con "sólo
--      casos nuevos" se avisa nada más lo que no estaba en la corrida
--      anterior (un caso que se resuelve y vuelve a aparecer es nuevo).
--   C) Catálogo (alert_catalog, espejo en lib/alerts/catalog.ts) y evaluador
--      alert_evaluate(tenant, kind, params, store): devuelve los casos
--      [{key, title, detail, amount?, url?}] con clave estable, hasta 200.
--   D) Runner alert_run_due (pg_cron cada 15 minutos): evalúa las reglas que
--      tocan, registra el evento, avisa por la campana (una notificación por
--      corrida y destinatario) y deja el mail pendiente. Cada regla corre en
--      su propio bloque: un error queda en el evento y no corta el resto.
--   E) Mail: la Edge alerts_email toma los eventos pendientes y manda un
--      resumen por negocio con el email del negocio (alert_email_pending /
--      alert_email_mark, sólo service_role).
--   F) RPC de la UI: alert_rules_list, alert_rule_save, alert_rule_delete,
--      alert_rule_test (Probar ahora, sin avisar) y alert_events_list.
--      Configurar: dueño o config.edit. Historial: reports.view.
--   G) Jobs pg_cron alerts-run (SQL puro) y alerts-email (pg_net a la Edge).
-- WhatsApp queda fuera (no hay infraestructura): channels es jsonb para
-- sumarlo como otra clave sin migrar datos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature.
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('alertas_programadas', 'Alertas programadas',
   'Reglas de aviso sobre stock, ventas, caja, cobranzas, compras y facturación, con frecuencia, horario y destinatarios; avisan por la campana y por mail sólo con los casos nuevos',
   'reportes', false, 178)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('alertas_programadas', p.key in ('pro', 'business', 'enterprise')),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'alertas_programadas');

-- Tipo de notificación nuevo (la campana lo muestra como "Alertas").
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support',
                  'cobros','disputas','comercial','pedidos','mercadolibre','alertas'));

-- Bitácora de mails: el resumen de alertas.
alter table system_emails drop constraint if exists system_emails_kind_check;
alter table system_emails add constraint system_emails_kind_check
  check (kind in ('system', 'receipt', 'smtp_test', 'password_recovery', 'account_reminder',
                  'account_statement', 'payment_link', 'quote', 'alerts_digest'));

-- -----------------------------------------------------------------------------
-- B) Tablas.
-- -----------------------------------------------------------------------------
create table if not exists alert_rules (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  kind              text not null check (kind ~ '^[a-z_]{3,40}$'),
  enabled           boolean not null default true,
  params            jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  frequency         text not null default 'daily' check (frequency in ('hourly', 'daily', 'weekly')),
  hour              smallint not null default 8 check (hour between 0 and 23),
  weekdays          smallint[] not null default '{}'
                      check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  store_id          uuid references stores(id) on delete cascade,
  channels          jsonb not null default '{"bell": true, "email": false}'::jsonb
                      check (jsonb_typeof(channels) = 'object'),
  audience_roles    text[] not null default array['owner', 'manager']::text[]
                      check (audience_roles <@ array['owner', 'manager', 'cashier', 'viewer']::text[]),
  audience_user_ids uuid[] not null default '{}' check (cardinality(audience_user_ids) <= 50),
  only_new          boolean not null default true,
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  last_hits         integer,
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
comment on table alert_rules is
  'ADR-176 (H162): reglas de alertas programadas del negocio sobre el catálogo alert_catalog(). Escritura por RPC.';
create unique index if not exists alert_rules_kind_store_uidx
  on alert_rules(tenant_id, kind, store_id) nulls not distinct where deleted_at is null;
create index if not exists alert_rules_due_idx
  on alert_rules(next_run_at) where enabled and deleted_at is null;
create index if not exists alert_rules_tenant_idx on alert_rules(tenant_id, created_at);
create index if not exists alert_rules_store_idx on alert_rules(store_id) where store_id is not null;

drop trigger if exists set_updated_at_alert_rules on alert_rules;
create trigger set_updated_at_alert_rules
  before update on alert_rules
  for each row execute function set_updated_at();

create table if not exists alert_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  rule_id     uuid not null references alert_rules(id) on delete cascade,
  kind        text not null,
  ran_at      timestamptz not null default now(),
  hits        integer not null default 0,
  new_hits    integer not null default 0,
  items       jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  notified    boolean not null default false,
  email_status text not null default 'none'
                check (email_status in ('none', 'pending', 'sent', 'failed', 'skipped')),
  email_error text check (email_error is null or char_length(email_error) <= 500),
  error       text check (error is null or char_length(error) <= 500),
  created_at  timestamptz not null default now()
);
comment on table alert_events is
  'ADR-176 (H162): cada corrida de una regla: casos encontrados (hasta 50, con new), aviso y estado del mail.';
create index if not exists alert_events_tenant_idx on alert_events(tenant_id, created_at desc);
create index if not exists alert_events_rule_idx on alert_events(rule_id, ran_at desc);
create index if not exists alert_events_email_pending_idx
  on alert_events(ran_at) where email_status = 'pending';

create table if not exists alert_seen (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  rule_id       uuid not null references alert_rules(id) on delete cascade,
  item_key      text not null check (char_length(item_key) <= 200),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (rule_id, item_key)
);
comment on table alert_seen is
  'ADR-176 (H162): casos vistos por regla en la última corrida (para "sólo casos nuevos"). Sólo el runner escribe.';
create index if not exists alert_seen_tenant_idx on alert_seen(tenant_id);

alter table alert_rules enable row level security;
alter table alert_events enable row level security;
alter table alert_seen enable row level security;

drop policy if exists alert_rules_select on alert_rules;
create policy alert_rules_select on alert_rules
  for select using ((tenant_id = (select current_tenant_id())
                     and ((select has_capability('config.edit')) or (select has_capability('reports.view'))))
                    or (select internal_scope()));
drop policy if exists alert_events_select on alert_events;
create policy alert_events_select on alert_events
  for select using ((tenant_id = (select current_tenant_id()) and (select has_capability('reports.view')))
                    or (select internal_scope()));
drop policy if exists alert_seen_select on alert_seen;
create policy alert_seen_select on alert_seen
  for select using ((tenant_id = (select current_tenant_id()) and (select has_capability('config.edit')))
                    or (select internal_scope()));

revoke insert, update, delete on alert_rules, alert_events, alert_seen from anon, authenticated;
revoke all on alert_rules, alert_events, alert_seen from anon;
grant select on alert_rules, alert_events, alert_seen to authenticated;

-- -----------------------------------------------------------------------------
-- C) Catálogo y evaluador.
-- -----------------------------------------------------------------------------
-- ESPEJO: lib/alerts/catalog.ts (tests/unit/alertsCatalog.test.ts compara este
-- JSON con el catálogo de la UI: tipos, umbrales, valores por defecto y rangos).
create or replace function alert_catalog()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select $catalog${
  "stock_bajo": {"label": "Stock bajo el mínimo", "severity": "warning", "url": "/inventario", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["producto", "productos"], "params": {}},
  "stock_negativo": {"label": "Stock negativo", "severity": "warning", "url": "/inventario", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["producto", "productos"], "params": {}},
  "venta_bajo_costo": {"label": "Ventas bajo costo", "severity": "critical", "url": "/ventas", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["renglón", "renglones"], "params": {"hours": {"default": 24, "min": 1, "max": 168}}},
  "deuda_vencida": {"label": "Deuda vencida de clientes", "severity": "warning", "url": "/clientes/cuentas", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["cliente", "clientes"], "params": {"days": {"default": 30, "min": 1, "max": 365}}},
  "cheques_por_vencer": {"label": "Cheques por vencer", "severity": "warning", "url": "/tesoreria", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["cheque", "cheques"], "params": {"days": {"default": 7, "min": 0, "max": 60}}},
  "facturas_compra_por_vencer": {"label": "Facturas de compra por vencer", "severity": "warning", "url": "/compras", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["factura", "facturas"], "params": {"days": {"default": 7, "min": 0, "max": 60}}},
  "caja_sin_cerrar": {"label": "Cajas sin cerrar", "severity": "warning", "url": "/caja", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["caja", "cajas"], "params": {"hours": {"default": 12, "min": 1, "max": 72}}},
  "comprobantes_sin_cae": {"label": "Comprobantes sin CAE", "severity": "critical", "url": "/ventas", "frequency": "hourly", "hour": 8, "weekdays": [], "noun": ["comprobante", "comprobantes"], "params": {"minutes": {"default": 30, "min": 5, "max": 1440}}},
  "mercaderia_parada": {"label": "Mercadería parada", "severity": "info", "url": "/inventario", "frequency": "weekly", "hour": 8, "weekdays": [1], "noun": ["producto", "productos"], "params": {"days": {"default": 60, "min": 7, "max": 365}}},
  "ajustes_grandes": {"label": "Ajustes de stock grandes", "severity": "warning", "url": "/inventario", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["ajuste", "ajustes"], "params": {"hours": {"default": 24, "min": 1, "max": 168}, "qty": {"default": 50, "min": 0, "max": 1000000}, "value": {"default": 100000, "min": 0, "max": 10000000000}}},
  "descuentos_altos": {"label": "Descuentos altos", "severity": "warning", "url": "/ventas", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["venta", "ventas"], "params": {"hours": {"default": 24, "min": 1, "max": 168}, "pct": {"default": 20, "min": 1, "max": 100}}},
  "presupuestos_por_vencer": {"label": "Presupuestos por vencer", "severity": "info", "url": "/presupuestos", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["presupuesto", "presupuestos"], "params": {"days": {"default": 3, "min": 0, "max": 60}}},
  "clientes_inactivos": {"label": "Clientes que dejaron de comprar", "severity": "info", "url": "/clientes", "frequency": "weekly", "hour": 8, "weekdays": [1], "noun": ["cliente", "clientes"], "params": {"days": {"default": 60, "min": 7, "max": 730}, "min_purchases": {"default": 3, "min": 1, "max": 100}}},
  "aumento_costo": {"label": "Aumentos de costo", "severity": "warning", "url": "/productos", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["producto", "productos"], "params": {"hours": {"default": 24, "min": 1, "max": 168}, "pct": {"default": 10, "min": 1, "max": 1000}}},
  "certificado_arca": {"label": "Certificado de ARCA por vencer", "severity": "critical", "url": "/configuracion?seccion=facturacion", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["certificado", "certificados"], "params": {"days": {"default": 30, "min": 1, "max": 120}}},
  "anulaciones": {"label": "Anulaciones", "severity": "warning", "url": "/ventas", "frequency": "daily", "hour": 8, "weekdays": [], "noun": ["anulación", "anulaciones"], "params": {"hours": {"default": 24, "min": 1, "max": 168}, "count": {"default": 5, "min": 1, "max": 1000}}}
}$catalog$::jsonb;
$$;
grant execute on function alert_catalog() to authenticated, service_role;

-- Umbral de una regla: el valor guardado (si es número) o el del catálogo,
-- siempre dentro del rango.
create or replace function _alert_num(p_params jsonb, p_kind text, p_key text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select greatest((d ->> 'min')::numeric, least((d ->> 'max')::numeric,
           coalesce(case when jsonb_typeof(p_params -> p_key) = 'number' then (p_params ->> p_key)::numeric end,
                    (d ->> 'default')::numeric)))
    from (select alert_catalog() -> p_kind -> 'params' -> p_key as d) x;
$$;
revoke all on function _alert_num(jsonb, text, text) from public, anon, authenticated;

create or replace function _alert_money(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p is null then '' else
    (case when p < 0 then '-$ ' else '$ ' end) || replace(to_char(abs(round(p)), 'FM999,999,999,999,990'), ',', '.') end;
$$;
revoke all on function _alert_money(numeric) from public, anon, authenticated;

create or replace function _alert_qty(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(trim_scale(round(p, 3))::text, '0');
$$;
revoke all on function _alert_qty(numeric) from public, anon, authenticated;

-- Próxima corrida en hora de Argentina. ESPEJO: nextRunAt() en
-- lib/alerts/catalog.ts. weekdays: 0 = domingo ... 6 = sábado.
create or replace function alert_next_run(p_frequency text, p_hour int, p_weekdays smallint[], p_from timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz    text := 'America/Argentina/Buenos_Aires';
  v_local timestamp := p_from at time zone v_tz;
  v_hour  int := greatest(0, least(23, coalesce(p_hour, 8)));
  v_cand  timestamp;
  i       int;
begin
  if p_frequency = 'hourly' then
    return (date_trunc('hour', v_local) + interval '1 hour') at time zone v_tz;
  end if;
  for i in 0..7 loop
    v_cand := date_trunc('day', v_local) + make_interval(days => i, hours => v_hour);
    if v_cand > v_local
       and (p_frequency <> 'weekly' or coalesce(cardinality(p_weekdays), 0) = 0
            or extract(dow from v_cand)::smallint = any (p_weekdays)) then
      return v_cand at time zone v_tz;
    end if;
  end loop;
  return (date_trunc('day', v_local) + make_interval(days => 1, hours => v_hour)) at time zone v_tz;
end;
$$;
grant execute on function alert_next_run(text, int, smallint[], timestamptz) to authenticated, service_role;

-- Casos de una regla. Sin avisar ni escribir: lo usan el runner y Probar
-- ahora. Cada caso: {key (estable), title, detail, amount?, url?}.
create or replace function alert_evaluate(p_tenant uuid, p_kind text, p_params jsonb, p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_items  jsonb := '[]'::jsonb;
  v_today  date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_tz     text := 'America/Argentina/Buenos_Aires';
  v_url    text := alert_catalog() -> p_kind ->> 'url';
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_hours  numeric;
  v_days   numeric;
  v_n      numeric;
  v_m      numeric;
  v_count  bigint;
  v_value  numeric;
  v_top    jsonb;
begin
  if p_tenant is null or alert_catalog() -> p_kind is null then
    raise exception 'invalid_kind';
  end if;

  if p_kind = 'stock_bajo' then
    if p_store is null then
      select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', p.id::text, 'title', p.name,
                 'detail', 'Quedan ' || _alert_qty(p.stock) || ' (mínimo ' || _alert_qty(p.stock_min) || ')',
                 'url', v_url) as item,
               coalesce(p.stock, 0) - p.stock_min as ord
          from products p
         where p.tenant_id = p_tenant and p.deleted_at is null and p.is_active
           and coalesce(p.track_stock, false) and coalesce(p.stock_min, 0) > 0
           and coalesce(p.stock, 0) <= p.stock_min
         order by ord, p.name limit 200) x;
    else
      select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', ps.product_id::text || ':' || coalesce(ps.variant_id::text, ''),
                 'title', p.name,
                 'detail', 'Quedan ' || _alert_qty(ps.qty) || ' (mínimo '
                           || _alert_qty(coalesce(ps.min_qty, p.stock_min)) || ')',
                 'url', v_url) as item,
               ps.qty - coalesce(ps.min_qty, p.stock_min) as ord
          from product_stock ps
          join products p on p.id = ps.product_id
         where ps.tenant_id = p_tenant and ps.store_id = p_store
           and p.deleted_at is null and p.is_active and coalesce(p.track_stock, false)
           and coalesce(ps.min_qty, p.stock_min, 0) > 0
           and ps.qty <= coalesce(ps.min_qty, p.stock_min)
         order by ord, p.name limit 200) x;
    end if;

  elsif p_kind = 'stock_negativo' then
    if p_store is null then
      select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', p.id::text, 'title', p.name,
                 'detail', 'Stock ' || _alert_qty(p.stock), 'url', v_url) as item,
               p.stock as ord
          from products p
         where p.tenant_id = p_tenant and p.deleted_at is null and p.is_active
           and coalesce(p.track_stock, false) and p.stock < 0
         order by p.stock, p.name limit 200) x;
    else
      select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', ps.product_id::text || ':' || coalesce(ps.variant_id::text, ''),
                 'title', p.name, 'detail', 'Stock ' || _alert_qty(ps.qty), 'url', v_url) as item,
               ps.qty as ord
          from product_stock ps
          join products p on p.id = ps.product_id
         where ps.tenant_id = p_tenant and ps.store_id = p_store
           and p.deleted_at is null and coalesce(p.track_stock, false) and ps.qty < 0
         order by ps.qty, p.name limit 200) x;
    end if;

  elsif p_kind = 'venta_bajo_costo' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    -- Costo del renglón si la venta lo guardó (H161); si no, el del producto.
    select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', y.id::text,
               'title', 'Venta N° ' || y.number || ': ' || y.product_name,
               'detail', 'Precio ' || _alert_money(y.unit) || ' y costo ' || _alert_money(y.cost)
                         || ' (' || _alert_qty(y.quantity) || ' u.)',
               'amount', round((y.cost - y.unit) * y.quantity, 2),
               'url', v_url) as item,
             (y.cost - y.unit) * y.quantity as ord
        from (
          select si.id, s.number, si.product_name, si.quantity,
                 si.subtotal / si.quantity as unit,
                 coalesce(nullif(to_jsonb(si) ->> 'unit_cost', '')::numeric, p.cost) as cost
            from sales s
            join sale_items si on si.sale_id = s.id
            join products p on p.id = si.product_id
           where s.tenant_id = p_tenant and s.status = 'completed'
             and s.created_at >= now() - make_interval(hours => v_hours::int)
             and (p_store is null or s.store_id = p_store)
             and si.tenant_id = p_tenant and si.quantity > 0
        ) y
       where y.cost > 0 and y.unit < y.cost
       order by ord desc limit 200) x;

  elsif p_kind = 'deuda_vencida' then
    v_days := _alert_num(v_params, p_kind, 'days');
    if tenant_has_feature_for(p_tenant, 'cuenta_corriente') then
      select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', c.id::text, 'title', c.name,
                 'detail', 'Vencido hace ' || d.max_days || ' días',
                 'amount', round(d.overdue, 2), 'url', v_url) as item,
               d.overdue as ord
          from (
            select od.customer_id, sum(od.open_amount) as overdue, max(v_today - od.due_date) as max_days
              from account_open_debits(p_tenant, null) od
             where od.due_date is not null and od.due_date < v_today
             group by od.customer_id
          ) d
          join customers c on c.id = d.customer_id
         where d.max_days > v_days and d.overdue > 0.009
         order by d.overdue desc limit 200) x;
    end if;

  elsif p_kind = 'cheques_por_vencer' then
    v_days := _alert_num(v_params, p_kind, 'days');
    -- De terceros en cartera (a depositar) y propios entregados (se debitan).
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', ch.id::text,
               'title', 'Cheque ' || case when ch.kind = 'own' then 'propio' else 'de tercero' end
                        || ' N° ' || ch.number || coalesce(' · ' || ch.bank_name, ''),
               'detail', case when ch.payment_date < v_today then 'Venció el ' || to_char(ch.payment_date, 'DD/MM')
                              when ch.payment_date = v_today then 'Vence hoy'
                              else 'Vence el ' || to_char(ch.payment_date, 'DD/MM') end
                         || case when ch.kind = 'own' then ' · se debita' else ' · a depositar' end,
               'amount', ch.amount, 'url', v_url) as item,
             ch.payment_date as ord
        from cheques ch
       where ch.tenant_id = p_tenant
         and ((ch.kind = 'third_party' and ch.status = 'en_cartera') or (ch.kind = 'own' and ch.status = 'entregado'))
         and ch.payment_date <= v_today + v_days::int
         and ch.payment_date >= v_today - 30
       order by ch.payment_date limit 200) x;

  elsif p_kind = 'facturas_compra_por_vencer' then
    v_days := _alert_num(v_params, p_kind, 'days');
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', o.invoice_id::text,
               'title', 'Factura ' || coalesce(o.letter || ' ', '') || coalesce(o.point_of_sale::text || '-', '')
                        || coalesce(o.number::text, '') || ' · ' || s.name,
               'detail', case when o.due_date < v_today then 'Venció el ' || to_char(o.due_date, 'DD/MM')
                              when o.due_date = v_today then 'Vence hoy'
                              else 'Vence el ' || to_char(o.due_date, 'DD/MM') end,
               'amount', o.open_ars, 'url', v_url) as item,
             o.due_date as ord
        from supplier_invoice_open o
        join suppliers s on s.id = o.supplier_id
       where o.tenant_id = p_tenant and o.open_ars > 0.009
         and o.due_date <= v_today + v_days::int
       order by o.due_date limit 200) x;

  elsif p_kind = 'caja_sin_cerrar' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', cs.id::text,
               'title', r.name || coalesce(' · ' || st.name, ''),
               'detail', 'Abierta desde el ' || to_char(cs.opened_at at time zone v_tz, 'DD/MM HH24:MI')
                         || coalesce(' por ' || nullif(u.full_name, ''), ''),
               'url', v_url) as item,
             cs.opened_at as ord
        from cash_shifts cs
        join cash_registers r on r.id = cs.cash_register_id
        left join stores st on st.id = coalesce(cs.store_id, r.store_id)
        left join users u on u.id = cs.opened_by
       where cs.tenant_id = p_tenant and cs.status = 'open'
         and cs.opened_at < now() - make_interval(hours => v_hours::int)
         and (p_store is null or coalesce(cs.store_id, r.store_id) = p_store)
       order by cs.opened_at limit 200) x;

  elsif p_kind = 'comprobantes_sin_cae' then
    v_n := _alert_num(v_params, p_kind, 'minutes');
    -- Pendiente y rechazado son casos distintos: si se rechaza, avisa de nuevo.
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', fd.id::text || ':'
                                       || case when fd.status in ('rechazado', 'requiere_accion') then 'r' else 'p' end,
               'title', case when fd.origin = 'sale' then 'Factura' else 'Nota de crédito' end
                        || coalesce(' de la venta N° ' || s.number, ''),
               'detail', case fd.status when 'rechazado' then 'Rechazado'
                                        when 'requiere_accion' then 'Requiere acción'
                                        else 'Sin CAE desde el ' || to_char(fd.created_at at time zone v_tz, 'DD/MM HH24:MI') end
                         || coalesce(' · ' || left(nullif(fd.last_error_msg, ''), 120), ''),
               'amount', fd.imp_total, 'url', v_url) as item,
             fd.created_at as ord
        from fiscal_documents fd
        left join sales s on s.id = fd.sale_id
       where fd.tenant_id = p_tenant and fd.environment = 'produccion'
         and fd.status in ('pendiente', 'enviando', 'rechazado', 'requiere_accion')
         and fd.created_at < now() - make_interval(mins => v_n::int)
         and (p_store is null or fd.store_id = p_store)
       order by fd.created_at limit 200) x;

  elsif p_kind = 'mercaderia_parada' then
    v_days := _alert_num(v_params, p_kind, 'days');
    -- Un resumen (cantidad y valor a costo) y los 10 de más valor.
    with cand as (
      select p.id, p.name, q.qty, round(coalesce(p.cost, 0) * q.qty, 2) as value
        from products p
        cross join lateral (
          select case when p_store is null then coalesce(p.stock, 0)
                      else coalesce((select sum(ps.qty) from product_stock ps
                                      where ps.product_id = p.id and ps.store_id = p_store
                                        and ps.tenant_id = p_tenant), 0) end as qty
        ) q
       where p.tenant_id = p_tenant and p.deleted_at is null and p.is_active
         and coalesce(p.track_stock, false) and q.qty > 0
         and p.created_at < now() - make_interval(days => v_days::int)
         and not exists (
           select 1 from sale_items si join sales s on s.id = si.sale_id
            where si.product_id = p.id and si.tenant_id = p_tenant and s.status = 'completed'
              and s.created_at >= now() - make_interval(days => v_days::int)
              and (p_store is null or s.store_id = p_store))
    )
    select count(*), coalesce(sum(value), 0),
           coalesce((select jsonb_agg(item order by ord desc) from (
              select jsonb_build_object('key', c2.id::text, 'title', c2.name,
                       'detail', 'Stock ' || _alert_qty(c2.qty) || ' sin ventas en ' || v_days || ' días',
                       'amount', c2.value, 'url', v_url) as item, c2.value as ord
                from cand c2 order by c2.value desc, c2.name limit 10) t), '[]'::jsonb)
      into v_count, v_value, v_top
      from cand;
    if v_count > 0 then
      v_items := jsonb_build_array(jsonb_build_object(
                   'key', 'resumen:' || v_count,
                   'title', v_count || case when v_count = 1 then ' producto' else ' productos' end
                            || ' sin ventas en ' || v_days || ' días',
                   'detail', 'Valor a costo ' || _alert_money(v_value),
                   'amount', v_value, 'url', v_url)) || v_top;
    end if;

  elsif p_kind = 'ajustes_grandes' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    v_n := _alert_num(v_params, p_kind, 'qty');
    v_m := _alert_num(v_params, p_kind, 'value');
    select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', a.id::text, 'title', p.name,
               'detail', case when a.delta > 0 then '+' else '' end || _alert_qty(a.delta) || ' u. · ' || a.reason
                         || coalesce(' · ' || nullif(u.full_name, ''), '')
                         || case when a.status = 'pending' then ' · pendiente de aprobar' else '' end,
               'amount', abs(a.value), 'url', v_url) as item,
             abs(a.value) as ord
        from stock_adjustments a
        join products p on p.id = a.product_id
        left join users u on u.id = a.requested_by
       where a.tenant_id = p_tenant and a.status in ('pending', 'applied')
         and a.created_at >= now() - make_interval(hours => v_hours::int)
         and (p_store is null or a.store_id = p_store)
         and ((v_n > 0 and abs(a.delta) >= v_n) or (v_m > 0 and abs(a.value) >= v_m))
       order by abs(a.value) desc limit 200) x;

  elsif p_kind = 'descuentos_altos' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    v_n := _alert_num(v_params, p_kind, 'pct');
    select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', s.id::text, 'title', 'Venta N° ' || s.number,
               'detail', 'Descuento del ' || round(s.discount_total * 100 / s.subtotal) || ' %'
                         || coalesce(' · ' || nullif(u.full_name, ''), ''),
               'amount', s.discount_total, 'url', v_url) as item,
             s.discount_total * 100 / s.subtotal as ord
        from sales s
        left join users u on u.id = s.created_by
       where s.tenant_id = p_tenant and s.status = 'completed'
         and s.created_at >= now() - make_interval(hours => v_hours::int)
         and (p_store is null or s.store_id = p_store)
         and s.subtotal > 0 and s.discount_total > 0
         and s.discount_total * 100 / s.subtotal >= v_n
       order by ord desc limit 200) x;

  elsif p_kind = 'presupuestos_por_vencer' then
    v_days := _alert_num(v_params, p_kind, 'days');
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', q.id::text,
               'title', 'Presupuesto N° ' || q.number || coalesce(' · ' || nullif(q.customer_name, ''), ''),
               'detail', case when q.valid_until = v_today then 'Vence hoy'
                              else 'Vence el ' || to_char(q.valid_until, 'DD/MM') end,
               'amount', q.total, 'url', v_url) as item,
             q.valid_until as ord
        from quotes q
       where q.tenant_id = p_tenant and q.status = 'sent'
         and q.valid_until between v_today and v_today + v_days::int
         and (p_store is null or q.store_id = p_store)
       order by q.valid_until limit 200) x;

  elsif p_kind = 'clientes_inactivos' then
    v_days := _alert_num(v_params, p_kind, 'days');
    v_n := _alert_num(v_params, p_kind, 'min_purchases');
    select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', c.id::text, 'title', c.name,
               'detail', a.n || ' compras · la última el ' || to_char(a.last_at at time zone v_tz, 'DD/MM/YYYY'),
               'url', v_url) as item,
             a.last_at as ord
        from (
          select s.customer_id, count(*) as n, max(s.created_at) as last_at
            from sales s
           where s.tenant_id = p_tenant and s.status = 'completed' and s.customer_id is not null
             and (p_store is null or s.store_id = p_store)
           group by s.customer_id
        ) a
        join customers c on c.id = a.customer_id and c.deleted_at is null
       where a.n >= v_n and a.last_at < now() - make_interval(days => v_days::int)
       order by a.last_at desc limit 200) x;

  elsif p_kind = 'aumento_costo' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    v_n := _alert_num(v_params, p_kind, 'pct');
    select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', h.id::text, 'title', p.name,
               'detail', 'De ' || _alert_money(h.old_value) || ' a ' || _alert_money(h.new_value)
                         || ' (+' || round((h.new_value - h.old_value) * 100 / h.old_value) || ' %)',
               'amount', h.new_value, 'url', v_url) as item,
             (h.new_value - h.old_value) * 100 / h.old_value as ord
        from product_cost_history h
        join products p on p.id = h.product_id
       where h.tenant_id = p_tenant and h.kind = 'cost'
         and h.created_at >= now() - make_interval(hours => v_hours::int)
         and h.old_value > 0 and h.new_value > h.old_value
         and (h.new_value - h.old_value) * 100 / h.old_value >= v_n
       order by ord desc limit 200) x;

  elsif p_kind = 'certificado_arca' then
    v_days := _alert_num(v_params, p_kind, 'days');
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb) into v_items from (
      select jsonb_build_object('key', c.id::text || ':' || to_char(c.not_after, 'YYYYMMDD'),
               'title', 'Certificado de ARCA',
               'detail', case when c.not_after < now() then 'Venció el ' else 'Vence el ' end
                         || to_char(c.not_after at time zone v_tz, 'DD/MM/YYYY'),
               'url', v_url) as item,
             c.not_after as ord
        from arca_certificates c
       where c.tenant_id = p_tenant and c.status = 'active' and c.deleted_at is null
         and c.environment = 'produccion' and c.not_after is not null
         and c.not_after <= now() + make_interval(days => v_days::int)
       order by c.not_after limit 200) x;

  elsif p_kind = 'anulaciones' then
    v_hours := _alert_num(v_params, p_kind, 'hours');
    v_n := _alert_num(v_params, p_kind, 'count');
    select count(*) into v_count
      from sales s
     where s.tenant_id = p_tenant and s.status = 'voided'
       and s.voided_at >= now() - make_interval(hours => v_hours::int)
       and (p_store is null or s.store_id = p_store);
    if v_count >= v_n then
      select coalesce(jsonb_agg(item order by ord desc), '[]'::jsonb) into v_items from (
        select jsonb_build_object('key', s.id::text, 'title', 'Venta N° ' || s.number,
                 'detail', 'Anulada el ' || to_char(s.voided_at at time zone v_tz, 'DD/MM HH24:MI')
                           || coalesce(' por ' || nullif(u.full_name, ''), '')
                           || coalesce(' · ' || left(nullif(s.void_reason, ''), 80), ''),
                 'amount', s.total, 'url', v_url) as item,
               s.voided_at as ord
          from sales s
          left join users u on u.id = s.voided_by
         where s.tenant_id = p_tenant and s.status = 'voided'
           and s.voided_at >= now() - make_interval(hours => v_hours::int)
           and (p_store is null or s.store_id = p_store)
         order by s.voided_at desc limit 200) x;
    end if;
  end if;

  return v_items;
end;
$$;
revoke all on function alert_evaluate(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function alert_evaluate(uuid, text, jsonb, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- D) Runner (pg_cron).
-- -----------------------------------------------------------------------------
create or replace function alert_run_due(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r          alert_rules%rowtype;
  v_cat      jsonb;
  v_items    jsonb;
  v_keys     text[];
  v_seen     text[];
  v_new      jsonb;
  v_notify   jsonb;
  v_stored   jsonb;
  v_event    uuid;
  v_n        int;
  v_title    text;
  v_body     text;
  v_store    text;
  v_bell     boolean;
  v_email    boolean;
  v_notified boolean;
  v_role     text;
  v_user     uuid;
  v_ran      int := 0;
  v_failed   int := 0;
  v_skipped  int := 0;
begin
  for r in
    select ar.* from alert_rules ar
     where ar.enabled and ar.deleted_at is null and ar.next_run_at is not null and ar.next_run_at <= now()
     order by ar.next_run_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update skip locked
  loop
    begin
      if not tenant_has_feature_for(r.tenant_id, 'alertas_programadas') then
        update alert_rules set next_run_at = alert_next_run(r.frequency, r.hour, r.weekdays, now())
         where id = r.id;
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_cat := alert_catalog() -> r.kind;
      v_items := alert_evaluate(r.tenant_id, r.kind, r.params, r.store_id);
      v_keys := array(select distinct e ->> 'key' from jsonb_array_elements(v_items) e);
      v_seen := array(select s.item_key from alert_seen s where s.rule_id = r.id and s.item_key = any (v_keys));
      select coalesce(jsonb_agg(e.item order by e.ord), '[]'::jsonb) into v_new
        from jsonb_array_elements(v_items) with ordinality e(item, ord)
       where not ((e.item ->> 'key') = any (v_seen));
      select coalesce(jsonb_agg(e.item || jsonb_build_object('new', not ((e.item ->> 'key') = any (v_seen)))
                                order by e.ord), '[]'::jsonb) into v_stored
        from jsonb_array_elements(v_items) with ordinality e(item, ord)
       where e.ord <= 50;

      delete from alert_seen where rule_id = r.id and not (item_key = any (v_keys));
      insert into alert_seen (tenant_id, rule_id, item_key)
      select r.tenant_id, r.id, k from unnest(v_keys) k
      on conflict (rule_id, item_key) do update set last_seen_at = now();

      v_notify := case when r.only_new then v_new else v_items end;
      v_n := jsonb_array_length(v_notify);
      v_bell := coalesce((r.channels ->> 'bell')::boolean, true);
      v_email := coalesce((r.channels ->> 'email')::boolean, false);
      v_notified := v_n > 0 and v_bell;

      insert into alert_events (tenant_id, rule_id, kind, hits, new_hits, items, notified, email_status)
      values (r.tenant_id, r.id, r.kind, jsonb_array_length(v_items), jsonb_array_length(v_new), v_stored,
              v_notified, case when v_n > 0 and v_email then 'pending' else 'none' end)
      returning id into v_event;

      if v_notified then
        select ' (' || st.name || ')' into v_store from stores st where st.id = r.store_id;
        v_title := (v_cat ->> 'label') || ': ' || v_n || ' '
                   || case when v_n = 1 then v_cat -> 'noun' ->> 0 else v_cat -> 'noun' ->> 1 end
                   || coalesce(v_store, '');
        select string_agg(t.title, ', ' order by t.ord) into v_body
          from (select e.item ->> 'title' as title, e.ord
                  from jsonb_array_elements(v_notify) with ordinality e(item, ord)
                 where e.ord <= 3) t;
        if v_n > 3 then
          v_body := v_body || ' y ' || (v_n - 3) || ' más';
        end if;
        foreach v_role in array r.audience_roles loop
          insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                                     title, body, action_label, action_url, expires_at)
          values (r.tenant_id, v_role, null, 'alertas', coalesce(v_cat ->> 'severity', 'warning'),
                  left(v_title, 200), left(v_body, 600), 'Ver alerta', '/alertas?evento=' || v_event,
                  now() + interval '14 days');
        end loop;
        foreach v_user in array r.audience_user_ids loop
          insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                                     title, body, action_label, action_url, expires_at)
          select r.tenant_id, null, v_user, 'alertas', coalesce(v_cat ->> 'severity', 'warning'),
                 left(v_title, 200), left(v_body, 600), 'Ver alerta', '/alertas?evento=' || v_event,
                 now() + interval '14 days'
           where exists (select 1 from tenant_users tu
                          where tu.tenant_id = r.tenant_id and tu.user_id = v_user and tu.status = 'active');
        end loop;
      end if;

      update alert_rules
         set last_run_at = now(), last_hits = jsonb_array_length(v_items), last_error = null,
             next_run_at = alert_next_run(r.frequency, r.hour, r.weekdays, now())
       where id = r.id;
      v_ran := v_ran + 1;
    exception when others then
      v_failed := v_failed + 1;
      begin
        insert into alert_events (tenant_id, rule_id, kind, error)
        values (r.tenant_id, r.id, r.kind, left(sqlerrm, 500));
        update alert_rules
           set last_run_at = now(), last_error = left(sqlerrm, 500),
               next_run_at = alert_next_run(r.frequency, r.hour, r.weekdays, now())
         where id = r.id;
      exception when others then
        raise warning 'alert_run_due %: %', r.id, sqlerrm;
      end;
    end;
  end loop;
  return jsonb_build_object('ran', v_ran, 'failed', v_failed, 'skipped', v_skipped);
end;
$$;
revoke all on function alert_run_due(int) from public, anon, authenticated;
grant execute on function alert_run_due(int) to service_role;

-- -----------------------------------------------------------------------------
-- E) Mail (Edge alerts_email, service_role).
-- -----------------------------------------------------------------------------
-- Eventos con el mail pendiente y sus destinatarios (emails de los miembros
-- activos de la audiencia). Lo de más de 2 días se descarta como 'skipped'.
create or replace function alert_email_pending(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  update alert_events set email_status = 'skipped', email_error = 'expired'
   where email_status = 'pending' and ran_at < now() - interval '2 days';

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.tenant_id, x.ran_at), '[]'::jsonb) into v_out from (
    select e.id as event_id, e.tenant_id, e.rule_id, e.kind, e.ran_at, e.hits, e.new_hits, e.items,
           r.only_new, alert_catalog() -> e.kind ->> 'label' as label,
           alert_catalog() -> e.kind ->> 'severity' as severity,
           (select st.name from stores st where st.id = r.store_id) as store_name,
           coalesce((select array_agg(distinct lower(u.email) order by lower(u.email))
                       from tenant_users tu join users u on u.id = tu.user_id
                      where tu.tenant_id = e.tenant_id and tu.status = 'active'
                        and (tu.role = any (r.audience_roles) or tu.user_id = any (r.audience_user_ids))
                        and u.email is not null and u.email <> ''), '{}') as recipients
      from alert_events e
      join alert_rules r on r.id = e.rule_id
     where e.email_status = 'pending'
     order by e.ran_at
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) x;
  return v_out;
end;
$$;
revoke all on function alert_email_pending(int) from public, anon, authenticated;
grant execute on function alert_email_pending(int) to service_role;

create or replace function alert_email_mark(p_ids uuid[], p_status text, p_error text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'invalid_status';
  end if;
  update alert_events set email_status = p_status, email_error = left(p_error, 500)
   where id = any (p_ids) and email_status = 'pending';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function alert_email_mark(uuid[], text, text) from public, anon, authenticated;
grant execute on function alert_email_mark(uuid[], text, text) to service_role;

-- -----------------------------------------------------------------------------
-- F) RPC de la UI.
-- -----------------------------------------------------------------------------
create or replace function _alert_can_edit(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(member_role_in(p_tenant) = 'owner', false) or coalesce(has_capability('config.edit'), false);
$$;
revoke all on function _alert_can_edit(uuid) from public, anon, authenticated;

create or replace function alert_assert(p_edit boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'alertas_programadas') then
    raise exception 'feature_not_in_plan: alertas_programadas';
  end if;
  if p_edit then
    if not _alert_can_edit(v_tenant) then raise exception 'forbidden' using errcode = '42501'; end if;
  elsif not (_alert_can_edit(v_tenant) or coalesce(has_capability('reports.view'), false)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function alert_assert(boolean) from public, anon, authenticated;

create or replace function alert_rules_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := alert_assert(false);
  v_edit   boolean := _alert_can_edit(v_tenant);
begin
  return jsonb_build_object(
    'catalog', alert_catalog(),
    'can_edit', v_edit,
    'rules', coalesce((
      select jsonb_agg((to_jsonb(r) - 'tenant_id') || jsonb_build_object('last_event', (
               select jsonb_build_object('id', e.id, 'ran_at', e.ran_at, 'hits', e.hits, 'new_hits', e.new_hits,
                                         'error', e.error, 'email_status', e.email_status)
                 from alert_events e where e.rule_id = r.id order by e.ran_at desc limit 1))
             order by r.kind, r.created_at)
        from alert_rules r
       where r.tenant_id = v_tenant and r.deleted_at is null), '[]'::jsonb),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name) order by st.is_default desc, st.name)
        from stores st where st.tenant_id = v_tenant and st.is_active), '[]'::jsonb),
    'members', case when v_edit then coalesce((
      select jsonb_agg(jsonb_build_object('user_id', tu.user_id, 'role', tu.role,
                                          'name', coalesce(nullif(u.full_name, ''), u.email))
                       order by coalesce(nullif(u.full_name, ''), u.email))
        from tenant_users tu join users u on u.id = tu.user_id
       where tu.tenant_id = v_tenant and tu.status = 'active'), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;
revoke all on function alert_rules_list() from public, anon;
grant execute on function alert_rules_list() to authenticated;

create or replace function alert_rule_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := alert_assert(true);
  v_kind    text := p ->> 'kind';
  v_cat     jsonb := alert_catalog() -> (p ->> 'kind');
  v_params  jsonb := '{}'::jsonb;
  v_key     text;
  v_val     jsonb;
  v_num     numeric;
  v_freq    text;
  v_hour    int;
  v_days    smallint[];
  v_store   uuid;
  v_bell    boolean;
  v_email   boolean;
  v_roles   text[];
  v_users   uuid[];
  v_id      uuid;
  v_old     alert_rules%rowtype;
  v_new     alert_rules%rowtype;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_rule'; end if;
  if v_kind is null or v_cat is null then raise exception 'invalid_kind'; end if;

  if p ? 'params' and jsonb_typeof(p -> 'params') <> 'object' then raise exception 'invalid_param'; end if;
  for v_key, v_val in select * from jsonb_each(coalesce(p -> 'params', '{}'::jsonb)) loop
    if v_cat -> 'params' -> v_key is null then raise exception 'invalid_param: %', v_key; end if;
    if jsonb_typeof(v_val) <> 'number' then raise exception 'invalid_param: %', v_key; end if;
    v_num := (v_val #>> '{}')::numeric;
    if v_num < (v_cat -> 'params' -> v_key ->> 'min')::numeric or v_num > (v_cat -> 'params' -> v_key ->> 'max')::numeric then
      raise exception 'param_out_of_range: %', v_key;
    end if;
    v_params := v_params || jsonb_build_object(v_key, v_num);
  end loop;
  for v_key in select jsonb_object_keys(v_cat -> 'params') loop
    if not v_params ? v_key then
      v_params := v_params || jsonb_build_object(v_key, v_cat -> 'params' -> v_key -> 'default');
    end if;
  end loop;

  v_freq := coalesce(nullif(p ->> 'frequency', ''), v_cat ->> 'frequency');
  if v_freq not in ('hourly', 'daily', 'weekly') then raise exception 'invalid_frequency'; end if;
  begin
    v_hour := coalesce((p ->> 'hour')::int, (v_cat ->> 'hour')::int);
  exception when others then raise exception 'invalid_hour';
  end;
  if v_hour is null or v_hour < 0 or v_hour > 23 then raise exception 'invalid_hour'; end if;

  if p ? 'weekdays' then
    if jsonb_typeof(p -> 'weekdays') <> 'array' then raise exception 'invalid_weekdays'; end if;
    if exists (select 1 from jsonb_array_elements(p -> 'weekdays') w
                where jsonb_typeof(w) <> 'number' or (w #>> '{}') !~ '^[0-6]$') then
      raise exception 'invalid_weekdays';
    end if;
    v_days := array(select distinct (w #>> '{}')::smallint from jsonb_array_elements(p -> 'weekdays') w order by 1);
  else
    v_days := array(select (w #>> '{}')::smallint from jsonb_array_elements(coalesce(v_cat -> 'weekdays', '[]'::jsonb)) w);
  end if;
  if v_freq = 'weekly' and cardinality(v_days) = 0 then raise exception 'weekdays_required'; end if;
  if v_freq <> 'weekly' then v_days := '{}'; end if;

  v_store := nullif(p ->> 'store_id', '')::uuid;
  if v_store is not null and not exists (select 1 from stores st where st.id = v_store and st.tenant_id = v_tenant) then
    raise exception 'invalid_store';
  end if;

  v_bell := coalesce((p -> 'channels' ->> 'bell')::boolean, true);
  v_email := coalesce((p -> 'channels' ->> 'email')::boolean, false);

  if p ? 'audience_roles' and jsonb_typeof(p -> 'audience_roles') <> 'array' then raise exception 'invalid_audience'; end if;
  v_roles := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'audience_roles', '["owner","manager"]'::jsonb)) x order by 1);
  if not (v_roles <@ array['owner', 'manager', 'cashier', 'viewer']::text[]) then raise exception 'invalid_audience'; end if;

  if p ? 'audience_user_ids' and jsonb_typeof(p -> 'audience_user_ids') <> 'array' then raise exception 'invalid_audience'; end if;
  begin
    v_users := array(select distinct x::uuid from jsonb_array_elements_text(coalesce(p -> 'audience_user_ids', '[]'::jsonb)) x);
  exception when others then raise exception 'invalid_audience';
  end;
  if cardinality(v_users) > 50 then raise exception 'invalid_audience'; end if;
  if exists (select 1 from unnest(v_users) u
              where not exists (select 1 from tenant_users tu
                                 where tu.tenant_id = v_tenant and tu.user_id = u and tu.status = 'active')) then
    raise exception 'invalid_user';
  end if;
  if (v_bell or v_email) and cardinality(v_roles) = 0 and cardinality(v_users) = 0 then
    raise exception 'audience_required';
  end if;

  v_id := nullif(p ->> 'id', '')::uuid;
  if v_id is not null then
    select * into v_old from alert_rules
     where id = v_id and tenant_id = v_tenant and deleted_at is null for update;
    if v_old.id is null then raise exception 'rule_not_found'; end if;
    if v_old.kind <> v_kind then raise exception 'kind_immutable'; end if;
  else
    select * into v_old from alert_rules
     where tenant_id = v_tenant and kind = v_kind and store_id is not distinct from v_store and deleted_at is null
     for update;
  end if;

  begin
    if v_old.id is null then
      insert into alert_rules (tenant_id, kind, enabled, params, frequency, hour, weekdays, store_id, channels,
                               audience_roles, audience_user_ids, only_new, next_run_at, created_by)
      values (v_tenant, v_kind, coalesce((p ->> 'enabled')::boolean, true), v_params, v_freq, v_hour, v_days, v_store,
              jsonb_build_object('bell', v_bell, 'email', v_email), v_roles, v_users,
              coalesce((p ->> 'only_new')::boolean, true), alert_next_run(v_freq, v_hour, v_days, now()), auth.uid())
      returning * into v_new;
    else
      update alert_rules
         set enabled = coalesce((p ->> 'enabled')::boolean, v_old.enabled),
             params = v_params, frequency = v_freq, hour = v_hour, weekdays = v_days, store_id = v_store,
             channels = jsonb_build_object('bell', v_bell, 'email', v_email),
             audience_roles = v_roles, audience_user_ids = v_users,
             only_new = coalesce((p ->> 'only_new')::boolean, v_old.only_new),
             next_run_at = alert_next_run(v_freq, v_hour, v_days, now())
       where id = v_old.id
       returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'rule_exists';
  end;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'alert_rules', v_new.id,
          case when v_old.id is null then 'alert_rule_created' else 'alert_rule_updated' end,
          case when v_old.id is null then null else to_jsonb(v_old) - 'tenant_id' end,
          to_jsonb(v_new) - 'tenant_id');
  return to_jsonb(v_new) - 'tenant_id';
end;
$$;
revoke all on function alert_rule_save(jsonb) from public, anon;
grant execute on function alert_rule_save(jsonb) to authenticated;

create or replace function alert_rule_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := alert_assert(true);
  v_old    alert_rules%rowtype;
begin
  select * into v_old from alert_rules
   where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if v_old.id is null then raise exception 'rule_not_found'; end if;
  update alert_rules set deleted_at = now(), enabled = false where id = p_id;
  delete from alert_seen where rule_id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'alert_rules', p_id, 'alert_rule_deleted', to_jsonb(v_old) - 'tenant_id');
end;
$$;
revoke all on function alert_rule_delete(uuid) from public, anon;
grant execute on function alert_rule_delete(uuid) to authenticated;

-- Probar ahora: los casos de hoy con esos umbrales, sin avisar ni guardar.
create or replace function alert_rule_test(p_kind text, p_params jsonb default '{}'::jsonb, p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := alert_assert(true);
  v_items  jsonb;
begin
  if alert_catalog() -> p_kind is null then raise exception 'invalid_kind'; end if;
  if p_store is not null and not exists (select 1 from stores st where st.id = p_store and st.tenant_id = v_tenant) then
    raise exception 'invalid_store';
  end if;
  v_items := alert_evaluate(v_tenant, p_kind, coalesce(p_params, '{}'::jsonb), p_store);
  return jsonb_build_object(
    'hits', jsonb_array_length(v_items),
    'items', coalesce((select jsonb_agg(e.item order by e.ord)
                         from jsonb_array_elements(v_items) with ordinality e(item, ord)
                        where e.ord <= 50), '[]'::jsonb));
end;
$$;
revoke all on function alert_rule_test(text, jsonb, uuid) from public, anon;
grant execute on function alert_rule_test(text, jsonb, uuid) to authenticated;

create or replace function alert_events_list(
  p_rule uuid default null, p_limit int default 30, p_before timestamptz default null, p_event uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := alert_assert(false);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'rule_id', e.rule_id, 'kind', e.kind, 'ran_at', e.ran_at, 'hits', e.hits,
             'new_hits', e.new_hits, 'items', e.items, 'notified', e.notified,
             'email_status', e.email_status, 'email_error', e.email_error, 'error', e.error,
             'store_name', (select st.name from stores st where st.id = r.store_id),
             'only_new', r.only_new) order by e.ran_at desc)
      from (select * from alert_events e0
             where e0.tenant_id = v_tenant
               and (p_event is null or e0.id = p_event)
               and (p_rule is null or e0.rule_id = p_rule)
               and (p_before is null or e0.created_at < p_before)
             order by e0.created_at desc
             limit greatest(1, least(coalesce(p_limit, 30), 100))) e
      join alert_rules r on r.id = e.rule_id), '[]'::jsonb);
end;
$$;
revoke all on function alert_events_list(uuid, int, timestamptz, uuid) from public, anon;
grant execute on function alert_events_list(uuid, int, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) pg_cron. Sin pg_cron o pg_net (stack local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten los jobs de alertas programadas.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j where j.jobname in ('alerts-run', 'alerts-email');

  perform cron.schedule('alerts-run', '*/15 * * * *', 'select public.alert_run_due(200)');

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de mails de alertas.';
    return;
  end if;

  perform cron.schedule('alerts-email', '7-59/15 * * * *', $job$
    select net.http_post(
      url := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/alerts_email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    where exists (select 1 from public.alert_events where email_status = 'pending');
  $job$);
end;
$cron$;
