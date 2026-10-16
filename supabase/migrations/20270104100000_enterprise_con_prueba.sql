-- =============================================================================
-- Todos los planes arrancan con prueba gratis (pedido del dueño): nadie paga al
-- crear la cuenta, el primer cobro es al terminar la prueba. Enterprise tenía
-- trial_days = 0 y el registro lo mandaba a "Pagar y activar" en el alta.
-- =============================================================================
update plans
   set trial_days = 14
 where tenant_id is null
   and key = 'enterprise'
   and coalesce(trial_days, 0) <= 0;
