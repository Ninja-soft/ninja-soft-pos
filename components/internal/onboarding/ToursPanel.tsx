"use client";

// Recorridos guiados desde internal (F15 · H70 · ADR-089): borrador,
// publicación con versión, pausa, archivo y métricas por paso. Sin deploy:
// lo publicado le llega al negocio en el próximo ingreso.
import { useState } from "react";
import { ArrowDown, ArrowUp, BarChart3, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { useToast } from "@/components/ui/Toast";
import { formatRelative } from "@/lib/utils/format";
import { VERTICAL_LABELS } from "@/lib/verticals/config";
import { SEGMENT_PLAN_LABELS } from "@/lib/internal/segments";
import { audienceSummary, compactAudience } from "@/lib/onboarding/audience";
import {
  EVENT_LABELS,
  KNOWN_ANCHORS,
  ONBOARDING_EVENTS,
  PLACEMENTS,
  PLACEMENT_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  firstIssue,
  tourDraftSchema,
  type ConfigStatus,
  type OnboardingEvent,
  type TourDraft,
  type TourStep,
} from "@/lib/onboarding/schema";
import {
  onboardingErrorMessage,
  tourHasDraftChanges,
  usePublishTour,
  useSaveTour,
  useSetTourStatus,
  useTourMetrics,
  type TourRow,
  useInternalTours,
} from "@/modules/onboarding/internal";
import { AudienceEditor } from "./AudienceEditor";

export const STATUS_TONE: Record<ConfigStatus, BadgeTone> = {
  draft: "neutral",
  published: "success",
  paused: "warning",
  archived: "neutral",
};

const LABELS = {
  plans: SEGMENT_PLAN_LABELS,
  industries: VERTICAL_LABELS as Record<string, string>,
  roles: ROLE_LABELS,
};

const TEXTAREA =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

export function ToursPanel({ canEdit }: { canEdit: boolean }) {
  const { data: tours, isLoading } = useInternalTours();
  const [editing, setEditing] = useState<TourRow | "new" | null>(null);
  const [metricsFor, setMetricsFor] = useState<TourRow | null>(null);
  const [statusFor, setStatusFor] = useState<{ tour: TourRow; status: "paused" | "archived" | "published" } | null>(null);
  const publish = usePublishTour();
  const setStatus = useSetTourStatus();
  const { toast } = useToast();

  if (isLoading) return <SpinnerBlock />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Lo publicado le llega a cada negocio según su audiencia y su evento. Editar no cambia nada hasta publicar
          (cada publicación es una versión nueva).
        </p>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={16} /> Nuevo recorrido
          </Button>
        )}
      </div>

      {!tours?.length ? (
        <EmptyState title="Sin recorridos" description="Creá el primero o aplicá la migración con los recorridos sembrados." />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {tours.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-foreground">{t.title}</p>
                  <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABELS[t.status]}</Badge>
                  {t.published_version && <Badge tone="info">v{t.published_version}</Badge>}
                  {t.published_version && tourHasDraftChanges(t) && t.status !== "archived" && (
                    <Badge tone="gold">Cambios sin publicar</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.key} · {EVENT_LABELS[t.trigger_event]} · prioridad {t.priority} · {t.steps.length} pasos
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{audienceSummary(t.audience, LABELS)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setMetricsFor(t)}>
                  <BarChart3 size={16} /> Métricas
                </Button>
                {canEdit && t.status !== "archived" && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(t)}>
                      Editar
                    </Button>
                    {tourHasDraftChanges(t) && (
                      <Button
                        size="sm"
                        loading={publish.isPending && publish.variables === t.id}
                        onClick={() =>
                          publish.mutate(t.id, {
                            onSuccess: (v) => toast({ title: `Publicado como versión ${v}`, variant: "success" }),
                            onError: (e) => toast({ title: onboardingErrorMessage(e.message), variant: "error" }),
                          })
                        }
                      >
                        Publicar
                      </Button>
                    )}
                    {t.status === "published" && (
                      <Button variant="secondary" size="sm" onClick={() => setStatusFor({ tour: t, status: "paused" })}>
                        Pausar
                      </Button>
                    )}
                    {t.status === "paused" && (
                      <Button variant="secondary" size="sm" onClick={() => setStatusFor({ tour: t, status: "published" })}>
                        Reanudar
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setStatusFor({ tour: t, status: "archived" })}>
                      Archivar
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && <TourEditor tour={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {metricsFor && <TourMetricsModal tour={metricsFor} onClose={() => setMetricsFor(null)} />}
      <ReasonDialog
        open={Boolean(statusFor)}
        onOpenChange={(o) => !o && setStatusFor(null)}
        title={
          statusFor?.status === "archived"
            ? "Archivar recorrido"
            : statusFor?.status === "paused"
              ? "Pausar recorrido"
              : "Reanudar recorrido"
        }
        description={
          statusFor?.status === "archived"
            ? "Deja de mostrarse y no se puede editar más. Las métricas quedan."
            : statusFor?.status === "paused"
              ? "Deja de mostrarse hasta que lo reanudes."
              : "Vuelve a mostrarse la última versión publicada."
        }
        confirmLabel="Confirmar"
        danger={statusFor?.status === "archived"}
        loading={setStatus.isPending}
        onConfirm={(reason) => {
          if (!statusFor) return;
          setStatus.mutate(
            { id: statusFor.tour.id, status: statusFor.status, reason },
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

const EMPTY_STEP: TourStep = { id: "paso", title: "Nuevo paso", body: "", placement: "modal", advance: "next" };

function uniqueStepId(steps: TourStep[]): string {
  let n = steps.length + 1;
  while (steps.some((s) => s.id === `paso-${n}`)) n += 1;
  return `paso-${n}`;
}

function TourEditor({ tour, onClose }: { tour: TourRow | null; onClose: () => void }) {
  const save = useSaveTour();
  const { toast } = useToast();
  const [draft, setDraft] = useState<TourDraft>(() => ({
    key: tour?.key ?? "",
    title: tour?.title ?? "",
    description: tour?.description ?? "",
    trigger_event: tour?.trigger_event ?? "manual",
    priority: tour?.priority ?? 50,
    audience: tour?.audience ?? {},
    steps: tour?.steps?.length ? tour.steps : [{ ...EMPTY_STEP, id: "bienvenida" }],
  }));
  const [error, setError] = useState<string | null>(null);
  const keyLocked = Boolean(tour?.published_version);

  const setStep = (i: number, patch: Partial<TourStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...d, steps };
    });

  const onSave = () => {
    const cleanSteps = draft.steps.map((s) => {
      const out: TourStep = { ...s };
      if (!out.body) delete out.body;
      if (!out.anchor) delete out.anchor;
      if (!out.route) delete out.route;
      if (!out.block) delete out.block;
      if (!out.action?.label || !out.action?.href) delete out.action;
      return out;
    });
    const parsed = tourDraftSchema.safeParse({
      ...draft,
      description: draft.description || undefined,
      audience: compactAudience(draft.audience),
      steps: cleanSteps,
    });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    save.mutate(
      { id: tour?.id ?? null, draft: parsed.data },
      {
        onSuccess: () => {
          toast({ title: "Borrador guardado. Publicalo para que llegue a los negocios.", variant: "success" });
          onClose();
        },
        onError: (e) => setError(onboardingErrorMessage(e.message)),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={tour ? `Editar: ${tour.title}` : "Nuevo recorrido"}
      className="max-w-3xl"
      footer={
        <>
          {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={onSave}>
            Guardar borrador
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Clave"
            value={draft.key}
            disabled={keyLocked}
            hint={keyLocked ? "No cambia después de publicar" : "Minúsculas y guiones, por ejemplo primer-cobro"}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          />
          <Input label="Título" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <Input
          label="Descripción (se ve en Ayuda)"
          value={draft.description ?? ""}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select<OnboardingEvent>
            label="Evento que lo dispara"
            value={draft.trigger_event}
            options={ONBOARDING_EVENTS.map((e) => ({ value: e, label: EVENT_LABELS[e] }))}
            onChange={(v) => setDraft({ ...draft, trigger_event: v })}
          />
          <Input
            label="Prioridad (0 a 100)"
            type="number"
            min={0}
            max={100}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          />
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Audiencia</h3>
          <AudienceEditor value={draft.audience} onChange={(audience) => setDraft({ ...draft, audience })} />
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">Pasos ({draft.steps.length} de 20)</h3>
            <Button
              variant="secondary"
              size="sm"
              disabled={draft.steps.length >= 20}
              onClick={() =>
                setDraft((d) => ({ ...d, steps: [...d.steps, { ...EMPTY_STEP, id: uniqueStepId(d.steps) }] }))
              }
            >
              <Plus size={16} /> Paso
            </Button>
          </div>
          <ol className="space-y-3">
            {draft.steps.map((s, i) => (
              <li key={i} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">Paso {i + 1}</span>
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" aria-label="Subir paso" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Bajar paso"
                      disabled={i === draft.steps.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Quitar paso"
                      disabled={draft.steps.length <= 1}
                      onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, k) => k !== i) }))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input label="Id" value={s.id} onChange={(e) => setStep(i, { id: e.target.value })} />
                  <div className="sm:col-span-2">
                    <Input label="Título" value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} />
                  </div>
                </div>
                <label className="block text-sm font-medium text-muted-foreground">
                  Texto
                  <textarea
                    className={`${TEXTAREA} mt-2`}
                    rows={2}
                    maxLength={400}
                    value={s.body ?? ""}
                    onChange={(e) => setStep(i, { body: e.target.value })}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    label="Cómo se muestra"
                    value={s.placement}
                    options={PLACEMENTS.map((p) => ({ value: p, label: PLACEMENT_LABELS[p] }))}
                    onChange={(v) => setStep(i, { placement: v })}
                  />
                  <Select<string>
                    label="Ancla en la pantalla"
                    value={s.anchor ?? ""}
                    options={[
                      { value: "", label: "Sin ancla" },
                      ...KNOWN_ANCHORS.map((a) => ({ value: a, label: a })),
                    ]}
                    onChange={(v) => setStep(i, { anchor: v || undefined })}
                  />
                  <Input
                    label="Pantalla"
                    placeholder="/pos"
                    value={s.route ?? ""}
                    onChange={(e) => setStep(i, { route: e.target.value || undefined })}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    label="Avanza"
                    value={s.advance}
                    options={[
                      { value: "next" as const, label: "Con Siguiente" },
                      { value: "click" as const, label: "Al tocar el ancla (hacer ahora)" },
                    ]}
                    onChange={(v) => setStep(i, { advance: v })}
                  />
                  <Input
                    label="Botón ir a (texto)"
                    placeholder="Ir a Productos"
                    value={s.action?.label ?? ""}
                    onChange={(e) => setStep(i, { action: { label: e.target.value, href: s.action?.href ?? "" } })}
                  />
                  <Input
                    label="Botón ir a (ruta)"
                    placeholder="/productos"
                    value={s.action?.href ?? ""}
                    onChange={(e) => setStep(i, { action: { label: s.action?.label ?? "", href: e.target.value } })}
                  />
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={Boolean(s.block)}
                    onCheckedChange={(v) => setStep(i, { block: v === true || undefined })}
                    aria-label="Bloquear el resto de la pantalla hasta hacer el paso"
                  />
                  <span>Bloquear el resto de la pantalla hasta hacer el paso</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Modal>
  );
}

function TourMetricsModal({ tour, onClose }: { tour: TourRow; onClose: () => void }) {
  const { data, isLoading, error } = useTourMetrics(tour.id);
  const pct = (n: number | null | undefined) => (n == null ? "Sin datos" : `${Math.round(n * 100)}%`);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Métricas: ${tour.title}`} className="max-w-2xl">
      {isLoading ? (
        <SpinnerBlock />
      ) : error || !data ? (
        <p className="text-sm text-destructive">No se pudieron cargar las métricas.</p>
      ) : (
        <div className="space-y-5 text-sm">
          <p className="text-muted-foreground">
            Negocios alcanzados: <strong className="text-foreground">{data.tenants_reached}</strong> · Primera venta
            después de iniciarlo: <strong className="text-foreground">{data.tenants_first_sale_after}</strong>
          </p>
          {data.versions.length === 0 ? (
            <p className="text-muted-foreground">Todavía nadie lo empezó.</p>
          ) : (
            data.versions.map((v) => {
              const steps = data.steps.filter((s) => s.version === v.version);
              return (
                <section key={v.version} className="space-y-2">
                  <h3 className="font-semibold text-foreground">
                    Versión {v.version}: {v.starts} inicios · {v.completed} completos ({pct(v.completion_rate)}) ·{" "}
                    {v.dismissed} abandonos
                  </h3>
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-2 font-medium">Paso</th>
                        <th className="py-1 pr-2 font-medium">Vistas</th>
                        <th className="py-1 font-medium">Abandonaron acá</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {steps.map((s) => (
                        <tr key={s.step_index}>
                          <td className="py-1 pr-2">
                            {s.step_index + 1}. {s.step_id ?? ""}
                          </td>
                          <td className="py-1 pr-2 tabular-nums">{s.views}</td>
                          <td className="py-1 tabular-nums">{s.abandoned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })
          )}
          <p className="text-xs text-muted-foreground">
            Última edición {formatRelative(tour.updated_at)}. Un abandono es un inicio sin completar cuyo último paso
            visto fue ese.
          </p>
        </div>
      )}
    </Modal>
  );
}
