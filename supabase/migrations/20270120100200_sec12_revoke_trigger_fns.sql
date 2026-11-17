-- =============================================================================
-- SEC-12 · Grupo B: las funciones de trigger no se ejecutan por el Data API
-- =============================================================================
-- 66 funciones de trigger de `public` (22 SECURITY DEFINER) eran ejecutables
-- por anon y 75 por authenticated. Una función que devuelve `trigger` no se
-- llama por RPC y Postgres no chequea EXECUTE al disparar el trigger, así que
-- se revoca a todas (no sólo a las 22 del relevamiento), incluidas las que
-- quedaron con el EXECUTE de PUBLIC. Mismo patrón que
-- `revoke_trigger_fn_execute` (junio). Las funciones de extensiones no se tocan.
-- =============================================================================

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prorettype = 'trigger'::regtype
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
