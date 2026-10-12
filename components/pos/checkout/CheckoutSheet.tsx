"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Gift,
  Link2,
  Lock,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import {
  checkoutTotals,
  quickCashAmounts,
  round2,
  settleLine,
  splitShare,
  tipFromPercent,
  tipMethodFor,
  type CheckoutLine,
} from "@/lib/pos/checkoutMath";
import {
  groupTenders,
  type ResolvedTender,
  type SaleMethod,
  type TenderPrefs,
} from "@/lib/pos/tenders";
import { BrandIcon } from "../ui/BrandIcon";
import { Keypad, applyKey, keypadNumber, type KeypadKey } from "../ui/Keypad";
import { PosSheet } from "../ui/PosSheet";
import { POS_CTA, POS_IDLE, POS_SELECTED, money } from "../ui/posStyles";
import { TenderPicker } from "./TenderPicker";
import type {
  AccountPayRequest,
  AccountPayState,
  CheckoutPayment,
  ElectronicRequest,
  ElectronicResult,
  PaymentExtra,
  Promo,
  SplitItem,
} from "./types";

// Plan de cuotas mínimo que necesita la hoja (subset de PaymentPlan).
export interface CheckoutPlan {
  id: string;
  label: string;
  base: string | null;
  installments: number | null;
  surcharge_pct: number | string | null;
}
export interface CheckoutWarrantyPlan {
  id: string;
  label: string;
  months: number;
  price: number | string;
  price_pct: number | string | null;
}
export interface CheckoutProfessional {
  id: string;
  name: string;
  commission_pct: number | string | null;
}

interface PaidLine extends CheckoutLine {
  key: string;
  tenderId: string;
  title: string;
  detail?: string;
  logo: string | null;
  method: SaleMethod;
  reference?: string;
  card_voucher?: CheckoutPayment["card_voucher"];
  surchargeItems: { name: string; amount: number }[];
  /** Cobro electrónico ya aprobado: no se puede quitar. */
  locked: boolean;
  /** ¿Puede llevar promo por medio? (Point no: el medio real se sabe al final). */
  promoEligible: boolean;
}

export interface CheckoutSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Total del carrito SIN redondear (subtotal - descuentos - promo - cupón). */
  base: number;
  rounding: number;
  deliveryFee?: number;
  cartPromo?: Promo | null;
  promoForMethod?: (method: string) => Promo | null;
  tenders: ResolvedTender[];
  prefs?: TenderPrefs;
  initialTenderId?: string | null;
  cardPlans: CheckoutPlan[];
  warrantyPlans: CheckoutWarrantyPlan[];
  initialWarrantyId?: string;
  professionals: CheckoutProfessional[];
  voucherRequired: boolean;
  storeCreditBalance: number;
  splitItems: SplitItem[];
  tipPresets: number[];
  quickCash: number[];
  keypad?: boolean;
  loading: boolean;
  style?: CSSProperties;
  onConfirm: (
    payments: CheckoutPayment[],
    extras: PaymentExtra[],
    change: number,
    appliedPromo: Promo | null,
  ) => void;
  renderElectronic: (req: ElectronicRequest) => React.ReactNode;
  /**
   * Panel de cuenta corriente v2 (saldo, disponible, vencido, cuotas y
   * autorización por mora / límite). Lo provee CheckoutSheetConnected; sin él
   * la cuenta corriente se registra como un pago simple.
   */
  renderAccount?: (req: AccountPayRequest) => React.ReactNode;
}

const PLAN_BASE: Record<string, string> = { debit: "debito", credit: "credito" };
const SPLITS = [
  { n: 2, label: "½" },
  { n: 3, label: "⅓" },
  { n: 4, label: "¼" },
];
let keySeq = 0;

export function CheckoutSheet(props: CheckoutSheetProps) {
  const {
    open,
    onOpenChange,
    base,
    rounding,
    deliveryFee = 0,
    cartPromo = null,
    promoForMethod,
    tenders,
    prefs,
    initialTenderId,
    cardPlans,
    warrantyPlans,
    initialWarrantyId = "",
    professionals,
    voucherRequired,
    storeCreditBalance,
    splitItems,
    tipPresets,
    quickCash,
    keypad,
    loading,
    style,
    onConfirm,
    renderElectronic,
    renderAccount,
  } = props;

  const [lines, setLines] = useState<PaidLine[]>([]);
  // Cuenta corriente: una sola línea por venta (el cargo, sus cuotas y el token
  // de autorización de un solo uso van en ese único pago; ver ADR-037).
  const hasAccountLine = lines.some((l) => l.method === "account");
  const sections = useMemo(
    () => groupTenders(hasAccountLine ? tenders.filter((t) => t.flow !== "account") : tenders, prefs),
    [tenders, prefs, hasAccountLine],
  );
  const visible = useMemo(() => sections.flatMap((s) => s.tenders), [sections]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"tenders" | "editor">("tenders");
  const [portionStr, setPortionStr] = useState("");
  const [receivedStr, setReceivedStr] = useState("");
  const [cardKind, setCardKind] = useState<"debit" | "credit">("debit");
  const [planId, setPlanId] = useState("");
  const [voucher, setVoucher] = useState({ lote: "", cupon: "", autorizacion: "" });
  // Número de operación (Directo): obligatorio, viaja como reference del pago.
  const [opRef, setOpRef] = useState("");
  const [itemsOpen, setItemsOpen] = useState(false);
  const [pickedItems, setPickedItems] = useState<string[]>([]);
  const [tipPct, setTipPct] = useState<number | null>(null);
  const [tipCustom, setTipCustom] = useState("");
  const [warrantyId, setWarrantyId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [electronic, setElectronic] = useState<{ tender: ResolvedTender; amount: number } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Estado del panel de cuenta corriente (reference JSON con cuotas / override y
  // si el cargo está bloqueado). Arranca bloqueado hasta que el panel lea la cuenta.
  const [accountPay, setAccountPay] = useState<AccountPayState>({ reference: undefined, blocked: true });
  const onAccountChange = useCallback((st: AccountPayState) => setAccountPay(st), []);
  const editorRef = useRef<HTMLDivElement>(null);

  // Reset al abrir (la hoja queda montada entre ventas).
  useEffect(() => {
    if (!open) return;
    const initial =
      (initialTenderId && visible.find((t) => t.id === initialTenderId)) ||
      visible.find((t) => t.id === "cash") ||
      visible[0] ||
      null;
    setLines([]);
    setActiveId(initial?.id ?? null);
    setView(initialTenderId && initial ? "editor" : "tenders");
    setPortionStr("");
    setReceivedStr("");
    setCardKind("debit");
    setPlanId("");
    setVoucher({ lote: "", cupon: "", autorizacion: "" });
    setItemsOpen(false);
    setPickedItems([]);
    setTipPct(null);
    setTipCustom("");
    setWarrantyId(initialWarrantyId);
    setProfessionalId("");
    setExtrasOpen(Boolean(initialWarrantyId));
    setElectronic(null);
    setConfirmLeave(false);
    // Sólo al abrir: no re-resetear si cambian los tenders mientras se cobra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = visible.find((t) => t.id === activeId) ?? null;

  // Método efectivo del tender activo (tarjeta/terminal: según el switch).
  const activeMethod: SaleMethod | null = active
    ? active.flow === "terminal"
      ? cardKind
      : active.method
    : null;
  const isCard = active?.flow === "card" || active?.flow === "terminal";

  // ── Promo por medio de pago (sólo si se paga TODO con un único medio) ─────────
  const pfm = useCallback(
    (m: string): Promo | null => (promoForMethod ? promoForMethod(m) : cartPromo),
    [promoForMethod, cartPromo],
  );

  const wplan = warrantyPlans.find((p) => p.id === warrantyId) ?? null;
  const warranty = wplan
    ? Number(wplan.price_pct) > 0
      ? round2((base * Number(wplan.price_pct)) / 100)
      : Number(wplan.price) || 0
    : 0;

  const totalsFor = useCallback(
    (ls: PaidLine[], promo: Promo | null, tip: number) =>
      checkoutTotals({
        base,
        rounding,
        deliveryFee,
        promoExtra: Math.max(0, (promo?.discount ?? 0) - (cartPromo?.discount ?? 0)),
        warranty,
        tip,
        lines: ls,
      }),
    [base, rounding, deliveryFee, cartPromo, warranty],
  );

  const promoFor = useCallback(
    (ls: PaidLine[], method: SaleMethod | null, tip: number, typed?: number | null): Promo | null => {
      if (ls.length === 0) {
        if (!method || active?.flow === "point") return cartPromo;
        const p = pfm(method);
        // Un primer pago parcial no lleva la promo por medio (sólo aplica si
        // se paga TODO con ese medio).
        if (typed != null && typed < totalsFor(ls, p, tip).grandTotal - 0.005) return cartPromo;
        return p;
      }
      const only = ls[0];
      if (ls.length === 1 && only && only.promoEligible) {
        const p = pfm(only.method);
        if (totalsFor(ls, p, tip).settled) return p;
      }
      return cartPromo;
    },
    [pfm, cartPromo, totalsFor, active?.flow],
  );

  // Propina: % sobre el total de productos (sin propina) o monto libre.
  const tipFor = useCallback(
    (ls: PaidLine[], method: SaleMethod | null) => {
      if (tipPct == null) return Math.max(0, Number(tipCustom) || 0);
      const t0 = totalsFor(ls, promoFor(ls, method, 0), 0);
      return tipFromPercent(t0.productsTotal, tipPct);
    },
    [tipPct, tipCustom, totalsFor, promoFor],
  );

  const typedPortion = portionStr.trim() === "" ? null : keypadNumber(portionStr);
  const tip = tipFor(lines, activeMethod);
  const promo = promoFor(lines, activeMethod, tip, typedPortion);
  const totals = totalsFor(lines, promo, tip);
  const remaining = Math.max(0, totals.remaining);
  const promoExtra = Math.max(0, (promo?.discount ?? 0) - (cartPromo?.discount ?? 0));

  // ── Editor del tender activo ───────────────────────────────────────────────
  const plansForActive = useMemo(() => {
    const b = activeMethod ? PLAN_BASE[activeMethod] : undefined;
    if (!isCard || !b) return [];
    return cardPlans
      .filter((p) => p.base === b)
      .sort((a, z) => (a.installments ?? 1) - (z.installments ?? 1));
  }, [cardPlans, activeMethod, isCard]);
  const plan = plansForActive.find((p) => p.id === planId) ?? null;
  const surchargePct = !active
    ? 0
    : isCard
      ? Number(plan?.surcharge_pct) || 0
      : active.surchargePct || 0;

  const maxPortion =
    active?.flow === "store_credit" ? Math.min(remaining, storeCreditBalance) : remaining;
  const portion = round2(Math.min(Math.max(0, typedPortion ?? maxPortion), maxPortion));

  const settleInput = useMemo(
    () => ({
      base,
      rounding,
      deliveryFee,
      promoExtra,
      warranty,
      tip,
      lines,
    }),
    [base, rounding, deliveryFee, promoExtra, warranty, tip, lines],
  );
  const settle = settleLine(settleInput, portion, surchargePct);
  const received = receivedStr.trim() === "" ? null : keypadNumber(receivedStr);
  const changePreview =
    active?.flow === "cash" && received != null ? Math.max(0, round2(received - settle.amount)) : 0;
  const receivedShort = active?.flow === "cash" && received != null && received < settle.amount - 0.005;

  const voucherOk =
    !voucherRequired ||
    !isCard ||
    (voucher.lote.trim() !== "" && voucher.cupon.trim() !== "" && voucher.autorizacion.trim() !== "");
  const isElectronic = active?.flow === "qr" || active?.flow === "point";
  const refOk = !active?.requiresReference || opRef.trim() !== "";
  const belowMin = Boolean(active?.minAmount && settle.amount > 0 && settle.amount < active.minAmount);
  const isAccount = active?.flow === "account";
  const accountOk = !isAccount || !renderAccount || !accountPay.blocked;
  const canCommit =
    Boolean(active) &&
    accountOk &&
    portion > 0 &&
    settle.amount > 0 &&
    voucherOk &&
    refOk &&
    !belowMin &&
    !receivedShort &&
    !electronic;

  // Reset de los campos al cambiar de medio.
  useEffect(() => {
    setPlanId("");
    setReceivedStr("");
    setVoucher({ lote: "", cupon: "", autorizacion: "" });
    setOpRef("");
    // El estado de cuenta corriente NO se resetea acá: el panel lo reporta al
    // montarse (y su efecto corre antes que éste, lo pisaría).
  }, [activeId, cardKind]);

  function pickTender(t: ResolvedTender) {
    setActiveId(t.id);
    setView("editor");
    if (t.method === "debit" || t.method === "credit") setCardKind(t.method);
    // En mobile el editor queda debajo: lo traemos a la vista.
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  // ── Armado de extras y cierre de la venta ─────────────────────────────────
  function finalize(ls: PaidLine[]) {
    const t = tipFor(ls, null);
    const finalPromo = promoFor(ls, null, t);
    const tt = totalsFor(ls, finalPromo, t);
    const extras: PaymentExtra[] = [];
    if (warranty > 0 && wplan) extras.push({ kind: "warranty", name: `Garantía ${wplan.label}`, amount: warranty });
    for (const l of ls) {
      for (const s of l.surchargeItems) {
        if (s.amount > 0) extras.push({ kind: "surcharge", name: s.name, amount: s.amount });
      }
    }
    if (t > 0) extras.push({ kind: "tip", amount: t, method: tipMethodFor(ls[0]?.method) });
    if (professionalId) extras.push({ kind: "professional", id: professionalId });
    const payments: CheckoutPayment[] = ls.map((l) => ({
      method: l.method,
      amount: l.amount,
      ...(l.reference ? { reference: l.reference } : {}),
      ...(l.card_voucher ? { card_voucher: l.card_voucher } : {}),
    }));
    onConfirm(payments, extras, tt.change, finalPromo);
  }

  function addLine(line: PaidLine) {
    const next = [...lines, line];
    setLines(next);
    setPortionStr("");
    setReceivedStr("");
    setPickedItems([]);
    setItemsOpen(false);
    setPlanId("");
    setVoucher({ lote: "", cupon: "", autorizacion: "" });
    setOpRef("");
    const t = tipFor(next, null);
    if (totalsFor(next, promoFor(next, null, t), t).settled) {
      finalize(next);
    } else {
      // Lo que resta se cobra con otro medio: se vuelve a elegir.
      setActiveId(null);
      setView("tenders");
    }
  }

  function commit() {
    if (!active || !canCommit) return;
    if (isElectronic) {
      setElectronic({ tender: active, amount: settle.amount });
      return;
    }
    if (!activeMethod) return;
    const surchargeName = plan
      ? `Recargo ${plan.label}`
      : `Recargo ${active.label} (${surchargePct}%)`;
    const hasVoucher =
      isCard && (voucherRequired || Object.values(voucher).some((v) => v.trim() !== ""));
    addLine({
      key: `l${++keySeq}`,
      tenderId: active.id,
      title: active.flow === "terminal" ? `${active.brandLabel} Point` : active.label,
      detail:
        active.flow === "cash" && received != null && received > settle.amount
          ? `Recibido ${money(received)}, vuelto ${money(received - settle.amount)}`
          : plan
            ? plan.label
            : active.requiresReference
              ? `Operación ${opRef.trim()}`
              : isAccount
                ? accountDetail(accountPay.reference)
                : undefined,
      logo: active.logo,
      method: activeMethod,
      amount: settle.amount,
      surcharge: settle.surcharge,
      surchargeItems: settle.surcharge > 0 ? [{ name: surchargeName, amount: settle.surcharge }] : [],
      received: active.flow === "cash" ? (received ?? settle.amount) : undefined,
      reference: active.requiresReference
        ? opRef.trim()
        : isAccount && renderAccount
          ? accountPay.reference
          : undefined,
      card_voucher: hasVoucher
        ? {
            lote: voucher.lote.trim(),
            cupon: voucher.cupon.trim(),
            autorizacion: voucher.autorizacion.trim(),
          }
        : undefined,
      locked: false,
      promoEligible: true,
    });
  }

  function onElectronicApproved(r: ElectronicResult) {
    const t = electronic?.tender;
    setElectronic(null);
    if (!t) return;
    const sc = round2(r.surcharges.reduce((a, s) => a + s.amount, 0));
    addLine({
      key: `l${++keySeq}`,
      tenderId: t.id,
      title: `${t.brandLabel} ${t.label}`,
      detail: "Aprobado",
      logo: t.logo,
      method: r.method,
      amount: r.amount,
      surcharge: sc,
      surchargeItems: r.surcharges,
      reference: r.reference,
      locked: true,
      promoEligible: t.flow === "qr",
    });
  }

  function removeLine(key: string) {
    setLines((ls) => ls.filter((l) => l.key !== key || l.locked));
  }

  const lockedTotal = round2(lines.filter((l) => l.locked).reduce((a, l) => a + l.amount, 0));
  function requestClose() {
    if (electronic) return;
    if (lockedTotal > 0) setConfirmLeave(true);
    else onOpenChange(false);
  }

  // ── Botón principal ────────────────────────────────────────────────────────
  const readyToConfirm = lines.length > 0 && totals.settled;
  let ctaLabel = "Elegí cómo paga";
  if (readyToConfirm) ctaLabel = `Confirmar venta ${money(totals.grandTotal)}`;
  else if (active) {
    const amt = money(settle.amount);
    if (active.flow === "qr") ctaLabel = active.channel === "link" ? `Generar link ${amt}` : `Generar QR ${amt}`;
    else if (active.flow === "point") ctaLabel = `Enviar al Point ${amt}`;
    else ctaLabel = settle.closes ? `Cobrar ${amt}` : `Agregar pago ${amt}`;
  }
  const ctaDisabled = readyToConfirm ? loading : !canCommit || loading;
  function onCta() {
    if (readyToConfirm) finalize(lines);
    else commit();
  }

  // Badge de promo por medio en cada botón (sólo antes del primer pago).
  const promoBadge = (t: ResolvedTender) => {
    if (lines.length > 0 || !promoForMethod || t.flow === "point") return 0;
    const m = t.flow === "terminal" ? "credit" : t.method;
    if (!m) return 0;
    return Math.max(0, (pfm(m)?.discount ?? 0) - (cartPromo?.discount ?? 0));
  };

  const quick = quickCashAmounts(settle.amount, { custom: quickCash });
  const roundingAdj = round2(
    totals.productsTotal - deliveryFee - (base - promoExtra + warranty + totals.surcharges),
  );

  const onKeypad = (k: KeypadKey) => {
    if (active?.flow === "cash") setReceivedStr((v) => applyKey(v, k));
    else setPortionStr((v) => applyKey(v, k));
  };

  return (
    <PosSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}
      onRequestClose={requestClose}
      title="Cobrar"
      description={`Total ${money(totals.grandTotal)}`}
      size="xl"
      style={style}
    >
      <div className="grid min-h-0 flex-1 md:h-[min(92dvh,860px)] md:grid-cols-[minmax(0,1fr)_minmax(360px,410px)]">
        {/* ── Medios ─────────────────────────────────────────────────────── */}
        <section
          className={cn(
            "slim-scrollbar min-h-0 overflow-y-auto px-4 pb-6 pt-3 md:px-6 md:pt-6",
            view === "editor" && "max-md:hidden",
          )}
        >
          {/* Encabezado compacto (sólo celular). */}
          <div className="mb-4 flex items-end justify-between gap-3 pr-10 md:hidden">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {lines.length > 0 ? "Resta cobrar" : "Total a cobrar"}
              </p>
              <p className="price-hl font-price text-4xl font-black tabular-nums leading-tight">
                {money(lines.length > 0 ? remaining : totals.grandTotal)}
              </p>
            </div>
            {lines.length > 0 && (
              <p className="pb-1 text-right text-xs text-muted-foreground">
                Pagado {money(totals.paid)}
                <br />
                de {money(totals.grandTotal)}
              </p>
            )}
          </div>
          <h2 className="mb-4 hidden font-display text-xl font-black tracking-tight md:block">¿Cómo paga?</h2>
          {sections.length === 0 ? (
            <p className="rounded-2xl bg-fg-6 p-4 text-sm text-muted-foreground">
              No hay medios de cobro habilitados. Activalos en Configuración, Medios de pago.
            </p>
          ) : (
            <TenderPicker
              sections={sections}
              activeId={activeId}
              onPick={pickTender}
              promoBadge={promoBadge}
              disabled={readyToConfirm || Boolean(electronic)}
            />
          )}
        </section>

        {/* ── Ticket del cobro ───────────────────────────────────────────── */}
        <aside
          className={cn(
            "flex min-h-0 flex-col bg-fg-4 md:border-l md:border-border",
            view === "tenders" && "max-md:hidden",
          )}
        >
          <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 md:px-5 md:pt-6">
            <button
              type="button"
              onClick={() => setView("tenders")}
              className="mb-3 flex items-center gap-1 text-sm font-semibold text-muted-foreground md:hidden"
            >
              <ChevronLeft size={16} /> Medios de pago
            </button>

            {/* Total */}
            <div className="pr-10 md:pr-8">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Total a cobrar
              </p>
              <p className="price-hl font-price text-[2.6rem] font-black leading-tight tabular-nums">
                {money(totals.grandTotal)}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {lines.length > 0 && !totals.settled && (
                  <span className="rounded-full bg-warning/15 px-2.5 py-1 text-xs font-bold text-warning">
                    Resta {money(remaining)}
                  </span>
                )}
                {totals.settled && lines.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-xs font-bold text-success">
                    <Check size={13} /> Cubierto
                  </span>
                )}
                {totals.change > 0 && (
                  <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-bold text-success">
                    Vuelto {money(totals.change)}
                  </span>
                )}
              </div>
            </div>

            {/* Desglose */}
            <dl className="mt-3 space-y-1 text-[13px]">
              {deliveryFee > 0 && <Row label="Envío" value={`+${money(deliveryFee)}`} />}
              {warranty > 0 && <Row label={`Garantía ${wplan?.label ?? ""}`} value={`+${money(warranty)}`} />}
              {totals.surcharges > 0 && <Row label="Recargos" value={`+${money(totals.surcharges)}`} />}
              {promoExtra > 0 && (
                <Row label={promo?.name ?? "Promo por medio de pago"} value={`−${money(promoExtra)}`} tone="success" />
              )}
              {Math.abs(roundingAdj) >= 0.01 && (
                <Row label="Redondeo" value={`${roundingAdj > 0 ? "+" : "−"}${money(Math.abs(roundingAdj))}`} />
              )}
              {tip > 0 && <Row label="Propina" value={`+${money(tip)}`} />}
            </dl>

            {/* Pagos cargados */}
            {lines.length > 0 && (
              <ul className="mt-4 space-y-1.5" aria-label="Pagos">
                {lines.map((l) => (
                  <li key={l.key} className="flex items-center gap-2.5 rounded-2xl bg-card p-2 pr-2.5">
                    <BrandIcon logo={l.logo} alt={l.title} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 truncate text-[13px] font-bold">
                        {l.title}
                        {l.locked && <Check size={13} className="shrink-0 text-success" aria-label="Aprobado" />}
                      </span>
                      {l.detail && <span className="block truncate text-[11px] text-muted-foreground">{l.detail}</span>}
                    </span>
                    <span className="font-price text-sm font-black tabular-nums">{money(l.amount)}</span>
                    {l.locked ? (
                      <Lock size={14} className="text-muted-foreground" aria-label="Cobro aprobado" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => removeLine(l.key)}
                        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
                        aria-label={`Quitar pago ${l.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Editor del medio activo */}
            {active && !readyToConfirm && (
              <div ref={editorRef} className="mt-4 rounded-3xl bg-card p-3.5 shadow-sm">
                <div className="flex items-center gap-2.5">
                  <BrandIcon logo={active.logo} alt={active.brandLabel} size={36} fallback={active.flow === "account" ? "account" : "wallet"} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black">
                      {active.group === "cash" || active.group === "transfer" || active.group === "card" || active.group === "customer"
                        ? active.label
                        : `${active.brandLabel} · ${active.label}`}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {active.flow === "qr"
                        ? active.channel === "link"
                          ? "Se genera un link para compartir; se acredita solo."
                          : "El cliente escanea y se acredita solo."
                        : active.flow === "point"
                          ? "La terminal recibe el cobro; el cliente pasa la tarjeta."
                          : active.flow === "terminal"
                            ? "Cobrá en la terminal y confirmá acá."
                            : active.flow === "store_credit"
                              ? `Saldo disponible ${money(storeCreditBalance)}`
                              : active.flow === "account"
                                ? "Queda en la cuenta corriente del cliente."
                                : active.hint ?? "Se registra al confirmar."}
                    </p>
                  </div>
                </div>

                {/* Monto de esta línea */}
                <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Monto a cobrar con este medio
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    inputMode="decimal"
                    value={portionStr}
                    onChange={(e) => setPortionStr(e.target.value.replace(/[^\d,.]/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && onCta()}
                    placeholder={money(maxPortion)}
                    aria-label="Monto a cobrar con este medio"
                    className="h-12 min-w-0 flex-1 rounded-2xl bg-fg-6 px-4 font-price text-xl font-black tabular-nums text-foreground outline-none placeholder:text-foreground focus:bg-muted"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip on={portionStr === ""} onClick={() => setPortionStr("")}>
                    Todo
                  </Chip>
                  {SPLITS.map((s) => (
                    <Chip
                      key={s.n}
                      on={portionStr !== "" && Math.abs(portion - splitShare(maxPortion, s.n)) < 0.005}
                      onClick={() => setPortionStr(String(splitShare(maxPortion, s.n)).replace(".", ","))}
                    >
                      {s.label}
                    </Chip>
                  ))}
                  {splitItems.length > 1 && (
                    <Chip on={itemsOpen} onClick={() => setItemsOpen((o) => !o)}>
                      Por ítem
                    </Chip>
                  )}
                </div>
                {itemsOpen && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {splitItems.map((it) => {
                      const on = pickedItems.includes(it.id);
                      return (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => {
                            const next = on ? pickedItems.filter((x) => x !== it.id) : [...pickedItems, it.id];
                            setPickedItems(next);
                            const sum = splitItems.filter((x) => next.includes(x.id)).reduce((a, x) => a + x.amount, 0);
                            setPortionStr(sum > 0 ? String(round2(sum)).replace(".", ",") : "");
                          }}
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                            on ? POS_SELECTED : POS_IDLE,
                          )}
                        >
                          {it.label} · {money(it.amount)}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Efectivo: recibido + vuelto */}
                {active.flow === "cash" && (
                  <div className="mt-4">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Recibido
                    </label>
                    <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                      <QuickCash on={receivedStr === ""} onClick={() => setReceivedStr("")}>
                        Exacto
                      </QuickCash>
                      {quick.map((q) => (
                        <QuickCash
                          key={q}
                          on={received === q}
                          onClick={() => setReceivedStr(String(q))}
                        >
                          {money(q)}
                        </QuickCash>
                      ))}
                      <input
                        inputMode="decimal"
                        value={quick.includes(received ?? -1) ? "" : receivedStr}
                        onChange={(e) => setReceivedStr(e.target.value.replace(/[^\d,.]/g, ""))}
                        onKeyDown={(e) => e.key === "Enter" && onCta()}
                        placeholder="Otro"
                        aria-label="Monto recibido"
                        className="h-11 min-w-0 rounded-xl bg-fg-6 px-3 text-center font-price text-sm font-bold tabular-nums outline-none focus:bg-muted"
                      />
                    </div>
                    <div
                      className={cn(
                        "mt-3 flex items-center justify-between rounded-2xl px-4 py-3",
                        receivedShort ? "bg-danger/15" : "bg-success/15",
                      )}
                    >
                      <span className={cn("text-sm font-bold", receivedShort ? "text-danger" : "text-success")}>
                        {receivedShort ? "Falta" : "Vuelto"}
                      </span>
                      <span
                        key={changePreview}
                        className={cn(
                          "pos-pop font-price text-2xl font-black tabular-nums",
                          receivedShort ? "text-danger" : "text-success",
                        )}
                      >
                        {money(receivedShort ? settle.amount - (received ?? 0) : changePreview)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Tarjeta: débito / crédito + cuotas */}
                {active.flow === "terminal" && (
                  <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-2xl bg-fg-6 p-1">
                    {(["debit", "credit"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setCardKind(k)}
                        className={cn(
                          "h-10 rounded-xl text-sm font-bold transition",
                          cardKind === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
                        )}
                      >
                        {k === "debit" ? "Débito" : "Crédito"}
                      </button>
                    ))}
                  </div>
                )}
                {isCard && plansForActive.length > 0 && (
                  <div className="mt-4">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Cuotas
                    </label>
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      <PlanChip on={planId === ""} onClick={() => setPlanId("")} title="Sin plan" sub={money(portion)} />
                      {plansForActive.map((p) => {
                        const pct = Number(p.surcharge_pct) || 0;
                        return (
                          <PlanChip
                            key={p.id}
                            on={planId === p.id}
                            onClick={() => setPlanId(p.id)}
                            title={p.label}
                            sub={pct > 0 ? `+${pct}% · ${money(round2(portion * (1 + pct / 100)))}` : "Sin recargo"}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
                {isCard && voucherRequired && (
                  <div className="mt-4">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Voucher de la tarjeta
                    </label>
                    <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                      {(
                        [
                          ["lote", "Lote"],
                          ["cupon", "Cupón"],
                          ["autorizacion", "Autoriz."],
                        ] as const
                      ).map(([k, label]) => (
                        <input
                          key={k}
                          inputMode="numeric"
                          value={voucher[k]}
                          onChange={(e) => setVoucher((v) => ({ ...v, [k]: e.target.value }))}
                          placeholder={label}
                          aria-label={label}
                          className="h-11 min-w-0 rounded-xl bg-fg-6 px-3 text-sm font-semibold outline-none focus:bg-muted"
                        />
                      ))}
                    </div>
                    {!voucherOk && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        Completá lote, cupón y autorización para registrar el pago.
                      </p>
                    )}
                  </div>
                )}

                {active.requiresReference && (
                  <div className="mt-4">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Número de operación
                    </label>
                    <input
                      value={opRef}
                      maxLength={64}
                      autoComplete="off"
                      onChange={(e) => setOpRef(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && onCta()}
                      placeholder="Ej. 123456"
                      aria-label="Número de operación"
                      className="mt-1.5 h-11 w-full rounded-xl bg-fg-6 px-3 text-sm font-semibold outline-none focus:bg-muted"
                    />
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Cobrá {money(settle.amount)} en el portal de {active.brandLabel} y cargá el número que
                      te da al aprobarse.
                    </p>
                  </div>
                )}
                {/* Cuenta corriente v2: saldo, disponible, vencido, cuotas y bloqueo
                    con autorización (motivo de encargado o PIN de supervisor). */}
                {isAccount && renderAccount && settle.amount > 0 && (
                  <div className="mt-4">
                    {renderAccount({ amount: settle.amount, onChange: onAccountChange })}
                  </div>
                )}
                {belowMin && active.minAmount && (
                  <p className="mt-3 rounded-xl bg-warning/15 px-3 py-2 text-xs font-semibold text-warning">
                    {active.brandLabel} acepta cobros desde {money(active.minAmount)}. Usá otro medio para
                    montos menores.
                  </p>
                )}
                {settle.surcharge > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Incluye recargo de {money(settle.surcharge)}.
                  </p>
                )}
                {isElectronic && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {active.flow === "point" ? <Smartphone size={13} /> : active.channel === "link" ? <Link2 size={13} /> : <QrCode size={13} />}
                    Al aprobarse se registra solo{settle.closes ? " y se cierra la venta" : ""}.
                  </p>
                )}

                {keypad && (
                  <Keypad className="mt-4" compact lastKey="," onKey={onKeypad} />
                )}
              </div>
            )}

            {/* Extras: propina, garantía, vendedor */}
            {(tipPresets.length > 0 || warrantyPlans.length > 0 || professionals.length > 0) && (
              <div className="mt-4 rounded-3xl bg-card">
                <button
                  type="button"
                  onClick={() => setExtrasOpen((o) => !o)}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
                  aria-expanded={extrasOpen}
                >
                  <span className="flex items-center gap-2 text-sm font-bold">
                    <Sparkles size={15} className="text-muted-foreground" />
                    Propina, garantía y vendedor
                  </span>
                  <ChevronDown size={16} className={cn("text-muted-foreground transition", extrasOpen && "rotate-180")} />
                </button>
                {extrasOpen && (
                  <div className="space-y-4 px-3.5 pb-4">
                    <div>
                      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        <Gift size={12} /> Propina
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        <Chip on={tipPct == null && (Number(tipCustom) || 0) === 0} onClick={() => { setTipPct(null); setTipCustom(""); }}>
                          Sin propina
                        </Chip>
                        {tipPresets.map((p) => (
                          <Chip key={p} on={tipPct === p} onClick={() => { setTipPct(p); setTipCustom(""); }}>
                            {p}%
                          </Chip>
                        ))}
                        <input
                          inputMode="decimal"
                          value={tipCustom}
                          onChange={(e) => {
                            setTipPct(null);
                            setTipCustom(e.target.value.replace(/[^\d.]/g, ""));
                          }}
                          placeholder="Otro $"
                          aria-label="Propina en pesos"
                          className="h-9 w-24 rounded-full bg-fg-6 px-3 text-center text-[13px] font-semibold outline-none focus:bg-muted"
                        />
                      </div>
                    </div>
                    {warrantyPlans.length > 0 && (
                      <div>
                        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          <ShieldCheck size={12} /> Garantía extendida
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          <Chip on={warrantyId === ""} onClick={() => setWarrantyId("")}>
                            Sin garantía
                          </Chip>
                          {warrantyPlans.map((w) => (
                            <Chip key={w.id} on={warrantyId === w.id} onClick={() => setWarrantyId(w.id)}>
                              {w.label} · {w.months} meses
                            </Chip>
                          ))}
                        </div>
                      </div>
                    )}
                    {professionals.length > 0 && (
                      <div>
                        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          <UserRound size={12} /> Vendedor
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          <Chip on={professionalId === ""} onClick={() => setProfessionalId("")}>
                            Sin asignar
                          </Chip>
                          {professionals.map((p) => (
                            <Chip key={p.id} on={professionalId === p.id} onClick={() => setProfessionalId(p.id)}>
                              {p.name}
                              {p.commission_pct != null ? ` · ${Number(p.commission_pct)}%` : ""}
                            </Chip>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* CTA */}
          <div className="shrink-0 border-t border-border bg-[color-mix(in_srgb,var(--popover)_92%,transparent)] px-4 pb-4 pt-3 backdrop-blur md:px-5 md:pb-5">
            <button
              type="button"
              onClick={onCta}
              disabled={ctaDisabled}
              className={cn(
                "flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-black tracking-tight",
                POS_CTA,
              )}
            >
              {loading || electronic ? <Spinner size={18} className="!border-black/20 !border-t-[color:var(--pos-ink)]" /> : null}
              {electronic ? "Esperando el cobro" : ctaLabel}
            </button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              {readyToConfirm
                ? "Se registra la venta y se imprime el ticket si está activo."
                : lines.length > 0
                  ? "Elegí otro medio para cobrar lo que resta."
                  : "Podés dividir el pago entre varios medios."}
            </p>
          </div>
        </aside>
      </div>

      {/* Confirmación inline: salir con cobros electrónicos aprobados */}
      {confirmLeave && (
        <div className="absolute inset-0 z-10 flex items-end bg-[color-mix(in_srgb,var(--popover)_92%,transparent)] backdrop-blur-sm md:items-center md:justify-center">
          <div className="w-full rounded-t-[28px] bg-popover p-5 shadow-2xl md:max-w-md md:rounded-[28px]">
            <p className="font-display text-lg font-black">Hay cobros aprobados</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Ya se cobraron {money(lockedTotal)} con QR o Point. Si salís sin confirmar la venta, el
              cobro queda en Cobros QR para conciliar y el carrito sigue abierto.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfirmLeave(false)}
                className="h-12 rounded-2xl bg-muted text-sm font-bold transition hover:bg-fg-10"
              >
                Volver al cobro
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmLeave(false);
                  onOpenChange(false);
                }}
                className="h-12 rounded-2xl bg-danger/15 text-sm font-bold text-danger transition hover:bg-danger/25"
              >
                Salir igual
              </button>
            </div>
          </div>
        </div>
      )}

      {electronic &&
        renderElectronic({
          tender: electronic.tender,
          amount: electronic.amount,
          onApproved: onElectronicApproved,
          onClose: () => setElectronic(null),
        })}
    </PosSheet>
  );
}

// Detalle de la línea de cuenta corriente (cuotas / autorización).
function accountDetail(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  try {
    const r = JSON.parse(reference) as { installments?: number; override_reason?: string; override_token?: string };
    const parts: string[] = [];
    if (r.installments && r.installments > 1) parts.push(`${r.installments} cuotas`);
    if (r.override_reason || r.override_token) parts.push("Autorizado");
    return parts.length ? parts.join(" · ") : undefined;
  } catch {
    return undefined;
  }
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "success" }) {
  return (
    <div className={cn("flex justify-between gap-3", tone === "success" ? "text-success" : "text-muted-foreground")}>
      <dt className="truncate">{label}</dt>
      <dd className="shrink-0 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn("h-9 rounded-full px-3.5 text-[13px] font-bold transition active:scale-95", on ? POS_SELECTED : POS_IDLE)}
    >
      {children}
    </button>
  );
}

function QuickCash({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "h-11 rounded-xl font-price text-sm font-black tabular-nums transition active:scale-95",
        on ? POS_SELECTED : "bg-fg-6 text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function PlanChip({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex flex-col items-start rounded-xl px-3 py-2 text-left transition active:scale-95",
        on ? POS_SELECTED : "bg-fg-6 text-foreground hover:bg-muted",
      )}
    >
      <span className="text-[13px] font-bold">{title}</span>
      <span className={cn("text-[11px] tabular-nums", on ? "opacity-70" : "text-muted-foreground")}>{sub}</span>
    </button>
  );
}
