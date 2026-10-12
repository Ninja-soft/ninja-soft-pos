# Cuenta corriente v2 (robusta) — spec

Pedido del dueño: "cuenta corriente hacelo robusto, que pueda configurarse diferentes fechas, cálculo de punitorios, gestión de cobranza etc". Estado actual: ver `cuenta-corriente-estado.md` (mismo directorio).

## Objetivos
1. Plazos configurables (negocio, grupo/cliente, venta) y cuotas.
2. Punitorios configurables y auditables.
3. Cobranza: cobros correctos (medio, caja, recibo, imputación), estado de cuenta, aging por vencimiento, recordatorios, promesas de pago, notas y tareas, bloqueo por mora.
4. Corrección de datos: anulación/devolución revierte deuda; límite sin carrera; todo cambio crítico en `audit_logs`; gating server-side.

## Features de plan (convención CLAUDE.md, 5 pasos)
| key | categoría | requires | qué cubre |
|---|---|---|---|
| `cuenta_corriente` (existe) | OPTIONAL | | ventas a cuenta, plazos, cuotas, cobros, estado de cuenta, aging, bloqueo por mora/límite |
| `cc_punitorios` (nueva) | OPTIONAL | cuenta_corriente | cálculo y devengo de punitorios, condonación |
| `cc_cobranza` (nueva) | OPTIONAL | cuenta_corriente | recordatorios automáticos, promesas de pago, tareas/notas, asignar cobrador |
Plan: mismas que `cuenta_corriente` (Business+) salvo análisis distinto; `featureInfo` con `requires: ["cuenta_corriente"]`. Gating real con `tenant_has_feature_for` en RPCs, triggers y cron.

## Configuración
`pos_settings.account_config jsonb` (negocio) y `customers.account_config jsonb` (override por cliente; null = hereda). Esquema (Zod + check en SQL):
```
{
  terms: { mode: "days" | "monthly_cutoff", days: 30, cutoff_day: 25, due_day: 10 },
  installments: { enabled: false, max: 6, interval_days: 30 },
  interest: { enabled: false, rate_pct: 3, period: "monthly" | "daily", method: "simple" | "compound",
              grace_days: 5, cap_pct: 50, min_amount: 0 },
  blocking: { overdue_days: 30 | null, allow_manager_override: true },
  reminders: { before_days: [3], after_days: [1, 7, 15], channel: "email" }
}
```
- days: vencimiento = fecha venta + days.
- monthly_cutoff: compras hasta `cutoff_day` vencen el `due_day` del mes siguiente; después del corte, al otro mes.
- `account_due_days` actual se migra a `terms.days`.

## Modelo de datos (migración nueva, no editar las aplicadas)
- `customer_account_movements` agrega: `kind` (`charge|payment|interest|interest_waiver|adjust_debit|adjust_credit|reversal`, backfill por signo/razón), `installment_no int`, `installments int`, `parent_id uuid` (interés/condonación/reversa → cargo), `method text` (en pagos), `cash_shift_id uuid`, `receipt_no bigint` (correlativo por tenant con advisory lock), `idempotency_key text` (único por tenant), `note text`, `period date` (interés), `voided_at`. Check de signo coherente con `kind`.
- `customer_account_allocations(id, tenant_id, payment_id, charge_id, amount)` con RLS.
- `customers`: `account_config jsonb`, `credit_status text` (`ok|watch|blocked`, manual o calculado), `collector_user_id uuid`.
- `account_collection_items(id, tenant_id, customer_id, type: note|promise|task|reminder_log, body, promise_date, promise_amount, status, due_at, assignee, done_at, created_by, created_at)` con RLS.
- RLS: escrituras SOLO vía RPCs security definer (revocar insert directo al ledger; el cobro actual por insert directo pasa a RPC).

## RPCs / triggers (security definer, chequeo de tenant y rol, audit_logs, gating)
- `payment_account_charge` (reemplazo): `select ... for update` del cliente (fin de la carrera); calcula vencimiento(s) según config efectiva; si la venta va en N cuotas, N cargos con `installment_no`; bloquea con `account_overdue_blocked` si hay deuda vencida > `blocking.overdue_days` (override sólo con rol manager y motivo → audit).
- `account_collect(customer_id, amount, method, allocations jsonb|null, idempotency_key, note)`: valida rol (cajero con caja abierta o owner/manager), imputa (por defecto: interés más viejo primero, luego cargos por vencimiento FIFO; o la imputación elegida), registra movimiento `payment` + allocations, impacta en la caja abierta (mismo mecanismo que los movimientos de caja existentes: buscá la tabla de movimientos de caja) para que entre en el Z, genera `receipt_no`, audit. Idempotente.
- `account_accrue_interest(as_of date default current_date)`: por tenant con `cc_punitorios` e interés habilitado, por cada cargo vencido + gracia con saldo, devenga un movimiento `interest` por período (único por `(parent_id, period)`), respeta `method` simple/compuesto y `cap_pct` sobre el capital original. Cron diario (pg_cron) llamándola.
- `account_waive_interest(movement_id, amount, reason)` y `account_adjust(customer_id, kind, amount, reason)`: owner/manager, audit.
- `account_statement(customer_id, from, to)`: saldo inicial, movimientos con saldo corrido, vencidos, intereses, próximos vencimientos.
- `account_aging(as_of)`: server-side por `due_date` (no vence / 1-30 / 31-60 / 61-90 / 90+), por cliente, totales; reemplaza el cálculo en el cliente.
- Reversa: anular venta (`fn_void_sale`), devolución (`returns_overhaul`) y cambio (`exchange_sale`) crean `reversal` por lo que corresponde de cargos de cuenta (sin tocar migraciones aplicadas: triggers nuevos o redefinición en migración nueva).
- `payment_method_plan_key('account')` → `cuenta_corriente` (gating también en el trigger de payments).

## Lógica pura (TDD, `lib/account/*`, espejo del SQL)
`terms.ts` (vencimientos días/corte, cuotas), `interest.ts` (simple/compuesto, diario/mensual, gracia, tope, mínimo), `allocation.ts` (imputación por defecto y elegida), `aging.ts`. Tests con casos fijos; los mismos casos documentados en comentarios del SQL.

## Cobranza automática
Edge Function `account_reminders` (cron diario): por tenant con `cc_cobranza`, arma recordatorios antes/después del vencimiento y estado de cuenta, envía por el email del negocio (infra existente de envío del tenant, ver `send_receipt_email` / tenant SMTP/Resend) con plantilla nueva (`account_reminder`, `account_statement`) en el diseño de emails del POS, registra `reminder_log`. Botón "Enviar estado de cuenta" manual. WhatsApp: link `wa.me` con texto prellenado (sin API).

## UI (español, voseo; reglas: sin "—", NoData, sin alert/confirm, spinners, relleno no bordes de color, mobile-first)
- `/clientes/cuentas`: tablero de cobranza (KPIs: total a cobrar, vencido, a vencer 7 días, punitorios del mes; aging ECharts; lista priorizada por mora con acciones rápidas cobrar / recordar / WhatsApp / promesa).
- Ficha de cuenta del cliente (modal o página): estado de cuenta con saldo corrido, filtros, export PDF/XLSX, cobrar con imputación (FIFO por defecto o elegir cargos), condonar interés, ajustes, promesas, notas, tareas, configuración propia (override).
- Configuración (`OperationSettingsCard` o card nueva "Cuenta corriente"): plazos, cuotas, punitorios con calculadora de ejemplo en vivo, bloqueo, recordatorios.
- POS: al elegir cuenta corriente mostrar saldo, límite disponible, vencidos y elegir cuotas si está habilitado; mensaje claro si está bloqueado (override de gerente inline).
- Usar ECharts para gráficos.

## Addendum v2b (decisiones del dueño)
- **PIN de supervisor**: dueños/encargados cargan un PIN (4 a 6 dígitos, hash bcrypt, RLS deny-all). El cajero pide autorización desde el POS eligiendo supervisor + PIN + motivo; `account_authorize_override` limita intentos (5 cada 15 min, bloqueo 15 min), audita y entrega un token de un solo uso (5 min, mismo cliente, mismo cajero, monto <= autorizado) que consume `payment_account_charge`. Cubre mora, cuenta bloqueada y límite. Sigue el override por sesión de dueño/encargado.
- **Punitorio diario**: un movimiento por cargo y mes calendario, upsert idempotente por `(parent_id, period)` con `accrued_through`.
- **Grupos**: editor de condiciones por grupo con badge de herencia y vista previa (`account_set_group_config`).
- **Emails**: vista previa de `account_reminder` y `account_statement` en `/internal/emails`.
- Migración `20261011200300_cuenta_corriente_v2_pin_supervisor.sql`.

## Docs
ADR nuevo "Cuenta corriente v2", roadmap H31/F5 actualizado, `docs/21-retail-advanced-settings.md` §7, CHANGELOG, `featureInfo` (desc/impact/minPlan/requires), `planComparison` derivado.
