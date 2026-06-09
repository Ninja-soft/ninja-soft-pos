-- =============================================================================
-- 20260608640000_perf_appointments_rls_initplan  (PERF — RLS initplan)
--
-- La policy appointments_staff_own_select (creada en H38/agenda) usa auth.uid()
-- SIN envolver en subquery, así que Postgres la re-evalúa POR FILA. El resto del
-- proyecto ya migró a (select auth.uid()) en 20260604121000_perf_rls_initplan
-- para que el planner la evalúe UNA vez (InitPlan). La agenda se saltó esa
-- convención. Esta migración recrea la policy idéntica en semántica, sólo
-- envolviendo los dos auth.uid() en (select auth.uid()). current_tenant_id() es
-- STABLE y no necesita envoltura. Sin cambios de comportamiento.
-- =============================================================================

drop policy if exists appointments_staff_own_select on appointments;

create policy appointments_staff_own_select on appointments
  for select
  to authenticated
  using (
    -- Si el negocio NO restringe "cada staff ve solo lo suyo", todos ven todo.
    (not coalesce((
      select ps.staff_sees_own_only
      from pos_settings ps
      where ps.tenant_id = current_tenant_id()
    ), false))
    -- El owner siempre ve todos los turnos del tenant.
    or (exists (
      select 1
      from tenant_users tu
      where tu.tenant_id = current_tenant_id()
        and tu.user_id = (select auth.uid())
        and tu.status = 'active'
        and tu.role = 'owner'
    ))
    -- Turnos sin profesional asignado: visibles para el staff.
    or (professional_id is null)
    -- El profesional ve sus propios turnos.
    or (exists (
      select 1
      from professionals pr
      where pr.id = appointments.professional_id
        and pr.tenant_id = current_tenant_id()
        and pr.user_id = (select auth.uid())
    ))
  );
