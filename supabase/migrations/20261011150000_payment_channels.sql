-- =============================================================================
-- 20261011150000_payment_channels
-- Medios de pago ordenados por MARCA y CANAL (pedido del dueño):
--   Mercado Pago: QR + link | Point aparte
--   Payway:       QR + link | Point aparte
--   Getnet:       QR + link | Point aparte
--   Nave:         QR + link | Point aparte
--
-- • payment_providers gana `brand` y `channel` ('manual' | 'qr_link' | 'point')
--   para que la UI agrupe por marca → canal sin listas hardcodeadas.
-- • Canales Point nuevos: payway_point, getnet_point, nave_point (filas en
--   payment_providers + features de plan, misma key 1:1).
-- • Plan: Point desde Pro (alineado con mercadopago_point). Las features QR+link
--   de cada marca (mercado_pago, payway, getnet, nave) no cambian.
-- • Gating real: payment_method_plan_key resuelve las keys nuevas, así el
--   trigger de `payments` las corta igual que al resto.
-- • Dependencia (operativa, no de plan): un Point usa la MISMA conexión
--   (credenciales) de su marca. Se documenta en lib/saas/featureInfo.ts (needs).
-- =============================================================================

-- A) Marca y canal en el catálogo -------------------------------------------
alter table payment_providers add column if not exists brand text;
alter table payment_providers add column if not exists channel text;

update payment_providers set brand = key, channel = 'manual'  where key in ('cash', 'transfer');
update payment_providers set brand = 'mercadopago', channel = 'qr_link' where key = 'mercadopago';
update payment_providers set brand = 'mercadopago', channel = 'point'   where key = 'mercadopago_point';
update payment_providers set brand = key, channel = 'qr_link'
  where key in ('modo', 'payway', 'getnet', 'mobbex', 'pagos360', 'nave');
update payment_providers set brand = 'fiserv', channel = 'point' where key = 'fiserv';

-- Canales Point nuevos (sort: justo después de su marca).
insert into payment_providers (key, name, kind, sort, is_active, brand, channel) values
  ('payway_point', 'Payway Point', 'gateway', 5, true, 'payway', 'point'),
  ('getnet_point', 'Getnet Point', 'gateway', 6, true, 'getnet', 'point'),
  ('nave_point',   'Nave Point',   'gateway', 10, true, 'nave', 'point')
on conflict (key) do update
  set brand = excluded.brand, channel = excluded.channel;

update payment_providers set brand = coalesce(brand, key), channel = coalesce(channel, 'qr_link')
where brand is null or channel is null;

alter table payment_providers alter column brand set not null;
alter table payment_providers alter column channel set not null;
alter table payment_providers drop constraint if exists payment_providers_channel_check;
alter table payment_providers
  add constraint payment_providers_channel_check check (channel in ('manual', 'qr_link', 'point'));

-- B) Features de plan de los canales Point ------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('payway_point', 'Payway Point', 'Cobros con la terminal Point de Payway', 'pagos', false, 65),
  ('getnet_point', 'Getnet Point', 'Cobros con la terminal Point de Getnet', 'pagos', false, 75),
  ('nave_point',   'Nave Point',   'Cobros con la terminal Point de Nave',   'pagos', false, 105)
on conflict (key) do nothing;

-- Point desde Pro en los planes globales (explícito por plan).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'payway_point', (p.key in ('pro', 'business', 'enterprise')),
         'getnet_point', (p.key in ('pro', 'business', 'enterprise')),
         'nave_point',   (p.key in ('pro', 'business', 'enterprise'))
       ),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise');

-- C) Gating: medio → feature de plan -------------------------------------------
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
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;
