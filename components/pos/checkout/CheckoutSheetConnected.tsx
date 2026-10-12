"use client";

import { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { isPlanActive, type PaymentPlan } from "@/modules/pos/api";
import { usePaymentPlans, usePosSettings, useProfessionals } from "@/modules/pos/hooks";
import { usePaymentMethodsStatus } from "@/modules/pos/layoutHooks";
import { resolveMerchantNumber } from "@/lib/payments/merchantNumbers";
import { useWarrantyPlans } from "@/modules/products/hooks";
import type { WarrantyPlan } from "@/modules/products/api";
import type { DisplayQr } from "@/lib/pos/customerDisplay";
import { CheckoutSheet, type CheckoutSheetProps } from "./CheckoutSheet";
import type { AccountPayRequest, ElectronicRequest } from "./types";

// Cobros electrónicos: los modales existentes de cada proveedor, en su chunk.
const QrCheckoutModal = dynamic(
  () => import("@/components/pos/QrCheckoutModal").then((m) => m.QrCheckoutModal),
  { ssr: false },
);
// Cuenta corriente v2 (saldo, cuotas, autorización): sólo carga si se elige.
const AccountPayPanel = dynamic(
  () => import("@/components/pos/AccountPayPanel").then((m) => m.AccountPayPanel),
  { ssr: false },
);
const PointCheckoutModal = dynamic(
  () => import("@/components/pos/PointCheckoutModal").then((m) => m.PointCheckoutModal),
  { ssr: false },
);

type Connected = Omit<
  CheckoutSheetProps,
  | "cardPlans"
  | "warrantyPlans"
  | "professionals"
  | "voucherRequired"
  | "renderElectronic"
  | "renderAccount"
> & {
  /** Reporta el QR activo a la pantalla del cliente (H25). */
  onQrState?: (qr: DisplayQr | null) => void;
  /**
   * Cliente de la venta (Mobbex lo informa como customer del checkout; la
   * cuenta corriente lee su saldo, disponible, vencido, cuotas y bloqueo).
   */
  customerId?: string | null;
};

// Hoja de cobro con sus datos (planes de cuotas, garantías, vendedores,
// voucher) y los modales de QR / link / Point de cada proveedor.
export function CheckoutSheetConnected({ onQrState, customerId = null, ...props }: Connected) {
  const { data: allPlans } = usePaymentPlans();
  const { data: wplans } = useWarrantyPlans(true);
  const { data: professionals } = useProfessionals();
  const { data: posSettings } = usePosSettings();
  const { data: methods } = usePaymentMethodsStatus();
  const merchantNumberFor = useCallback(
    (brand: string | null, providerKey: string | null) =>
      resolveMerchantNumber(methods ?? [], brand, providerKey),
    [methods],
  );

  // Sólo los planes VIGENTES hoy (H27).
  const cardPlans = useMemo(
    () => (allPlans ?? []).filter((p: PaymentPlan) => isPlanActive(p)),
    [allPlans],
  );

  const renderElectronic = (req: ElectronicRequest) => {
    const t = req.tender;
    if (t.flow === "point" && t.pointProvider) {
      return (
        <PointCheckoutModal
          open
          provider={t.pointProvider}
          base={req.amount}
          onOpenChange={(o) => !o && req.onClose()}
          onApproved={(reference, amount, cardType) =>
            // La tarjeta real (débito/crédito) la informa el proveedor al aprobar.
            req.onApproved({ reference, amount, method: cardType, surcharges: [] })
          }
        />
      );
    }
    if (t.flow === "qr" && t.qrProvider) {
      // Planes y modo del medio ya cargados: el QR se pide al abrir, sin
      // esperar dos consultas más (ADR-048, "QR más rápido").
      const row = (methods ?? []).find((m) => m.provider_key === t.qrProvider);
      const prefetched =
        allPlans && methods
          ? {
              plans: cardPlans.filter((p) => p.provider_key === t.qrProvider),
              mode: row?.plan_mode ?? "plans",
              pct: Number(row?.surcharge_pct) || 0,
            }
          : null;
      return (
        <QrCheckoutModal
          open
          provider={t.qrProvider}
          providerName={t.brandLabel}
          channel={t.channel === "link" ? "link" : "qr"}
          customerId={customerId}
          prefetched={prefetched}
          park={req.park ?? null}
          base={req.amount}
          onQrState={onQrState}
          onOpenChange={(o) => {
            if (o) return;
            onQrState?.(null);
            req.onClose();
          }}
          onApproved={(reference, amount, extras) => {
            // El modal se desmonta al aprobar: limpiamos el QR de la pantalla
            // del cliente acá (su efecto de limpieza no llega a correr).
            onQrState?.(null);
            req.onApproved({
              reference,
              amount,
              method: "qr",
              surcharges: extras
                .filter((e) => e.kind === "surcharge" && e.amount > 0)
                .map((e) => ({ name: e.name, amount: e.amount })),
            });
          }}
        />
      );
    }
    return null;
  };

  const renderAccount = (req: AccountPayRequest) => (
    <AccountPayPanel customerId={customerId} total={req.amount} onChange={req.onChange} />
  );

  return (
    <CheckoutSheet
      {...props}
      cardPlans={cardPlans}
      merchantNumberFor={merchantNumberFor}
      warrantyPlans={(wplans ?? []) as WarrantyPlan[]}
      professionals={professionals ?? []}
      voucherRequired={Boolean(posSettings?.requireCardVoucher)}
      renderElectronic={renderElectronic}
      renderAccount={renderAccount}
    />
  );
}
