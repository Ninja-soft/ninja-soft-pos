"use client";

import Link from "next/link";
import { BadgePercent, Plug, Settings2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/Button";
import { SettingsCard } from "@/components/settings/Settings";
import { AccountConfig } from "@/components/integrations/mercadolibre/MlSettings";
import { useMlCategoryMemory, useMlItems, type MlAccount } from "@/modules/mercadolibre/hooks";
import { MlListingRulesEditor } from "./MlListingRulesEditor";

// Configuración experta del gestor (H141 · ADR-132) dentro de la misma
// pantalla de Mercado Libre: precios por tipo de publicación, stock
// publicable, sucursal, facturación y etiquetas. Conectar o desconectar
// cuentas sigue en Configuración > Integraciones.
export function MlConfigTab({ account, canManage, extra }: { account: MlAccount; canManage: boolean; extra?: React.ReactNode }) {
  const { data: memory = [] } = useMlCategoryMemory(account.id);
  const { data: items = [] } = useMlItems(account.id);
  const sampleCategory = memory[0]?.category_id ?? items.find((i) => i.category_id)?.category_id ?? null;

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Precios por tipo de publicación"
        description="Clásica, Premium y los que uses: recargo o lista de precios propia, redondeo y precio mínimo."
        icon={BadgePercent}
      >
        <MlListingRulesEditor account={account} canManage={canManage} sampleCategoryId={sampleCategory} />
      </SettingsCard>

      <SettingsCard
        title="Stock, precio base y facturación"
        description="De dónde sale el stock publicado, cuánto se guarda, el precio base de la cuenta y cuándo se facturan las ventas."
        icon={Settings2}
        actions={
          <Link href="/configuracion?seccion=mercadolibre" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Plug size={15} /> Cuentas conectadas
          </Link>
        }
      >
        <AccountConfig account={account} canManage={canManage} />
      </SettingsCard>

      {extra}
    </div>
  );
}
