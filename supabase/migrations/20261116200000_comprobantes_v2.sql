-- =============================================================================
-- 20261116200000_comprobantes_v2  (ADR-119 · comprobantes v2)
--
-- Todo comprobante (venta, devolución / nota de crédito, provisorio,
-- contingencia, offline, reimpresión, email y PDF) sale del motor ADR-112.
-- Se retiran el ticket de bloques "Simple (anterior)" y las plantillas propias
-- de bloques, lienzo y HTML como opción de la UI. NADA se borra:
--
--   1. Gating: invoice_style_needs_pro suma los modelos nuevos (A4 Elegante,
--      Bloques de color, Compacto de una hoja y Catálogo con fotos; ticket
--      Moderno y Minimal) y las opciones de aspecto (tipografía, densidad,
--      esquinas rectas, posición del logo, estilo del encabezado,
--      separadores) y las fotos de producto. El tamaño de letra y los bloques
--      que se muestran (contacto, medios de pago, número interno, detalle de
--      IVA en B, leyendas, código de barras) son BASE. Espejo exacto de
--      lib/invoices/style.ts → invoiceStyleNeedsPro. El trigger
--      tenant_branding_assert_invoice_style (ADR-112) no cambia: ya llama a
--      esta función y a comprobantes_sin_sello.
--   2. Datos: los negocios con una plantilla propia activa (impresión o email)
--      o con el modelo "simple" pasan al modelo Clásico nuevo, que toma el
--      color y el logo de su marca (tenant_branding.accent / logo_url). Si la
--      plantilla de email (o la de impresión) era A4, el email adjunta la hoja
--      A4; si la de impresión era A4 y el perfil "ticket de venta" no tenía
--      formato, el perfil queda en A4. Se guarda de dónde vino
--      (invoice_style.legacy_from) para soporte.
--   3. Baja lógica: las plantillas quedan con print_active / email_active en
--      false (siguen en ticket_templates, sin deleted_at, con su contenido).
--   4. Onboarding: el paso "ticket" pasa a ser "diseñó sus comprobantes"
--      (invoice_style guardado) o tenía una plantilla (no se pierde el paso).
--
-- Sin columnas nuevas: las opciones viven en el jsonb invoice_style (ADR-112,
-- check de objeto y 8 KB). Copy en lib/saas/featureInfo.ts (tickets_pro).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Gating server-side de invoice_style (espejo de invoiceStyleNeedsPro).
-- -----------------------------------------------------------------------------
create or replace function invoice_style_needs_pro(p jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p ->> 'a4_model', '') in ('moderno', 'minimal', 'corporativo', 'ejecutivo', 'elegante', 'bloques', 'compacto', 'catalogo')
      or coalesce(p ->> 'ticket_model', '') in ('compacto', 'destacado', 'moderno', 'minimal')
      or (coalesce(p ->> 'accent_mode', 'brand') = 'custom' and coalesce(p ->> 'accent_custom', '') ~ '^#[0-9a-fA-F]{6}$')
      or (coalesce(p ->> 'logo_mode', 'brand') = 'custom' and btrim(coalesce(p ->> 'logo_custom_url', '')) <> '')
      or btrim(coalesce(p ->> 'legends', '')) <> ''
      -- ADR-119: aspecto distinto del default (valores válidos; lo inválido se normaliza al default).
      or coalesce(p ->> 'font_family', 'auto') in ('inter', 'helvetica', 'serif', 'mono')
      or coalesce(p ->> 'density', 'normal') in ('compacta', 'amplia')
      or coalesce(p ->> 'corners', 'rounded') = 'square'
      or coalesce(p ->> 'logo_position', 'auto') in ('left', 'center', 'right')
      or coalesce(p ->> 'header_style', 'color') in ('neutral', 'filled')
      or coalesce(p ->> 'separators', 'auto') in ('dotted', 'solid', 'none')
      or coalesce(p ->> 'show_photos', 'false') = 'true'
      or coalesce(p ->> 'ticket_photos', 'false') = 'true';
$$;
revoke all on function invoice_style_needs_pro(jsonb) from public, anon;
grant execute on function invoice_style_needs_pro(jsonb) to authenticated, service_role;

update features
set description = 'Modelos de factura A4 (Moderno, Minimal, Corporativo, Ejecutivo, Elegante, Bloques de color, Compacto, Catálogo con fotos) y de ticket (Compacto, Destacado, Moderno, Minimal), aspecto (tipografía, densidad, esquinas, logo, encabezado, separadores), fotos de producto, color y logo propios y leyendas'
where key = 'tickets_pro';

-- -----------------------------------------------------------------------------
-- 2. Negocios con plantilla propia activa o con el modelo "simple".
-- -----------------------------------------------------------------------------
drop table if exists _cv2_targets;
create temporary table _cv2_targets as
with tpl as (
  select tenant_id,
         bool_or(print_active) as had_print,
         bool_or(email_active) as had_email,
         bool_or(print_active and paper = 'a4') as print_a4,
         bool_or(email_active and paper = 'a4') as email_a4
    from ticket_templates
   where deleted_at is null and (print_active or email_active)
   group by tenant_id
)
select coalesce(t.tenant_id, b.tenant_id) as tenant_id,
       coalesce(t.had_print or t.had_email, false) as had_template,
       coalesce(b.invoice_style ->> 'ticket_model', '') = 'simple' as was_simple,
       -- El email adjunta A4 si la plantilla de email era A4 (o, sin una de
       -- email, si la de impresión lo era).
       coalesce(t.email_a4, false) or (not coalesce(t.had_email, false) and coalesce(t.print_a4, false)) as email_a4,
       coalesce(t.print_a4, false) as print_a4
  from tpl t
  full join (select tenant_id, invoice_style from tenant_branding where invoice_style ->> 'ticket_model' = 'simple') b
    on b.tenant_id = t.tenant_id;

-- El trigger de plan de invoice_style se apaga sólo durante esta migración:
-- lo que se escribe es el modelo Clásico (BASE), pero un negocio que ya tenía
-- opciones Pro guardadas y bajó de plan no debe frenar la migración.
alter table tenant_branding disable trigger tenant_branding_assert_invoice_style;

insert into tenant_branding (tenant_id, invoice_style)
select x.tenant_id, '{}'::jsonb
  from _cv2_targets x
 where not exists (select 1 from tenant_branding b where b.tenant_id = x.tenant_id)
on conflict (tenant_id) do nothing;

update tenant_branding b
   set invoice_style = b.invoice_style
         || jsonb_build_object(
              'ticket_model', 'clasico',
              'a4_model', case when coalesce(b.invoice_style ->> 'a4_model', '') = '' then 'clasico' else b.invoice_style ->> 'a4_model' end,
              'legacy_from', case when x.had_template then 'plantilla_propia' else 'simple' end
            )
         || case when x.email_a4 and not (b.invoice_style ? 'email_format') then '{"email_format":"a4"}'::jsonb else '{}'::jsonb end
  from _cv2_targets x
 where b.tenant_id = x.tenant_id
   and (x.had_template or x.was_simple);

alter table tenant_branding enable trigger tenant_branding_assert_invoice_style;

-- La plantilla de impresión era A4 y el perfil del ticket de venta no tenía
-- formato: el perfil queda en A4 (la ventana del ticket lo preselecciona).
update pos_settings s
   set print_profiles = jsonb_set(
         coalesce(s.print_profiles, '{}'::jsonb),
         '{sale}',
         coalesce(s.print_profiles -> 'sale', '{}'::jsonb) || '{"paper":"a4"}'::jsonb,
         true)
  from _cv2_targets x
 where s.tenant_id = x.tenant_id
   and x.print_a4
   and coalesce(s.print_profiles -> 'sale' ->> 'paper', '') = '';

-- -----------------------------------------------------------------------------
-- 3. Baja lógica de las plantillas propias: inactivas, con su contenido.
-- -----------------------------------------------------------------------------
update ticket_templates
   set print_active = false,
       email_active = false
 where print_active or email_active;

drop table if exists _cv2_targets;

comment on table ticket_templates is
  'H9b: plantillas de ticket (bloques, lienzo, HTML). RETIRADAS por ADR-119: la UI ya no las usa ni las activa; quedan como historial (print_active/email_active en false desde 20261116200000). Todo comprobante sale del motor ADR-112 (tenant_branding.invoice_style).';

comment on column tenant_branding.invoice_style is
  'ADR-112 / ADR-119: personalización de comprobantes. Modelos (a4_model, ticket_model), color y logo (accent_mode/custom, logo_mode/custom_url), sello, leyendas, trade_name, bloques (show_payments, show_internal_ref, show_contact, show_iva_breakdown, show_legends, show_sale_barcode), aspecto (font_family, font_size, density, corners, logo_position, header_style, separators), fotos (show_photos, ticket_photos), a4_copies, email_format y legacy_from (migración). {} = defaults.';

-- -----------------------------------------------------------------------------
-- 4. Onboarding: el paso "ticket" es haber diseñado los comprobantes.
--    Misma definición que 20261108300300 salvo la clave 'ticket'.
-- -----------------------------------------------------------------------------
create or replace function onboarding_tenant_signals(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- onboarding_status (pasos base)
    'fiscal', p_tenant is not null and exists (
      select 1 from tenant_branding where tenant_id = p_tenant and coalesce(cuit, '') <> ''),
    'mp', p_tenant is not null and (
      exists (
        select 1 from payment_secrets
         where tenant_id = p_tenant and provider_key = 'mercadopago'
           and coalesce(secrets ->> 'access_token', '') <> '')
      or exists (
        select 1 from tenant_payment_methods
         where tenant_id = p_tenant and provider_key = 'mercadopago' and enabled)),
    'producto', p_tenant is not null and exists (
      select 1 from products where tenant_id = p_tenant and deleted_at is null),
    -- ADR-119: diseño de comprobantes guardado (o una plantilla de antes).
    'ticket', p_tenant is not null and (
      exists (
        select 1 from tenant_branding
         where tenant_id = p_tenant and invoice_style <> '{}'::jsonb)
      or exists (
        select 1 from ticket_templates where tenant_id = p_tenant and deleted_at is null)),
    'venta', p_tenant is not null and exists (
      select 1 from sales where tenant_id = p_tenant),
    -- onboarding_activation_status (ADR-086)
    'caja', p_tenant is not null and exists (
      select 1 from cash_shifts where tenant_id = p_tenant),
    'equipo', p_tenant is not null and (
      select count(*) from tenant_users where tenant_id = p_tenant and status = 'active') > 1,
    'mesas', p_tenant is not null and exists (
      select 1 from dining_tables where tenant_id = p_tenant),
    'agenda', p_tenant is not null and exists (
      select 1 from appointments where tenant_id = p_tenant),
    'arca', p_tenant is not null and exists (
      select 1 from arca_settings where tenant_id = p_tenant and enabled and environment = 'produccion'),
    'escuela', p_tenant is not null and exists (
      select 1 from school_progress
       where tenant_id = p_tenant and course_key = 'pos-basico' and passed_at is not null),
    -- Sólo para el panel interno (H71)
    'medios', p_tenant is not null and exists (
      select 1 from tenant_payment_methods where tenant_id = p_tenant and enabled),
    'first_sale_at', (
      select min(created_at) from sales where tenant_id = p_tenant and status = 'completed'),
    'products_count', (
      select count(*) from products where tenant_id = p_tenant and deleted_at is null),
    'shifts_7d', (
      select count(*) from cash_shifts where tenant_id = p_tenant and opened_at >= now() - interval '7 days')
  );
$$;

revoke all on function onboarding_tenant_signals(uuid) from public, anon, authenticated;
