"use client";

// Agenda editable de la sincronización automática del catálogo (ADR-113):
// activar/desactivar, frecuencia (diaria, semanal con días, cada N días o
// cron avanzado), hora Argentina, tipo de corrida automática y "una completa
// cada K corridas". Guarda con internal_catalog_sync_config_save (auditada);
// el job de cada minuto (catalog_sync_tick) aplica la agenda sin reprogramar
// pg_cron.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Save } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { Callout } from "@/components/ui/Callout";
import { headerActionsRow } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { useCatalogSyncConfig, useSaveCatalogSyncConfig } from "@/modules/internal/catalogsHooks";
import {
  describeSchedule,
  FULL_EVERY_MAX,
  FULL_EVERY_MIN,
  INTERVAL_MAX,
  INTERVAL_MIN,
  nextRunIsFull,
  nextScheduledRun,
  toConfigPayload,
  utcCronEquivalent,
  validateSyncConfig,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  type SyncFrequency,
  type SyncRunKind,
  type SyncScheduleConfig,
} from "@/modules/internal/catalogSyncSchedule";

const FREQUENCIES: { value: SyncFrequency; label: string }[] = [
  { value: "daily", label: "Diaria" },
  { value: "weekly", label: "Semanal" },
  { value: "interval", label: "Cada N días" },
  { value: "cron", label: "Cron avanzado" },
];

const KINDS: { value: SyncRunKind; label: string }[] = [
  { value: "incremental", label: "Sólo cambios" },
  { value: "full", label: "Lectura completa" },
];

// Mensajes de la RPC (raise exception) en castellano.
const SERVER_ERRORS: Record<string, string> = {
  forbidden: "Sólo un admin o super admin del panel interno puede cambiar la agenda.",
  invalid_hour: "La hora no es válida.",
  invalid_weekdays: "Elegí al menos un día.",
  invalid_interval: "La cantidad de días no es válida.",
  invalid_cron: "La expresión cron no es válida.",
  invalid_full_every: "La cantidad de corridas no es válida.",
};

const pad = (n: number) => String(n).padStart(2, "0");

const fmtDateAr = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleString("es-AR", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Argentina/Buenos_Aires",
      })
    : "";

function serverMessage(e: unknown): string | undefined {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e ? String((e as { message?: unknown }).message) : "";
  const key = Object.keys(SERVER_ERRORS).find((k) => msg.includes(k));
  return key ? SERVER_ERRORS[key] : msg || undefined;
}

export function CatalogSyncScheduleCard() {
  const { toast } = useToast();
  const { data: saved, isLoading, error } = useCatalogSyncConfig();
  const save = useSaveCatalogSyncConfig();
  const [draft, setDraft] = useState<SyncScheduleConfig | null>(null);

  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const errors = useMemo(() => (draft ? validateSyncConfig(draft) : {}), [draft]);
  const hasErrors = Object.keys(errors).length > 0;
  const dirty =
    !!draft && !!saved && JSON.stringify(toConfigPayload(draft)) !== JSON.stringify(toConfigPayload(saved));

  // La próxima se calcula con lo que está en pantalla (vista previa) y se
  // refresca cada minuto.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (isLoading || !draft) {
    return (
      <Card className="min-w-0">
        <CardContent className="p-5">
          {error ? (
            <Callout tone="danger" icon={AlertTriangle}>
              No se pudo leer la agenda de la sincronización.
            </Callout>
          ) : (
            <SpinnerBlock className="py-2" />
          )}
        </CardContent>
      </Card>
    );
  }

  const set = (patch: Partial<SyncScheduleConfig>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const toggleDay = (day: number) =>
    set({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((d) => d !== day)
        : [...draft.weekdays, day].sort((a, b) => a - b),
    });

  const next = hasErrors ? null : nextScheduledRun(draft, now);
  const utc = utcCronEquivalent(draft);

  async function onSave() {
    if (!draft || hasErrors) return;
    try {
      await save.mutateAsync(draft);
      toast({ title: "Agenda guardada", description: describeSchedule(draft), variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar la agenda", description: serverMessage(e), variant: "error" });
    }
  }

  return (
    <Card className="min-w-0">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground">Sincronización automática</p>
            <p className="text-xs text-muted-foreground">
              {draft.enabled ? "Corre sola según esta agenda." : "Apagada: sólo corre cuando la disparás a mano."}
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            label="Activar la sincronización automática"
          />
        </div>

        <fieldset disabled={!draft.enabled} className={cn("min-w-0 space-y-5", !draft.enabled && "opacity-60")}>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Frecuencia</p>
            <Segmented
              value={draft.frequency}
              options={FREQUENCIES}
              onChange={(v) => set({ frequency: v, intervalDays: v === "interval" ? draft.intervalDays ?? 2 : draft.intervalDays })}
              size="sm"
              scrollOnMobile
              aria-label="Frecuencia"
            />
          </div>

          {draft.frequency === "weekly" && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Días</p>
              <div className={headerActionsRow} role="group" aria-label="Días de la semana">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const on = draft.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      title={WEEKDAY_LABELS[d]}
                      onClick={() => toggleDay(d)}
                      className={cn(
                        "h-9 min-w-[2.75rem] rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on
                          ? "bg-[var(--pos-solid)] text-white"
                          : "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/70",
                      )}
                    >
                      {WEEKDAY_SHORT[d]}
                    </button>
                  );
                })}
              </div>
              {errors.weekdays && <p className="text-xs text-danger">{errors.weekdays}</p>}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {draft.frequency === "interval" && (
              <Input
                label="Cada cuántos días"
                type="number"
                inputMode="numeric"
                min={INTERVAL_MIN}
                max={INTERVAL_MAX}
                value={draft.intervalDays ?? ""}
                onChange={(e) => set({ intervalDays: e.target.value === "" ? null : Number(e.target.value) })}
                error={errors.intervalDays}
                hint="Se cuenta desde el día en que guardás."
              />
            )}
            {draft.frequency === "cron" ? (
              <Input
                label="Expresión cron (hora Argentina)"
                value={draft.cronExpr ?? ""}
                onChange={(e) => set({ cronExpr: e.target.value })}
                placeholder="0 6 * * 6"
                className="font-mono"
                spellCheck={false}
                error={errors.cronExpr}
                hint="minuto hora día mes día-de-la-semana. Ej.: 30 5 * * 1-5 (lunes a viernes 05:30)."
              />
            ) : (
              <Input
                label="Hora (Argentina)"
                type="time"
                step={60}
                value={`${pad(draft.hour)}:${pad(draft.minute)}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map((x) => Number(x));
                  set({ hour: Number.isFinite(h) ? h : -1, minute: Number.isFinite(m) ? m : -1 });
                }}
                error={errors.hour}
              />
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Tipo de corrida automática</p>
            <Segmented
              value={draft.runKind}
              options={KINDS}
              onChange={(v) => set({ runKind: v })}
              size="sm"
              scrollOnMobile
              aria-label="Tipo de corrida automática"
            />
            <p className="text-xs text-muted-foreground">
              {draft.runKind === "full"
                ? "Lee todo el catálogo cada vez (varias horas con 1M de publicaciones) y marca como no disponibles las ofertas que ya no están."
                : "Pide sólo lo que cambió desde la última corrida buena. Es lo recomendado."}
            </p>
          </div>

          {draft.runKind === "incremental" && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  checked={draft.fullEvery !== null}
                  onCheckedChange={(v) => set({ fullEvery: v ? draft.fullEvery ?? 4 : null })}
                  label="Hacer una lectura completa cada tantas corridas"
                />
                {/* La frase con el campo en línea; si no entra, pasa entera
                    a la línea de abajo sin separar el campo de "corridas". */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-foreground">
                  <span>Una lectura completa cada</span>
                  <span className="inline-flex shrink-0 items-center gap-2">
                    <span className="w-16 shrink-0">
                      <Input
                        aria-label="Cantidad de corridas"
                        type="number"
                        inputMode="numeric"
                        min={FULL_EVERY_MIN}
                        max={FULL_EVERY_MAX}
                        disabled={draft.fullEvery === null}
                        value={draft.fullEvery ?? ""}
                        onChange={(e) => set({ fullEvery: e.target.value === "" ? NaN : Number(e.target.value) })}
                        className="h-9 px-2 text-center tabular-nums"
                      />
                    </span>
                    <span>corridas</span>
                  </span>
                </div>
              </div>
              {errors.fullEvery && <p className="text-xs text-danger">{errors.fullEvery}</p>}
            </div>
          )}
        </fieldset>

        <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
          <p className="text-foreground">{describeSchedule(draft)}</p>
          {draft.enabled && (
            <p className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <CalendarClock size={14} />
              {next ? (
                <>
                  Próxima: <span className="font-medium text-foreground">{fmtDateAr(next)}</span>
                  <span>({nextRunIsFull(draft) ? "lectura completa" : "sólo cambios"})</span>
                </>
              ) : hasErrors ? (
                "Corregí la agenda para ver la próxima."
              ) : (
                "Esta expresión no tiene ninguna fecha en los próximos 4 años."
              )}
            </p>
          )}
          {draft.enabled && utc && (
            <p className="text-xs text-muted-foreground">
              En UTC (como lo ve pg_cron): <code className="font-mono">{utc}</code>
            </p>
          )}
          {saved?.lastAutoNote && <p className="text-xs text-warning">{saved.lastAutoNote}</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(saved ?? null)} disabled={save.isPending}>
              Descartar
            </Button>
          )}
          <Button onClick={onSave} loading={save.isPending} disabled={!dirty || hasErrors || save.isPending}>
            {!save.isPending && <Save size={15} />}
            Guardar agenda
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
