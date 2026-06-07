-- =============================================================================
-- SaaS Wave 2-A — Editor de planes ampliado.
-- Reescribe internal_save_plan agregando los campos comerciales nuevos:
--   p_secondary_name (nombre comercial secundario, p.ej. Aprendiz/Sensei),
--   p_image_url      (logo/imagen rectangular del plan, bucket plan-assets),
--   p_is_recommended (marca de plan destacado; uno solo entre los globales).
-- Mantiene idénticos los guards, la auditoría y el aviso de aumento de tarifa.
-- También crea el bucket público `plan-assets` para las imágenes de planes
-- (son globales, NO scoped por tenant) con escritura sólo para staff interno.
-- =============================================================================

create or replace function public.internal_save_plan(
  p_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_icon text,
  p_monthly_price numeric,
  p_trial_days integer,
  p_limits jsonb,
  p_is_active boolean,
  p_secondary_name text default null,
  p_image_url text default null,
  p_is_recommended boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old plans%rowtype;
  v_id  uuid;
  v_key text;
  r     record;
  v_email text;
  v_period text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  if p_id is null then
    v_key := coalesce(
      nullif(btrim(p_key), ''),
      regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g') || '_'
        || substr(md5(random()::text), 1, 4)
    );

    insert into plans (key, name, secondary_name, description, icon, image_url,
                       is_recommended, monthly_price_ars,
                       trial_days, limits, is_active, sort, tenant_id)
    values (v_key, btrim(p_name), nullif(btrim(p_secondary_name), ''), p_description,
            p_icon, nullif(btrim(p_image_url), ''),
            coalesce(p_is_recommended, false), p_monthly_price,
            coalesce(p_trial_days, 14), coalesce(p_limits, '{}'::jsonb),
            coalesce(p_is_active, true), 0, null)
    returning id into v_id;

    -- Sólo un plan global puede estar recomendado a la vez.
    if coalesce(p_is_recommended, false) then
      update plans set is_recommended = false
       where tenant_id is null and id <> v_id and is_recommended;
    end if;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'plans', v_id, 'plan_saved',
            jsonb_build_object('key', v_key, 'name', btrim(p_name),
                               'secondary_name', nullif(btrim(p_secondary_name), ''),
                               'image_url', nullif(btrim(p_image_url), ''),
                               'is_recommended', coalesce(p_is_recommended, false),
                               'monthly_price_ars', p_monthly_price,
                               'trial_days', coalesce(p_trial_days, 14),
                               'is_active', coalesce(p_is_active, true),
                               'limits', coalesce(p_limits, '{}'::jsonb)));
    return v_id;
  end if;

  select * into v_old from plans where id = p_id;
  if not found then
    raise exception 'plan_not_found';
  end if;
  if v_old.tenant_id is not null then
    raise exception 'not_global_plan';
  end if;

  update plans
     set name              = btrim(p_name),
         secondary_name    = nullif(btrim(p_secondary_name), ''),
         description        = p_description,
         icon              = p_icon,
         image_url         = nullif(btrim(p_image_url), ''),
         is_recommended    = coalesce(p_is_recommended, false),
         monthly_price_ars = p_monthly_price,
         trial_days        = coalesce(p_trial_days, v_old.trial_days),
         limits            = coalesce(p_limits, v_old.limits),
         is_active         = coalesce(p_is_active, v_old.is_active)
   where id = p_id;

  -- Sólo un plan global puede estar recomendado a la vez.
  if coalesce(p_is_recommended, false) then
    update plans set is_recommended = false
     where tenant_id is null and id <> p_id and is_recommended;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (null, auth.uid(), 'plans', p_id, 'plan_saved',
          jsonb_build_object('name', v_old.name, 'secondary_name', v_old.secondary_name,
                             'description', v_old.description,
                             'icon', v_old.icon, 'image_url', v_old.image_url,
                             'is_recommended', v_old.is_recommended,
                             'monthly_price_ars', v_old.monthly_price_ars,
                             'trial_days', v_old.trial_days, 'is_active', v_old.is_active,
                             'limits', v_old.limits),
          jsonb_build_object('name', btrim(p_name),
                             'secondary_name', nullif(btrim(p_secondary_name), ''),
                             'description', p_description,
                             'icon', p_icon, 'image_url', nullif(btrim(p_image_url), ''),
                             'is_recommended', coalesce(p_is_recommended, false),
                             'monthly_price_ars', p_monthly_price,
                             'trial_days', coalesce(p_trial_days, v_old.trial_days),
                             'is_active', coalesce(p_is_active, v_old.is_active),
                             'limits', coalesce(p_limits, v_old.limits)));

  if p_monthly_price > v_old.monthly_price_ars then
    v_period := to_char(now(), 'YYYY-MM');
    for r in
      select distinct s.tenant_id, t.name as tenant_name
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.plan_id = p_id
         and s.status in ('trial','active','past_due')
         and coalesce(s.is_lifetime, false) = false
         and t.deleted_at is null
    loop
      if exists (select 1 from dunning_events
                  where tenant_id = r.tenant_id and kind = 'price_increase'
                    and period_key = v_period) then
        continue;
      end if;

      insert into notifications (target_tenant_id, target_role, type, severity, title, body,
                                 requires_ack, created_by)
      values (r.tenant_id, 'owner', 'plan', 'warning',
              'Actualización de tarifa',
              'Tu plan "' || btrim(p_name) || '" pasa de $' || v_old.monthly_price_ars::text
                || ' a $' || p_monthly_price::text || ' por mes desde tu próximo ciclo.',
              true, auth.uid());

      select u.email into v_email
        from tenant_users tu join users u on u.id = tu.user_id
       where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
       order by tu.created_at limit 1;

      if v_email is not null then
        insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
        values (r.tenant_id, v_email, 'Actualización de tarifa de tu plan', 'system', 'pending',
                _dunning_email_html(r.tenant_name, 'Actualización de tarifa',
                  'Te avisamos que tu plan "' || btrim(p_name) || '" pasa de $'
                    || v_old.monthly_price_ars::text || ' a $' || p_monthly_price::text
                    || ' por mes a partir de tu próximo ciclo de facturación.'));
      end if;

      insert into dunning_events (tenant_id, kind, period_key)
      values (r.tenant_id, 'price_increase', v_period);
    end loop;
  end if;

  return p_id;
end;
$function$;

-- La nueva firma (12 args) coexiste con la vieja (9 args) por sobrecarga.
-- Bloqueamos su ejecución directa a anon/public; sólo authenticated (los guards
-- internos is_internal()/internal_level() hacen el resto).
revoke all on function public.internal_save_plan(
  uuid, text, text, text, text, numeric, integer, jsonb, boolean,
  text, text, boolean
) from public, anon;
grant execute on function public.internal_save_plan(
  uuid, text, text, text, text, numeric, integer, jsonb, boolean,
  text, text, boolean
) to authenticated;

-- =============================================================================
-- Bucket público para imágenes de planes (logos rectangulares). Las imágenes
-- de planes son GLOBALES (no scoped por tenant): cualquiera puede verlas (select
-- público) pero sólo el staff interno autenticado puede subir/editar/borrar.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('plan-assets', 'plan-assets', true)
on conflict (id) do nothing;

drop policy if exists "plan_assets_write" on storage.objects;
drop policy if exists "plan_assets_modify" on storage.objects;
drop policy if exists "plan_assets_remove" on storage.objects;

-- Subida/edición/borrado: sólo staff interno (is_internal()).
create policy "plan_assets_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'plan-assets' and is_internal());
create policy "plan_assets_modify" on storage.objects for update to authenticated
  using (bucket_id = 'plan-assets' and is_internal())
  with check (bucket_id = 'plan-assets' and is_internal());
create policy "plan_assets_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'plan-assets' and is_internal());
