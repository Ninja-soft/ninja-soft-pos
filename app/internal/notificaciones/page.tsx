"use client";

import { useMemo, useState } from "react";
import { Bell, Send } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InfoHint } from "@/components/ui/InfoHint";
import { cn } from "@/lib/utils/cn";
import { formatRelative } from "@/lib/utils/format";
import { createClient } from "@/lib/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useInternalTenants } from "@/modules/internal/hooks";
import {
  useDeleteNotification,
  useSendNotification,
  useSentNotifications,
} from "@/modules/internal/hooks";
import type { SentNotification } from "@/modules/internal/api";
import type {
  NotificationSeverity,
  NotificationType,
} from "@/modules/notifications/api";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { IntegrationLogo } from "@/components/ui/IntegrationLogo";
import { EmptyState } from "@/components/ui/EmptyState";
import { VERTICALS, VERTICAL_LABELS } from "@/lib/verticals/config";
import { useDeleteNotificationBatch, useNotifySegment } from "@/modules/internal/opsHooks";
import {
  EMPTY_SEGMENT,
  SEGMENT_PLANS,
  SEGMENT_PLAN_LABELS,
  SEGMENT_STATUSES,
  SEGMENT_STATUS_LABELS,
  fromRpcSegment,
  groupByBatch,
  segmentError,
  segmentSummary,
  segmentTenants,
  toRpcSegment,
  toggleValue,
  type Segment,
} from "@/lib/internal/segments";

type Audience = "all" | "tenant" | "segment";

const INDUSTRY_LABELS = VERTICAL_LABELS as Record<string, string>;

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "min-h-[32px] rounded-md border px-2.5 py-1 text-xs transition",
        on
          ? "choice-on border-transparent font-medium text-foreground"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

const TYPE_OPTIONS: { value: NotificationType; label: string }[] = [
  { value: "news", label: "Novedad" },
  { value: "plan", label: "Plan" },
  { value: "billing", label: "Facturación" },
  { value: "usage", label: "Uso" },
  { value: "security", label: "Seguridad" },
  { value: "afip", label: "AFIP" },
  { value: "maintenance", label: "Mantenimiento" },
  { value: "support", label: "Soporte" },
];

// Etiquetas para el listado: incluye los tipos automáticos (cobros, disputas)
// que no se eligen desde el formulario pero sí aparecen en "Enviadas".
const TYPE_LABELS: Record<string, string> = {
  ...Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label])),
  cobros: "Cobros",
  disputas: "Contracargos y devoluciones",
};

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  critical: "bg-danger",
  blocking: "bg-danger ring-2 ring-danger/30",
};

const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: "Info",
  success: "Éxito",
  warning: "Aviso",
  critical: "Crítica",
  blocking: "Bloqueante",
};

const SEVERITY_VALUES: NotificationSeverity[] = [
  "info",
  "success",
  "warning",
  "critical",
  "blocking",
];

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todos los roles" },
  { value: "owner", label: "Dueños" },
  { value: "manager", label: "Encargados" },
  { value: "cashier", label: "Cajeros" },
  { value: "viewer", label: "Solo lectura" },
];

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-foreground/30";

const fieldLabelCls = "mb-2 block text-sm font-medium text-muted-foreground";

// Bloque del formulario con su propio título (Audiencia, Mensaje, Opciones).
function FormBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    // min-w-0: un fieldset por defecto toma el ancho mínimo de su contenido.
    // La leyenda flota (para no cortar el borde superior) y el contenido va en
    // un bloque con clear: así las grillas no quedan a la derecha del float.
    <fieldset className="min-w-0 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <legend className="float-left mb-4 w-full text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      <div className="clear-both space-y-4">{children}</div>
    </fieldset>
  );
}

// Severidad como pastillas con el punto de su color de estado. Radiogroup
// accesible (flechas mueven la selección); lo elegido va con relleno neutro.
function SeverityPicker({
  value,
  onChange,
}: {
  value: NotificationSeverity;
  onChange: (v: NotificationSeverity) => void;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const i = SEVERITY_VALUES.indexOf(value);
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % SEVERITY_VALUES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + SEVERITY_VALUES.length) % SEVERITY_VALUES.length;
    if (next === null) return;
    e.preventDefault();
    const v = SEVERITY_VALUES[next]!;
    onChange(v);
    const group = e.currentTarget.parentElement;
    (group?.children[next] as HTMLButtonElement | undefined)?.focus();
  }

  return (
    <div role="radiogroup" aria-labelledby="notif-severity-label" className="flex flex-wrap gap-2">
      {SEVERITY_VALUES.map((s) => {
        const on = s === value;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s)}
            onKeyDown={onKeyDown}
            className={cn(
              "inline-flex min-h-[40px] items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on
                ? "choice-on border-transparent font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[s])} />
            {SEVERITY_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}

// Vista previa del aviso tal como se ve en la campana del POS (mismo armado
// que NotificationItem: punto de severidad, título, tipo, cuerpo y acciones).
function NotificationPreview({
  type,
  severity,
  title,
  body,
  actionLabel,
  requiresAck,
}: {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionLabel: string;
  requiresAck: boolean;
}) {
  const t = title.trim();
  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-muted-foreground">Vista previa en la campana</span>
      <div className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-sm font-semibold text-foreground">Notificaciones</span>
          <Bell size={15} aria-hidden className="text-muted-foreground" />
        </div>
        <div className="relative bg-muted/30 py-2.5 pl-5 pr-3">
          <span
            aria-hidden
            className={cn("absolute left-2 top-[18px] h-1.5 w-1.5 rounded-full", SEVERITY_DOT[severity])}
          />
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 break-words text-sm font-semibold leading-snug",
                t ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {t || "Título del aviso"}
            </span>
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {TYPE_LABELS[type] ?? type}
            </span>
          </div>
          {body.trim() && (
            <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{body.trim()}</p>
          )}
          <span className="mt-1 block text-[11px] text-muted-foreground">recién</span>
          {(actionLabel.trim() || requiresAck) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {actionLabel.trim() && (
                <span className="rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-medium text-ninja-flameSoft">
                  {actionLabel.trim()}
                </span>
              )}
              {requiresAck && (
                <span className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground">
                  Entendido
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {severity === "blocking" && (
        <div className="flex items-center gap-3 rounded-lg bg-danger/15 px-3 py-2.5 text-sm text-foreground">
          <Bell size={15} aria-hidden className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 break-words font-medium">{t || "Título del aviso"}</span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {severity === "blocking"
          ? "Bloqueante: además se muestra como franja arriba del POS hasta que lo confirmen."
          : "Así aparece en la lista de la campana de cada usuario alcanzado."}
      </p>
    </div>
  );
}

export default function InternalNotificacionesPage() {
  const { toast } = useToast();
  const { data: tenants = [] } = useInternalTenants();
  const { data: sent = [], isLoading: sentLoading } = useSentNotifications();
  const send = useSendNotification();
  const sendSegment = useNotifySegment();
  const del = useDeleteNotification();
  const delBatch = useDeleteNotificationBatch();

  // Nivel del staff actual: solo no-support puede borrar (el RPC también lo
  // bloquea server-side; esto solo oculta la acción en la UI).
  const { data: myLevel } = useQuery({
    queryKey: ["my-internal-level"],
    queryFn: async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return ((user?.app_metadata as { internal_level?: string } | null)
        ?.internal_level ?? null) as string | null;
    },
    staleTime: 5 * 60 * 1000,
  });
  const canDelete = myLevel !== "support";

  const [toDelete, setToDelete] = useState<{ row: SentNotification; count: number } | null>(null);
  const [segment, setSegment] = useState<Segment>(EMPTY_SEGMENT);

  const [audience, setAudience] = useState<Audience>("all");
  const [tenantId, setTenantId] = useState<string>("");
  const [tenantSearch, setTenantSearch] = useState("");
  const [role, setRole] = useState<string>("");
  const [type, setType] = useState<NotificationType>("news");
  const [severity, setSeverity] = useState<NotificationSeverity>("info");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [requiresAck, setRequiresAck] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [displayUntil, setDisplayUntil] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const filteredTenants = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        (t.ownerEmail ?? "").toLowerCase().includes(q),
    );
  }, [tenants, tenantSearch]);

  // Validación de la acción: ambos campos o ninguno, y URL http(s).
  const hasLabel = actionLabel.trim().length > 0;
  const hasUrl = actionUrl.trim().length > 0;
  const actionMismatch = hasLabel !== hasUrl;
  const actionUrlInvalid = hasUrl && !isHttpUrl(actionUrl);

  const broadcast = audience === "all";
  const tenantMissing = audience === "tenant" && !tenantId;
  const segmentErr = audience === "segment" ? segmentError(segment) : null;
  const segmentMatches = useMemo(
    () => (audience === "segment" ? segmentTenants(tenants, segment) : []),
    [audience, tenants, segment],
  );
  const segmentInvalid = audience === "segment" && (segmentErr !== null || segmentMatches.length === 0);
  const sending = send.isPending || sendSegment.isPending;

  const canSend =
    title.trim().length > 0 &&
    !actionMismatch &&
    !actionUrlInvalid &&
    !tenantMissing &&
    !segmentInvalid &&
    !sending;

  function resetForm() {
    setAudience("all");
    setSegment(EMPTY_SEGMENT);
    setTenantId("");
    setTenantSearch("");
    setRole("");
    setType("news");
    setSeverity("info");
    setTitle("");
    setBody("");
    setActionLabel("");
    setActionUrl("");
    setRequiresAck(false);
    setExpiresAt("");
    setDisplayUntil("");
  }

  function doSend() {
    if (audience === "segment") {
      sendSegment.mutate(
        {
          segment: toRpcSegment(segment),
          role: role || null,
          type,
          severity,
          title: title.trim(),
          body: body.trim(),
          actionLabel: actionLabel.trim(),
          actionUrl: actionUrl.trim(),
          requiresAck,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "",
          displayUntil: displayUntil ? new Date(displayUntil).toISOString() : "",
        },
        {
          onSuccess: (r) => {
            setConfirmOpen(false);
            resetForm();
            toast({ title: `Enviada a ${r.sent} negocios`, variant: "success" });
          },
          onError: (e) => {
            setConfirmOpen(false);
            toast({
              title: "No se pudo enviar",
              description: e instanceof Error ? e.message : undefined,
              variant: "error",
            });
          },
        },
      );
      return;
    }
    send.mutate(
      {
        tenantId: broadcast ? null : tenantId,
        role: role || null,
        userId: null,
        type,
        severity,
        title: title.trim(),
        body: body.trim(),
        actionLabel: actionLabel.trim(),
        actionUrl: actionUrl.trim(),
        requiresAck,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "",
        displayUntil: displayUntil ? new Date(displayUntil).toISOString() : "",
      },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          resetForm();
          toast({ title: "Notificación enviada", variant: "success" });
        },
        onError: (e) => {
          setConfirmOpen(false);
          toast({
            title: "No se pudo enviar",
            description: e instanceof Error ? e.message : undefined,
            variant: "error",
          });
        },
      },
    );
  }

  const selectedTenant = tenants.find((t) => t.id === tenantId);
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === role)?.label ?? "";
  const audienceSummary =
    audience === "segment"
      ? `${segmentSummary(segment, INDUSTRY_LABELS)} (${segmentMatches.length} negocios)${role ? ` · ${roleLabel}` : ""}`
      : broadcast
    ? role
      ? `TODOS los negocios · ${roleLabel}`
      : "TODOS los negocios"
    : `${selectedTenant?.name ?? "un negocio"}${role ? ` · ${roleLabel}` : ""}`;

  return (
    <>
      <PageHeader
        eyebrow="Comunicaciones"
        title="Notificaciones"
        icon={Bell}
        description={
          <>
            Enviá avisos in-app a los negocios. Llegan a la campana del POS de los
            usuarios alcanzados.
          </>
        }
      />

      {/* Nueva notificación */}
      <section className="mt-8">
      <SectionHeader
        title="Nueva notificación"
        icon={Send}
        description="Elegí a quién le llega, escribí el aviso y revisá el resumen antes de enviar."
      />
      <Card className="mt-4">
        <CardContent className="space-y-5 p-4 sm:p-5">
          {/* Audiencia */}
          <FormBlock title="Audiencia">
            <Segmented<Audience>
              aria-label="Audiencia"
              value={audience}
              onChange={setAudience}
              options={[
                { value: "all", label: "Todos los negocios" },
                { value: "tenant", label: "Un negocio" },
                { value: "segment", label: "Segmento" },
              ]}
            />
            {audience === "segment" && (
              <div className="space-y-4 rounded-lg bg-muted/50 p-4">
                <div>
                  <span className="mb-2 block text-xs font-semibold text-muted-foreground">
                    Plan
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {SEGMENT_PLANS.map((p) => (
                      <Chip
                        key={p}
                        on={segment.plans.includes(p)}
                        label={SEGMENT_PLAN_LABELS[p] ?? p}
                        onClick={() => setSegment((s) => ({ ...s, plans: toggleValue(s.plans, p) }))}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-xs font-semibold text-muted-foreground">
                    Estado
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {SEGMENT_STATUSES.map((x) => (
                      <Chip
                        key={x}
                        on={segment.statuses.includes(x)}
                        label={SEGMENT_STATUS_LABELS[x] ?? x}
                        onClick={() => setSegment((s) => ({ ...s, statuses: toggleValue(s.statuses, x) }))}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-xs font-semibold text-muted-foreground">
                    Rubro
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {VERTICALS.map((v) => (
                      <Chip
                        key={v}
                        on={segment.industries.includes(v)}
                        label={INDUSTRY_LABELS[v] ?? v}
                        onClick={() => setSegment((s) => ({ ...s, industries: toggleValue(s.industries, v) }))}
                      />
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    label="Alta desde"
                    type="date"
                    value={segment.createdFrom}
                    onChange={(e) => setSegment((s) => ({ ...s, createdFrom: e.target.value }))}
                  />
                  <Input
                    label="Alta hasta"
                    type="date"
                    value={segment.createdTo}
                    onChange={(e) => setSegment((s) => ({ ...s, createdTo: e.target.value }))}
                  />
                  <div>
                    <label className={fieldLabelCls}>Rol (opcional)</label>
                    <select className={selectCls} value={role} onChange={(e) => setRole(e.target.value)}>
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-sm" role="status">
                  {segmentErr ? (
                    <span className="text-muted-foreground">{segmentErr}</span>
                  ) : segmentMatches.length === 0 ? (
                    <span className="text-warning">Ningún negocio coincide con este segmento.</span>
                  ) : (
                    <>
                      <span className="font-medium text-foreground">Llega a {segmentMatches.length} negocios</span>
                      <span className="text-muted-foreground">
                        {": "}
                        {segmentMatches
                          .slice(0, 6)
                          .map((t) => t.name)
                          .join(", ")}
                        {segmentMatches.length > 6 ? ` y ${segmentMatches.length - 6} más` : ""}. Los dados de baja
                        no entran.
                      </span>
                    </>
                  )}
                </p>
              </div>
            )}
            {audience === "tenant" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Input
                    label="Buscar negocio"
                    placeholder="Nombre, slug o email del dueño"
                    value={tenantSearch}
                    onChange={(e) => setTenantSearch(e.target.value)}
                  />
                  <select
                    className={cn(selectCls, "mt-2")}
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    size={1}
                  >
                    <option value="">Elegí un negocio…</option>
                    {filteredTenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={fieldLabelCls}>
                    Rol (opcional)
                  </label>
                  <select
                    className={selectCls}
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {broadcast && (
              <div className="sm:max-w-xs">
                <label className={fieldLabelCls}>
                  Rol (opcional)
                </label>
                <select
                  className={selectCls}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </FormBlock>

          <FormBlock title="Mensaje">
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div className="min-w-0 space-y-4">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
              <Input
                label="Título"
                placeholder="Ej. Mantenimiento programado"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Select<NotificationType>
                id="notif-type"
                label="Tipo"
                value={type}
                onChange={setType}
                options={TYPE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                  icon: o.value === "afip" ? <IntegrationLogo name="arca" size={16} /> : undefined,
                }))}
              />
            </div>

            <div>
              <span id="notif-severity-label" className={fieldLabelCls}>
                Severidad
              </span>
              <SeverityPicker value={severity} onChange={setSeverity} />
            </div>

            <div>
              <label htmlFor="notif-body" className={fieldLabelCls}>
                Cuerpo (opcional)
              </label>
              <textarea
                id="notif-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Detalle del aviso"
                className="w-full rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-foreground/30"
              />
            </div>

            {/* Acción opcional */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Etiqueta del botón (opcional)"
                placeholder="Ej. Ver detalles"
                value={actionLabel}
                onChange={(e) => setActionLabel(e.target.value)}
                error={
                  actionMismatch && hasUrl && !hasLabel
                    ? "Completá la etiqueta"
                    : undefined
                }
              />
              <Input
                label="URL de la acción (opcional)"
                placeholder="https://"
                value={actionUrl}
                onChange={(e) => setActionUrl(e.target.value)}
                error={
                  actionUrlInvalid
                    ? "Debe empezar con http:// o https://"
                    : actionMismatch && hasLabel && !hasUrl
                      ? "Completá la URL"
                      : undefined
                }
              />
            </div>
            </div>

            <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
              <NotificationPreview
                type={type}
                severity={severity}
                title={title}
                body={body}
                actionLabel={actionLabel}
                requiresAck={requiresAck}
              />
            </div>
            </div>
          </FormBlock>

          <FormBlock title="Opciones">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3.5 py-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-sm font-medium text-foreground">Requiere confirmación</span>
                <InfoHint title="Requiere confirmación" label="Qué es requiere confirmación">
                  Si está activado, el usuario debe confirmar/marcar como leída la
                  notificación para cerrarla (acuse de recibo); queda registrado que
                  la vio. Si está desactivado, es informativa y se puede descartar sin
                  confirmar.
                </InfoHint>
              </div>
              <Switch
                checked={requiresAck}
                onCheckedChange={setRequiresAck}
                label="Requiere confirmación"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={fieldLabelCls} htmlFor="expires">
                  Vence (opcional)
                </label>
                <input
                  id="expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className={selectCls}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Después de esta fecha deja de mostrarse a todos.
                </p>
              </div>
              {/* Ventana de captación: límite para mostrarla a nuevos registros. */}
              <div>
                <label className={fieldLabelCls} htmlFor="display-until">
                  Mostrar a nuevos registros hasta
                </label>
                <input
                  id="display-until"
                  type="datetime-local"
                  value={displayUntil}
                  onChange={(e) => setDisplayUntil(e.target.value)}
                  className={selectCls}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Quien se registre después del envío la ve sólo si esta fecha todavía
                  no pasó. Los ya registrados la ven igual. Vacío: sin corte.
                </p>
              </div>
            </div>
          </FormBlock>

          <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Llega a:</span> {audienceSummary}
            </p>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={!canSend}
              loading={sending}
              className="shrink-0"
            >
              <Send size={16} /> Enviar
            </Button>
          </div>
        </CardContent>
      </Card>
      </section>

      {/* Enviadas */}
      <section className="mt-10">
        <SectionHeader
          title="Enviadas"
          icon={Bell}
          description="Los envíos a un segmento se agrupan en una sola fila."
        />
        <TableWrap className="mt-4">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Aviso</th>
                <th className="hidden px-4 py-3 font-semibold md:table-cell">Audiencia</th>
                <th className="px-4 py-3 font-semibold">Severidad</th>
                <th className="hidden px-4 py-3 font-semibold lg:table-cell">Tipo</th>
                <th className="hidden px-4 py-3 font-semibold sm:table-cell">Confirmación</th>
                {canDelete && (
                  <th className="px-4 py-3 text-right font-semibold">
                    <span className="sr-only">Acciones</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sentLoading && <TableStateRow colSpan={canDelete ? 6 : 5} loading />}
              {!sentLoading && sent.length === 0 && (
                <TableStateRow colSpan={canDelete ? 6 : 5}>
                  <EmptyState
                    compact
                    icon={Bell}
                    title="Acá vas a ver los avisos que mandes"
                    description="Llegan a la campana del POS de los usuarios alcanzados."
                  />
                </TableStateRow>
              )}
              {!sentLoading &&
                groupByBatch(sent).map(({ row: n, count }) => {
                  const audienceText = n.segmentBatchId
                    ? `Segmento: ${segmentSummary(fromRpcSegment(n.segment), INDUSTRY_LABELS)} (${count} negocios)`
                    : n.audience;
                  return (
                    <tr key={n.id} className="align-top transition hover:bg-muted/40">
                      <td className="max-w-[20rem] px-4 py-3">
                        <div className="font-medium text-foreground">{n.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatRelative(n.createdAt)}
                          <span className="md:hidden"> · {audienceText}</span>
                        </div>
                      </td>
                      <td className="hidden max-w-[16rem] px-4 py-3 text-muted-foreground md:table-cell">
                        {audienceText}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[n.severity] ?? "bg-info")}
                          />
                          {SEVERITY_LABELS[n.severity] ?? n.severity}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                        <span className="inline-flex items-center gap-1.5">
                          {n.type === "afip" && <IntegrationLogo name="arca" size={16} />}
                          {TYPE_LABELS[n.type] ?? n.type}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        {n.requiresAck ? <Badge tone="info">Requiere</Badge> : <Badge>No</Badge>}
                      </td>
                      {canDelete && (
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            title="Borrar notificación"
                            aria-label="Borrar notificación"
                            onClick={() => setToDelete({ row: n, count })}
                            className="inline-grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={broadcast ? "¿Enviar a TODOS los negocios?" : "Confirmar envío"}
        description={`Audiencia: ${audienceSummary}. Título: “${title.trim()}”.`}
        confirmLabel="Enviar"
        danger={broadcast}
        loading={sending}
        onConfirm={doSend}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => {
          if (!o) setToDelete(null);
        }}
        title="¿Borrar notificación?"
        description={
          toDelete
            ? `Se dará de baja “${toDelete.row.title}”${
                toDelete.row.segmentBatchId ? ` en los ${toDelete.count} negocios del segmento` : ""
              }. Dejará de mostrarse a los usuarios.`
            : undefined
        }
        confirmLabel="Borrar"
        danger
        loading={del.isPending || delBatch.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          const batch = toDelete.row.segmentBatchId;
          if (batch) {
            delBatch.mutate(batch, {
              onSuccess: () => {
                setToDelete(null);
                toast({ title: "Notificaciones borradas", variant: "success" });
              },
              onError: (e) => {
                setToDelete(null);
                toast({
                  title: "No se pudo borrar",
                  description: e instanceof Error ? e.message : undefined,
                  variant: "error",
                });
              },
            });
            return;
          }
          const id = toDelete.row.id;
          del.mutate(id, {
            onSuccess: () => {
              setToDelete(null);
              toast({ title: "Notificación borrada", variant: "success" });
            },
            onError: (e) => {
              setToDelete(null);
              toast({
                title: "No se pudo borrar",
                description: e instanceof Error ? e.message : undefined,
                variant: "error",
              });
            },
          });
        }}
      />
    </>
  );
}
