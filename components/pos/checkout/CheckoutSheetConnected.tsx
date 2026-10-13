"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { isPlanActive, type PaymentPlan } from "@/modules/pos/api";
import { usePaymentPlans, usePosSettings, useProfessionals } from "@/modules/pos/hooks";
import { useProfessionalsForPosStore } from "@/modules/branches/staffHooks";
import { usePaymentMethodsStatus } from "@/modules/pos/layoutHooks";
import { acquirerMerchantNumber, availableAcquirers, rememberKey } from "@/lib/payments/acquirers";
import { warmEdgeFunctions } from "@/lib/pos/warmEdge";
import { useWarrantyPlans } from "@/modules/products/hooks";
import type { WarrantyPlan } from "@/modules/products/api";
import type { DisplayQr, DisplayTransfer } from "@/lib/pos/customerDisplay";
import { usePosTransferConfig } from "@/modules/payments/transfer";
import { useFeature } from "@/modules/saas/gating";
import { usePaymentTerminals } from "@/modules/config/hooks";
import { useBranchContext, useCurrentRegister } from "@/modules/branches/hooks";
import { pickIntegratedTerminal } from "@/lib/payments/terminals";
import { parseIntegration } from "@/lib/payments/terminal/config";
import { INTEGRATED_CARD_TENDER_ID, integratedCardTender, normalizeTenderId } from "@/lib/pos/tenders";
import { isTenderAllowedOffline } from "@/lib/pos/offline/policy";
import { CheckoutSheet, type CheckoutSheetProps } from "./CheckoutSheet";
import type { AccountPayRequest, ElectronicRequest, TerminalChargeRequest } from "./types";

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
// Terminal integrada (ADR-053): sólo carga si la caja tiene una.
const TerminalChargeModal = dynamic(
  () => import("./TerminalChargeModal").then((m) => m.TerminalChargeModal),
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
  | "transfer"
> & {
  /** Reporta la cuenta de la transferencia a la pantalla del cliente (ADR-055). */
  onTransferState?: (t: DisplayTransfer | null) => void;
  /** Reporta el QR activo a la pantalla del cliente (H25). */
  onQrState?: (qr: DisplayQr | null) => void;
  /**
   * Cliente de la venta (Mobbex lo informa como customer del checkout; la
   * cuenta corriente lee su saldo, disponible, vencido, cuotas y bloqueo).
   */
  customerId?: string | null;
  /**
   * Sin conexión (ADR-077): sólo medios manuales sin integración (efectivo,
   * transferencia y tarjeta en posnet); sin terminal integrada ni detección
   * automática de transferencias.
   */
  offline?: boolean;
};

// Hoja de cobro con sus datos (planes de cuotas, garantías, vendedores,
// voucher) y los modales de QR / link / Point de cada proveedor.
export function CheckoutSheetConnected({
  onQrState,
  onTransferState,
  customerId = null,
  offline = false,
  ...props
}: Connected) {
  // Cuentas de transferencia de la caja (herencia por sucursal y caja).
  const transferCfg = usePosTransferConfig();
  // Detección automática de transferencias de Mercado Pago (ADR-061).
  const transferAuto = useFeature("transferencia_auto_mp");
  const posBranch = useBranchContext();
  const posRegister = useCurrentRegister();
  const transfer = useMemo(
    () =>
      transferCfg.available
        ? {
            showScreen: transferCfg.showScreen,
            requireReference: transferCfg.requireReference,
            accounts: transferCfg.accounts,
            defaultAccountId: transferCfg.defaultAccountId,
            onDisplay: onTransferState,
            autoDetect: {
              enabled: transferAuto === true && !offline,
              storeId: posBranch.posStoreId ?? null,
              registerId: posRegister.data?.id ?? null,
            },
          }
        : null,
    [transferCfg, onTransferState, transferAuto, offline, posBranch.posStoreId, posRegister.data?.id],
  );
  const { data: allPlans } = usePaymentPlans();
  const { data: wplans } = useWarrantyPlans(true);
  const { data: allProfessionals } = useProfessionals();
  // Sólo los vendedores habilitados en la sucursal del POS (F17 · H91).
  const professionals = useProfessionalsForPosStore(allProfessionals);
  const { data: posSettings } = usePosSettings();
  const { data: methods } = usePaymentMethodsStatus();
  const merchantNumberFor = useCallback(
    (brand: string | null, providerKey: string | null, acquirer?: string | null) =>
      acquirerMerchantNumber(methods ?? [], brand, acquirer ?? null, providerKey),
    [methods],
  );

  // Tarjeta en posnet (ADR-054): adquirentes del negocio (o los elegidos en la
  // configuración del cupón) y el último usado en esta caja.
  const voucherRules = posSettings?.cardVoucherRules ?? null;
  const posnetAcquirers = useMemo(
    () => availableAcquirers(methods, voucherRules?.acquirers),
    [methods, voucherRules?.acquirers],
  );
  const register = useCurrentRegister();
  const storageKey = rememberKey(register.data?.id);
  const [remembered, setRemembered] = useState<string | null>(null);
  useEffect(() => {
    try {
      setRemembered(window.localStorage.getItem(storageKey));
    } catch {
      setRemembered(null);
    }
  }, [storageKey, props.open]);
  const onAcquirerUsed = useCallback(
    (key: string) => {
      setRemembered(key);
      try {
        window.localStorage.setItem(storageKey, key);
      } catch {
        // Sin almacenamiento (modo privado): se elige cada vez.
      }
    },
    [storageKey],
  );

  // Precalentado de las Edge de los medios QR / link al abrir la hoja: el
  // primer "Generar QR" no paga el arranque en frío (ADR-048).
  const qrProviders = useMemo(
    () => props.tenders.filter((t) => t.flow === "qr").map((t) => t.qrProvider),
    [props.tenders],
  );
  useEffect(() => {
    if (props.open && qrProviders.length > 0) warmEdgeFunctions(qrProviders);
  }, [props.open, qrProviders]);

  // Terminal integrada de la caja (ADR-053): "Tarjeta en terminal" primero y
  // la Tarjeta en posnet como respaldo. Sin la feature no se ofrece (el
  // servidor igual rechaza el cupón "de terminal" sin plan).
  const hasIntegrated = useFeature("terminal_integrada");
  const { data: terminals } = usePaymentTerminals();
  const branchCtx = useBranchContext();
  const currentRegister = useCurrentRegister();
  const integratedTerminal = useMemo(() => {
    if (hasIntegrated === false || offline) return null;
    return pickIntegratedTerminal({
      terminals: terminals ?? [],
      storeId: branchCtx.posStoreId,
      registerId: currentRegister.data?.id ?? null,
    }).terminal;
  }, [hasIntegrated, offline, terminals, branchCtx.posStoreId, currentRegister.data?.id]);
  const tenders = useMemo(() => {
    if (offline) return props.tenders.filter(isTenderAllowedOffline);
    const card = props.tenders.find((t) => t.flow === "card");
    if (!integratedTerminal || !card) return props.tenders;
    const cfg = parseIntegration(integratedTerminal.external_meta);
    const integrated = integratedCardTender(card, {
      terminalId: integratedTerminal.id,
      label: integratedTerminal.label,
      providerKey: integratedTerminal.provider_key,
      requiresBrand: cfg.adapter === "payway_lapos",
      simulated: cfg.adapter === "simulator",
    });
    const i = props.tenders.indexOf(card);
    return [...props.tenders.slice(0, i), integrated, ...props.tenders.slice(i)];
  }, [props.tenders, integratedTerminal, offline]);
  // "Tarjeta" fijada en el carrito abre la terminal integrada si hay una.
  const initialTenderId =
    integratedTerminal && props.initialTenderId && normalizeTenderId(props.initialTenderId) === "card"
      ? INTEGRATED_CARD_TENDER_ID
      : offline && props.initialTenderId && !tenders.some((t) => t.id === props.initialTenderId)
        ? null
        : props.initialTenderId;
  const renderTerminal = (req: TerminalChargeRequest) =>
    integratedTerminal ? <TerminalChargeModal terminal={integratedTerminal} req={req} /> : null;

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
          mode={t.qrMode}
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
      tenders={tenders}
      initialTenderId={initialTenderId}
      renderTerminal={renderTerminal}
      cardPlans={cardPlans}
      merchantNumberFor={merchantNumberFor}
      posnetAcquirers={posnetAcquirers}
      rememberedAcquirer={remembered}
      onAcquirerUsed={onAcquirerUsed}
      voucherRules={voucherRules}
      warrantyPlans={(wplans ?? []) as WarrantyPlan[]}
      professionals={professionals ?? []}
      voucherRequired={Boolean(posSettings?.requireCardVoucher)}
      renderElectronic={renderElectronic}
      renderAccount={renderAccount}
      transfer={transfer}
    />
  );
}
