-- =============================================================================
-- ARCA: estado de la conexión guardado POR AMBIENTE (ADR-153).
--
-- Antes había una sola "última conexión" (last_connection_*) para los dos
-- ambientes: probar producción pisaba la prueba de homologación y los pasos
-- Autorizar y Probar del asistente (que miran la conexión del ambiente actual)
-- volvían a "pendiente" aunque estaban hechos. Ahora cada ambiente guarda su
-- última prueba completa con el detalle de cada paso (certificado, WSAA,
-- FEDummy, puntos de venta, último comprobante), así el asistente y la guía de
-- producción muestran dónde quedó cada cosa aunque el dueño salga y vuelva.
--
-- Además: los puntos de venta que lista ARCA se guardan aunque la prueba falle
-- en un paso posterior (por ejemplo, último comprobante en un punto de venta
-- que no es Web Services), para poder explicar cuál falta.
--
-- Idempotente. No toca datos de negocio: sólo suma una columna, la rellena con
-- la última prueba registrada de cada ambiente y recrea arca_record_connection
-- (misma firma, misma seguridad).
-- =============================================================================

alter table arca_settings
  add column if not exists connection_by_env jsonb not null default '{}'::jsonb;

-- Relleno: última prueba de conexión de cada ambiente según los eventos.
with last as (
  select distinct on (e.tenant_id, e.environment)
         e.tenant_id, e.environment, e.outcome, e.error_code, e.error_msg, e.created_at
    from fiscal_document_events e
   where e.document_id is null
     and e.action = 'test_conexion'
     and e.environment in ('homologacion', 'produccion')
   order by e.tenant_id, e.environment, e.created_at desc
), agg as (
  select l.tenant_id,
         jsonb_object_agg(l.environment, jsonb_build_object(
           'ok', l.outcome = 'ok',
           'at', l.created_at,
           'code', l.error_code,
           'message', l.error_msg)) as by_env
    from last l
   group by l.tenant_id
)
update arca_settings s
   set connection_by_env = agg.by_env || coalesce(s.connection_by_env, '{}'::jsonb)
  from agg
 where agg.tenant_id = s.tenant_id
   and s.connection_by_env = '{}'::jsonb;

create or replace function arca_record_connection(p_tenant uuid, p_env text, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok     boolean := coalesce((p ->> 'ok')::boolean, false);
  -- Los puntos de venta valen si ARCA los listó, aunque otro paso falle.
  v_pos_ok boolean := coalesce((p ->> 'pos_ok')::boolean, v_ok);
  v_full   boolean := p ? 'full_test';
  v_pos    integer[];
  v_entry  jsonb;
begin
  if p_env not in ('homologacion', 'produccion') then
    raise exception 'invalid_environment';
  end if;
  insert into arca_settings (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  if p ? 'pos' and jsonb_typeof(p -> 'pos') = 'array' then
    select array_agg(x::integer order by x::integer) into v_pos from jsonb_array_elements_text(p -> 'pos') x;
  end if;
  -- Sólo una prueba completa (test_conexion) define el estado del ambiente;
  -- una consulta suelta de puntos de venta no lo pisa.
  if v_full then
    v_entry := jsonb_build_object(
      'ok', v_ok,
      'at', now(),
      'code', p ->> 'error_code',
      'message', left(p ->> 'message', 500),
      'cuit', p ->> 'cuit',
      'steps', case when jsonb_typeof(p -> 'steps') = 'array' then p -> 'steps' else '[]'::jsonb end,
      'pos', case when v_pos_ok and p ? 'pos' then to_jsonb(coalesce(v_pos, '{}')) else null end);
  end if;
  update arca_settings set
    last_connection_at = now(),
    last_connection_env = p_env,
    last_connection_ok = v_ok,
    last_connection_message = left(p ->> 'message', 500),
    connection_by_env = case when v_full
                             then coalesce(connection_by_env, '{}'::jsonb) || jsonb_build_object(p_env, v_entry)
                             else connection_by_env end,
    prod_test_ok_at = case when p_env = 'produccion' and v_ok and coalesce((p ->> 'full_test')::boolean, false)
                           then now() else prod_test_ok_at end,
    prod_pos_verified = case when p_env = 'produccion' and v_pos_ok and p ? 'pos' then coalesce(v_pos, '{}') else prod_pos_verified end,
    prod_pos_verified_at = case when p_env = 'produccion' and v_pos_ok and p ? 'pos' then now() else prod_pos_verified_at end
  where tenant_id = p_tenant;
  insert into fiscal_document_events (tenant_id, environment, action, outcome, error_code, error_msg, duration_ms,
                                      created_by)
  values (p_tenant, p_env, coalesce(p ->> 'action', 'test_conexion'), case when v_ok then 'ok' else 'error' end,
          p ->> 'error_code', left(p ->> 'message', 500), (p ->> 'duration_ms')::integer,
          nullif(p ->> 'user_id', '')::uuid);
end;
$$;
revoke all on function arca_record_connection(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function arca_record_connection(uuid, text, jsonb) to service_role;
