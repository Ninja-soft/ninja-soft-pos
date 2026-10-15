"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { MlBillingSettingsForm } from "@/components/mercadolibre/billing/MlBillingSettings";
import { useMlBillingSettings } from "@/modules/mercadolibre/billingHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

// Configuración > Facturación de Mercado Libre (ADR-141 sobre la configuración
// por secciones). Es el único lugar donde se configura la facturación de la
// cuenta: cuándo facturar y subir la factura (base, ADR-104) y, con la feature
// `mercadolibre_facturacion`, las reglas (cupones, envío, receptor, punto de
// venta, notas de crédito y percepciones). Lo valida el servidor
// (ml_billing_settings_save). La bandeja de facturación vive en la sección
// Facturación del gestor.
export function MlBillingExtension({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { data: settings, isLoading } = useMlBillingSettings(account.id);
  const [upgrade, setUpgrade] = useState(false);

  if (isLoading || !settings) return <SpinnerBlock className="py-10" />;

  return (
    <div className="space-y-4">
      {!settings.features.billing && (
        <Callout
          tone="brand"
          icon={Lock}
          title="Facturación de Mercado Libre con reglas"
          actions={<Button size="sm" onClick={() => setUpgrade(true)}>Ver planes</Button>}
        >
          Cupones y envío en la factura, datos fiscales del comprador con el padrón de ARCA, qué factura sale y cuál se sube a la venta,
          percepciones de IIBB cobradas por link de pago y una bandeja para facturar en lote. Hoy tus ventas se facturan con la letra
          automática según cuándo elijas abajo.
        </Callout>
      )}
      <MlBillingSettingsForm account={account} settings={settings} canManage={canManage} />
      <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre_facturacion" featureLabel="Facturación de Mercado Libre" />
    </div>
  );
}
