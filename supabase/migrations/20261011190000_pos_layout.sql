-- =============================================================================
-- 20261011190000_pos_layout
-- Diseño del POS elegible y personalizable (rediseño del punto de venta).
--
-- • pos_settings.pos_layout jsonb: diseño del NEGOCIO (preset Mostrador /
--   Boutique / Salón / Caja rápida, densidad, grilla, carrito, acento, orden y
--   fijados de medios de cobro, montos rápidos, teclado, propinas, teclas
--   rápidas). FLAG-OPERATIVO (CLAUDE.md §6): gratis, sin gating de plan. El
--   cliente lo valida con Zod (lib/pos/layout.ts) campo por campo.
-- • El override por usuario vive en users.settings.pos_layout (sin columna
--   nueva); NO puede traer teclas rápidas (el cliente las ignora).
-- • Feature OPTIONAL `pos_quick_keys_pro` (desde Pro): más de 12 teclas
--   rápidas (hasta 48) o color por tecla. Gating REAL con trigger en
--   pos_settings: la UI nunca es la única barrera.
-- • Pedidos de los medios de cobro (pos_layout.payments) sólo ordenan, ocultan
--   o fijan: nunca habilitan un medio (eso sigue en payment_method_plan_key,
--   create_sale y las Edge de cada proveedor).
-- =============================================================================

-- A) Columna --------------------------------------------------------------------
alter table pos_settings
  add column if not exists pos_layout jsonb not null default '{}'::jsonb;

alter table pos_settings drop constraint if exists pos_settings_pos_layout_object;
alter table pos_settings
  add constraint pos_settings_pos_layout_object
  check (jsonb_typeof(pos_layout) = 'object');

comment on column pos_settings.pos_layout is
  'Diseño del POS del negocio (preset, grilla, carrito, acento, medios fijados, teclas rápidas). Ver lib/pos/layout.ts.';

-- B) Feature de plan --------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('pos_quick_keys_pro', 'Teclas rápidas Pro',
   'Hasta 48 teclas rápidas en el POS, con color por tecla', 'ventas', false, 25)
on conflict (key) do nothing;

-- Desde Pro en los planes globales (explícito por plan).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('pos_quick_keys_pro', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise');

-- C) Gating real en la escritura -------------------------------------------------------
-- Sólo mira las teclas rápidas: el resto del diseño es libre. Con la feature
-- se aceptan hasta 48 teclas y color por tecla; sin ella, hasta 12 y sin color.
create or replace function trg_assert_pos_layout_feature()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_keys jsonb;
  v_count int;
  v_pro boolean;
begin
  if tg_op = 'UPDATE' and new.pos_layout is not distinct from old.pos_layout then
    return new;
  end if;

  v_keys := case
    when jsonb_typeof(new.pos_layout -> 'quickKeys') = 'array' then new.pos_layout -> 'quickKeys'
    else '[]'::jsonb
  end;
  v_count := jsonb_array_length(v_keys);

  if v_count > 48 then
    raise exception 'pos_layout_quick_keys_max';
  end if;

  v_pro := v_count > 12
    or exists (
      select 1 from jsonb_array_elements(v_keys) k
      where coalesce(k ->> 'color', '') <> ''
    );

  if v_pro and not tenant_has_feature_for(new.tenant_id, 'pos_quick_keys_pro') then
    raise exception 'feature_not_in_plan: pos_quick_keys_pro';
  end if;

  return new;
end;
$function$;

revoke all on function trg_assert_pos_layout_feature() from public, anon;

drop trigger if exists pos_settings_assert_layout on pos_settings;
create trigger pos_settings_assert_layout
  before insert or update of pos_layout on pos_settings
  for each row execute function trg_assert_pos_layout_feature();
