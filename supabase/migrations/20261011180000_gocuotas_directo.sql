-- =============================================================================
-- 20261011180000_gocuotas_directo  (F8 · ADR-033 GO Cuotas · ADR-034 Directo)
--
-- GO Cuotas (provider/feature `gocuotas`, marca gocuotas, canal qr_link):
--   cuotas sin interés con tarjeta de débito. Integración por API Redirect V1
--   (Edge `gocuotas` + `gocuotas_webhook`). El cobro entra como method='qr'
--   con reference = intent (mp_payment_intents.provider_key='gocuotas'), así
--   que el gating fino del trigger de payments ya lo cubre vía
--   payment_method_plan_key('gocuotas').
--
-- Directo (provider/feature `directo`, marca directo, canal manual):
--   crédito directo de Crédito Directo S.A. Sin API pública: el cajero cobra
--   en el portal de comercios de Directo (QR o link) y en el POS registra el
--   número de operación. Se agrega `directo` como valor de payments.method
--   (más limpio que 'other': se ve en caja, reportes y cierres) y el gating
--   coarse del trigger lo corta por plan. El número de operación es
--   obligatorio (payments.reference) por constraint.
--
-- Plan: ambos OPTIONAL desde Pro (pro, business, enterprise), como el resto
-- de los medios de uso masivo (getnet, nave, payway).
-- =============================================================================

-- A) Catálogo de proveedores ---------------------------------------------------
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('gocuotas', 'GO Cuotas', 'gateway', 11, true, 'gocuotas', 'qr_link'),
  ('directo',  'Directo',   'manual',  12, true, 'directo',  'manual')
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      brand = excluded.brand,
      channel = excluded.channel;

-- B) Features de plan ----------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('gocuotas', 'GO Cuotas', 'Cobros en cuotas sin interés con débito vía GO Cuotas (QR + link)', 'pagos', false, 110),
  ('directo',  'Directo',   'Cobros con crédito Directo (se registra el número de operación)',  'pagos', false, 120)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'gocuotas', (p.key in ('pro', 'business', 'enterprise')),
         'directo',  (p.key in ('pro', 'business', 'enterprise'))
       ),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise');

-- C) payments.method: 'directo' + número de operación obligatorio --------------
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','debit','credit','transfer','qr','other','store_credit','account','directo'));

alter table payments drop constraint if exists payments_directo_reference_check;
alter table payments add constraint payments_directo_reference_check
  check (method <> 'directo' or length(btrim(coalesce(reference, ''))) between 1 and 64);

-- D) Gating: medio → feature de plan (redefinida desde 20261011150000) ----------
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    when 'mercadopago'       then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    when 'mercadopago_point' then 'mercadopago_point'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    when 'payway'            then 'payway'
    when 'payway_point'      then 'payway_point'
    when 'getnet'            then 'getnet'
    when 'getnet_point'      then 'getnet_point'
    when 'fiserv'            then 'fiserv'
    when 'pagos360'          then 'pagos360'
    when 'nave'              then 'nave'
    when 'nave_point'        then 'nave_point'
    when 'gocuotas'          then 'gocuotas'
    when 'directo'           then 'directo'
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;
