-- =============================================================================
-- 20261112100000_comprobantes_plantillas  (ADR-112 · plantillas de factura)
--
-- Motor de comprobantes con modelos A4 y ticket (Clásico, Moderno, Minimal,
-- Corporativo, Ejecutivo; Clásico, Compacto, Destacado) y personalización por
-- negocio. Todo vive en tenant_branding (la fila de marca y ticket del
-- negocio): sus policies RLS ya existentes (lectura del tenant; escritura sólo
-- owner/manager, tenant_branding_insert / _update / _delete) cubren las
-- columnas nuevas, no hace falta una tabla aparte.
--
--   1. Columnas:
--        invoice_style   jsonb   elección del negocio (modelos, color, logo,
--                                sello, leyendas, opciones). '{}' = defaults.
--        iibb            text    N° de Ingresos Brutos del emisor (RG 1415).
--        activity_start  date    Inicio de actividades del emisor (RG 1415).
--      iibb y activity_start son datos fiscales BASE (cualquier plan): el
--      trigger de personalizacion_marca no los mira.
--   2. Feature `comprobantes_sin_sello` (OPTIONAL, Business y Enterprise):
--      ocultar el sello "Un software de Ninja Soft". Los modelos no clásicos,
--      el color y el logo propios y las leyendas propias quedan dentro de
--      `tickets_pro` (Pro+), que ya es "personalización de comprobantes".
--   3. Gating real server-side: trigger BEFORE INSERT/UPDATE que, cuando la
--      escritura cambia invoice_style, exige tickets_pro y/o
--      comprobantes_sin_sello según lo elegido (invoice_style_needs_pro es el
--      espejo exacto de lib/invoices/style.ts → invoiceStyleNeedsPro).
--      La UI no es la única barrera.
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
-- =============================================================================

alter table tenant_branding
  add column if not exists invoice_style  jsonb not null default '{}'::jsonb,
  add column if not exists iibb           text,
  add column if not exists activity_start date;

alter table tenant_branding drop constraint if exists tenant_branding_invoice_style_obj;
alter table tenant_branding add constraint tenant_branding_invoice_style_obj
  check (jsonb_typeof(invoice_style) = 'object' and pg_column_size(invoice_style) <= 8192);

alter table tenant_branding drop constraint if exists tenant_branding_iibb_len;
alter table tenant_branding add constraint tenant_branding_iibb_len
  check (iibb is null or char_length(iibb) <= 60);

comment on column tenant_branding.invoice_style is
  'ADR-112: personalización de comprobantes (a4_model, ticket_model, accent_mode/custom, logo_mode/custom_url, show_ninja_seal, legends, trade_name, show_payments, show_internal_ref, a4_copies, email_format). {} = defaults.';
comment on column tenant_branding.iibb is 'ADR-112: N° de Ingresos Brutos del emisor (dato obligatorio de la factura).';
comment on column tenant_branding.activity_start is 'ADR-112: inicio de actividades del emisor (dato obligatorio de la factura).';

-- -----------------------------------------------------------------------------
-- Feature comprobantes_sin_sello (OPTIONAL) y copy actualizado de tickets_pro.
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('comprobantes_sin_sello', 'Comprobantes sin sello NinjaSoft',
   'Ocultar el sello "Un software de Ninja Soft" de facturas, notas de crédito y tickets',
   'tickets', false, 145)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update features
set description = 'Diseñador avanzado de tickets y modelos de factura A4 y ticket (Moderno, Minimal, Corporativo, Ejecutivo, Compacto, Destacado), color y logo propios y leyendas'
where key = 'tickets_pro';

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('comprobantes_sin_sello', (p.key in ('business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'comprobantes_sin_sello');

-- -----------------------------------------------------------------------------
-- Gating server-side de invoice_style.
-- -----------------------------------------------------------------------------
create or replace function invoice_style_needs_pro(p jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p ->> 'a4_model', '') in ('moderno', 'minimal', 'corporativo', 'ejecutivo')
      or coalesce(p ->> 'ticket_model', '') in ('compacto', 'destacado')
      or (coalesce(p ->> 'accent_mode', 'brand') = 'custom' and coalesce(p ->> 'accent_custom', '') ~ '^#[0-9a-fA-F]{6}$')
      or (coalesce(p ->> 'logo_mode', 'brand') = 'custom' and btrim(coalesce(p ->> 'logo_custom_url', '')) <> '')
      or btrim(coalesce(p ->> 'legends', '')) <> '';
$$;
revoke all on function invoice_style_needs_pro(jsonb) from public, anon;
grant execute on function invoice_style_needs_pro(jsonb) to authenticated, service_role;

create or replace function trg_assert_invoice_style_feature()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Sólo cuando la escritura toca invoice_style (los datos fiscales y el
  -- ticket básico siguen libres en cualquier plan).
  if tg_op = 'UPDATE' and new.invoice_style is not distinct from old.invoice_style then
    return new;
  end if;

  if invoice_style_needs_pro(new.invoice_style)
     and not tenant_has_feature_for(new.tenant_id, 'tickets_pro') then
    raise exception 'feature_not_in_plan: tickets_pro';
  end if;

  if (new.invoice_style ->> 'show_ninja_seal') = 'false'
     and not tenant_has_feature_for(new.tenant_id, 'comprobantes_sin_sello') then
    raise exception 'feature_not_in_plan: comprobantes_sin_sello';
  end if;

  return new;
end;
$function$;
revoke all on function trg_assert_invoice_style_feature() from public, anon;

drop trigger if exists tenant_branding_assert_invoice_style on tenant_branding;
create trigger tenant_branding_assert_invoice_style
  before insert or update on tenant_branding
  for each row execute function trg_assert_invoice_style_feature();
