"use client";

import { useMemo, useState } from "react";
import { Bell, Send } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
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
import { SpinnerBlock } from "@/components/ui/Spinner";
import { PageHeader } from "@/components/ui/PageHeader";
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
        "rounded-md border px-2.5 py-1 text-xs transition",
        on
          ? "border-ninja-flameSoft bg-ninja-flame/10 text-ninja-flameSoft"
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

const TYPE_LABELS: Record<NotificationType, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<NotificationType, string>;

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: "bg-blue-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-red-500",
  blocking: "bg-red-700",
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
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20";

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
      <Card className="mt-6">
        <CardContent className="space-y-5 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Send size={16} /> Nueva notificación
          </div>

          {/* Audiencia */}
          <div className="space-y-3">
            <span className="block text-sm font-medium text-muted-foreground">
              Audiencia
            </span>
            <Segmented<Audience>
              value={audience}
              onChange={setAudience}
              options={[
                { value: "all", label: "Todos los negocios" },
                { value: "tenant", label: "Un negocio" },
                { value: "segment", label: "Segmento" },
              ]}
            />
            {audience === "segment" && (
              <div className="space-y-3 rounded-md border border-border p-4">
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
                    <label className="mb-2 block text-sm font-medium text-muted-foreground">Rol (opcional)</label>
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
                  <label className="mb-2 block text-sm font-medium text-muted-foreground">
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
                <label className="mb-2 block text-sm font-medium text-muted-foreground">
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
          </div>

          {/* Tipo + Severidad */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-muted-foreground">
                Tipo
              </label>
              <select
                className={selectCls}
                value={type}
                onChange={(e) => setType(e.target.value as NotificationType)}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">
                Severidad
              </span>
              <Segmented<NotificationSeverity>
                value={severity}
                onChange={setSeverity}
                options={SEVERITY_VALUES.map((s) => ({
                  value: s,
                  label: SEVERITY_LABELS[s],
                  preview: (
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[s])}
                      />
                      {SEVERITY_LABELS[s]}
                    </span>
                  ),
                }))}
              />
            </div>
          </div>

          <Input
            label="Título"
            placeholder="Ej. Mantenimiento programado"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Cuerpo (opcional)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Detalle del aviso…"
              className="w-full rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
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
              placeholder="https://…"
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

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="accent-ninja-flame"
                  checked={requiresAck}
                  onChange={(e) => setRequiresAck(e.target.checked)}
                />
                Requiere confirmación
              </label>
              <InfoHint title="Requiere confirmación" label="Qué es requiere confirmación">
                Si está activado, el usuario debe confirmar/marcar como leída la
                notificación para cerrarla (acuse de recibo); queda registrado que
                la vio. Si está desactivado, es informativa y se puede descartar sin
                confirmar.
              </InfoHint>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground" htmlFor="expires">
                Vence (opcional)
              </label>
              <input
                id="expires"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
              />
            </div>
          </div>

          {/* Ventana de captación: límite para mostrarla a nuevos registros. */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <label
                className="text-sm text-muted-foreground"
                htmlFor="display-until"
              >
                Mostrar hasta (captación de nuevos registros)
              </label>
              <input
                id="display-until"
                type="datetime-local"
                value={displayUntil}
                onChange={(e) => setDisplayUntil(e.target.value)}
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Quien se registre después del envío la verá solo si esta fecha
              todavía no pasó. Los ya registrados la ven igual. Vacío = sin
              corte.
            </p>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={!canSend}
              loading={sending}
            >
              <Send size={16} /> Enviar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Enviadas */}
      <Card className="mt-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Bell size={16} /> Enviadas
          </div>
          {sentLoading ? (
            <SpinnerBlock className="py-6" />
          ) : sent.length === 0 ? (
            <EmptyState compact icon={Bell} title="Todavía no enviaste notificaciones" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Fecha</th>
                    <th className="py-2 pr-4 font-medium">Audiencia</th>
                    <th className="py-2 pr-4 font-medium">Severidad</th>
                    <th className="py-2 pr-4 font-medium">Tipo</th>
                    <th className="py-2 pr-4 font-medium">Título</th>
                    <th className="py-2 pr-4 font-medium">Conf.</th>
                    {canDelete && (
                      <th className="py-2 pr-2 text-right font-medium">
                        Acción
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupByBatch(sent).map(({ row: n, count }) => (
                    <tr key={n.id}>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground">
                        {formatRelative(n.createdAt)}
                      </td>
                      <td className="py-2.5 pr-4">
                        {n.segmentBatchId
                          ? `Segmento: ${segmentSummary(fromRpcSegment(n.segment), INDUSTRY_LABELS)} (${count} negocios)`
                          : n.audience}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              SEVERITY_DOT[n.severity] ?? "bg-blue-500",
                            )}
                          />
                          {SEVERITY_LABELS[n.severity] ?? n.severity}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          {n.type === "afip" && <IntegrationLogo name="arca" size={16} />}
                          {TYPE_LABELS[n.type] ?? n.type}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 font-medium text-foreground">
                        {n.title}
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        {n.requiresAck ? "Sí" : "No"}
                      </td>
                      {canDelete && (
                        <td className="py-2.5 pr-2 text-right">
                          <button
                            type="button"
                            title="Borrar notificación"
                            aria-label="Borrar notificación"
                            onClick={() => setToDelete({ row: n, count })}
                            className="inline-grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-red-500/10 hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

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
