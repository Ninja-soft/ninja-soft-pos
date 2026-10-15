-- =============================================================================
-- 20261220100000_aislamiento_cuentas.sql  (ADR-152)
-- Aislamiento entre cuentas: un usuario con varios negocios, o staff interno
-- con negocio propio, nunca ve datos de otro negocio desde el panel.
--
-- Auditoría en producción (2026-10-15, sólo lectura):
--   rls_internal_scope_leaks() = 0, rls_bare_current_tenant_policies() = 0,
--   rls_policies_without_initplan() = 0, vistas todas con security_invoker y
--   ninguna tabla de public sin RLS. Quedaban policies con is_internal()
--   SUELTO (sin internal_scope() de ADR-052): el guard sólo marca las que
--   además mencionan tenant_id, así que estas pasaban. Con ellas el staff,
--   desde el panel de SU negocio (sin el header x-ninja-scope), leía datos de
--   todos los clientes: perfiles de usuarios, estado de lectura de
--   notificaciones de cualquiera, emails del sistema, facturación, notas
--   internas, descuentos y eventos de cobranza.
--
--   1. Esas policies pasan a internal_scope(): el staff ve lo de plataforma
--      sólo desde /internal (que manda el header). Nunca `OR is_internal()`.
--   2. internal_notify / internal_delete_notification exigen internal_scope().
--   3. Notificaciones: una notificación dirigida a una persona (target_user_id)
--      lleva siempre su negocio (target_tenant_id). Sin negocio sólo quedan
--      las de plataforma (broadcast de NinjaSoft, marcadas en la UI). Así una
--      notificación personal nunca aparece en otro negocio del mismo usuario.
--      Producción: 0 filas violan la regla (se valida al aplicar).
--   4. rls_internal_scope_leaks() también lista las policies con is_internal()
--      suelto (con o sin tenant_id), para que no vuelva.
--
-- Sin features nuevas (aislamiento es BASE, principio 1). Sin cambio de datos.
-- =============================================================================

-- ── 1. is_internal() suelto → internal_scope() ───────────────────────────────

-- users: perfil propio; el staff ve otros perfiles sólo en /internal.
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select using (id = (select auth.uid()) or (select public.internal_scope()));

-- notification_reads: el estado de lectura es de cada usuario.
drop policy if exists notification_reads_select on public.notification_reads;
create policy notification_reads_select on public.notification_reads
  for select using (user_id = (select auth.uid()) or (select public.internal_scope()));

-- notifications: escribir es del panel interno (las RPC del sistema son
-- SECURITY DEFINER y no pasan por acá).
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert with check ((select public.internal_scope()));
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update using ((select public.internal_scope())) with check ((select public.internal_scope()));

-- billing_records
drop policy if exists br_select on public.billing_records;
create policy br_select on public.billing_records
  for select using ((select public.internal_scope()));
drop policy if exists br_insert on public.billing_records;
create policy br_insert on public.billing_records
  for insert with check ((select public.internal_scope()));

-- dunning_events
drop policy if exists dunning_events_select on public.dunning_events;
create policy dunning_events_select on public.dunning_events
  for select using ((select public.internal_scope()));

-- system_emails (destinatarios y contenido de los emails de todos los negocios)
drop policy if exists system_emails_select on public.system_emails;
create policy system_emails_select on public.system_emails
  for select using ((select public.internal_scope()));

-- tenant_discounts
drop policy if exists tenant_discounts_select on public.tenant_discounts;
create policy tenant_discounts_select on public.tenant_discounts
  for select using ((select public.internal_scope()));
drop policy if exists tenant_discounts_insert on public.tenant_discounts;
create policy tenant_discounts_insert on public.tenant_discounts
  for insert with check ((select public.internal_scope()));
drop policy if exists tenant_discounts_update on public.tenant_discounts;
create policy tenant_discounts_update on public.tenant_discounts
  for update using ((select public.internal_scope())) with check ((select public.internal_scope()));

-- tenant_notes (notas internas del staff sobre cada cliente)
drop policy if exists tenant_notes_select on public.tenant_notes;
create policy tenant_notes_select on public.tenant_notes
  for select using ((select public.internal_scope()));
drop policy if exists tenant_notes_insert on public.tenant_notes;
create policy tenant_notes_insert on public.tenant_notes
  for insert with check ((select public.internal_scope()) and author_user_id = (select auth.uid()));
drop policy if exists tenant_notes_update on public.tenant_notes;
create policy tenant_notes_update on public.tenant_notes
  for update using ((select public.internal_scope())) with check ((select public.internal_scope()));

-- subscription_addons (la lectura del negocio propio no cambia)
drop policy if exists subscription_addons_insert on public.subscription_addons;
create policy subscription_addons_insert on public.subscription_addons
  for insert with check ((select public.internal_scope()));
drop policy if exists subscription_addons_update on public.subscription_addons;
create policy subscription_addons_update on public.subscription_addons
  for update using ((select public.internal_scope())) with check ((select public.internal_scope()));

-- tenant_catalog_purchases (la lectura del negocio propio no cambia)
drop policy if exists tcp_insert on public.tenant_catalog_purchases;
create policy tcp_insert on public.tenant_catalog_purchases
  for insert with check ((select public.internal_scope()));
drop policy if exists tcp_update on public.tenant_catalog_purchases;
create policy tcp_update on public.tenant_catalog_purchases
  for update using ((select public.internal_scope())) with check ((select public.internal_scope()));
drop policy if exists tcp_delete on public.tenant_catalog_purchases;
create policy tcp_delete on public.tenant_catalog_purchases
  for delete using ((select public.internal_scope()));

-- ── 2. RPC del composer de notificaciones ────────────────────────────────────

create or replace function public.internal_notify(
  p_tenant_id uuid, p_role text, p_user_id uuid, p_type text, p_severity text, p_title text,
  p_body text default null, p_action_label text default null, p_action_url text default null,
  p_requires_ack boolean default false, p_expires_at timestamptz default null,
  p_display_until timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not internal_scope() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(internal_level(), 'admin') = 'support' then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'invalid_title'; end if;
  -- Una notificación personal siempre es de un negocio (ver constraint abajo).
  if p_user_id is not null and p_tenant_id is null then raise exception 'user_target_needs_tenant'; end if;
  insert into notifications (target_tenant_id, target_role, target_user_id, type, severity, title, body,
    action_label, action_url, requires_ack, expires_at, display_until, created_by)
  values (p_tenant_id, p_role, p_user_id, coalesce(p_type,'news'), coalesce(p_severity,'info'),
    btrim(p_title), p_body, p_action_label, p_action_url, coalesce(p_requires_ack,false),
    p_expires_at, p_display_until, auth.uid())
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'notifications', v_id, 'notification_sent',
    jsonb_build_object('title', btrim(p_title), 'severity', coalesce(p_severity,'info'),
      'role', p_role, 'user', p_user_id, 'display_until', p_display_until));
  return v_id;
end; $$;

create or replace function public.internal_delete_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_notif notifications%rowtype;
begin
  if not internal_scope() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(internal_level(), 'admin') = 'support' then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_notif from notifications where id = p_id and deleted_at is null;
  if not found then raise exception 'notification_not_found'; end if;
  update notifications set deleted_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_notif.target_tenant_id, auth.uid(), 'notifications', p_id, 'notification_deleted',
    jsonb_build_object('title', v_notif.title, 'severity', v_notif.severity));
end; $$;

revoke all on function public.internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon;
grant execute on function public.internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.internal_delete_notification(uuid) from public, anon;
grant execute on function public.internal_delete_notification(uuid) to authenticated, service_role;

-- ── 3. Notificación personal = de un negocio ─────────────────────────────────

alter table public.notifications drop constraint if exists notifications_user_target_needs_tenant;
alter table public.notifications
  add constraint notifications_user_target_needs_tenant
  check (target_user_id is null or target_tenant_id is not null) not valid;
alter table public.notifications validate constraint notifications_user_target_needs_tenant;

comment on constraint notifications_user_target_needs_tenant on public.notifications is
  'ADR-152: una notificación personal lleva su negocio; sin negocio sólo las de plataforma.';

-- ── 4. Guard: is_internal() suelto en cualquier policy permisiva ─────────────

create or replace function public.rls_internal_scope_leaks()
returns table (tablename name, policyname name)
language sql
stable
security definer
set search_path = ''
as $$
  select p.tablename, p.policyname
    from pg_catalog.pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and (coalesce(p.qual, '') like '%is_internal()%' or coalesce(p.with_check, '') like '%is_internal()%')
     and (
       -- ADR-052: `tenant_id = ... OR is_internal()` abre todos los negocios.
       (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%tenant_id%'
       -- ADR-152: tablas con datos de clientes o de usuarios con is_internal()
       -- suelto (el staff los leía desde el panel de su propio negocio).
       or exists (
         select 1 from pg_catalog.pg_attribute a
          where a.attrelid = (quote_ident(p.schemaname) || '.' || quote_ident(p.tablename))::regclass
            and a.attname in ('tenant_id', 'user_id')
            and not a.attisdropped
       )
       or p.tablename = 'users'
     );
$$;

revoke all on function public.rls_internal_scope_leaks() from public, anon, authenticated;
grant execute on function public.rls_internal_scope_leaks() to service_role;
