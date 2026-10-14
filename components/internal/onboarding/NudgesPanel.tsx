"use client";

// Sugerencias por evento desde internal (F15 · H74 · ADR-089): evento,
// audiencia, prioridad, cooldown, máximo de impresiones, vigencia, botón y
// ayuda de soporte; límite global por sesión y por día ("no molestar").
import { useEffect, useState } from "react";
import { Lightbulb, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListSkeleton } from "@/components/internal/onboarding/ListSkeleton";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { useToast } from "@/components/ui/Toast";
import { VERTICAL_LABELS } from "@/lib/verticals/config";
import { SEGMENT_PLAN_LABELS } from "@/lib/internal/segments";
import { audienceSummary, compactAudience } from "@/lib/onboarding/audience";
import {
  EVENT_LABELS,
  ONBOARDING_EVENTS,
  ROLE_LABELS,
  STATUS_LABELS,
  firstIssue,
  nudgeDraftSchema,
  type NudgeDraft,
  type OnboardingEvent,
} from "@/lib/onboarding/schema";
import {
  onboardingErrorMessage,
  useInternalNudges,
  useNudgeMetrics,
  useNudgeSettings,
  useSaveNudge,
  useSaveNudgeSettings,
  useSetNudgeStatus,
  type NudgeRow,
} from "@/modules/onboarding/internal";
import { AudienceEditor } from "./AudienceEditor";
import { STATUS_TONE } from "./ToursPanel";

const LABELS = {
  plans: SEGMENT_PLAN_LABELS,
  industries: VERTICAL_LABELS as Record<string, string>,
  roles: ROLE_LABELS,
};

const TEXTAREA =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-foreground/30";

// datetime-local <-> ISO (en la zona del navegador del staff).
function toLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocal(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function NudgesPanel({ canEdit }: { canEdit: boolean }) {
  const { data: nudges, isLoading } = useInternalNudges();
  const { data: metrics } = useNudgeMetrics();
  const [editing, setEditing] = useState<NudgeRow | "new" | null>(null);
  const [statusFor, setStatusFor] = useState<{ nudge: NudgeRow; status: "published" | "paused" | "archived" } | null>(
    null,
  );
  const setStatus = useSetNudgeStatus();
  const { toast } = useToast();

  if (isLoading) return <ListSkeleton />;

  return (
    <div className="space-y-4">
      <LimitsCard canEdit={canEdit} />

      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Cada usuario ve como mucho una sugerencia por vez. Editar una publicada crea una versión nueva; el cooldown y
          el máximo de impresiones siguen contando.
        </p>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={16} /> Nueva sugerencia
          </Button>
        )}
      </div>

      {!nudges?.length ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            icon={Lightbulb}
            title="Acá van a aparecer las sugerencias por evento"
            description="Creá una para sugerir un paso cuando el negocio hace algo puntual."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {nudges.map((n) => {
            const m = metrics?.get(n.id);
            const ctr = m && m.shown > 0 ? Math.round((m.clicked / m.shown) * 100) : null;
            return (
              <li key={n.id} className="flex flex-wrap items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-foreground">{n.title}</p>
                    <Badge tone={STATUS_TONE[n.status]}>{STATUS_LABELS[n.status]}</Badge>
                    <Badge tone="info">v{n.version}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {n.key} · {EVENT_LABELS[n.event]} · prioridad {n.priority} · cada {n.cooldown_hours} h · hasta{" "}
                    {n.max_impressions} veces
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{audienceSummary(n.audience, LABELS)}</p>
                  {m && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {m.shown} vistas · {m.clicked} clics{ctr !== null ? ` (${ctr}%)` : ""} · {m.dismissed} &quot;no
                      mostrar más&quot; · {m.tenants_reached} negocios · {m.tenants_first_sale_after} vendieron por primera
                      vez después
                    </p>
                  )}
                </div>
                {canEdit && n.status !== "archived" && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(n)}>
                      Editar
                    </Button>
                    {n.status !== "published" && (
                      <Button size="sm" onClick={() => setStatusFor({ nudge: n, status: "published" })}>
                        Publicar
                      </Button>
                    )}
                    {n.status === "published" && (
                      <Button variant="secondary" size="sm" onClick={() => setStatusFor({ nudge: n, status: "paused" })}>
                        Pausar
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setStatusFor({ nudge: n, status: "archived" })}>
                      Archivar
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && <NudgeEditor nudge={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ReasonDialog
        open={Boolean(statusFor)}
        onOpenChange={(o) => !o && setStatusFor(null)}
        title={
          statusFor?.status === "published"
            ? "Publicar sugerencia"
            : statusFor?.status === "paused"
              ? "Pausar sugerencia"
              : "Archivar sugerencia"
        }
        confirmLabel="Confirmar"
        danger={statusFor?.status === "archived"}
        loading={setStatus.isPending}
        onConfirm={(reason) => {
          if (!statusFor) return;
          setStatus.mutate(
            { id: statusFor.nudge.id, status: statusFor.status, reason },
            {
              onSuccess: () => {
                toast({ title: "Listo", variant: "success" });
                setStatusFor(null);
              },
              onError: (e) => toast({ title: onboardingErrorMessage(e.message), variant: "error" }),
            },
          );
        }}
      />
    </div>
  );
}

function LimitsCard({ canEdit }: { canEdit: boolean }) {
  const { data } = useNudgeSettings();
  const save = useSaveNudgeSettings();
  const { toast } = useToast();
  const [perSession, setPerSession] = useState(1);
  const [perDay, setPerDay] = useState(3);
  useEffect(() => {
    if (data) {
      setPerSession(data.per_session);
      setPerDay(data.per_day);
    }
  }, [data]);
  const dirty = data && (data.per_session !== perSession || data.per_day !== perDay);
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[200px] flex-1">
          <p className="text-sm font-semibold text-foreground">No molestar</p>
          <p className="text-xs text-muted-foreground">Máximo de sugerencias por usuario, para toda la plataforma.</p>
        </div>
        <div className="w-36">
          <Input
            label="Por sesión"
            type="number"
            min={1}
            max={10}
            value={perSession}
            disabled={!canEdit}
            onChange={(e) => setPerSession(Number(e.target.value) || 1)}
          />
        </div>
        <div className="w-36">
          <Input
            label="Por día"
            type="number"
            min={1}
            max={20}
            value={perDay}
            disabled={!canEdit}
            onChange={(e) => setPerDay(Number(e.target.value) || 1)}
          />
        </div>
        {canEdit && (
          <Button
            size="sm"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { per_session: perSession, per_day: perDay },
                {
                  onSuccess: () => toast({ title: "Límites guardados", variant: "success" }),
                  onError: (e) => toast({ title: onboardingErrorMessage(e.message), variant: "error" }),
                },
              )
            }
          >
            Guardar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function NudgeEditor({ nudge, onClose }: { nudge: NudgeRow | null; onClose: () => void }) {
  const save = useSaveNudge();
  const { toast } = useToast();
  const [draft, setDraft] = useState<NudgeDraft>(() => ({
    key: nudge?.key ?? "",
    title: nudge?.title ?? "",
    body: nudge?.body ?? "",
    event: nudge?.event ?? "sin_productos",
    audience: nudge?.audience ?? {},
    priority: nudge?.priority ?? 50,
    cooldown_hours: nudge?.cooldown_hours ?? 24,
    max_impressions: nudge?.max_impressions ?? 3,
    starts_at: nudge?.starts_at ?? null,
    expires_at: nudge?.expires_at ?? null,
    cta_label: nudge?.cta_label ?? "",
    cta_href: nudge?.cta_href ?? "",
    support_fallback: nudge?.support_fallback ?? false,
  }));
  const [error, setError] = useState<string | null>(null);

  const onSave = () => {
    const parsed = nudgeDraftSchema.safeParse({
      ...draft,
      body: draft.body || undefined,
      cta_label: draft.cta_label || null,
      cta_href: draft.cta_href || null,
      audience: compactAudience(draft.audience),
    });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    save.mutate(
      { id: nudge?.id ?? null, draft: parsed.data },
      {
        onSuccess: () => {
          toast({
            title: nudge?.status === "published" ? "Guardada como versión nueva" : "Guardada",
            variant: "success",
          });
          onClose();
        },
        onError: (e) => setError(onboardingErrorMessage(e.message)),
      },
    );
  };

  const intField = (k: "priority" | "cooldown_hours" | "max_impressions", v: string) =>
    setDraft({ ...draft, [k]: Math.max(0, Math.floor(Number(v) || 0)) });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={nudge ? `Editar: ${nudge.title}` : "Nueva sugerencia"}
      className="max-w-2xl"
      footer={
        <>
          {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={onSave}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Clave"
            value={draft.key}
            disabled={Boolean(nudge?.published_at)}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          />
          <Select<OnboardingEvent>
            label="Evento"
            value={draft.event}
            options={ONBOARDING_EVENTS.map((e) => ({ value: e, label: EVENT_LABELS[e] }))}
            onChange={(v) => setDraft({ ...draft, event: v })}
          />
        </div>
        <Input label="Título" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <label className="block text-sm font-medium text-muted-foreground">
          Texto
          <textarea
            className={`${TEXTAREA} mt-2`}
            rows={2}
            maxLength={300}
            value={draft.body ?? ""}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Prioridad (0 a 100)" type="number" value={draft.priority} onChange={(e) => intField("priority", e.target.value)} />
          <Input
            label="Cooldown (horas)"
            type="number"
            value={draft.cooldown_hours}
            onChange={(e) => intField("cooldown_hours", e.target.value)}
          />
          <Input
            label="Máximo de veces por usuario"
            type="number"
            value={draft.max_impressions}
            onChange={(e) => intField("max_impressions", e.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Desde (opcional)"
            type="datetime-local"
            value={toLocal(draft.starts_at ?? null)}
            onChange={(e) => setDraft({ ...draft, starts_at: fromLocal(e.target.value) })}
          />
          <Input
            label="Expira (opcional)"
            type="datetime-local"
            value={toLocal(draft.expires_at ?? null)}
            onChange={(e) => setDraft({ ...draft, expires_at: fromLocal(e.target.value) })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Botón (texto)"
            value={draft.cta_label ?? ""}
            onChange={(e) => setDraft({ ...draft, cta_label: e.target.value })}
          />
          <Input
            label="Botón (destino)"
            placeholder="/productos o tour:primer-cobro"
            value={draft.cta_href ?? ""}
            onChange={(e) => setDraft({ ...draft, cta_href: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={draft.support_fallback}
            onCheckedChange={(v) => setDraft({ ...draft, support_fallback: v === true })}
            aria-label="Ofrecer Pedir ayuda"
          />
          <span>Ofrecer &quot;Pedir ayuda&quot; (abre la Ayuda)</span>
        </div>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Audiencia</h3>
          <AudienceEditor value={draft.audience} onChange={(audience) => setDraft({ ...draft, audience })} />
        </section>
      </div>
    </Modal>
  );
}
