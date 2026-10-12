"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { Settings } from "lucide-react";
import { InfoHint } from "@/components/ui/InfoHint";
import { PageHeader } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import { useGating } from "@/modules/saas/gating";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { SettingsCard, SettingsSection } from "@/components/settings/Settings";
import { ScopedSection } from "@/components/config/ScopedConfig";
import { SettingsMobileNav, SettingsSideNav } from "@/components/settings/SettingsNav";
import {
  DEFAULT_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  resolveSection,
  type SettingsSectionDef,
  type SettingsSectionKey,
} from "@/components/settings/sections";

// Cada sección de Configuración se muestra sola (una por vez): su componente
// se carga en un chunk aparte en lugar de bajar las 20 juntas al entrar.
const loading = () => <SpinnerBlock className="py-16" />;
const AppearanceSettings = dynamic(
  () => import("@/components/settings/AppearanceSettings").then((m) => m.AppearanceSettings),
  { loading },
);
const BranchesManager = dynamic(
  () => import("@/components/branches/BranchesManager").then((m) => m.BranchesManager),
  { loading },
);
const BrandingCard = dynamic(
  () => import("@/components/dashboard-team/BrandingCard").then((m) => m.BrandingCard),
  { loading },
);
const PaymentMethodsCard = dynamic(
  () => import("@/components/dashboard-team/PaymentMethodsCard").then((m) => m.PaymentMethodsCard),
  { loading },
);
const OperationSettingsCard = dynamic(
  () => import("@/components/dashboard-team/OperationSettingsCard").then((m) => m.OperationSettingsCard),
  { loading },
);
const ReturnsSettingsCard = dynamic(
  () => import("@/components/dashboard-team/ReturnsSettingsCard").then((m) => m.ReturnsSettingsCard),
  { loading },
);
const ScannerCard = dynamic(
  () => import("@/components/dashboard-team/ScannerCard").then((m) => m.ScannerCard),
  { loading },
);
const CustomerDisplayCard = dynamic(
  () => import("@/components/dashboard-team/CustomerDisplayCard").then((m) => m.CustomerDisplayCard),
  { loading },
);
const HardwareCard = dynamic(
  () => import("@/components/dashboard-team/HardwareCard").then((m) => m.HardwareCard),
  { loading },
);
const WarrantyPlansManager = dynamic(
  () => import("@/components/products/WarrantyPlansManager").then((m) => m.WarrantyPlansManager),
  { loading },
);
const RubroCard = dynamic(
  () => import("@/components/dashboard-team/RubroCard").then((m) => m.RubroCard),
  { loading },
);
const ProfessionalsManager = dynamic(
  () => import("@/components/agenda/ProfessionalsManager").then((m) => m.ProfessionalsManager),
  { loading },
);
const SalonesManager = dynamic(
  () => import("@/components/dining/SalonesManager").then((m) => m.SalonesManager),
  { loading },
);
const MenusManager = dynamic(
  () => import("@/components/dining/MenusManager").then((m) => m.MenusManager),
  { loading },
);
const PromotionsManager = dynamic(
  () => import("@/components/promotions/PromotionsManager").then((m) => m.PromotionsManager),
  { loading },
);
const CouponsManager = dynamic(
  () => import("@/components/coupons/CouponsManager").then((m) => m.CouponsManager),
  { loading },
);
const ZonasManager = dynamic(
  () => import("@/components/delivery/ZonasManager").then((m) => m.ZonasManager),
  { loading },
);
const ServicePacksManager = dynamic(
  () => import("@/components/packs/ServicePacksManager").then((m) => m.ServicePacksManager),
  { loading },
);
const TenantEmailCard = dynamic(
  () => import("@/components/dashboard-team/TenantEmailCard").then((m) => m.TenantEmailCard),
  { loading },
);
const TicketTemplatesCard = dynamic(
  () => import("@/components/tickets/TicketTemplatesCard").then((m) => m.TicketTemplatesCard),
  { loading },
);
const PrintSettingsCard = dynamic(
  () => import("@/components/dashboard-team/PrintSettingsCard").then((m) => m.PrintSettingsCard),
  { loading },
);
const PosLayoutCard = dynamic(
  () => import("@/components/pos/settings/PosLayoutCard").then((m) => m.PosLayoutCard),
  { loading },
);
const PriceListsCard = dynamic(
  () => import("@/components/prices/PriceListsCard").then((m) => m.PriceListsCard),
  { loading },
);
const AccountSettingsCard = dynamic(
  () => import("@/components/account/AccountSettingsCard").then((m) => m.AccountSettingsCard),
  { loading },
);
const GroupAccountTermsCard = dynamic(
  () => import("@/components/account/GroupAccountTermsCard").then((m) => m.GroupAccountTermsCard),
  { loading },
);
const SecuritySettings = dynamic(
  () => import("@/components/security/SecuritySettings").then((m) => m.SecuritySettings),
  { loading },
);
const SupervisorPinCard = dynamic(
  () => import("@/components/account/SupervisorPinCard").then((m) => m.SupervisorPinCard),
  { loading },
);

// Configuración por sucursal y caja (F17 · H92/H93, ADR-049).
const TerminalsManager = dynamic(
  () => import("@/components/config/TerminalsManager").then((m) => m.TerminalsManager),
  { loading },
);
const PrintersManager = dynamic(
  () => import("@/components/config/PrintersManager").then((m) => m.PrintersManager),
  { loading },
);
const ScopedPrintProfiles = dynamic(
  () => import("@/components/config/PrintersManager").then((m) => m.ScopedPrintProfiles),
  { loading },
);
const BranchLogoField = dynamic(
  () => import("@/components/config/BranchBranding").then((m) => m.BranchLogoField),
  { loading },
);
const StoreGroupsCard = dynamic(
  () => import("@/components/config/BranchBranding").then((m) => m.StoreGroupsCard),
  { loading },
);

// Campos de pos_settings que se pisan por sucursal o caja en cada sección.
const OPERACION_FIELDS = [
  "rounding_multiple",
  "allow_negative_stock",
  "max_discount",
  "require_card_voucher",
  "offer_warranty",
  "allow_free_sale",
  "max_free_sale",
  "blind_close",
  "close_tolerance",
  "require_close_reason",
];
const CLIENTES_FIELDS = ["require_customer", "auto_email_receipt"];
const DISPLAY_FIELDS = ["display_show_unit_prices", "display_welcome_message", "display_thanks_message"];

// Contenido de cada sección. El encabezado (título + bajada) lo pone
// SettingsSection a partir de `sections.ts`; acá va sólo el cuerpo.
function SectionBody({ section }: { section: SettingsSectionKey }) {
  switch (section) {
    case "apariencia":
      return <AppearanceSettings />;
    // Rubro y Marca: sólo owner/manager (los componentes se auto-ocultan).
    case "rubro":
      return <RubroCard />;
    case "marca":
      return (
        <ScopedSection
          domain="ticket"
          scopedExtra={(s) => (s.scope === "store" ? <BranchLogoField storeId={s.id} /> : null)}
        >
          <BrandingCard />
        </ScopedSection>
      );
    // Sucursales y cajas (F17 · H89/H91): ABM, personal y traslados. La
    // primera sucursal y caja son BASE; la segunda pide su feature adentro.
    case "sucursales":
      return (
        <>
          <BranchesManager />
          <StoreGroupsCard />
        </>
      );
    case "seguridad":
      return <SecuritySettings />;
    // Modelos de ticket (escritura protegida por RLS).
    case "tickets":
      return <TicketTemplatesCard />;
    // Impresión por tipo de documento (F10 · H22; owner/manager).
    case "impresion":
      return (
        <>
          <ScopedSection domain="pos_settings" fields={[]} scopedExtra={(s) => <ScopedPrintProfiles scope={s} />}>
            <PrintSettingsCard />
          </ScopedSection>
          <PrintersManager />
        </>
      );
    case "email":
      return <TenantEmailCard />;
    case "pagos":
      return (
        <Suspense fallback={null}>
          <ScopedSection domain="payment_method">
            <PaymentMethodsCard />
          </ScopedSection>
        </Suspense>
      );
    case "terminales":
      return <TerminalsManager />;
    case "operacion":
      return (
        <ScopedSection domain="pos_settings" fields={OPERACION_FIELDS}>
          <OperationSettingsCard view="operacion" />
        </ScopedSection>
      );
    // Diseño del POS: preset, grilla, carrito, medios fijados y teclas rápidas.
    case "diseno-pos":
      return <PosLayoutCard />;
    // Salones y mesas (F13 · H44): CRUD de salones/sectores y mesas. Sólo con
    // el modo gastronómico activo (H43). Escritura RLS por tenant.
    case "salones":
      return (
        <SettingsCard padded>
          <SalonesManager />
        </SettingsCard>
      );
    // Menús por horario (F13 · H47). Escritura RLS owner/manager.
    case "menus":
      return (
        <SettingsCard padded>
          <MenusManager />
        </SettingsCard>
      );
    // Zonas de envío (F13 · H49): tarifa automática por zona.
    case "zonas":
      return (
        <SettingsCard padded>
          <ZonasManager />
        </SettingsCard>
      );
    // Profesionales para la agenda (F12 · H38).
    case "profesionales":
      return (
        <SettingsCard padded>
          <ProfessionalsManager />
        </SettingsCard>
      );
    // Paquetes / packs de sesiones (F12 · H41).
    case "paquetes":
      return (
        <SettingsCard padded>
          <ServicePacksManager />
        </SettingsCard>
      );
    case "clientes":
      return (
        <ScopedSection domain="pos_settings" fields={CLIENTES_FIELDS}>
          <OperationSettingsCard view="clientes" />
        </ScopedSection>
      );
    // Cuenta corriente v2: plazos, cuotas, punitorios, bloqueo y recordatorios.
    case "cuenta-corriente":
      return (
        <>
          <AccountSettingsCard />
          <GroupAccountTermsCard />
          <SupervisorPinCard />
        </>
      );
    case "devoluciones":
      return <ReturnsSettingsCard />;
    case "escaner":
      return <ScannerCard />;
    // Pantalla del cliente / doble pantalla (F10 · H25).
    case "pantalla-cliente":
      return (
        <ScopedSection domain="pos_settings" fields={DISPLAY_FIELDS}>
          <CustomerDisplayCard />
        </ScopedSection>
      );
    // Centro de diagnóstico de hardware (F10 · H26).
    case "hardware":
      return <HardwareCard />;
    // Promociones (F9 · H53) y cupones (F9 · H54, tope de uso atómico en
    // create_sale). Escritura RLS owner/manager.
    case "promociones":
      return (
        <>
          <SettingsCard title="Promociones" padded>
            <PromotionsManager />
          </SettingsCard>
          <SettingsCard title="Cupones" padded>
            <CouponsManager />
          </SettingsCard>
        </>
      );
    case "precios":
      return <PriceListsCard />;
    case "garantias":
      return (
        <SettingsCard padded>
          <WarrantyPlansManager />
        </SettingsCard>
      );
  }
}

export default function ConfiguracionPage() {
  return (
    <Suspense fallback={null}>
      <ConfiguracionInner />
    </Suspense>
  );
}

function ConfiguracionInner() {
  const params = useSearchParams();
  const router = useRouter();
  // Modo gastronómico (H43) y delivery (H49): ocultan sus secciones si están
  // apagados (toggles del tenant, no gating de plan: se ocultan sin candado).
  const { data: diningEnabled } = useDiningEnabled();
  const { data: deliveryEnabled } = useDeliveryEnabled();
  const { data: gating } = useGating();

  const seccionParam = params.get("seccion");
  const [section, setSection] = useState<SettingsSectionKey>(
    () => resolveSection(seccionParam) ?? DEFAULT_SECTION,
  );
  // Links internos (p. ej. "Activar modo gastronómico" desde Diseño del POS)
  // cambian ?seccion= sin remontar la página.
  useEffect(() => {
    const s = resolveSection(seccionParam);
    if (s) setSection(s);
  }, [seccionParam]);

  // Gating universal: con la feature fuera del plan, el ítem muestra candado y
  // abre el UpgradeModal (el backend igual bloquea la escritura).
  const isLocked = useCallback(
    (s: SettingsSectionDef) =>
      Boolean(s.feature) && Boolean(gating) && !(gating?.features[s.feature!] ?? false),
    [gating],
  );
  const [upgradeFor, setUpgradeFor] = useState<SettingsSectionDef | null>(null);

  const select = (s: SettingsSectionDef) => {
    if (isLocked(s)) {
      setUpgradeFor(s);
      return;
    }
    setSection(s.key);
    // La sección queda en la URL (compartible, sobrevive al recargar).
    router.replace(`/configuracion?seccion=${s.key}` as Route, { scroll: false });
    document.querySelector("main")?.scrollTo({ top: 0 });
  };

  const visibleGroups = SETTINGS_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter(
      (s) => (!s.requiresDining || diningEnabled) && (!s.requiresDelivery || deliveryEnabled),
    ),
  })).filter((g) => g.sections.length > 0);

  const def = (SETTINGS_SECTIONS.find((s) => s.key === section) ??
    SETTINGS_SECTIONS[0]) as SettingsSectionDef;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8 lg:px-8">
      <PageHeader
        eyebrow="Preferencias"
        title="Configuración"
        icon={Settings}
        help={<InfoHint section="configuracion" size={18} />}
        description="Ajustá NinjaPos a tu negocio. Los cambios se aplican al instante y quedan guardados en tu cuenta."
      />

      <div className="mt-5 lg:hidden">
        <SettingsMobileNav
          groups={visibleGroups}
          active={section}
          locked={isLocked}
          onSelect={select}
        />
      </div>

      <div className="mt-5 grid gap-8 lg:mt-8 lg:grid-cols-[248px_minmax(0,1fr)] xl:gap-12">
        <aside className="hidden lg:block">
          <div className="slim-scrollbar sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pb-4 pr-1">
            <SettingsSideNav
              groups={visibleGroups}
              active={section}
              locked={isLocked}
              onSelect={select}
            />
          </div>
        </aside>

        <SettingsSection
          key={def.key}
          title={def.title}
          description={def.description}
          icon={def.icon}
          className="max-w-[1080px]"
          titleClassName="max-lg:sr-only"
        >
          <SectionBody section={def.key} />
        </SettingsSection>
      </div>

      {upgradeFor?.feature && (
        <UpgradeModal
          open
          onOpenChange={(o) => !o && setUpgradeFor(null)}
          featureKey={upgradeFor.feature}
          featureLabel={upgradeFor.title}
        />
      )}
    </div>
  );
}
