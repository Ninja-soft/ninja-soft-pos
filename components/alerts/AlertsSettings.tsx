"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BellRing, History, Mail, Play, Plus, Trash2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { AlertItemsList } from "@/components/alerts/AlertItemsList";
import {
  ALERT_CATALOG,
  ALERT_GROUPS,
  ALERT_KINDS,
  FREQUENCY_LABEL,
  ROLE_LABEL,
  WEEKDAY_SHORT,
  alertErrorMessage,
  defaultParams,
  scheduleLabel,
  validateParams,
  type AlertFrequency,
  type AlertKind,
  type AlertRole,
} from "@/lib/alerts/catalog";
import {
  useAlertMutations,
  useAlertsOverview,
  type AlertItem,
  type AlertRule,
  type AlertRuleInput,
  type AlertsOverview,
} from "@/modules/alerts/api";
import { cn } from "@/lib/utils/cn";

const SEVERITY_TONE: Record<string, BadgeTone> = { info: "info", warning: "warning", critical: "danger" };
const SEVERITY_LABEL: Record<string, string> = { info: "Informativa", warning: "Importante", critical: "Urgente" };
const ROLES: AlertRole[] = ["owner", "manager", "cashier", "viewer"];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

const fmtWhen = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

function inputFromRule(rule: AlertRule): AlertRuleInput {
  return {
    id: rule.id,
    kind: rule.kind,
    enabled: rule.enabled,
    params: { ...defaultParams(rule.kind), ...rule.params },
    frequency: rule.frequency,
    hour: rule.hour,
    weekdays: rule.weekdays ?? [],
    store_id: rule.store_id,
    channels: { bell: rule.channels?.bell !== false, email: rule.channels?.email === true },
    audience_roles: rule.audience_roles ?? [],
    audience_user_ids: rule.audience_user_ids ?? [],
    only_new: rule.only_new,
  };
}

function newInput(kind: AlertKind, storeId: string | null): AlertRuleInput {
  const def = ALERT_CATALOG[kind];
  return {
    id: null,
    kind,
    enabled: true,
    params: defaultParams(kind),
    frequency: def.frequency,
    hour: def.hour,
    weekdays: def.weekdays.length ? [...def.weekdays] : [1, 2, 3, 4, 5],
    store_id: storeId,
    channels: { bell: true, email: false },
    audience_roles: ["owner", "manager"],
    audience_user_ids: [],
    only_new: true,
  };
}

// Configuración › Alertas (F24 · H162, ADR-176). Una tarjeta por tipo del
// catálogo; cada una puede tener una regla para todo el negocio y otras por
// sucursal. El servidor valida todo y es el único que evalúa.
export function AlertsSettings() {
  const overview = useAlertsOverview();
  const [editing, setEditing] = useState<AlertRuleInput | null>(null);

  if (overview.isLoading) return <SpinnerBlock className="py-16" />;
  if (overview.error || !overview.data) {
    return (
      <Callout tone="warning" icon={BellRing} title="No se pudieron cargar las alertas">
        {alertErrorMessage(overview.error)}
      </Callout>
    );
  }
  const data = overview.data;

  return (
    <div className="space-y-6">
      <Callout
        tone="brand"
        icon={BellRing}
        actions={
          <Link href="/alertas" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <History size={15} aria-hidden /> Ver historial
          </Link>
        }
      >
        Cada alerta revisa sola tus datos con la frecuencia que elijas (hora de Argentina) y avisa por la campana o con un
        resumen por mail. Con <b>sólo casos nuevos</b> no te repite lo que ya te avisó.
      </Callout>
      {!data.can_edit && (
        <Callout tone="neutral">Podés ver las alertas; las configura el dueño o quien edita la configuración.</Callout>
      )}
      {ALERT_GROUPS.map((group) => {
        const kinds = ALERT_KINDS.filter((k) => ALERT_CATALOG[k].group === group);
        return (
          <section key={group} className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground">{group}</h3>
            {kinds.map((kind) => (
              <KindCard
                key={kind}
                kind={kind}
                data={data}
                editing={editing?.kind === kind ? editing : null}
                onEdit={setEditing}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
AlertsSettings.displayName = "AlertsSettings";

function KindCard({
  kind,
  data,
  editing,
  onEdit,
}: {
  kind: AlertKind;
  data: AlertsOverview;
  editing: AlertRuleInput | null;
  onEdit: (v: AlertRuleInput | null) => void;
}) {
  const def = ALERT_CATALOG[kind];
  const { toast } = useToast();
  const m = useAlertMutations();
  const rules = data.rules.filter((r) => r.kind === kind);
  const storeName = (id: string | null) =>
    id ? (data.stores.find((s) => s.id === id)?.name ?? "Sucursal") : "Todo el negocio";
  // Primer alcance libre (todo el negocio o una sucursal) para "Otra sucursal".
  const freeStore =
    data.stores.length > 1
      ? ([null, ...data.stores.map((s) => s.id)] as (string | null)[]).find(
          (id) => !rules.some((r) => (r.store_id ?? null) === id),
        )
      : undefined;

  async function toggle(rule: AlertRule) {
    try {
      await m.save.mutateAsync({ ...inputFromRule(rule), enabled: !rule.enabled });
      toast({ title: rule.enabled ? "Alerta apagada" : "Alerta encendida", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: alertErrorMessage(e), variant: "error" });
    }
  }

  return (
    <SettingsCard padded>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {def.label}
            <Badge tone={SEVERITY_TONE[def.severity]}>{SEVERITY_LABEL[def.severity]}</Badge>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{def.description}</p>
        </div>
        {rules.length === 0 && data.can_edit && !editing && (
          <Switch
            checked={false}
            label={`Encender ${def.label}`}
            onCheckedChange={() => onEdit(newInput(kind, null))}
          />
        )}
      </div>

      {rules.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-lg bg-muted/40">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {storeName(r.store_id)}
                  {r.enabled ? <Badge tone="success">Encendida</Badge> : <Badge>Apagada</Badge>}
                  {r.channels?.email && (
                    <Badge tone="neutral">
                      <Mail size={12} aria-hidden /> Mail
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {scheduleLabel(r.frequency, r.hour, r.weekdays ?? [])}
                  {r.only_new ? " · sólo casos nuevos" : ""}
                  {r.last_run_at ? ` · última: ${fmtWhen(r.last_run_at)}, ${r.last_hits ?? 0} casos` : " · todavía no corrió"}
                  {r.last_error ? " · falló la última corrida" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {r.last_event && (
                  <Link href={`/alertas?regla=${r.id}`} className="text-xs font-medium text-muted-foreground hover:underline">
                    Historial
                  </Link>
                )}
                {data.can_edit && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(inputFromRule(r))}>
                      Configurar
                    </Button>
                    <Switch checked={r.enabled} label={`Encender ${def.label}`} onCheckedChange={() => toggle(r)} />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.can_edit && !editing && rules.length > 0 && freeStore !== undefined && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => onEdit(newInput(kind, freeStore))}>
          <Plus size={15} aria-hidden /> Otra sucursal
        </Button>
      )}

      {editing && <RuleEditor value={editing} data={data} onClose={() => onEdit(null)} />}
    </SettingsCard>
  );
}

function RuleEditor({
  value,
  data,
  onClose,
}: {
  value: AlertRuleInput;
  data: AlertsOverview;
  onClose: () => void;
}) {
  const def = ALERT_CATALOG[value.kind];
  const { toast } = useToast();
  const m = useAlertMutations();
  const [form, setForm] = useState<AlertRuleInput>(value);
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(value.params).map(([k, v]) => [k, String(v)])),
  );
  const [test, setTest] = useState<{ hits: number; items: AlertItem[] } | null>(null);

  const params = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = v.trim() === "" ? Number.NaN : Number(v.replace(",", "."));
    return out;
  }, [raw]);
  const paramErrors = validateParams(form.kind, params);
  const needsDays = form.frequency === "weekly" && form.weekdays.length === 0;
  const needsAudience =
    (form.channels.bell || form.channels.email) && form.audience_roles.length === 0 && form.audience_user_ids.length === 0;
  const invalid = Object.keys(paramErrors).length > 0 || needsDays || needsAudience;

  const set = <K extends keyof AlertRuleInput>(k: K, v: AlertRuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  async function save() {
    try {
      await m.save.mutateAsync({ ...form, params });
      toast({ title: form.id ? "Alerta guardada" : "Alerta encendida", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: alertErrorMessage(e), variant: "error" });
    }
  }

  async function remove() {
    if (!form.id) return;
    try {
      await m.remove.mutateAsync(form.id);
      toast({ title: "Alerta borrada", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo borrar", description: alertErrorMessage(e), variant: "error" });
    }
  }

  async function runTest() {
    try {
      setTest(await m.test.mutateAsync({ kind: form.kind, params, storeId: form.store_id }));
    } catch (e) {
      toast({ title: "No se pudo probar", description: alertErrorMessage(e), variant: "error" });
    }
  }

  const paramEntries = Object.entries(def.params);

  return (
    <div className="mt-4 space-y-5 border-t border-border pt-4">
      {paramEntries.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {paramEntries.map(([k, p]) => (
            <Input
              key={k}
              type="number"
              inputMode="decimal"
              min={p.min}
              max={p.max}
              label={`${p.label} (${p.unit})`}
              value={raw[k] ?? ""}
              onChange={(e) => setRaw((r) => ({ ...r, [k]: e.target.value }))}
              error={paramErrors[k]}
              hint={p.hint}
            />
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select<AlertFrequency>
          label="Cada cuánto"
          value={form.frequency}
          onChange={(v) => set("frequency", v)}
          options={(["hourly", "daily", "weekly"] as AlertFrequency[]).map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
        />
        {form.frequency !== "hourly" && (
          <Select<string>
            label="A qué hora (Argentina)"
            value={String(form.hour)}
            onChange={(v) => set("hour", Number(v))}
            options={HOURS}
          />
        )}
      </div>

      {form.frequency === "weekly" && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Qué días</p>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={form.weekdays.includes(d)}
                onClick={() => set("weekdays", toggleIn(form.weekdays, d))}
                className={cn(
                  "h-9 min-w-[3rem] rounded-md px-3 text-sm font-medium transition-colors",
                  form.weekdays.includes(d) ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {WEEKDAY_SHORT[d]}
              </button>
            ))}
          </div>
          {needsDays && <p className="mt-1 text-xs text-danger">Elegí al menos un día.</p>}
        </div>
      )}

      {data.stores.length > 1 && (
        <Select<string>
          label="Sucursal"
          value={form.store_id ?? "all"}
          onChange={(v) => set("store_id", v === "all" ? null : v)}
          options={[{ value: "all", label: "Todo el negocio" }, ...data.stores.map((s) => ({ value: s.id, label: s.name }))]}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Por dónde avisa</p>
          <label className="flex items-center gap-2.5 py-1.5 text-sm">
            <Checkbox checked={form.channels.bell} onCheckedChange={(v) => set("channels", { ...form.channels, bell: v })} />
            Campana de NinjaPos
          </label>
          <label className="flex items-center gap-2.5 py-1.5 text-sm">
            <Checkbox checked={form.channels.email} onCheckedChange={(v) => set("channels", { ...form.channels, email: v })} />
            Resumen por mail
          </label>
          {form.channels.email && (
            <p className="mt-1 text-xs text-muted-foreground">
              Sale con el email del negocio (Configuración › Email). WhatsApp, más adelante.
            </p>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">A quién</p>
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2.5 py-1.5 text-sm">
              <Checkbox
                checked={form.audience_roles.includes(r)}
                onCheckedChange={() => set("audience_roles", toggleIn(form.audience_roles, r))}
              />
              {ROLE_LABEL[r]}
            </label>
          ))}
          {data.members.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                Personas{form.audience_user_ids.length ? ` (${form.audience_user_ids.length})` : ""}
              </summary>
              <div className="mt-1 max-h-48 overflow-y-auto">
                {data.members.map((p) => (
                  <label key={p.user_id} className="flex items-center gap-2.5 py-1.5 text-sm">
                    <Checkbox
                      checked={form.audience_user_ids.includes(p.user_id)}
                      onCheckedChange={() => set("audience_user_ids", toggleIn(form.audience_user_ids, p.user_id))}
                    />
                    <span className="truncate">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{ROLE_LABEL[p.role]}</span>
                  </label>
                ))}
              </div>
            </details>
          )}
          {needsAudience && <p className="mt-1 text-xs text-danger">Elegí algún rol o alguna persona.</p>}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="text-sm">
          <p className="font-medium">Sólo casos nuevos</p>
          <p className="text-xs text-muted-foreground">No repite lo que ya avisó mientras siga igual.</p>
        </div>
        <Switch checked={form.only_new} label="Sólo casos nuevos" onCheckedChange={(v) => set("only_new", v)} />
      </div>

      {test && (
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-sm font-semibold">
            Hoy daría {test.hits} {test.hits === 1 ? def.noun[0] : def.noun[1]}
          </p>
          <AlertItemsList items={test.items} total={test.hits} empty="Nada para avisar con estos umbrales." />
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          {form.id && (
            <Button variant="ghost" size="sm" onClick={remove} loading={m.remove.isPending}>
              <Trash2 size={15} aria-hidden /> Borrar
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={runTest} loading={m.test.isPending} disabled={Object.keys(paramErrors).length > 0}>
            <Play size={15} aria-hidden /> Probar ahora
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="sm" onClick={save} loading={m.save.isPending} disabled={invalid}>
            Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}
