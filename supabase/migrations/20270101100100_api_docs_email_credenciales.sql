-- =============================================================================
-- 20270101100100_api_docs_email_credenciales  (ADR-163 · H68b)
--
-- Pedido del dueño (16/10): "la documentación de la API que se pueda enviar
-- por email, con las credenciales generadas".
--
-- El envío con credenciales NO pasa por la cola (system_emails guarda el
-- HTML): lo hace la Edge send_api_docs_email, que manda directo con la cadena
-- de proveedores de la plataforma y no persiste el cuerpo. Acá sólo:
--
--   * api_docs_email_prepare(...)  (authenticated, con el JWT del dueño)
--       - dueño del negocio activo (_api_owner_assert(false));
--       - email, nota (<= 500) y tope compartido con api_docs_send_email
--         (20 por negocio en 24 h, contado en audit_logs);
--       - la credencial (si viene) es del negocio y está activa;
--       - con secreto: la Edge manda sha256(secreto) y tiene que coincidir con
--         api_clients.secret_hash (el secreto en claro nunca llega a la base)
--         y el dueño tiene que haber confirmado (p_ack_secret = true);
--       - audita api_docs_emailed ANTES de enviar: destinatario, with_secret,
--         client_id acortado, ambiente, alcances, adjuntos. Nunca el secreto
--         ni su hash.
--   * api_docs_email_finish(...)  (service_role, la Edge): si el envío falló,
--     deja api_docs_email_failed con el motivo (sin cuerpo ni secreto).
--
-- Sin tablas ni policies nuevas.
-- =============================================================================

create or replace function api_docs_email_prepare(
  p_recipient     text,
  p_note          text,
  p_client_id     text,
  p_secret_sha256 text,
  p_ack_secret    boolean,
  p_attachments   text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _api_owner_assert(false);
  v_email  text := lower(btrim(coalesce(p_recipient, '')));
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_sent   int;
  v_name   text;
  v_client api_clients;
  v_with_secret boolean := nullif(btrim(coalesce(p_secret_sha256, '')), '') is not null;
  v_att    text[] := coalesce(p_attachments, '{}'::text[]);
  v_audit  uuid;
begin
  if v_email = '' or length(v_email) > 254 or v_email !~ '^[^@\s<>"'',;]+@[^@\s<>"'',;]+\.[^@\s<>"'',;]+$' then
    raise exception 'invalid_email' using errcode = 'check_violation';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = 'check_violation';
  end if;
  if not (v_att <@ array['postman', 'docs_html']::text[]) then
    raise exception 'invalid_attachments' using errcode = 'check_violation';
  end if;

  select count(*) into v_sent
    from audit_logs a
   where a.tenant_id = v_tenant
     and a.action = 'api_docs_emailed'
     and a.created_at > now() - interval '24 hours';
  if v_sent >= 20 then
    raise exception 'too_many_emails' using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(p_client_id, '')), '') is not null then
    select * into v_client
      from api_clients c
     where c.tenant_id = v_tenant
       and c.client_id = btrim(p_client_id)
       and c.revoked_at is null;
    if not found then
      raise exception 'client_not_found' using errcode = 'check_violation';
    end if;
  elsif v_with_secret then
    raise exception 'client_not_found' using errcode = 'check_violation';
  end if;

  if v_with_secret then
    if p_secret_sha256 !~ '^[0-9a-f]{64}$' or v_client.secret_hash is distinct from p_secret_sha256 then
      raise exception 'secret_mismatch' using errcode = 'check_violation';
    end if;
    if coalesce(p_ack_secret, false) is not true then
      raise exception 'secret_ack_required' using errcode = 'check_violation';
    end if;
  end if;

  select t.name into v_name from tenants t where t.id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(),
          case when v_client.id is null then 'api_docs' else 'api_client' end,
          v_client.id, 'api_docs_emailed', null,
          jsonb_build_object(
            'email', v_email,
            'note', v_note,
            'with_secret', v_with_secret,
            'client_id', case when v_client.id is null then null else left(v_client.client_id, 13) || '…' end,
            'environment', v_client.environment,
            'scopes', case when v_client.id is null then null else to_jsonb(v_client.scopes) end,
            'attachments', to_jsonb(v_att),
            'channel', 'direct'))
  returning id into v_audit;

  return jsonb_build_object(
    'audit_id', v_audit,
    'tenant_name', coalesce(nullif(btrim(v_name), ''), 'Un negocio de NinjaSoft'),
    'with_secret', v_with_secret,
    'client', case when v_client.id is null then null else jsonb_build_object(
      'name', v_client.name,
      'client_id', v_client.client_id,
      'environment', v_client.environment,
      'scopes', to_jsonb(v_client.scopes),
      'rate_limit_per_min', v_client.rate_limit_per_min) end);
end;
$$;
revoke all on function api_docs_email_prepare(text, text, text, text, boolean, text[]) from public, anon;
grant execute on function api_docs_email_prepare(text, text, text, text, boolean, text[]) to authenticated;

create or replace function api_docs_email_finish(p_audit_id uuid, p_ok boolean, p_error text, p_provider text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row audit_logs;
begin
  select * into v_row from audit_logs a where a.id = p_audit_id and a.action = 'api_docs_emailed';
  if not found or coalesce(p_ok, false) then
    return;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_row.tenant_id, v_row.actor_user_id, v_row.entity_type, v_row.entity_id, 'api_docs_email_failed', null,
          jsonb_build_object(
            'email', v_row.after_data ->> 'email',
            'with_secret', (v_row.after_data ->> 'with_secret')::boolean,
            'client_id', v_row.after_data ->> 'client_id',
            'provider', left(coalesce(p_provider, ''), 40),
            'error', left(coalesce(p_error, ''), 200)));
end;
$$;
revoke all on function api_docs_email_finish(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function api_docs_email_finish(uuid, boolean, text, text) to service_role;
