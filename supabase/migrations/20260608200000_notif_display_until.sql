-- 20260608200000_notif_display_until (Wave 2 — paquete J)
-- 1) display_until: ventana de captación para usuarios que se registren DESPUÉS del envío.
--    Un miembro la ve si: display_until is null OR display_until > now() OR membership.created_at <= notification.created_at.
-- 2) internal_delete_notification(): baja lógica auditada.
-- 3) internal_notify() recibe p_display_until (12º arg).

alter table notifications add column if not exists display_until timestamptz;

drop policy if exists notifications_select on notifications;
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
      and (
        display_until is null
        or display_until > now()
        or exists (
          select 1 from tenant_users me2
          where me2.tenant_id = (select current_tenant_id())
            and me2.user_id = (select auth.uid())
            and me2.created_at <= notifications.created_at
        )
      )
    )
  );

drop function if exists internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz);

create or replace function internal_notify(
  p_tenant_id uuid, p_role text, p_user_id uuid, p_type text, p_severity text,
  p_title text, p_body text default null, p_action_label text default null,
  p_action_url text default null, p_requires_ack boolean default false,
  p_expires_at timestamptz default null, p_display_until timestamptz default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  if coalesce(internal_level(), 'admin') = 'support' then raise exception 'forbidden'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'invalid_title'; end if;
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
revoke all on function internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon;
grant execute on function internal_notify(uuid, text, uuid, text, text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated;

create or replace function internal_delete_notification(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_notif notifications%rowtype;
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  if coalesce(internal_level(), 'admin') = 'support' then raise exception 'forbidden'; end if;
  select * into v_notif from notifications where id = p_id and deleted_at is null;
  if not found then raise exception 'notification_not_found'; end if;
  update notifications set deleted_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_notif.target_tenant_id, auth.uid(), 'notifications', p_id, 'notification_deleted',
    jsonb_build_object('title', v_notif.title, 'severity', v_notif.severity));
end; $$;
revoke all on function internal_delete_notification(uuid) from public, anon;
grant execute on function internal_delete_notification(uuid) to authenticated;
