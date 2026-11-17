-- =============================================================================
-- Foto de grants del Data API (SEC-06). SÓLO LECTURA.
-- Devuelve una fila con un jsonb: por tabla/vista de `public`, los privilegios
-- de anon y authenticated, RLS y cantidad de policies; por función de
-- `public` (sin las de extensiones), SECURITY DEFINER, EXECUTE de anon y
-- authenticated y proconfig (search_path). Ordenado y estable.
-- Lo corre scripts/security/grants-snapshot.mjs (prod o local) y
-- tests/integration/grants-parity.test.ts.
-- =============================================================================
with rels as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
),
fns as (
  select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select jsonb_build_object(
  'tables', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', r.relname,
      'kind', r.relkind,
      'rls', r.relrowsecurity,
      'policies', (select count(*) from pg_policies pp where pp.schemaname = 'public' and pp.tablename = r.relname),
      -- Grants explícitos por columna (pg_attribute.attacl): un revoke a nivel
      -- tabla también los borra, así que la migración los vuelve a otorgar.
      'columns', coalesce((
        select jsonb_object_agg(g.grantee || ' ' || lower(g.priv), g.cols order by g.grantee, g.priv)
          from (
            select x.grantee::regrole::text as grantee, x.privilege_type as priv,
                   jsonb_agg(a.attname order by a.attname collate "C") as cols
              from pg_attribute a, aclexplode(a.attacl) x
             where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
               and x.grantee in ('anon'::regrole, 'authenticated'::regrole)
             group by 1, 2
          ) g), '{}'::jsonb),
      'anon', (case when has_table_privilege('anon', r.oid, 'SELECT') then 's' else '' end)
           || (case when has_table_privilege('anon', r.oid, 'INSERT') then 'i' else '' end)
           || (case when has_table_privilege('anon', r.oid, 'UPDATE') then 'u' else '' end)
           || (case when has_table_privilege('anon', r.oid, 'DELETE') then 'd' else '' end),
      'authenticated', (case when has_table_privilege('authenticated', r.oid, 'SELECT') then 's' else '' end)
           || (case when has_table_privilege('authenticated', r.oid, 'INSERT') then 'i' else '' end)
           || (case when has_table_privilege('authenticated', r.oid, 'UPDATE') then 'u' else '' end)
           || (case when has_table_privilege('authenticated', r.oid, 'DELETE') then 'd' else '' end)
    ) order by r.relname collate "C")
    from rels r), '[]'::jsonb),
  'functions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'sig', f.sig,
      'secdef', f.prosecdef,
      'anon', has_function_privilege('anon', f.oid, 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', f.oid, 'EXECUTE'),
      'config', coalesce(array_to_string(f.proconfig, ','), '')
    ) order by f.sig collate "C")
    from fns f), '[]'::jsonb)
) as snapshot;
