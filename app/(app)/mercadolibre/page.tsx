"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Handshake, Lock, MessageCircleQuestion, Plug, Receipt, Tag, Truck, Warehouse } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { selectCls } from "@/components/stock/transfers/shared";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useMlAccounts } from "@/modules/mercadolibre/hooks";
import { ACCOUNT_STATUS_LABELS, accountStatusTone } from "@/lib/mercadolibre/labels";
import { MlItemsTab } from "@/components/mercadolibre/MlItemsTab";
import { MlOrdersTab } from "@/components/mercadolibre/MlOrdersTab";
import { MlQuestionsTab } from "@/components/mercadolibre/MlQuestionsTab";
import { MlShipmentsTab } from "@/components/mercadolibre/MlShipmentsTab";
import { MlFullTab } from "@/components/mercadolibre/full/MlFullTab";

type Tab = "items" | "orders" | "questions" | "shipments" | "full";

// Mercado Libre (H87 · ADR-104): publicaciones vinculadas con el catálogo,
// ventas que entraron al POS con su comisión y factura, preguntas para
// responder y envíos con etiquetas. Dueño o encargado; el servidor exige la
// feature `mercadolibre` en cada escritura. Full (ADR-142): depósito virtual,
// envíos a Full y etiquetas, con la feature `mercadolibre_full`.
export default function MercadoLibrePage() {
  const enabled = useFeature("mercadolibre");
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: accounts = [], isLoading } = useMlAccounts(canManage && enabled === true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("items");
  const [upgrade, setUpgrade] = useState(false);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0]!.id);
  }, [accounts, accountId]);
  const account = accounts.find((a) => a.id === accountId) ?? null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Canales"
        title="Mercado Libre"
        icon={Handshake}
        description="Publicaciones, ventas, preguntas y envíos de tus cuentas de Mercado Libre, con el stock y el precio del POS."
        actions={
          <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Plug size={15} /> Cuentas y configuración
          </Link>
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
            Conectá tus cuentas, sincronizá stock y precio, y recibí las ventas en el POS desde el plan Pro.
          </Callout>
        ) : !canManage && me ? (
          <Callout tone="info" icon={Lock} title="Sólo dueño o encargado">
            La gestión de Mercado Libre la hace el dueño o un encargado.
          </Callout>
        ) : isLoading || enabled === undefined ? (
          <SpinnerBlock className="py-16" />
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="Conectá tu primera cuenta de Mercado Libre"
            description="Desde Configuración > Integraciones > Mercado Libre, con el usuario administrador de la cuenta."
            action={
              <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ size: "sm" })}>
                Conectar cuenta
              </Link>
            }
          />
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
            <Segmented
              value={tab}
              onChange={setTab}
              aria-label="Secciones de Mercado Libre"
              iconOnlyOnMobile
              options={[
                { value: "items", label: "Publicaciones", icon: <Tag size={15} /> },
                { value: "orders", label: "Ventas", icon: <Receipt size={15} /> },
                { value: "questions", label: "Preguntas", icon: <MessageCircleQuestion size={15} /> },
                { value: "shipments", label: "Envíos", icon: <Truck size={15} /> },
                { value: "full", label: "Full", icon: <Warehouse size={15} /> },
              ]}
            />
            {account && tab === "items" && <MlItemsTab accountId={account.id} />}
            {account && tab === "orders" && <MlOrdersTab accountId={account.id} />}
            {account && tab === "questions" && <MlQuestionsTab accountId={account.id} />}
            {account && tab === "shipments" && <MlShipmentsTab key={account.id} account={account} />}
            {account && tab === "full" && <MlFullTab key={account.id} account={account} canManage={canManage} />}
          </>
        )}
      </div>
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre" featureLabel="Mercado Libre" />
    </PageContainer>
  );
}
