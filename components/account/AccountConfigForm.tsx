"use client";

import { useState } from "react";
import { CalendarClock, Layers, Percent, ShieldAlert, BellRing, Calculator } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { formatCurrency } from "@/lib/utils/format";
import { accountConfigSchema, type AccountConfig } from "@/lib/account/config";
import { dueDateFor, todayIso } from "@/lib/account/terms";
import { interestExample } from "@/lib/account/interest";
import { fmtDate } from "./shared";

const numCls =
  "h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft disabled:opacity-50";

function Num({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  disabled,
  placeholder,
  label,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  label: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className={numCls}
    />
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg bg-muted/30 p-4">
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Icon size={15} className="text-ninja-flameSoft" /> {title}
      </h4>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

const parseList = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365)
    .slice(0, 10);

// Formulario de condiciones de cuenta corriente (negocio u override del
// cliente). Incluye la calculadora de punitorios en vivo.
export function AccountConfigForm({
  value,
  onChange,
  disabled,
  showReminders = true,
}: {
  value: AccountConfig;
  onChange: (v: AccountConfig) => void;
  disabled?: boolean;
  showReminders?: boolean;
}) {
  const [calcAmount, setCalcAmount] = useState(10000);
  const [calcDays, setCalcDays] = useState(45);
  const [before, setBefore] = useState(value.reminders.before_days.join(", "));
  const [after, setAfter] = useState(value.reminders.after_days.join(", "));

  const set = <K extends keyof AccountConfig>(k: K, patch: Partial<AccountConfig[K]>) =>
    onChange({ ...value, [k]: { ...value[k], ...patch } });

  const t = value.terms;
  const i = value.interest;
  const valid = accountConfigSchema.safeParse(value);
  const exampleDue = dueDateFor(todayIso(), t);
  const example = interestExample(calcAmount || 0, calcDays || 0, i);

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <Section icon={CalendarClock} title="Plazos">
        <Row title="Cómo vence una compra a cuenta">
          <Segmented
            value={t.mode}
            onChange={(mode) => set("terms", { mode })}
            options={[
              { value: "days", label: "A días" },
              { value: "monthly_cutoff", label: "Corte mensual" },
            ]}
          />
        </Row>
        {t.mode === "days" ? (
          <Row title="Días para pagar" hint="Vencimiento = fecha de la compra + días.">
            <Num label="Días" value={t.days} min={0} max={365} onChange={(v) => set("terms", { days: v ?? 0 })} />
          </Row>
        ) : (
          <>
            <Row title="Día de corte" hint="Las compras hasta este día vencen el mes siguiente.">
              <Num label="Día de corte" value={t.cutoff_day} min={1} max={31} onChange={(v) => set("terms", { cutoff_day: v ?? 25 })} />
            </Row>
            <Row title="Día de vencimiento" hint="Si el mes es más corto, vence el último día.">
              <Num label="Día de vencimiento" value={t.due_day} min={1} max={31} onChange={(v) => set("terms", { due_day: v ?? 10 })} />
            </Row>
          </>
        )}
        <p className="pt-2 text-xs text-muted-foreground">
          Una compra de hoy vence el <span className="font-semibold text-foreground">{fmtDate(exampleDue)}</span>.
        </p>
      </Section>

      <Section icon={Layers} title="Cuotas">
        <Row title="Permitir vender en cuotas">
          <Switch
            checked={value.installments.enabled}
            onCheckedChange={(enabled) => set("installments", { enabled })}
            label="Permitir cuotas"
          />
        </Row>
        {value.installments.enabled && (
          <>
            <Row title="Máximo de cuotas">
              <Num label="Máximo de cuotas" value={value.installments.max} min={1} max={24} onChange={(v) => set("installments", { max: v ?? 1 })} />
            </Row>
            {t.mode === "days" && (
              <Row title="Días entre cuotas" hint="Con corte mensual, las cuotas vencen mes a mes.">
                <Num label="Días entre cuotas" value={value.installments.interval_days} min={1} max={90} onChange={(v) => set("installments", { interval_days: v ?? 30 })} />
              </Row>
            )}
          </>
        )}
      </Section>

      <Section icon={Percent} title="Punitorios">
        <Row title="Cobrar interés por mora" hint="Se calcula todos los días sobre lo vencido.">
          <Switch checked={i.enabled} onCheckedChange={(enabled) => set("interest", { enabled })} label="Punitorios" />
        </Row>
        {i.enabled && (
          <>
            <Row title="Tasa">
              <Num label="Tasa" value={i.rate_pct} step={0.01} min={0} max={100} onChange={(v) => set("interest", { rate_pct: v ?? 0 })} />
              <span className="text-sm text-muted-foreground">%</span>
              <Segmented
                value={i.period}
                onChange={(period) => set("interest", { period })}
                options={[
                  { value: "monthly", label: "mensual" },
                  { value: "daily", label: "diaria" },
                ]}
              />
            </Row>
            <Row title="Cálculo" hint="Compuesto suma el interés impago a la base.">
              <Segmented
                value={i.method}
                onChange={(method) => set("interest", { method })}
                options={[
                  { value: "simple", label: "Simple" },
                  { value: "compound", label: "Compuesto" },
                ]}
              />
            </Row>
            <Row title="Días de gracia" hint="Después del vencimiento, antes de cobrar interés.">
              <Num label="Días de gracia" value={i.grace_days} min={0} max={90} onChange={(v) => set("interest", { grace_days: v ?? 0 })} />
            </Row>
            <Row title="Tope" hint="Máximo de interés sobre la compra original. Vacío = sin tope.">
              <Num label="Tope" value={i.cap_pct} min={0} max={1000} placeholder="Sin tope" onChange={(v) => set("interest", { cap_pct: v })} />
              <span className="text-sm text-muted-foreground">%</span>
            </Row>
            <Row
              title="Mínimo por liquidación"
              hint={
                i.period === "daily"
                  ? "Con tasa diaria se mide contra el total del mes; montos menores esperan."
                  : "Montos menores esperan a la próxima liquidación."
              }
            >
              <Num label="Mínimo" value={i.min_amount} step={0.01} min={0} onChange={(v) => set("interest", { min_amount: v ?? 0 })} />
            </Row>
            <div className="pt-3">
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-3 text-sm">
                <Calculator size={15} className="text-ninja-flameSoft" />
                <span>Una deuda de</span>
                <Num label="Monto de ejemplo" value={calcAmount} step={100} onChange={(v) => setCalcAmount(v ?? 0)} />
                <span>con</span>
                <Num label="Días de atraso" value={calcDays} onChange={(v) => setCalcDays(v ?? 0)} />
                <span>días de atraso genera</span>
                <span className="font-price font-bold text-foreground">{formatCurrency(example)}</span>
                <span>de punitorio.</span>
              </div>
            </div>
          </>
        )}
      </Section>

      <Section icon={ShieldAlert} title="Bloqueo y autorizaciones">
        <Row title="Bloquear ventas a cuenta con deuda vencida">
          <Switch
            checked={value.blocking.overdue_days !== null}
            onCheckedChange={(on) => set("blocking", { overdue_days: on ? 30 : null })}
            label="Bloqueo por mora"
          />
        </Row>
        {value.blocking.overdue_days !== null && (
          <Row title="Bloquear después de" hint="Días de atraso de la deuda más vieja.">
            <Num label="Días de mora" value={value.blocking.overdue_days} min={0} max={365} onChange={(v) => set("blocking", { overdue_days: v ?? 0 })} />
            <span className="text-sm text-muted-foreground">días</span>
          </Row>
        )}
        <Row
          title="Permitir que un supervisor autorice igual"
          hint="Mora, cuenta bloqueada o límite: el dueño o un encargado con motivo o con su PIN. Queda en la auditoría."
        >
          <Switch
            checked={value.blocking.allow_manager_override}
            onCheckedChange={(allow_manager_override) => set("blocking", { allow_manager_override })}
            label="Autorización de supervisor"
          />
        </Row>
      </Section>

      {showReminders && (
        <Section icon={BellRing} title="Recordatorios por email">
          <Row title="Días antes del vencimiento" hint="Separados por coma. Ej: 3">
            <input
              aria-label="Días antes"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
              onBlur={() => set("reminders", { before_days: parseList(before) })}
              className="h-9 w-32 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
            />
          </Row>
          <Row title="Días después del vencimiento" hint="Separados por coma. Ej: 1, 7, 15">
            <input
              aria-label="Días después"
              value={after}
              onChange={(e) => setAfter(e.target.value)}
              onBlur={() => set("reminders", { after_days: parseList(after) })}
              className="h-9 w-32 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
            />
          </Row>
          <p className="pt-2 text-xs text-muted-foreground">
            Se envían con el email de tu negocio (Configuración, sección Email) a los clientes con email cargado.
          </p>
        </Section>
      )}

      {!valid.success && (
        <p className="rounded-lg bg-red-400/10 px-3 py-2 text-sm text-danger">
          Hay valores fuera de rango: revisá los números.
        </p>
      )}
    </fieldset>
  );
}

export function isConfigValid(c: AccountConfig): boolean {
  return accountConfigSchema.safeParse(c).success;
}
