"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { BillingCard } from "@/components/internal/BillingCard";
import { PlanCard } from "@/components/internal/PlanCard";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Display, Heading } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  useInternalTenants,
  useTenantFlags,
  useInternalMutations,
  useTenantHealth,
  useTenantNotes,
  useTenantNoteMutations,
  useImpersonateTenant,
  useInternalAudit,
  useTenantAddons,
  useGiftAiAddon,
  AI_ASSISTANT_ADDON_KEY,
} from "@/modules/internal/hooks";
import { VERTICALS, VERTICAL_LABELS } from "@/lib/verticals/config";
import { formatCurrency, formatRelative } from "@/lib/utils/format";

const STATUSES = [
  { key: "trial", name: "Trial" },
  { key: "active", name: "Activo" },
  { key: "past_due", name: "Pago pendiente" },
  { key: "suspended", name: "Suspendido" },
  { key: "cancelled", name: "Cancelado" },
];
const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-AR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function InternalTenantDetail({
  params,
}: {
  params: { id: string };
}) {
  const { toast } = useToast();
  const { data: tenants } = useInternalTenants();
  const tenant = tenants?.find((t) => t.id === params.id);
  const { data: flags } = useTenantFlags(params.id);
  const { data: healthMap } = useTenantHealth();
  const health = healthMap?.get(params.id);
  const { data: notes } = useTenantNotes(params.id);
  const noteMut = useTenantNoteMutations(params.id);
  const [noteBody, setNoteBody] = useState("");
  const { setStatus, setFlag, setIndustry } = useInternalMutations(
    params.id,
  );
  const supabase = createClient();
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // Nivel del staff actual (para mostrar/ocultar impersonation).
  const { data: myUser } = useQuery({
    queryKey: ["my-user"],
    queryFn: () => createClient().auth.getUser().then((r) => r.data.user),
    staleTime: 5 * 60 * 1000,
  });
  const myLevel =
    (myUser?.app_metadata as { internal_level?: string } | undefined)
      ?.internal_level ?? null;
  const canImpersonate = myLevel === "super_admin" || myLevel === "admin";

  // Impersonation.
  const impersonate = useImpersonateTenant();
  const [impersonateResult, setImpersonateResult] = useState<{
    actionLink: string;
    ownerEmail: string;
  } | null>(null);

  // Regalar el Asistente IA a ESTE negocio (addon bonificado, sin cobro).
  const { data: tenantAddons } = useTenantAddons(params.id);
  const hasAiAddon = tenantAddons?.has(AI_ASSISTANT_ADDON_KEY) ?? false;
  const giftAi = useGiftAiAddon(params.id);

  // Audit log del tenant (últimas 30 acciones).
  const { data: auditEntries } = useInternalAudit({ tenantId: params.id });
  const [auditTab, setAuditTab] = useState<"all" | "billing">("all");
  const BILLING_TYPES = new Set(["subscription", "trial", "billing_record", "billing", "impersonation"]);
  const visibleAudit = auditTab === "billing"
    ? (auditEntries ?? []).filter((e) => BILLING_TYPES.has(e.entity_type))
    : (auditEntries ?? []);

  // Genera el link de suscripción (preapproval) de Mercado Pago para el tenant.
  const checkout = useMutation({
    mutationFn: async () => {
      const backUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}/internal/tenants/${params.id}`
          : undefined;
      const { data, error } = await supabase.functions.invoke(
        "mp_subscription_checkout",
        { body: { tenant_id: params.id, back_url: backUrl } },
      );
      if (error) throw error;
      const res = data as { init_point?: string; error?: string };
      if (res?.error || !res?.init_point) throw new Error(res?.error ?? "sin_link");
      return res.init_point;
    },
    onSuccess: (u) => {
      setCheckoutUrl(u);
      toast({ title: "Link de cobro generado", variant: "success" });
    },
    onError: (e: Error) =>
      toast({ title: "No se pudo generar", description: e.message, variant: "error" }),
  });

  function wrap(p: Promise<unknown>, ok: string) {
    p.then(() => toast({ title: ok, variant: "success" })).catch((e) =>
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
    );
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() =>
      toast({ title: "Copiado al portapapeles", variant: "success" }),
    );
  }

  return (
    <>
      <Link
        href="/internal/tenants"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft size={15} /> Volver a negocios
      </Link>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Display className="text-3xl md:text-4xl">
          {tenant?.name ?? "…"}
        </Display>
        {(() => {
          const st = tenant?.subStatus ?? tenant?.status;
          return st ? (
            <span className="rounded-md bg-ninja-flame/12 px-2.5 py-1 text-xs font-semibold text-ninja-flameSoft">
              {STATUSES.find((s) => s.key === st)?.name ?? st}
            </span>
          ) : null;
        })()}
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{tenant?.slug}</p>

      {/* ── Ficha 360: info básica ───────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        {tenant?.ownerEmail && (
          <span>
            <span className="font-medium text-foreground">
              {tenant.ownerName ?? tenant.ownerEmail}
            </span>
            {tenant.ownerName && (
              <span className="ml-1 opacity-60">{tenant.ownerEmail}</span>
            )}
          </span>
        )}
        <span>Alta: {fmtDate(tenant?.created_at)}</span>
        {tenant?.trial_ends_at && (
          <span>
            Trial hasta:{" "}
            <span
              className={
                new Date(tenant.trial_ends_at) < new Date()
                  ? "font-medium text-destructive"
                  : "font-medium text-foreground"
              }
            >
              {fmtDate(tenant.trial_ends_at)}
            </span>
          </span>
        )}
      </div>

      <div className="mt-6">
        <PlanCard tenantId={params.id} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Estado de suscripción
            </label>
            <select
              className={selectCls}
              value={tenant?.subStatus ?? tenant?.status ?? "trial"}
              onChange={(e) =>
                wrap(setStatus.mutateAsync(e.target.value), "Estado actualizado")
              }
            >
              {STATUSES.map((s) => (
                <option key={s.key} value={s.key} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Rubro
            </label>
            <select
              className={selectCls}
              value={tenant?.industry ?? "otro"}
              onChange={(e) =>
                wrap(setIndustry.mutateAsync(e.target.value), "Rubro actualizado")
              }
            >
              {VERTICALS.map((v) => (
                <option key={v} value={v} className="bg-popover text-popover-foreground">
                  {VERTICAL_LABELS[v]}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
      </div>

      <Heading className="mt-8" as="h2">
        Salud operativa
      </Heading>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Último login",
            value: formatRelative(health?.last_login_at),
          },
          {
            label: "Última venta",
            value: formatRelative(health?.last_sale_at),
          },
          {
            label: "Ventas (7 días)",
            value: health ? String(health.sales_7d_count) : "…",
            sub: health ? formatCurrency(health.sales_7d_total) : undefined,
          },
          {
            label: "Usuarios activos",
            value: health ? String(health.active_users) : "…",
          },
        ].map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-5">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {kpi.label}
              </div>
              <div className="mt-1.5 text-xl font-semibold text-foreground">
                {kpi.value}
              </div>
              {kpi.sub && (
                <div className="text-sm text-muted-foreground">{kpi.sub}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Heading className="mt-8" as="h2">
        Cobro de suscripción
      </Heading>
      <Card className="mt-3">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <Button disabled={checkout.isPending} onClick={() => checkout.mutate()}>
            {checkout.isPending ? "Generando…" : "Generar link de cobro (Mercado Pago)"}
          </Button>
          {checkoutUrl && (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ninja-flameSoft hover:underline"
            >
              <ExternalLink size={15} /> Abrir link de pago
            </a>
          )}
          <p className="w-full text-xs text-muted-foreground">
            Crea una suscripción mensual en Mercado Pago con la cuenta de NinjaSoft
            por el plan del negocio. El estado se actualiza solo cuando el cliente
            paga.
          </p>
        </CardContent>
      </Card>

      {/* ── Regalar el Asistente IA a ESTE negocio ───────────────────────── */}
      <Heading className="mt-8" as="h2">
        Asistente IA
      </Heading>
      <Card className="mt-3">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          {hasAiAddon ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-sm font-semibold text-success">
                <Check size={15} /> Asistente IA activo (regalado)
              </span>
              <Button
                variant="secondary"
                loading={giftAi.revoke.isPending}
                disabled={giftAi.grant.isPending}
                onClick={() =>
                  giftAi.revoke.mutate(undefined, {
                    onSuccess: () =>
                      toast({ title: "Asistente IA quitado", variant: "success" }),
                    onError: (e) =>
                      toast({
                        title: "No se pudo quitar",
                        description: e instanceof Error ? e.message : undefined,
                        variant: "error",
                      }),
                  })
                }
              >
                Quitar Asistente IA
              </Button>
            </>
          ) : (
            <Button
              loading={giftAi.grant.isPending}
              disabled={giftAi.revoke.isPending}
              onClick={() =>
                giftAi.grant.mutate(undefined, {
                  onSuccess: () =>
                    toast({ title: "Asistente IA regalado", variant: "success" }),
                  onError: (e) =>
                    toast({
                      title: "No se pudo regalar",
                      description: e instanceof Error ? e.message : undefined,
                      variant: "error",
                    }),
                })
              }
            >
              <Sparkles size={15} /> Regalar Asistente IA
            </Button>
          )}
          <p className="w-full text-xs text-muted-foreground">
            Activa el complemento del Asistente IA para este negocio sin cobro
            (bonificado). El dueño y su equipo pueden usarlo al instante. Para un
            único tester/beta global, usá el “Email de la beta” en la configuración
            interna de IA.
          </p>
        </CardContent>
      </Card>

      <div className="mt-8">
        <BillingCard
          tenantId={params.id}
          trialEndsAt={tenant?.trial_ends_at ?? null}
          subStatus={tenant?.subStatus ?? null}
          planKey={tenant?.planKey ?? null}
        />
      </div>

      {/* ── Impersonation (solo admin / super_admin) ─────────────────────── */}
      {canImpersonate && (
        <>
          <Heading className="mt-8" as="h2">
            Acceder como este negocio
          </Heading>
          <Card className="mt-3">
            <CardContent className="p-5">
              <div className="mb-4 flex items-start gap-2 rounded-lg bg-yellow-500/10 px-4 py-3 text-sm text-warning">
                <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                <span>
                  Esto genera un magic link de un solo uso para el dueño del negocio.{" "}
                  <strong>Abrilo en una ventana de incógnito</strong> para no cerrar
                  tu sesión de staff.
                </span>
              </div>

              {!impersonateResult ? (
                <Button
                  disabled={impersonate.isPending}
                  onClick={() =>
                    impersonate.mutate(params.id, {
                      onSuccess: (res) => setImpersonateResult(res),
                      onError: (e) =>
                        toast({
                          title: "Error al generar link",
                          description: e instanceof Error ? e.message : undefined,
                          variant: "error",
                        }),
                    })
                  }
                >
                  {impersonate.isPending ? "Generando…" : "Generar magic link"}
                </Button>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Link generado para{" "}
                    <span className="font-medium text-foreground">
                      {impersonateResult.ownerEmail}
                    </span>
                    . Expira en ~1 hora.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={impersonateResult.actionLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-ninja-flameSoft/40 bg-ninja-flame/10 px-3 py-2 text-sm font-medium text-ninja-flameSoft transition hover:bg-ninja-flame/20"
                    >
                      <ExternalLink size={14} /> Abrir en nueva pestaña
                    </a>
                    <button
                      onClick={() => copyToClipboard(impersonateResult.actionLink)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <Copy size={14} /> Copiar link
                    </button>
                    <button
                      onClick={() => setImpersonateResult(null)}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      Generar nuevo
                    </button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Heading className="mt-8" as="h2">
        Notas internas
      </Heading>
      <Card className="mt-3">
        <CardContent className="p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const body = noteBody.trim();
              if (!body) return;
              wrap(
                noteMut.add.mutateAsync(body).then(() => setNoteBody("")),
                "Nota agregada",
              );
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Nota de soporte (solo visible para staff NinjaSoft)…"
              rows={2}
              className="min-h-[44px] flex-1 rounded-lg border border-input bg-background px-4 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            />
            <Button
              type="submit"
              disabled={noteMut.add.isPending || !noteBody.trim()}
              className="sm:self-end"
            >
              {noteMut.add.isPending ? "Guardando…" : "Agregar"}
            </Button>
          </form>

          <ul className="mt-4 divide-y divide-border">
            {notes?.length === 0 && (
              <li className="py-3 text-sm text-muted-foreground">
                Sin notas todavía.
              </li>
            )}
            {notes?.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {n.body}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {n.authorName ?? n.authorEmail ?? "Staff"} ·{" "}
                    {formatRelative(n.created_at)}
                  </p>
                </div>
                <button
                  onClick={() =>
                    wrap(noteMut.remove.mutateAsync(n.id), "Nota eliminada")
                  }
                  title="Eliminar nota"
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Heading className="mt-8" as="h2">
        Feature flags
      </Heading>
      <Card className="mt-3">
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {flags?.map((f) => {
              const effective = f.enabled ?? f.defaultEnabled;
              return (
                <li
                  key={f.key}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div>
                    <div className="font-mono text-sm">{f.key}</div>
                    {f.description && (
                      <div className="text-xs text-muted-foreground">
                        {f.description}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      wrap(
                        setFlag.mutateAsync({ flagKey: f.key, enabled: !effective }),
                        "Flag actualizada",
                      )
                    }
                    className={
                      effective
                        ? "h-6 w-11 rounded-full bg-ninja-flame px-0.5 transition"
                        : "h-6 w-11 rounded-full bg-muted px-0.5 transition"
                    }
                    aria-label={`Toggle ${f.key}`}
                  >
                    <span
                      className={
                        effective
                          ? "block h-5 w-5 translate-x-5 rounded-full bg-white transition"
                          : "block h-5 w-5 translate-x-0 rounded-full bg-white transition"
                      }
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {/* ── Ficha 360: actividad reciente ────────────────────────────────── */}
      <Heading className="mt-8" as="h2">
        Actividad reciente
      </Heading>
      <Card className="mt-3">
        {/* tabs (segmentado) */}
        <div className="border-b border-border p-3">
          <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {(["all", "billing"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setAuditTab(tab)}
                className={
                  auditTab === tab
                    ? "rounded-md bg-ninja-flame/15 px-3 py-1.5 text-sm font-semibold text-ninja-flameSoft transition"
                    : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                }
              >
                {tab === "all" ? "Todo" : "Plan & facturación"}
              </button>
            ))}
          </div>
        </div>
        <CardContent className="p-0">
          {visibleAudit.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              Sin registros de actividad.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {visibleAudit.slice(0, 30).map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {entry.entity_type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {entry.action.replace(/_/g, " ")}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {entry.actorName ?? entry.actorEmail ?? "sistema"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(entry.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
