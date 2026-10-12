"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  CreditCard,
  ExternalLink,
  Monitor,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  QrCode,
  Receipt,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { TenderLogo } from "@/components/pos/ui/TenderLogo";
import { paymentIcon } from "@/lib/payments/logos";
import { TERMINAL_KIND_LABEL, lastSeenLabel, type PaymentTerminal } from "@/lib/payments/terminals";
import { groupByRegister, providerLogoKey, registerPickHint } from "@/lib/payments/terminalSetup";
import { isIntegratedKind } from "@/lib/payments/terminal/config";
import { useBranchContext, useBranchScope } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";
import { terminalErrorMessage } from "@/modules/config/api";
import { usePaymentTerminals, useTerminalMutations } from "@/modules/config/hooks";
import { posApi } from "@/modules/pos/api";
import { useFeature } from "@/modules/saas/gating";
import { providerLabel } from "./ScopedConfig";
import { TerminalDeviceModal } from "./TerminalDeviceModal";
import { TerminalWizard, draftFromTerminal, newTerminalDraft, type TerminalDraft } from "./TerminalWizard";

// =============================================================================
// Terminales de cobro por sucursal y caja (F17 · H93, ADR-049). BASE.
//
// Registro de los Point de Mercado Pago, Nave Point, Clover, cajas QR de
// Mercado Pago y posnets integrados o sin integrar: sucursal, caja (o toda la
// sucursal), id del proveedor, n° de comercio y por defecto de la caja. El
// POS elige la de su caja sola; las Edges validan en el servidor que la
// terminal sea del negocio y de esa sucursal. El alta es un asistente
// (TerminalWizard) y arriba se explica cómo se relacionan terminal, caja y
// cobro.
// =============================================================================

function lastSeenText(iso: string | null): string {
  return iso ? `Última actividad: ${lastSeenLabel(iso).toLowerCase()}` : "Todavía no se usó";
}

export function TerminalsManager() {
  const ctx = useBranchContext();
  const scope = useBranchScope();
  const { data: terminals, isLoading } = usePaymentTerminals();
  const mut = useTerminalMutations();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<TerminalDraft | null>(null);
  const [archive, setArchive] = useState<PaymentTerminal | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<PaymentTerminal | null>(null);
  const integratedAllowed = useFeature("terminal_integrada") !== false;
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";

  const live = useMemo(() => (terminals ?? []).filter((t) => !t.deleted_at), [terminals]);
  const byStore = useMemo(() => {
    const m = new Map<string, PaymentTerminal[]>();
    for (const t of live) m.set(t.store_id, [...(m.get(t.store_id) ?? []), t]);
    return m;
  }, [live]);

  const branches = ctx.allowed;
  const storeOf = (id: string) => ctx.all.find((b) => b.id === id);
  const registersOf = (storeId: string) => (storeOf(storeId)?.registers ?? []).filter((r) => !r.deleted_at);
  const firstStore = branches[0]?.id ?? "";
  const quickUpdate = (t: PaymentTerminal, patch: { is_default?: boolean; active?: boolean }, ok: string) =>
    mut.update.mutate(
      { id: t.id, patch },
      {
        onSuccess: () => toast({ title: ok, variant: "success" }),
        onError: (e) => toast({ title: terminalErrorMessage(e), variant: "error" }),
      },
    );

  // Caja QR de MP propia de una caja: usa la dirección de la sucursal.
  const createQrFor = async (registerId: string) => {
    const store = ctx.all.find((b) => b.registers.some((r) => r.id === registerId));
    const m = (store?.address ?? "").match(/^(.*?)\s+(\d+)\b/);
    if (!store || !m || !store.city || !store.province) {
      toast({
        title: "Completá la dirección de la sucursal",
        description: "Calle con número, ciudad y provincia en Sucursales y cajas: Mercado Pago las pide para la caja QR.",
        variant: "error",
      });
      return;
    }
    setQrFor(registerId);
    try {
      await posApi.mpQrSetup({
        name: store.name,
        street_name: m[1]!.trim(),
        street_number: m[2]!,
        city_name: store.city,
        state_name: store.province,
        cash_register_id: registerId,
      });
      toast({ title: "Caja QR creada para la caja", variant: "success" });
      await qc.invalidateQueries({ queryKey: ["payment-terminals"] });
    } catch (e) {
      toast({
        title: "No se pudo crear la caja QR",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setQrFor(null);
    }
  };

  if (isLoading) return null;
  const empty = live.length === 0;
  return (
    <div className="space-y-4">
      <SettingsCard
        title="Cómo funcionan las terminales"
        description="Registrás cada equipo una vez y el POS lo usa solo al cobrar."
        actions={
          canManage && !empty && firstStore ? (
            <Button size="sm" onClick={() => setDraft(newTerminalDraft(firstStore))}>
              <Plus size={14} /> Agregar terminal
            </Button>
          ) : undefined
        }
        padded
      >
        <ol className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]" aria-label="Terminal, caja y cobro">
          <FlowItem n={1} icon={CreditCard} title="Terminal" text="El equipo que cobra: Point, Clover, caja QR o posnet conectado." />
          <FlowLink />
          <FlowItem n={2} icon={Monitor} title="Caja" text="Cada terminal va en una caja o queda para toda la sucursal." />
          <FlowLink />
          <FlowItem
            n={3}
            icon={Receipt}
            title="Cobro"
            text="Al cobrar, el POS usa la terminal de su caja sin preguntar y registra el pago solo."
          />
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          ¿Cobrás con un posnet sin integrar? No hace falta registrarlo: el cajero carga el cupón.{" "}
          <Link
            href={"/configuracion?seccion=posnet" as never}
            className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
          >
            Configurar Tarjeta en posnet <ExternalLink size={12} aria-hidden />
          </Link>
        </p>
      </SettingsCard>

      {empty ? (
        <SettingsCard>
          <EmptyState
            icon={CreditCard}
            title="Todavía no registraste terminales"
            description="Agregá la primera y te guiamos paso a paso: qué tipo es, en qué caja está, cómo se identifica y con qué datos sale el cupón."
            action={
              canManage && firstStore ? (
                <Button onClick={() => setDraft(newTerminalDraft(firstStore))}>
                  <Plus size={15} /> Agregar la primera terminal
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Las da de alta el dueño o un encargado.</p>
              )
            }
          />
        </SettingsCard>
      ) : (
        branches.map((b) => {
          const list = byStore.get(b.id) ?? [];
          const groups = groupByRegister(list, registersOf(b.id));
          const floatingCount = list.filter((t) => !t.cash_register_id && t.active).length;
          return (
            <SettingsCard
              key={b.id}
              title={
                <span className="flex items-center gap-2">
                  <BranchDot branch={b} /> {branchLabel(b)}
                </span>
              }
              description={list.length === 0 ? "Sin terminales" : `${list.length} terminal${list.length > 1 ? "es" : ""}`}
              actions={
                canManage ? (
                  <Button size="sm" variant="secondary" onClick={() => setDraft(newTerminalDraft(b.id))}>
                    <Plus size={14} /> Agregar en esta sucursal
                  </Button>
                ) : undefined
              }
            >
              {groups.map((g) => (
                <div key={g.registerId ?? "store"} className="px-5 py-4">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-semibold">
                        <Monitor size={14} className="text-muted-foreground" aria-hidden /> {g.name}
                      </p>
                      <p className="text-xs text-muted-foreground">{registerPickHint(g, floatingCount)}</p>
                    </div>
                    {g.registerId && canManage && (
                      <span className="flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDraft(newTerminalDraft(b.id, g.registerId))}>
                          <Plus size={13} /> Terminal
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={qrFor === g.registerId}
                          onClick={() => createQrFor(g.registerId!)}
                        >
                          <QrCode size={13} /> {qrFor === g.registerId ? "Creando" : "Caja QR propia"}
                        </Button>
                      </span>
                    )}
                  </div>
                  {g.terminals.length > 0 && (
                    <ul className="space-y-2">
                      {g.terminals.map((t) => (
                        <TerminalRow
                          key={t.id}
                          t={t}
                          canManage={canManage}
                          onConnect={() => setConnectFor(t)}
                          onDefault={() => quickUpdate(t, { is_default: true }, `${t.label} queda por defecto`)}
                          onToggle={() =>
                            quickUpdate(t, { active: !t.active }, t.active ? `${t.label} pausada` : `${t.label} activa`)
                          }
                          onEdit={() => setDraft(draftFromTerminal(t))}
                          onArchive={() => setArchive(t)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </SettingsCard>
          );
        })
      )}

      {draft && (
        <TerminalWizard
          initial={draft}
          onClose={() => setDraft(null)}
          branches={branches}
          registersOf={registersOf}
          terminals={live}
          integratedAllowed={integratedAllowed}
          onCreateQr={createQrFor}
          onCreatedIntegrated={setConnectFor}
        />
      )}

      {connectFor && <TerminalDeviceModal terminal={connectFor} onClose={() => setConnectFor(null)} />}

      <ConfirmDialog
        open={Boolean(archive)}
        onOpenChange={(o) => !o && setArchive(null)}
        title={`Archivar ${archive?.label ?? "terminal"}`}
        description="Deja de ofrecerse en el POS. Los cobros que ya pasaron por ella no cambian."
        confirmLabel="Archivar"
        danger
        loading={mut.archive.isPending}
        onConfirm={() =>
          archive &&
          mut.archive.mutate(archive.id, {
            onSuccess: () => setArchive(null),
            onError: (e) => toast({ title: terminalErrorMessage(e), variant: "error" }),
          })
        }
      />
    </div>
  );
}

function FlowItem({ n, icon: Icon, title, text }: { n: number; icon: LucideIcon; title: string; text: string }) {
  return (
    <li className="flex gap-3 rounded-lg bg-muted/50 p-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-card text-foreground" aria-hidden>
        <Icon size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">
          <span className="text-muted-foreground">{n}.</span> {title}
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{text}</span>
      </span>
    </li>
  );
}

function FlowLink() {
  return (
    <li aria-hidden className="hidden place-items-center text-muted-foreground sm:grid">
      <ArrowLeftRight size={16} />
    </li>
  );
}

function TerminalRow({
  t,
  canManage,
  onConnect,
  onDefault,
  onToggle,
  onEdit,
  onArchive,
}: {
  t: PaymentTerminal;
  canManage: boolean;
  onConnect: () => void;
  onDefault: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <li className="rounded-lg border border-border">
      <div className="flex min-w-0 items-start gap-3 p-3">
        <TenderLogo
          source={{ logo: paymentIcon(providerLogoKey(t.provider_key)) }}
          alt={providerLabel(t.provider_key)}
          size={32}
          fallback="card"
        />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            {t.label}
            {t.active ? <Badge tone="success">Activa</Badge> : <Badge tone="warning">Pausada</Badge>}
            {t.is_default && t.cash_register_id && (
              <Badge tone="neutral">
                <Star size={11} className="mr-0.5 inline fill-current" aria-hidden /> Por defecto
              </Badge>
            )}
            {t.environment === "test" && <Badge tone="info">Prueba</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {providerLabel(t.provider_key)} · {TERMINAL_KIND_LABEL[t.kind]}
          </p>
          {(t.external_id || t.merchant_number) && (
            <p className="break-all text-xs text-muted-foreground">
              {t.external_id && <span className="font-mono">{t.external_id}</span>}
              {t.external_id && t.merchant_number ? " · " : ""}
              {t.merchant_number ? `Comercio ${t.merchant_number}` : ""}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{lastSeenText(t.last_seen_at)}</p>
        </div>
      </div>
      {canManage && (
        <span className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
          {isIntegratedKind(t.kind) && (
            <Button size="sm" variant="secondary" onClick={onConnect}>
              <Plug size={13} /> Conectar
            </Button>
          )}
          {t.cash_register_id && !t.is_default && (
            <Button size="sm" variant="ghost" onClick={onDefault} aria-label={`Usar ${t.label} por defecto`} title="Usar por defecto">
              <Star size={13} /> <span className="hidden sm:inline">Usar por defecto</span>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onToggle} aria-label={`${t.active ? "Pausar" : "Activar"} ${t.label}`} title={t.active ? "Pausar" : "Activar"}>
            {t.active ? <Pause size={13} /> : <Play size={13} />}{" "}
            <span className="hidden sm:inline">{t.active ? "Pausar" : "Activar"}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil size={13} /> Editar
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Archivar ${t.label}`} title="Archivar" onClick={onArchive} className="ml-auto">
            <Trash2 size={13} />
          </Button>
        </span>
      )}
    </li>
  );
}
