"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Columns3, Gauge, Handshake, LifeBuoy, Lock, MessageCircleQuestion, Plug, Receipt, Settings2, Tag, Truck, Zap } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useMlAccounts } from "@/modules/mercadolibre/hooks";
import { ACCOUNT_STATUS_LABELS, accountStatusTone } from "@/lib/mercadolibre/labels";
import { GESTOR_SECTIONS, sectionInfo, type GestorSection } from "@/lib/mercadolibre/gestor";
import { MlItemsTab } from "@/components/mercadolibre/MlItemsTab";
import { MlOrdersTab } from "@/components/mercadolibre/MlOrdersTab";
import { MlQuestionsTab } from "@/components/mercadolibre/MlQuestionsTab";
import { MlShipmentsTab } from "@/components/mercadolibre/MlShipmentsTab";
import { MlQuickPublish } from "@/components/mercadolibre/gestor/MlQuickPublish";
import { MlConfigTab } from "@/components/mercadolibre/gestor/MlConfigTab";
import { MlSetupChecklist } from "@/components/mercadolibre/gestor/MlSetupChecklist";
import { MlMetricsTab } from "@/components/mercadolibre/gestor/MlMetricsTab";
import { MlPostsaleTab } from "@/components/mercadolibre/gestor/MlPostsaleTab";
import { MlBoardsTab } from "@/components/mercadolibre/gestor/MlBoardsTab";
import { isConfigSection, type ConfigSection } from "@/lib/mercadolibre/configSections";

const ICONS: Partial<Record<GestorSection, typeof Tag>> = {
  items: Tag,
  orders: Receipt,
  questions: MessageCircleQuestion,
  shipments: Truck,
  postsale: LifeBuoy,
  boards: Columns3,
  metrics: Gauge,
  config: Settings2,
};

const SECTIONS = GESTOR_SECTIONS;
const isSection = (v: string | null): v is GestorSection => SECTIONS.some((s) => s.key === v);

// Gestor de Mercado Libre (H87 · ADR-104, H141 · ADR-132): publicar rápido y
// en varios tipos con su precio, ventas, preguntas, envíos, posventa,
// embudos, métricas y configuración de la cuenta, todo en una pantalla con
// secciones. Dueño o encargado; el servidor exige `mercadolibre` (y
// `mercadolibre_gestor` para posventa, embudos y métricas) en cada escritura.
export default function MercadoLibrePage() {
  return (
    <Suspense fallback={<SpinnerBlock className="py-16" />}>
      <MercadoLibreGestor />
    </Suspense>
  );
}

function MercadoLibreGestor() {
  const enabled = useFeature("mercadolibre");
  const gestor = useFeature("mercadolibre_gestor");
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: accounts = [], isLoading } = useMlAccounts(canManage && enabled === true);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [accountId, setAccountId] = useState<string | null>(null);
  const tabParam = params.get("tab");
  const tab: GestorSection = isSection(tabParam) ? tabParam : "items";
  const cfgParam = params.get("cfg");
  const cfg: ConfigSection = isConfigSection(cfgParam) ? cfgParam : "cuenta";
  const [upgrade, setUpgrade] = useState(false);
  const [quick, setQuick] = useState(false);
  const [upgradeGestor, setUpgradeGestor] = useState(false);

  const setTab = (t: GestorSection, section?: ConfigSection) => {
    const q = new URLSearchParams(params.toString());
    q.set("tab", t);
    if (t === "config" && section) q.set("cfg", section);
    else if (t !== "config") q.delete("cfg");
    router.replace(`${pathname}?${q.toString()}` as Route, { scroll: false });
  };

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0]!.id);
  }, [accounts, accountId]);
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const ready = account?.status === "active";

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Canales"
        title="Mercado Libre"
        icon={Handshake}
        description="Tu cuenta de Mercado Libre manejada desde el POS: publicás tu catálogo en minutos con el precio de cada tipo de publicación, las ventas entran solas con su comisión, respondés reclamos a tiempo y ves cuánto margen te queda para cuidar tu reputación."
        actions={
          <>
            {account && ready && tab !== "items" && (
              <Button size="sm" onClick={() => setQuick(true)}>
                <Zap size={15} /> Publicar rápido
              </Button>
            )}
            <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <Plug size={15} /> Cuentas conectadas
            </Link>
          </>
        }
      />

      <div className="mt-6 space-y-5">
        {enabled === false ? (
          <Callout
            tone="brand"
            icon={Lock}
            title="Mercado Libre no está en tu plan"
            actions={<Button size="sm" onClick={() => setUpgrade(true)}>Ver planes</Button>}
          >
            Conectá tus cuentas, publicá rápido con precios por tipo de publicación, sincronizá stock y precio, y recibí las ventas en el POS desde el plan Pro.
          </Callout>
        ) : !canManage && me ? (
          <Callout tone="info" icon={Lock} title="Sólo dueño o encargado">
            La gestión de Mercado Libre la hace el dueño o un encargado.
          </Callout>
        ) : isLoading || enabled === undefined ? (
          <SpinnerBlock className="py-16" />
        ) : accounts.length === 0 ? (
          <div className="space-y-4">
            <EmptyState
              icon={Plug}
              title="Conectá tu cuenta de Mercado Libre"
              description="Con el usuario administrador de la cuenta. Después vas a poder hacer todo esto desde acá:"
              action={
                <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ size: "sm" })}>
                  Conectar cuenta
                </Link>
              }
            />
            <SectionGuide onPick={null} />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {accounts.length > 1 ? (
                <select
                  className={`${selectCls} sm:w-64`}
                  value={accountId ?? ""}
                  onChange={(e) => setAccountId(e.target.value)}
                  aria-label="Cuenta de Mercado Libre"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname || a.ml_user_id}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm font-medium">{account?.nickname}</span>
              )}
              {account && <Badge tone={accountStatusTone(account.status)}>{ACCOUNT_STATUS_LABELS[account.status] ?? account.status}</Badge>}
            </div>
            {account?.status === "reauth_required" && (
              <Callout tone="warning" title="La conexión venció">
                Reconectá la cuenta en Configuración para que vuelvan a entrar las ventas y se sincronice el stock.
              </Callout>
            )}
            {account && <MlSetupChecklist account={account} onGo={setTab} />}

            <div className="space-y-2">
              <Segmented
                value={tab}
                onChange={setTab}
                aria-label="Secciones de Mercado Libre"
                scrollOnMobile
                options={SECTIONS.map((s) => {
                  const Icon = ICONS[s.key] ?? Tag;
                  return { value: s.key, label: s.label, icon: <Icon size={15} /> };
                })}
              />
              <p className="text-sm text-muted-foreground">{sectionInfo(tab).summary}</p>
            </div>

            {account && tab === "items" && (
              <MlItemsTab accountId={account.id} onQuickPublish={ready ? () => setQuick(true) : undefined} onConfigurePrices={() => setTab("config", "publicaciones")} />
            )}
            {account && tab === "orders" && <MlOrdersTab accountId={account.id} />}
            {account && tab === "questions" && <MlQuestionsTab accountId={account.id} />}
            {account && tab === "shipments" && <MlShipmentsTab key={account.id} account={account} />}
            {account && sectionInfo(tab).feature === "mercadolibre_gestor" && gestor === false && (
              <Callout
                tone="brand"
                icon={Lock}
                title="El gestor de Mercado Libre no está en tu plan"
                actions={<Button size="sm" onClick={() => setUpgradeGestor(true)}>Ver planes</Button>}
              >
                Métricas y reputación con el margen que te queda, posventa con vencimientos y embudos de ventas y reclamos.
              </Callout>
            )}
            {account && gestor && tab === "metrics" && <MlMetricsTab account={account} canManage={canManage} />}
            {account && gestor && tab === "postsale" && <MlPostsaleTab account={account} canManage={canManage} />}
            {account && gestor && tab === "boards" && <MlBoardsTab account={account} canManage={canManage} />}
            {account && tab === "config" && (
              <MlConfigTab account={account} canManage={canManage} section={cfg} onSection={(s) => setTab("config", s)} />
            )}

            <SectionGuide onPick={setTab} />
            {account && ready && <MlQuickPublish open={quick} onOpenChange={setQuick} account={account} />}
          </>
        )}
      </div>
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre" featureLabel="Mercado Libre" />
      <UpgradeModal open={upgradeGestor} onOpenChange={setUpgradeGestor} featureKey="mercadolibre_gestor" featureLabel="Gestor de Mercado Libre" />
    </PageContainer>
  );
}

/** "Qué podés hacer acá": una línea por sección (ir a la sección si hay cuenta). */
function SectionGuide({ onPick }: { onPick: ((s: GestorSection) => void) | null }) {
  return (
    <Disclosure title="Qué podés hacer en Mercado Libre" variant="help" defaultOpen={onPick === null}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {SECTIONS.map((s) => {
          const Icon = ICONS[s.key] ?? Tag;
          const body = (
            <>
              <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="block text-xs text-muted-foreground">{s.summary}</span>
              </span>
            </>
          );
          return (
            <li key={s.key}>
              {onPick ? (
                <button type="button" onClick={() => onPick(s.key)} className={cn("flex w-full gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted")}>
                  {body}
                </button>
              ) : (
                <div className="flex gap-2 rounded-lg px-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}
