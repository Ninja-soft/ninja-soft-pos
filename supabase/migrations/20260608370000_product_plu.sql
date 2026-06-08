-- =============================================================================
-- 20260608370000_product_plu
-- PLU de producto: código corto de 6 dígitos para tipear rápido en el POS.
--
-- El setting ya existe (pos_settings.plu_enabled / plu_mode, modos
-- 'random'|'incremental'). Acá se implementa la GENERACIÓN y el almacenamiento:
--   * products.plu (text, 6 dígitos) ÚNICO por tenant (índice parcial).
--   * next_product_plu(tenant, mode): genera el próximo PLU sin colisión.
--       - 'random': 6 dígitos al azar (100000..999999), reintenta ante choque.
--       - 'incremental': max(plu)+1 correlativo de 6 dígitos (arranca 100000).
--     Serializa por tenant con advisory lock transaccional para evitar carreras.
--   * Trigger BEFORE INSERT en products: si NEW.plu es null y el tenant tiene el
--     PLU habilitado, asigna el PLU automáticamente. Cubre cualquier vía de alta
--     (form, import, RPC). Si el usuario tipeó un PLU, se respeta (lo valida la
--     UI a 6 dígitos; la unicidad la garantiza el índice).
--   * pos_settings.plu_prompted: marca si al tenant ya se le preguntó por el PLU
--     (al cargar su primer producto) para no volver a preguntar.
--
-- Conservador: si el PLU está deshabilitado, no se asigna nada y nada cambia.
-- No regresiona el alta de productos existente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columna + unicidad por tenant (solo filas vivas con plu cargado).
-- -----------------------------------------------------------------------------
alter table products add column if not exists plu text;

create unique index if not exists products_tenant_plu_idx
  on products(tenant_id, plu)
  where plu is not null and deleted_at is null;

-- "Ya se preguntó por el PLU" (prompt del primer producto). Default false.
alter table pos_settings
  add column if not exists plu_prompted boolean not null default false;

-- -----------------------------------------------------------------------------
-- next_product_plu(tenant, mode) -> text (6 dígitos), único por tenant.
-- SECURITY DEFINER: necesita ver todos los PLU del tenant aunque el caller sea
-- un trigger; el alcance se acota por p_tenant. search_path fijo (hardening).
-- -----------------------------------------------------------------------------
create or replace function public.next_product_plu(p_tenant uuid, p_mode text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate text;
  v_max       int;
  v_tries     int := 0;
begin
  if p_tenant is null then
    raise exception 'no_tenant';
  end if;

  -- Serializa la asignación de PLU por tenant dentro de la transacción: dos
  -- altas concurrentes del mismo tenant no eligen el mismo número.
  perform pg_advisory_xact_lock(hashtext('product_plu:' || p_tenant::text));

  if p_mode = 'incremental' then
    -- Mayor PLU numérico de 6 dígitos del tenant (vivos), + 1. Arranca en 100000.
    select max(plu::int) into v_max
    from products
    where tenant_id = p_tenant
      and deleted_at is null
      and plu ~ '^[0-9]{6}$';

    v_candidate := lpad((coalesce(v_max, 99999) + 1)::text, 6, '0');

    -- Si el correlativo se pasó de 6 dígitos o (raro) ya existe, cae a random.
    if length(v_candidate) > 6 or exists (
      select 1 from products
      where tenant_id = p_tenant and deleted_at is null and plu = v_candidate
    ) then
      p_mode := 'random';
    else
      return v_candidate;
    end if;
  end if;

  -- random (modo por defecto y fallback del incremental).
  loop
    v_tries := v_tries + 1;
    -- 100000..999999 (siempre 6 dígitos).
    v_candidate := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    exit when not exists (
      select 1 from products
      where tenant_id = p_tenant and deleted_at is null and plu = v_candidate
    );
    if v_tries >= 50 then
      -- Espacio casi lleno: barre buscando el primer hueco de forma determinista.
      select g.n::text into v_candidate
      from generate_series(100000, 999999) as g(n)
      where not exists (
        select 1 from products
        where tenant_id = p_tenant and deleted_at is null
          and plu = lpad(g.n::text, 6, '0')
      )
      order by g.n
      limit 1;
      if v_candidate is null then
        raise exception 'plu_space_exhausted';
      end if;
      return lpad(v_candidate, 6, '0');
    end if;
  end loop;

  return v_candidate;
end;
$$;

-- Trigger-only: que no se pueda invocar desde el API público.
revoke execute on function public.next_product_plu(uuid, text) from anon, authenticated, public;

-- -----------------------------------------------------------------------------
-- Trigger BEFORE INSERT: asigna PLU si el tenant lo tiene habilitado y la fila
-- viene sin plu. SECURITY DEFINER para leer pos_settings de forma confiable.
-- -----------------------------------------------------------------------------
create or replace function public.set_product_plu()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_mode    text;
begin
  -- Respeta un PLU tipeado manualmente.
  if new.plu is not null and btrim(new.plu) <> '' then
    return new;
  end if;
  new.plu := null;

  if new.tenant_id is null then
    return new;
  end if;

  select ps.plu_enabled, ps.plu_mode
    into v_enabled, v_mode
  from pos_settings ps
  where ps.tenant_id = new.tenant_id;

  if coalesce(v_enabled, false) then
    new.plu := next_product_plu(new.tenant_id, coalesce(v_mode, 'random'));
  end if;

  return new;
end;
$$;

revoke execute on function public.set_product_plu() from anon, authenticated, public;

drop trigger if exists set_product_plu on products;
create trigger set_product_plu
  before insert on products
  for each row execute function set_product_plu();
