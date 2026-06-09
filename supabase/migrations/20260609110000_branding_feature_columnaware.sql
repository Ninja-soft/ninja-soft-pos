-- =============================================================================
-- 20260609110000_branding_feature_columnaware  (FIX — gate de branding por columna)
--
-- 20260609100000 puso un trigger que gateaba TODA escritura a tenant_branding por
-- la feature `personalizacion_marca`. Pero tenant_branding mezcla:
--   • BRANDING (personalizacion_marca, feature paga): logo_path, logo_url, accent.
--   • FISCAL / BASE (cualquier plan): legal_name, cuit, iva_condition, phone,
--     address, y los campos básicos de ticket (ticket_footer/title/legend/width/
--     show_qr/show_logo).
-- Gatear toda la tabla rompía `create_tenant` (que hace upsert de datos fiscales
-- a tenant_branding en el alta, incluso para planes sin la feature) y bloqueaba
-- editar datos fiscales/ticket en planes bajos.
--
-- Este fix reemplaza el trigger por uno COLUMN-AWARE: sólo exige
-- `personalizacion_marca` cuando la escritura SETEA/CAMBIA un campo de branding
-- (logo_path/logo_url/accent) a un valor no vacío. Fiscal y ticket básico quedan
-- libres → el alta de tenant y la carga fiscal funcionan en cualquier plan.
-- =============================================================================

drop trigger if exists tenant_branding_assert_feature on tenant_branding;

create or replace function trg_assert_branding_feature()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  v_branding_touched boolean;
begin
  if tg_op = 'INSERT' then
    v_branding_touched :=
      coalesce(new.logo_path, '') <> ''
      or coalesce(new.logo_url, '') <> ''
      or coalesce(new.accent, '') <> '';
  else
    -- UPDATE: sólo si un campo de branding CAMBIA a un valor no vacío.
    v_branding_touched :=
      (new.logo_path is distinct from old.logo_path
        or new.logo_url is distinct from old.logo_url
        or new.accent  is distinct from old.accent)
      and (coalesce(new.logo_path, '') <> ''
        or coalesce(new.logo_url, '') <> ''
        or coalesce(new.accent, '') <> '');
  end if;

  if v_branding_touched
     and not tenant_has_feature_for(new.tenant_id, 'personalizacion_marca') then
    raise exception 'feature_not_in_plan: personalizacion_marca';
  end if;

  return new;
end;
$function$;

revoke all on function trg_assert_branding_feature() from public, anon;

create trigger tenant_branding_assert_feature
  before insert or update on tenant_branding
  for each row execute function trg_assert_branding_feature();
