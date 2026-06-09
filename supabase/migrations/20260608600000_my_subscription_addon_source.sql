-- =============================================================================
-- 20260608600000_my_subscription_addon_source  (SAAS — exponer source del addon)
--
-- El panel del dueño debe distinguir un addon BONIFICADO por NinjaSoft
-- (subscription_addons.source = 'granted', sin cobro) de uno CONTRATADO/pago
-- (source = 'purchased', con monthly_price_ars). my_subscription() ya devolvía el
-- addon pero NO exponía `source`, así que la UI no podía mostrar "Bonificado por
-- NinjaSoft" en lugar del precio.
--
-- Esta migración reproduce my_subscription() AGREGANDO únicamente `source` al
-- objeto de cada addon. Sin otros cambios de comportamiento. Espeja
-- 20260608270000_owner_subscription_panel (G).
-- =============================================================================

create or replace function my_subscription()
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_result jsonb;
begin
  if v_tid is null or not is_tenant_manager() then
    return null;
  end if;

  select jsonb_build_object(
    'plan', jsonb_build_object(
      'key', p.key,
      'name', p.name,
      'secondary_name', p.secondary_name,
      'image_url', p.image_url,
      'icon', p.icon,
      'monthly_price_ars', p.monthly_price_ars,
      'is_custom', (p.tenant_id is not null)
    ),
    'status', s.status,
    'billing_cycle', s.billing_cycle,
    'current_period_start', s.current_period_start,
    'current_period_end', s.current_period_end,
    'cancel_at_period_end', coalesce(s.cancel_at_period_end, false),
    'is_lifetime', coalesce(s.is_lifetime, false),
    'closure_requested_at', t.closure_requested_at,
    'next_charge', case
      when coalesce(s.is_lifetime, false) then null
      else s.current_period_end
    end,
    'addons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'addon_key', sa.addon_key,
        'label', pa.label,
        'status', sa.status,
        -- 'granted' = bonificado por NinjaSoft (sin cobro); 'purchased' = pago.
        'source', sa.source,
        'cancel_at_period_end', coalesce(sa.cancel_at_period_end, false),
        'current_period_end', sa.current_period_end,
        'monthly_price_ars', coalesce(sa.monthly_price_ars, pa.monthly_price_ars)
      ) order by sa.addon_key)
      from subscription_addons sa
      left join plan_addons pa on pa.key = sa.addon_key
      where sa.tenant_id = v_tid
    ), '[]'::jsonb),
    'last_payment', (
      select jsonb_build_object(
        'amount', br.amount,
        'medium', br.medium,
        'period_end', br.period_end,
        'created_at', br.created_at
      )
      from billing_records br
      where br.tenant_id = v_tid
      order by br.created_at desc
      limit 1
    )
  )
  into v_result
  from subscriptions s
  join plans p on p.id = s.plan_id
  join tenants t on t.id = s.tenant_id
  where s.tenant_id = v_tid;

  return v_result;
end;
$fn$;
