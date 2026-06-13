-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Tipos de promoción: NxM (2x1, 3x2…) y precio fijo (combo/pack)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Suma dos action_type al motor de promociones (H53): 'nxm' (lleva N, paga M) y
-- 'fixed_price' (el alcance pasa a costar un precio fijo). NxM necesita N (buy_qty)
-- y M (pay_qty); fixed_price reusa action_value como el precio. ADITIVO sobre la
-- tabla `promotions`: columnas nuevas nullable + el CHECK de action_type extendido.

alter table promotions add column if not exists buy_qty int;
alter table promotions add column if not exists pay_qty int;

-- Permitir los nuevos tipos.
alter table promotions drop constraint if exists promotions_action_type_check;
alter table promotions
  add constraint promotions_action_type_check
  check (action_type in ('percent','amount','nxm','fixed_price'));

-- Coherencia de NxM: N (lleva) > M (paga) ≥ 1; sólo para action_type = 'nxm'.
alter table promotions drop constraint if exists promotions_nxm_check;
alter table promotions
  add constraint promotions_nxm_check
  check (
    action_type <> 'nxm'
    or (buy_qty is not null and pay_qty is not null and pay_qty >= 1 and buy_qty > pay_qty)
  );

comment on column promotions.buy_qty is 'NxM: N (lleva). null fuera de action_type=nxm.';
comment on column promotions.pay_qty is 'NxM: M (paga). null fuera de action_type=nxm.';
