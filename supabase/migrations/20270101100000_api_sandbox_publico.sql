-- =============================================================================
-- 20270101100000_api_sandbox_publico  (ADR-163 · H68b · Portal público de la API)
--
-- Enviar la documentación de la API por email desde
-- Configuración › Integraciones › API.
--
--   * api_docs_send_email(p_recipient, p_note): sólo el DUEÑO del negocio
--     activo (_api_owner_assert(false), igual que ver las credenciales). No
--     exige el plan: la documentación es pública (/developers,
--     /api/docs/html, /api/openapi.json); lo que se manda es un link, nunca
--     una credencial ni datos del negocio.
--   * Va por el sistema de emails existente: enqueue_system_email (clave de
--     plantilla api_docs_shared, con el HTML de abajo como fallback) ->
--     system_emails -> process_pending_emails.
--   * Auditado en audit_logs ANTES de responder (api_docs_emailed, con el
--     destinatario y la nota).
--   * Freno al abuso: hasta 20 envíos por negocio en 24 horas, contados en
--     audit_logs (índice audit_logs_tenant_created_idx).
--
-- El sandbox público (/api/sandbox/v1 con datos ficticios) y la página
-- /developers NO tocan la base: el dataset vive en el código
-- (lib/api/sandboxDataset.ts) y una credencial de prueba propia usa el
-- circuito de ADR-159 (dry_run en la base). Sin tablas ni policies nuevas.
-- =============================================================================

create or replace function api_docs_send_email(p_recipient text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(false);
  v_email  text := lower(btrim(coalesce(p_recipient, '')));
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_name   text;
  v_sent   int;
  v_portal constant text := 'https://pos.soft.ninja/developers';
  v_html_url constant text := 'https://pos.soft.ninja/api/docs/html';
  v_pdf_url constant text := 'https://pos.soft.ninja/api/docs/html?print=1';
  v_subject text;
  v_body   text;
begin
  if v_email = '' or length(v_email) > 254 or v_email !~ '^[^@\s<>"'',;]+@[^@\s<>"'',;]+\.[^@\s<>"'',;]+$' then
    raise exception 'invalid_email' using errcode = 'check_violation';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = 'check_violation';
  end if;

  select count(*) into v_sent
    from audit_logs a
   where a.tenant_id = v_tenant
     and a.action = 'api_docs_emailed'
     and a.created_at > now() - interval '24 hours';
  if v_sent >= 20 then
    raise exception 'too_many_emails' using errcode = 'check_violation';
  end if;

  select t.name into v_name from tenants t where t.id = v_tenant;
  v_name := coalesce(nullif(btrim(v_name), ''), 'Un negocio de NinjaSoft');

  v_subject := 'Documentación de la API de NinjaSoft POS';
  v_body :=
    '<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f5fa;padding:24px">'
    || '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;color:#09051C">'
    || '<p style="margin:0 0 4px;font-size:13px;color:#6b7280">' || _catalog_html(v_name) || '</p>'
    || '<h1 style="margin:0 0 12px;font-size:20px">Documentación de la API de NinjaSoft POS</h1>'
    || '<p style="margin:0 0 16px;font-size:14px">Te compartieron la documentación de la API pública v1: '
    || 'autenticación, endpoints con ejemplos, errores, límites y un sandbox para probar sin cuenta con datos ficticios.</p>'
    || coalesce('<p style="margin:0 0 16px;font-size:14px;white-space:pre-wrap;background:#f6f5fa;border-radius:8px;padding:12px">'
                || _catalog_html(v_note) || '</p>', '')
    || '<p style="margin:0 0 8px"><a href="' || v_portal
    || '" style="display:inline-block;background:#09051C;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir el portal de desarrolladores</a></p>'
    || '<p style="margin:12px 0 0;font-size:13px">Descargas: <a href="' || v_html_url || '">HTML</a> · '
    || '<a href="' || v_pdf_url || '">PDF (imprimir y Guardar como PDF)</a></p>'
    || '<p style="margin:16px 0 0;font-size:12px;color:#6b7280">Las credenciales no viajan por email: '
    || 'el dueño del negocio las crea en Configuración, Integraciones, API.</p>'
    || '</div></div>';

  perform enqueue_system_email(
    v_tenant, v_email, 'api_docs_shared',
    jsonb_build_object('negocio', v_name, 'link', v_portal, 'html', v_html_url, 'pdf', v_pdf_url, 'nota', coalesce(v_note, '')),
    v_subject, v_body);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'api_docs', null, 'api_docs_emailed', null,
          jsonb_build_object('email', v_email, 'note', v_note, 'link', v_portal));

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;
revoke all on function api_docs_send_email(text, text) from public, anon;
grant execute on function api_docs_send_email(text, text) to authenticated;
