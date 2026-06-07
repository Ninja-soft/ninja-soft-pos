-- =============================================================================
-- 20260607170000_notifications  (H13b — F7)
-- Centro de notificaciones por cuenta.
--
-- notifications: mensajes dirigidos por audiencia (todos los tenants /
--   un tenant / un rol dentro del tenant / un usuario puntual), con severidad
--   (info/success/warning/critical/blocking), acción embebida opcional
--   (action_label + action_url), requires_ack y vencimiento.
-- notification_reads: estado por usuario (leída / archivada / ack).
-- internal_notify(): RPC para que staff (o RPCs del sistema) emitan
--   notificaciones. Composer en /internal/notificaciones.
-- Automático: internal_update_custom_plan notifica el cambio de precio al
--   tenant (criterio del roadmap: aviso in-app ante aumento de cuota/precio).
-- =============================================================================

create table if not exists notifications (
  id               uuid primary key default gen_random_uuid(),
  -- Audiencia: target_tenant_id null = todos los tenants (broadcast).
  target_tenant_id uuid references tenants(id) on delete cascade,
  target_role      text check (target_role in ('owner','manager','cashier','viewer')),
  target_user_id   uuid references users(id) on delete cascade,
  type             text not null default 'news'
                     check (type in ('news','plan','billing','usage','security','afip','maintenance','support')),
  severity         text not null default 'info'
                     check (severity in ('info','success','warning','critical','blocking')),
  title            text not null,
  body             text,
  action_label     text,
  action_url       text,
  requires_ack     boolean not null default false,
  expires_at       timestamptz,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create index if not exists idx_notifications_tenant on notifications(target_tenant_id);
create index if not exists idx_notifications_created on notifications(created_at desc);

create table if not exists notification_reads (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  read_at         timestamptz,
  archived_at     timestamptz,
  acked_at        timestamptz,
  unique (notification_id, user_id)
);

create index if not exists idx_notification_reads_user on notification_reads(user_id);

alter table notifications enable row level security;
alter table notification_reads enable row level security;

-- Lectura: el destinatario (membresía activa del tenant + rol/usuario si aplica)
-- o staff interno. Vencidas/borradas no se listan.
create policy notifications_select on notifications
  for select using (
    (select is_internal())
    or (
      deleted_at is null
      and (expires_at is null or expires_at > now())
      and (target_tenant_id is null or target_tenant_id = (select current_tenant_id()))
      and (target_user_id is null or target_user_id = (select auth.uid()))
      and (
        target_role is null
        or exists (
          select 1 from tenant_users me
          where me.tenant_id = (select current_tenant_id())
            and me.user_id = (select auth.uid())
            and me.status = 'active'
            and me.role = notifications.target_role
        )
      )
      and exists (
        select 1 from tenant_users me
        where me.tenant_id = (select current_tenant_id())
          and me.user_id = (select auth.uid())
          and me.status = 'active'
      )
    )
  );

-- Escritura de notifications: solo staff interno (composer / sistema vía RPC).
create policy notifications_insert on notifications
  for insert with check ((select is_internal()));
create policy notifications_update on notifications
  for update using ((select is_internal())) with check ((select is_internal()));

-- Estado de lectura: cada usuario maneja SOLO sus filas.
create policy notification_reads_select on notification_reads
  for select using (user_id = (select auth.uid()) or (select is_internal()));
create policy notification_reads_insert on notification_reads
  for insert with check (user_id = (select auth.uid()));
create policy notification_reads_update on notification_reads
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- RPC de emisión (staff o sistema). Devuelve el id creado. Auditado.
create or replace function internal_notify(
  p_tenant_id uuid,
  p_role text,
  p_user_id uuid,
  p_type text,
  p_severity text,
  p_title text,
  p_body text default null,
  p_action_label text default null,
  p_action_url text default null,
  p_requires_ack boolean default false,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'invalid_title';
  end if;

  insert into notifications (target_tenant_id, target_role, target_user_id, type,
                             severity, title, body, action_label, action_url,
                             requires_ack, expires_at, created_by)
  values (p_tenant_id, p_role, p_user_id, coalesce(p_type, 'news'),
          coalesce(p_severity, 'info'), btrim(p_title), p_body, p_action_label,
          p_action_url, coalesce(p_requires_ack, false), p_expires_at, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'notifications', v_id, 'notification_sent',
          jsonb_build_object('title', btrim(p_title), 'severity', coalesce(p_severity, 'info'),
                             'role', p_role, 'user', p_user_id));
  return v_id;
end;
$$;
revoke all on function internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz) from public, anon;
grant execute on function internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz) to authenticated;

-- Automático: el cambio de precio/límites de un plan custom notifica al owner
-- del tenant (criterio del roadmap H13b: aviso in-app ante aumento de precio).
create or replace function internal_update_custom_plan(
  p_plan_id uuid,
  p_name text,
  p_monthly_price numeric,
  p_limits jsonb,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old plans%rowtype;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  select * into v_old from plans where id = p_plan_id;
  if not found then
    raise exception 'plan_not_found';
  end if;
  if v_old.tenant_id is null then
    raise exception 'not_custom_plan';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  update plans
     set name = btrim(p_name),
         monthly_price_ars = p_monthly_price,
         limits = coalesce(p_limits, limits)
   where id = p_plan_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_old.tenant_id, auth.uid(), 'plans', p_plan_id, 'custom_plan_updated',
          jsonb_build_object('name', v_old.name, 'monthly_price_ars', v_old.monthly_price_ars,
                             'limits', v_old.limits),
          jsonb_build_object('name', btrim(p_name), 'monthly_price_ars', p_monthly_price,
                             'limits', coalesce(p_limits, v_old.limits),
                             'reason', p_reason));

  -- Notificación in-app al owner si cambió el precio.
  if p_monthly_price is distinct from v_old.monthly_price_ars then
    insert into notifications (target_tenant_id, target_role, type, severity, title, body,
                               requires_ack, created_by)
    values (v_old.tenant_id, 'owner', 'plan',
            case when p_monthly_price > v_old.monthly_price_ars then 'warning' else 'info' end,
            'Cambio de precio de tu plan',
            'Tu plan "' || btrim(p_name) || '" pasa de $' || v_old.monthly_price_ars::text
              || ' a $' || p_monthly_price::text || ' por mes.'
              || case when p_reason is not null then ' Motivo: ' || p_reason else '' end,
            true, auth.uid());
  end if;
end;
$$;
