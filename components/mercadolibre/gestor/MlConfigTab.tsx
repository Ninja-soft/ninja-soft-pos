"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  BadgePercent,
  CheckCircle2,
  Circle,
  CircleDashed,
  ExternalLink,
  FileText,
  LifeBuoy,
  Lock,
  MessageCircleQuestion,
  Package,
  Plug,
  RefreshCw,
  Tag,
  Truck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { AccountConfig } from "@/components/integrations/mercadolibre/MlSettings";
import { cn } from "@/lib/utils/cn";
import { ACCOUNT_STATUS_LABELS, LOGISTIC_LABELS, accountStatusTone, mlErrorMessage } from "@/lib/mercadolibre/labels";
import { CONFIG_SECTIONS, SHIPPING_MODE_NAMES, configStatus, type ConfigSection, type SectionStatus } from "@/lib/mercadolibre/configSections";
import { useFeature } from "@/modules/saas/gating";
import {
  mlPublishApi,
  useMlAccountShipping,
  useMlCategoryMemory,
  useMlItems,
  useMlListingRules,
  useMlMutations,
  useMlWebhookSeen,
  type MlAccount,
} from "@/modules/mercadolibre/hooks";
import { useMlGestorSettings, useMlTemplates } from "@/modules/mercadolibre/gestorHooks";
import { MlListingRulesEditor } from "./MlListingRulesEditor";
import { MlGestorConfig } from "./MlGestorConfig";
import { MlBillingExtension } from "./config/MlBillingExtension";

// Configuración de Mercado Libre por secciones: Cuenta, Publicaciones y
// precios, Envíos, Facturación, Posventa y Preguntas. Cada sección explica qué
// se configura, muestra si está lista o qué falta y guarda sólo lo suyo.
// Conectar o desconectar cuentas sigue en Configuración > Integraciones.

const ICONS: Record<ConfigSection, LucideIcon> = {
  cuenta: UserRound,
  publicaciones: Tag,
  envios: Truck,
  facturacion: FileText,
  posventa: LifeBuoy,
  preguntas: MessageCircleQuestion,
};

function StatusBadge({ s }: { s: SectionStatus }) {
  const tone = s.state === "ok" ? "success" : s.state === "missing" ? "warning" : "neutral";
  const Icon = s.state === "ok" ? CheckCircle2 : s.state === "missing" ? Circle : CircleDashed;
  return (
    <Badge tone={tone}>
      {s.state === "loading" ? <Spinner size={12} /> : <Icon size={12} aria-hidden />}
      {s.label}
    </Badge>
  );
}

function when(iso: string | null): string {
  if (!iso) return "Nunca";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

export function MlConfigTab({
  account,
  canManage,
  section,
  onSection,
}: {
  account: MlAccount;
  canManage: boolean;
  section: ConfigSection;
  onSection: (s: ConfigSection) => void;
}) {
  const gestor = useFeature("mercadolibre_gestor");
  const { data: rules = [] } = useMlListingRules(account.id);
  // "Facturo a mano" de la puesta en marcha (preferencia del navegador).
  const [invoiceConfirmed, setInvoiceConfirmed] = useState(false);
  useEffect(() => {
    try {
      setInvoiceConfirmed(window.localStorage.getItem(`ml-setup-invoice-ok:${account.id}`) === "1");
    } catch {
      setInvoiceConfirmed(false);
    }
  }, [account.id]);
  const shipping = useMlAccountShipping(account.id);
  const { data: gestorSettings } = useMlGestorSettings(gestor ? account.id : null);
  const { data: questionTemplates = [] } = useMlTemplates(gestor ? "question" : null);
  const status = configStatus({
    status: account.status,
    storeId: account.location?.store_id ?? null,
    rulesCount: rules.length,
    invoiceMode: account.invoice_mode,
    invoiceConfirmed,
    mercadoEnvios: shipping.isLoading ? undefined : shipping.isError ? null : (shipping.data?.mercadoenvios ?? null),
    gestor,
    gestorConfigured: Boolean(gestorSettings),
    questionTemplates: gestor ? questionTemplates.filter((t) => t.scope === "question").length : 0,
  });
  const info = CONFIG_SECTIONS.find((s) => s.key === section)!;
  const pending = CONFIG_SECTIONS.filter((s) => status[s.key].state === "missing");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Segmented<ConfigSection>
          value={section}
          onChange={onSection}
          aria-label="Secciones de la configuración de Mercado Libre"
          size="sm"
          scrollOnMobile
          options={CONFIG_SECTIONS.map((s) => {
            const Icon = ICONS[s.key];
            return { value: s.key, label: s.label, icon: <Icon size={14} /> };
          })}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{info.summary}</p>
          <StatusBadge s={status[section]} />
        </div>
        {pending.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Falta completar:{" "}
            {pending.map((s, i) => (
              <span key={s.key}>
                {i > 0 && ", "}
                <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onSection(s.key)}>
                  {s.label}
                </button>
              </span>
            ))}
            .
          </p>
        )}
      </div>

      {section === "cuenta" && <AccountSection account={account} canManage={canManage} />}
      {section === "publicaciones" && <ListingsSection account={account} canManage={canManage} />}
      {section === "envios" && <ShippingSection account={account} canManage={canManage} />}
      {section === "facturacion" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Las ventas de Mercado Libre se facturan con ARCA desde el POS. Elegí cuándo, si la factura se sube sola a la venta y las reglas.
            </p>
            <StatusBadge s={status.facturacion} />
          </div>
          {/* ADR-141: la configuración completa de facturación (base + reglas) vive acá. */}
          <MlBillingExtension account={account} canManage={canManage} />
        </div>
      )}
      {(section === "posventa" || section === "preguntas") &&
        (gestor === undefined ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : gestor ? (
          <MlGestorConfig account={account} canManage={canManage} part={section === "posventa" ? "postsale" : "questions"} />
        ) : (
          <Callout tone="brand" icon={Lock} title="Está en el gestor de Mercado Libre">
            {section === "posventa"
              ? "Umbrales de reputación, avisos de reclamos y plantillas de respuesta vienen con el gestor de Mercado Libre. Las preguntas y las ventas siguen funcionando igual."
              : "Las respuestas rápidas vienen con el gestor de Mercado Libre. Igual podés responder cada pregunta desde la sección Preguntas."}
          </Callout>
        ))}
    </div>
  );
}

function AccountSection({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { toast } = useToast();
  const { syncAccount } = useMlMutations();
  const { data: webhookSeen, isLoading } = useMlWebhookSeen(account.id);
  return (
    <SettingsCard
      title={account.nickname || `Usuario ${account.ml_user_id}`}
      description="Conectada con el usuario administrador de la cuenta. Las ventas, preguntas y reclamos entran solos."
      icon={UserRound}
      actions={<Badge tone={accountStatusTone(account.status)}>{ACCOUNT_STATUS_LABELS[account.status] ?? account.status}</Badge>}
    >
      <div className="divide-y divide-border">
        <SettingRow label="Conectada" description={`Desde el ${when(account.connected_at)}.`}>
          <span className="text-sm text-muted-foreground">{account.user_product_seller ? "Modelo User Products" : "Modelo clásico"}</span>
        </SettingRow>
        <SettingRow label="Última sincronización" description="Las órdenes y publicaciones se revisan solas cada 10 minutos, además de las notificaciones.">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{when(account.last_sync_at)}</span>
            {canManage && account.status === "active" && (
              <Button
                size="sm"
                variant="secondary"
                loading={syncAccount.isPending}
                onClick={() =>
                  syncAccount.mutate(account.id, {
                    onSuccess: (r) => toast({ title: "Sincronización pedida", description: `${r?.orders ?? 0} órdenes revisadas`, variant: "success" }),
                    onError: (e) => toast({ title: "No se pudo sincronizar", description: mlErrorMessage(e), variant: "error" }),
                  })
                }
              >
                <RefreshCw size={15} /> Sincronizar ahora
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Notificaciones de Mercado Libre" description="Cuando llegan, las ventas y preguntas entran al instante. Si todavía no llegó ninguna, todo se revisa cada 10 minutos.">
          {isLoading ? <Spinner size={14} /> : <Badge tone={webhookSeen ? "success" : "neutral"}>{webhookSeen ? "Llegando" : "Todavía no llegó ninguna"}</Badge>}
        </SettingRow>
        {(account.status !== "active" || account.last_error) && (
          <div className="px-5 py-4">
            <Callout tone={account.status === "active" ? "danger" : "warning"} title={account.status === "active" ? "Último error" : "La conexión venció"}>
              {account.status === "active" ? account.last_error : (account.status_reason ?? "Reconectá la cuenta para que vuelvan a entrar las ventas.")}
            </Callout>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
          <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Plug size={15} /> {account.status === "active" ? "Cuentas conectadas" : "Reconectar"}
          </Link>
        </div>
      </div>
    </SettingsCard>
  );
}

function ListingsSection({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { data: memory = [] } = useMlCategoryMemory(account.id);
  const { data: items = [] } = useMlItems(account.id);
  const sampleCategory = memory[0]?.category_id ?? items.find((i) => i.category_id)?.category_id ?? null;
  return (
    <div className="space-y-4">
      <SettingsCard
        title="Precios por tipo de publicación"
        description="Clásica, Premium y los que uses: recargo o lista de precios propia, redondeo y precio mínimo. Si una categoría pide un precio mínimo (por ejemplo $ 3.500 en almacén), ponelo acá."
        icon={BadgePercent}
      >
        <MlListingRulesEditor account={account} canManage={canManage} sampleCategoryId={sampleCategory} />
      </SettingsCard>
      <SettingsCard
        title="Stock publicable y sucursal"
        description="De qué sucursal sale el stock, cuánto se guarda y el tope por publicación."
        icon={Package}
      >
        <AccountConfig account={account} canManage={canManage} sections={["stock"]} saveLabel="Guardar stock" />
      </SettingsCard>
      <SettingsCard title="Precio base de la cuenta" description="El precio sobre el que se calculan los tipos de publicación y el tipo por defecto." icon={Tag}>
        <AccountConfig account={account} canManage={canManage} sections={["price", "listing"]} saveLabel="Guardar precio base" />
      </SettingsCard>
    </div>
  );
}

function ShippingSection({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useMlAccountShipping(account.id);
  const s = q.data;
  const refresh = async () => {
    try {
      const fresh = await mlPublishApi.accountShipping(account.id, true);
      qc.setQueryData(["ml", "account_shipping", account.id], fresh);
    } catch (e) {
      toast({ title: "No se pudo consultar Mercado Libre", description: mlErrorMessage(e), variant: "error" });
    }
  };
  const accepted = s?.mercadoenvios === "accepted";

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Mercado Envíos en tu cuenta"
        description="Lo leemos de tu cuenta de Mercado Libre. Al publicar se usa solo la forma de envío que tu cuenta y la categoría admiten."
        icon={Truck}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={q.isFetching} aria-label="Volver a consultar">
            <RefreshCw size={15} className={cn(q.isFetching && "animate-spin")} /> Actualizar
          </Button>
        }
      >
        {q.isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : q.isError || !s?.read ? (
          <div className="px-5 py-4">
            <Callout tone="warning" title="No pudimos leer los envíos de tu cuenta" actions={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Reintentar</Button>}>
              {q.error ? mlErrorMessage(q.error) : "Mercado Libre no respondió. Al publicar se vuelve a consultar."}
            </Callout>
          </div>
        ) : (
          <div className="divide-y divide-border">
            <SettingRow
              label="Estado"
              description={
                accepted
                  ? "Podés ofrecer Mercado Envíos: Mercado Libre se encarga de la etiqueta y el seguimiento."
                  : "Tu cuenta no aceptó Mercado Envíos. Igual podés publicar: se publica con envío a convenir (lo acordás con el comprador) o con costo fijo, y lo que está en el catálogo de Mercado Libre sale como publicación propia."
              }
            >
              <Badge tone={accepted ? "success" : "warning"}>{accepted ? "Mercado Envíos activo" : "Sin Mercado Envíos"}</Badge>
            </SettingRow>
            {!accepted && (
              <SettingRow label="Cómo activarlo" description={`En Mercado Libre: ${s.settings_path}. Después tocá "Actualizar" acá.`}>
                <a href={s.settings_url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  <ExternalLink size={15} /> Abrir Mercado Libre
                </a>
              </SettingRow>
            )}
            <SettingRow label="Formas de envío de la cuenta" description="Las que Mercado Libre tiene habilitadas para vos. Cada categoría puede admitir menos.">
              <div className="flex flex-wrap justify-end gap-1.5">
                {s.modes.length === 0 ? (
                  <span className="text-sm text-muted-foreground">Ninguna informada</span>
                ) : (
                  s.modes.map((m) => (
                    <Badge key={m} tone="neutral">
                      {SHIPPING_MODE_NAMES[m] ?? m}
                    </Badge>
                  ))
                )}
              </div>
            </SettingRow>
            {s.me2_logistics.length > 0 && (
              <SettingRow
                label="Logísticas de Mercado Envíos"
                description="Algunas categorías (hornos, heladeras, cocinas) sólo admiten Flex. Si tu cuenta no la tiene, esos productos se publican con envío a convenir."
              >
                <div className="flex flex-wrap justify-end gap-1.5">
                  {s.me2_logistics.map((l) => (
                    <Badge key={l} tone="neutral">
                      {LOGISTIC_LABELS[l] ?? l}
                    </Badge>
                  ))}
                </div>
              </SettingRow>
            )}
            <SettingRow
              label="Retiro en persona"
              description="Se elige en cada publicación (Publicación completa > Retiro en persona). Esta es la preferencia que tiene tu cuenta en Mercado Libre."
            >
              <Badge tone={s.local_pick_up ? "success" : "neutral"}>{s.local_pick_up ? "Ofrecido" : "No ofrecido"}</Badge>
            </SettingRow>
          </div>
        )}
      </SettingsCard>
      <SettingsCard title="Etiquetas" description="Las etiquetas de Mercado Envíos se imprimen desde la sección Envíos." icon={Truck}>
        <AccountConfig account={account} canManage={canManage} sections={["labels"]} saveLabel="Guardar etiquetas" />
      </SettingsCard>
    </div>
  );
}
