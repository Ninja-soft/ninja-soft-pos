"use client";

import { useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CreditCard,
  ExternalLink,
  Flag,
  Landmark,
  LayoutGrid,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Trash2,
  Users,
} from "lucide-react";
import { BillingCard } from "@/components/internal/BillingCard";
import { BillingProfileInternalCard } from "@/components/internal/BillingProfileInternalCard";
import { PlanCard } from "@/components/internal/PlanCard";
import { TenantLimitsCard } from "@/components/internal/TenantLimitsCard";
import { SearchField } from "@/components/ui/SearchField";
import { TenantLedgerTab } from "@/components/internal/billing/TenantLedgerTab";
import { ImpersonationCard } from "@/components/internal/ImpersonationCard";
import { Tenant360Card } from "@/components/internal/Tenant360Card";
import { TenantMembersCard } from "@/components/internal/TenantMembersCard";
import { TenantAuditTimeline } from "@/components/internal/TenantAuditTimeline";
import { TenantLifecycleCard } from "@/components/internal/TenantLifecycleCard";
import { ActivationCard } from "@/components/internal/ActivationCard";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Display } from "@/components/ui/Typography";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { createCheckoutLink } from "@/modules/billing/collection";
import { billingErrorMessage } from "@/lib/billing/ledger";
import {
  useInternalTenants,
  useTenantFlags,
  useInternalMutations,
  useTenantHealth,
  useTenantNotes,
  useTenantNoteMutations,
  useMyStaffLevel,
  useTenantAddons,
  useGiftAiAddon,
  AI_ASSISTANT_ADDON_KEY,
} from "@/modules/internal/hooks";
import { VERTICALS, VERTICAL_LABELS } from "@/lib/verticals/config";
import { TenantProfileCard } from "@/components/internal/TenantProfileCard";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  EDITABLE_STATUSES,
  lifecycleErrorMessage,
  lifecycleState,
} from "@/lib/internal/tenantLifecycle";

const STATUSES = [
  { key: "trial", name: "Trial" },
  { key: "active", name: "Activo" },
  { key: "past_due", name: "Pago pendiente" },
  { key: "suspended", name: "Suspendido" },
  { key: "cancelled", name: "Cancelado" },
];
const STATUS_TONE: Record<string, BadgeTone> = {
  trial: "info",
  active: "success",
  past_due: "warning",
  suspended: "danger",
  cancelled: "neutral",
  deleted: "neutral",
};

const TABS = [
  { value: "resumen", label: "Resumen", icon: <LayoutGrid size={15} /> },
  { value: "plan", label: "Plan y cobro", icon: <CreditCard size={15} /> },
  { value: "cuenta", label: "Cuenta corriente", icon: <Landmark size={15} /> },
  { value: "miembros", label: "Miembros y acceso", icon: <Users size={15} /> },
  { value: "config", label: "Configuración", icon: <SlidersHorizontal size={15} /> },
  { value: "auditoria", label: "Auditoría", icon: <ScrollText size={15} /> },
] as const;
type Tab = (typeof TABS)[number]["value"];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.value === v);

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "Sin datos";
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "resumen";
  function setTab(next: Tab) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "resumen") sp.delete("tab");
    else sp.set("tab", next);
    const qs = sp.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
  }

  const { data: tenants, isLoading: tenantsLoading } = useInternalTenants();
  const tenant = tenants?.find((t) => t.id === params.id);
  const { data: flags, isLoading: flagsLoading } = useTenantFlags(params.id);
  const { data: healthMap } = useTenantHealth();
  const health = healthMap?.get(params.id);
  const { data: notes, isLoading: notesLoading } = useTenantNotes(params.id);
  const noteMut = useTenantNoteMutations(params.id);
  const [noteBody, setNoteBody] = useState("");
  const [flagQuery, setFlagQuery] = useState("");
  const visibleFlags = (flags ?? []).filter((f) => {
    const q = flagQuery.trim().toLowerCase();
    return !q || f.key.toLowerCase().includes(q) || (f.description ?? "").toLowerCase().includes(q);
  });
  const { setStatus, setFlag, setIndustry } = useInternalMutations(
    params.id,
  );
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // Nivel del staff actual (para mostrar/ocultar impersonation y acciones).
  const { level: myLevel } = useMyStaffLevel();
  const canImpersonate = myLevel === "super_admin" || myLevel === "admin";
  const lcState = tenant
    ? lifecycleState({ status: tenant.status, deletedAt: tenant.deletedAt })
    : "operating";

  // Regalar el Asistente IA a ESTE negocio (addon bonificado, sin cobro).
  const { data: tenantAddons } = useTenantAddons(params.id);
  const hasAiAddon = tenantAddons?.has(AI_ASSISTANT_ADDON_KEY) ?? false;
  const giftAi = useGiftAiAddon(params.id);

  // Genera el link de suscripción (preapproval) de Mercado Pago para el tenant.
  // Si el negocio está en cuenta corriente, la Edge responde
  // billing_mode_not_mp: el pase a MP se pide con Cambiar modalidad (ADR-120).
  const checkout = useMutation({
    mutationFn: async () => {
      const res = await createCheckoutLink(params.id);
      if (!res.url) throw new Error(res.error ?? "sin_link");
      return res.url;
    },
    onSuccess: (u) => {
      setCheckoutUrl(u);
      toast({ title: "Link de cobro generado", variant: "success" });
    },
    onError: (e: Error) =>
      toast({ title: "No se pudo generar", description: billingErrorMessage(e), variant: "error" }),
  });

  function wrap(p: Promise<unknown>, ok: string) {
    p.then(() => toast({ title: ok, variant: "success" })).catch((e) =>
      toast({
        title: "Error",
        description: lifecycleErrorMessage(
          e instanceof Error ? e.message : (e as { message?: string } | null)?.message,
        ),
        variant: "error",
      }),
    );
  }

  const stKey = tenant?.deletedAt ? "deleted" : tenant?.subStatus ?? tenant?.status;
  const stLabel =
    stKey === "deleted"
      ? "Dado de baja"
      : STATUSES.find((s) => s.key === stKey)?.name ?? stKey;
  const currentStatus = tenant?.subStatus ?? tenant?.status ?? "trial";
  const statusOptions = [
    ...(lcState !== "operating"
      ? [
          {
            value: currentStatus,
            label:
              STATUSES.find((s) => s.key === currentStatus)?.name ?? "Fuera de operación",
          },
        ]
      : []),
    ...EDITABLE_STATUSES.map((s) => ({ value: s.key as string, label: s.name })),
  ];

  const healthKpis = [
    { label: "Último login", value: health ? formatRelative(health.last_login_at) : null },
    { label: "Última venta", value: health ? formatRelative(health.last_sale_at) : null },
    {
      label: "Ventas (7 días)",
      value: health ? String(health.sales_7d_count) : null,
      sub: health ? formatCurrency(health.sales_7d_total) : undefined,
    },
    { label: "Usuarios activos", value: health ? String(health.active_users) : null },
  ];

  return (
    <>
      <Link
        href="/internal/tenants"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft size={15} /> Negocios
      </Link>

      {/* ── Encabezado ───────────────────────────────────────────────────── */}
      <header className="mt-3 flex items-start gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted text-base font-bold text-muted-foreground">
          {tenant?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenant.logoUrl} alt="" className="h-full w-full object-contain" />
          ) : tenant ? (
            (tenant.name[0] ?? "?").toUpperCase()
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {tenant ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Display className="break-words text-2xl md:text-3xl">{tenant.name}</Display>
              {stKey && <Badge tone={STATUS_TONE[stKey] ?? "neutral"}>{stLabel}</Badge>}
              {tenant.planName && <Badge tone="brand">{tenant.planName}</Badge>}
            </div>
          ) : tenantsLoading ? (
            <Skeleton className="h-8 w-56" />
          ) : (
            <Display className="text-2xl md:text-3xl">Negocio no encontrado</Display>
          )}
          <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {tenant?.slug && (
              <div>
                <dt className="sr-only">Slug</dt>
                <dd className="font-mono text-xs leading-5">{tenant.slug}</dd>
              </div>
            )}
            {tenant?.ownerEmail && (
              <div className="min-w-0">
                <dt className="sr-only">Dueño</dt>
                <dd className="truncate">
                  <span className="font-medium text-foreground">
                    {tenant.ownerName ?? tenant.ownerEmail}
                  </span>
                  {tenant.ownerName && <span className="ml-1">{tenant.ownerEmail}</span>}
                </dd>
              </div>
            )}
            {tenant && (
              <div>
                <dt className="inline">Alta </dt>
                <dd className="inline text-foreground">{fmtDate(tenant.created_at)}</dd>
              </div>
            )}
            {tenant?.trial_ends_at && (
              <div>
                <dt className="inline">Trial hasta </dt>
                <dd
                  className={
                    new Date(tenant.trial_ends_at) < new Date()
                      ? "inline font-medium text-danger"
                      : "inline font-medium text-foreground"
                  }
                >
                  {fmtDate(tenant.trial_ends_at)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </header>

      {/* ── Pestañas ─────────────────────────────────────────────────────── */}
      <div className="slim-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented<Tab>
          aria-label="Secciones del negocio"
          value={tab}
          onChange={setTab}
          options={TABS.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))}
          className="max-w-none flex-nowrap"
        />
      </div>

      <div className="mt-6 space-y-8">
        {/* ── Resumen ───────────────────────────────────────────────────── */}
        {tab === "resumen" && (
          <>
            {tenant && (
              <TenantLifecycleCard
                tenant={{
                  id: tenant.id,
                  slug: tenant.slug,
                  status: tenant.status,
                  deletedAt: tenant.deletedAt,
                }}
                level={myLevel}
              />
            )}

            <section>
              <SectionHeader
                title="Salud operativa"
                description="Último uso real del sistema por parte del negocio."
              />
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {healthKpis.map((kpi) => (
                  <Card key={kpi.label}>
                    <CardContent className="p-4">
                      <div className="text-xs font-medium text-muted-foreground">{kpi.label}</div>
                      {kpi.value === null ? (
                        <Skeleton className="mt-2 h-6 w-20" />
                      ) : (
                        <div className="mt-1 truncate text-lg font-semibold tabular-nums text-foreground">
                          {kpi.value}
                        </div>
                      )}
                      {kpi.sub && (
                        <div className="truncate text-xs tabular-nums text-muted-foreground">
                          {kpi.sub}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <section>
              <SectionHeader
                title="Ficha 360"
                description="Uso, módulos efectivos y últimos errores del negocio."
              />
              <Tenant360Card
                tenantId={params.id}
                status={tenant?.deletedAt ? "cancelled" : tenant?.subStatus ?? tenant?.status ?? null}
                createdAt={tenant?.created_at ?? null}
                trialEndsAt={tenant?.trial_ends_at ?? null}
              />
            </section>

            <section>
              <SectionHeader
                title="Activación"
                description="Hitos de puesta en marcha desde el alta."
              />
              <ActivationCard tenantId={params.id} />
            </section>

            <section>
              <SectionHeader title="Rubro y perfil" />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Card>
                  <CardContent className="p-5">
                    <Select
                      label="Rubro"
                      value={tenant?.industry ?? "otro"}
                      options={VERTICALS.map((v) => ({ value: v as string, label: VERTICAL_LABELS[v] }))}
                      onChange={(v) => wrap(setIndustry.mutateAsync(v), "Rubro actualizado")}
                    />
                  </CardContent>
                </Card>
                <TenantProfileCard tenantId={params.id} />
              </div>
            </section>
          </>
        )}

        {/* ── Plan y cobro ──────────────────────────────────────────────── */}
        {tab === "plan" && (
          <>
            <PlanCard tenantId={params.id} />

            <Card>
              <CardContent className="grid gap-2 p-5 sm:grid-cols-[minmax(0,320px)_1fr] sm:items-start sm:gap-5">
                <Select
                  label="Estado de suscripción"
                  value={currentStatus}
                  options={statusOptions}
                  disabled={lcState !== "operating"}
                  onChange={(v) => wrap(setStatus.mutateAsync(v), "Estado actualizado")}
                />
                <p className="text-xs leading-relaxed text-muted-foreground sm:pt-8">
                  {lcState === "operating"
                    ? "Suspender, cancelar o reactivar se hace desde Ciclo de vida, en Resumen (pide motivo)."
                    : "Reactivá el negocio desde Ciclo de vida, en Resumen, para cambiar el estado."}
                </p>
              </CardContent>
            </Card>

            <BillingCard
              tenantId={params.id}
              trialEndsAt={tenant?.trial_ends_at ?? null}
              subStatus={tenant?.subStatus ?? null}
              planKey={tenant?.planKey ?? null}
            />

            <BillingProfileInternalCard tenantId={params.id} />

            <section>
              <SectionHeader
                title="Cobro de suscripción"
                description="Crea una suscripción en Mercado Pago con la cuenta de NinjaSoft por el plan del negocio. El estado se actualiza solo cuando el cliente paga. Para pasar un negocio de cuenta corriente a débito automático, usá Cambiar modalidad en Cuenta corriente."
              />
              <Card className="mt-3">
                <CardContent className="flex flex-wrap items-center gap-3 p-5">
                  <Button loading={checkout.isPending} onClick={() => checkout.mutate()}>
                    Generar link de cobro
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
                </CardContent>
              </Card>
            </section>

            <section>
              <SectionHeader
                title="Asistente IA"
                description="Activa el complemento sin cobro (bonificado) para este negocio. Para un único tester global, usá el email de la beta en la configuración interna de IA."
              />
              <Card className="mt-3">
                <CardContent className="flex flex-wrap items-center gap-3 p-5">
                  {hasAiAddon ? (
                    <>
                      <Badge tone="success">
                        <Check size={13} /> Activo (regalado)
                      </Badge>
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
                </CardContent>
              </Card>
            </section>
          </>
        )}

        {/* ── Cuenta corriente (F20-1 · ADR-115) ────────────────────────── */}
        {tab === "cuenta" && <TenantLedgerTab tenantId={params.id} tenantName={tenant?.name ?? "El negocio"} />}

        {/* ── Miembros y acceso ─────────────────────────────────────────── */}
        {tab === "miembros" && (
          <>
            <section>
              <SectionHeader title="Miembros" />
              <TenantMembersCard tenantId={params.id} />
            </section>

            {canImpersonate && (
              <section>
                <SectionHeader title="Acceder como este negocio" />
                <ImpersonationCard tenantId={params.id} />
              </section>
            )}

            <section>
              <SectionHeader
                title="Notas internas"
                description="Sólo las ve el staff de NinjaSoft."
              />
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
                    <label htmlFor="tenant-note" className="sr-only">
                      Nueva nota
                    </label>
                    <textarea
                      id="tenant-note"
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder="Nota de soporte"
                      rows={2}
                      className="min-h-[44px] flex-1 rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
                    />
                    <Button
                      type="submit"
                      loading={noteMut.add.isPending}
                      disabled={!noteBody.trim()}
                      className="sm:self-end"
                    >
                      Agregar
                    </Button>
                  </form>

                  {notesLoading ? (
                    <SkeletonLines lines={3} className="mt-5" />
                  ) : notes?.length === 0 ? (
                    <EmptyState
                      compact
                      icon={StickyNote}
                      title="Sin notas todavía"
                      description="Dejá contexto para el resto del equipo: acuerdos, reclamos o pendientes."
                      className="mt-2"
                    />
                  ) : (
                    <ul className="mt-4 divide-y divide-border">
                      {notes?.map((n) => (
                        <li key={n.id} className="flex items-start gap-3 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                              {n.body}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {n.authorName ?? n.authorEmail ?? "Staff"} ·{" "}
                              {formatRelative(n.created_at)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              wrap(noteMut.remove.mutateAsync(n.id), "Nota eliminada")
                            }
                            aria-label="Eliminar nota"
                            title="Eliminar nota"
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>
          </>
        )}

        {/* ── Configuración: límites del plan y feature flags ───────────── */}
        {tab === "config" && (
          <>
          <TenantLimitsCard tenantId={params.id} />
          <section>
            <SectionHeader
              title="Feature flags"
              icon={Flag}
              description="Interruptores técnicos por negocio. Si no hay override, vale el default de la plataforma."
              actions={
                flags && flags.length > 0 ? (
                  <Badge tone="neutral">
                    {flags.filter((f) => f.enabled !== null && f.enabled !== undefined).length} con override
                  </Badge>
                ) : undefined
              }
            />
            {flags && flags.length > 6 && (
              <SearchField
                value={flagQuery}
                onValueChange={setFlagQuery}
                placeholder="Buscar flag"
                aria-label="Buscar feature flag"
                className="mt-3 sm:max-w-xs"
              />
            )}
            <Card className="mt-3 overflow-hidden">
              {flagsLoading ? (
                <div className="p-5">
                  <SkeletonLines lines={6} />
                </div>
              ) : !flags || flags.length === 0 ? (
                <EmptyState compact icon={SlidersHorizontal} title="Sin feature flags" />
              ) : visibleFlags.length === 0 ? (
                <EmptyState compact icon={SlidersHorizontal} title="Ningún flag coincide" />
              ) : (
                <ul className="divide-y divide-border">
                  {visibleFlags.map((f) => {
                    const effective = f.enabled ?? f.defaultEnabled;
                    return (
                      <li
                        key={f.key}
                        className="flex items-center justify-between gap-4 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-sm">{f.key}</span>
                            {f.enabled !== null && f.enabled !== undefined && (
                              <Badge tone="neutral">Override</Badge>
                            )}
                          </div>
                          {f.description && (
                            <div className="text-xs text-muted-foreground">{f.description}</div>
                          )}
                          <div className="text-xs text-muted-foreground">
                            Default de la plataforma: {f.defaultEnabled ? "activo" : "apagado"}
                          </div>
                        </div>
                        <Switch
                          checked={effective}
                          label={`Activar ${f.key}`}
                          onCheckedChange={(v) =>
                            wrap(
                              setFlag.mutateAsync({ flagKey: f.key, enabled: v }),
                              "Flag actualizada",
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>
          </>
        )}

        {/* ── Auditoría del negocio (timeline filtrable, ADR-073) ───────── */}
        {tab === "auditoria" && (
          <section>
            <SectionHeader title="Auditoría" description="Todo lo que pasó en este negocio, filtrable." />
            <TenantAuditTimeline tenantId={params.id} />
          </section>
        )}
      </div>
    </>
  );
}
