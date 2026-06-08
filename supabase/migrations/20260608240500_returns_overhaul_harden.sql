-- =============================================================================
-- 20260608240500_returns_overhaul_harden
-- Endurece las funciones del overhaul de devoluciones según el linter de Supabase:
--   1) gen_voucher_code(): fija search_path (no mutable).
--   2) seed_default_return_reasons / seed_return_reasons_on_store: NO deben ser
--      invocables por RPC (authenticated). Son internas: el trigger (definer,
--      owner=postgres) y el backfill las llaman sin necesitar grant a authenticated.
-- =============================================================================

-- 1) search_path estable en el generador de códigos.
create or replace function gen_voucher_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code     text;
  i          int;
begin
  loop
    v_code := 'VAL-';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from store_credit_vouchers where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- 2) Las funciones de seed son internas: revocamos EXECUTE a authenticated para
--    que no queden expuestas como RPC SECURITY DEFINER. El trigger sigue
--    funcionando (corre como owner) y el backfill ya se ejecutó en la migración.
revoke execute on function seed_default_return_reasons(uuid) from authenticated;
revoke execute on function seed_return_reasons_on_store() from authenticated;
