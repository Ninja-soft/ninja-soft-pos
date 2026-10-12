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
  SlidersHorizontal,
  Smartphone,
  Trash2,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import {
  checkoutTotals,
  defaultKeypadField,
  keypadFieldFor,
  quickCashAmounts,
  round2,
  settleLine,
  splitRemainder,
  splitShare,
  tipFromPercent,
  tipMethodFor,
  type CheckoutLine,
  type KeypadField,
} from "@/lib/pos/checkoutMath";
import {
  checkoutSections,
  groupTenders,
  normalizeTenderId,
  type ResolvedTender,
  type SaleMethod,
  type TenderPrefs,
} from "@/lib/pos/tenders";
import { PRESET_DEFAULTS, type CheckoutPrefs } from "@/lib/pos/layout";
import {
  availableCardBrands,
  cardBrandByKey,
  cardBrandLogo,
  cardLogoKey,
  plansForCard,
  type CardKind,
} from "@/lib/pos/cardBrands";
import { Keypad, applyKey, keypadNumber, type KeypadKey } from "../ui/Keypad";
import { PosSheet } from "../ui/PosSheet";
import { TenderLogo, tenderFallback } from "../ui/TenderLogo";
import { POS_CTA, money } from "../ui/posStyles";
import { TenderPicker, type TenderPickerVariant } from "./TenderPicker";
import { CardWizard, EMPTY_VOUCHER, PlanChip, type CardStep } from "./CardWizard";
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
  /** Entidad (payment_plans.brand): su logo va en el chip. null = aplica a todas. */
  brand?: string | null;
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
  /** Diseño de la hoja (pos_layout.checkout). */
  checkout?: CheckoutPrefs;
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
const DEFAULT_CHECKOUT = PRESET_DEFAULTS.mostrador.checkout;
const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const INPUT =
  "rounded-lg border border-border bg-background text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";
const PILL =
  "inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const PILL_IDLE = "border border-border bg-card text-muted-foreground hover:text-foreground";
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
    checkout = DEFAULT_CHECKOUT,
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
  const usable = useMemo(
    () => (hasAccountLine ? tenders.filter((t) => t.flow !== "account") : tenders),
    [tenders, hasAccountLine],
  );
  // Selector: favoritos arriba y grupos ocultos fuera (pos_layout.checkout).
  const sections = useMemo(
    () => checkoutSections(usable, prefs, { favorites: checkout.favorites, hiddenGroups: checkout.hiddenGroups }),
    [usable, prefs, checkout.favorites, checkout.hiddenGroups],
  );
  // Todos los medios usables (también los de grupos ocultos: un medio fijado
  // en el carrito abre la hoja aunque su grupo no se muestre en el selector).
  const visible = useMemo(() => groupTenders(usable, prefs).flatMap((s) => s.tenders), [usable, prefs]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"tenders" | "editor">("tenders");
  const [portionStr, setPortionStr] = useState("");
  const [receivedStr, setReceivedStr] = useState("");
  // Campo que escribe el teclado (monto con este medio o, en efectivo, recibido).
  const [keypadChoice, setKeypadChoice] = useState<KeypadField>("received");
  const [cardKind, setCardKind] = useState<CardKind>("debit");
  // Tarjeta en posnet: entidad elegida y paso del asistente (1 entidad, 2 tipo
  // y cuotas, 3 datos del cupón).
  const [cardBrand, setCardBrand] = useState<string | null>(null);
  const [cardStep, setCardStep] = useState<CardStep>(1);
  const [planId, setPlanId] = useState("");
  const [voucher, setVoucher] = useState(EMPTY_VOUCHER);
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
    const initialId = initialTenderId ? normalizeTenderId(initialTenderId) : null;
    const initial =
      (initialId && visible.find((t) => t.id === initialId)) ||
      visible.find((t) => t.id === "cash") ||
      visible[0] ||
      null;
    setLines([]);
    setActiveId(initial?.id ?? null);
    setView(initialTenderId && initial ? "editor" : "tenders");
    setPortionStr("");
    setReceivedStr("");
    setKeypadChoice(defaultKeypadField(initial?.flow));
    setCardKind("debit");
    setCardBrand(null);
    setCardStep(1);
    setPlanId("");
    setVoucher(EMPTY_VOUCHER);
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
  const isCard = active?.flow === "card" || active?.flow === "terminal";
  const isPosnet = active?.flow === "card";
  const activeMethod: SaleMethod | null = active ? (isCard ? cardKind : active.method) : null;

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
    if (!isCard) return [];
    // Tarjeta en posnet: planes de la entidad elegida (y los sin entidad).
    if (isPosnet) return plansForCard(cardPlans, cardBrand === "other" ? null : cardBrand, cardKind);
    const b = activeMethod ? PLAN_BASE[activeMethod] : undefined;
    if (!b) return [];
    return cardPlans
      .filter((p) => p.base === b)
      .sort((a, z) => (a.installments ?? 1) - (z.installments ?? 1));
  }, [cardPlans, activeMethod, isCard, isPosnet, cardBrand, cardKind]);
  const cardBrands = useMemo(() => availableCardBrands(cardPlans), [cardPlans]);
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

  const last4Ok = voucher.ultimos4.trim() === "" || /^\d{4}$/.test(voucher.ultimos4.trim());
  const voucherOk =
    !isCard ||
    ((!voucherRequired ||
      (voucher.lote.trim() !== "" && voucher.cupon.trim() !== "" && voucher.autorizacion.trim() !== "")) &&
      last4Ok);
  // Tarjeta en posnet: se registra recién en el paso del cupón.
  const posnetReady = !isPosnet || (cardBrand !== null && cardStep === 3);
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
    posnetReady &&
    refOk &&
    !belowMin &&
    !receivedShort &&
    !electronic;

  // Reset de los campos al cambiar de medio.
  useEffect(() => {
    setPlanId("");
    setReceivedStr("");
    setVoucher(EMPTY_VOUCHER);
    setOpRef("");
    // El estado de cuenta corriente NO se resetea acá: el panel lo reporta al
    // montarse (y su efecto corre antes que éste, lo pisaría).
  }, [activeId, cardKind]);

  function pickTender(t: ResolvedTender) {
    setActiveId(t.id);
    setView("editor");
    setKeypadChoice(defaultKeypadField(t.flow));
    if (t.method === "debit" || t.method === "credit") setCardKind(t.method);
    if (t.flow === "card") {
      setCardBrand(null);
      setCardStep(1);
    }
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
    setVoucher(EMPTY_VOUCHER);
    setOpRef("");
    setCardBrand(null);
    setCardStep(1);
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
      isCard &&
      (voucherRequired ||
        isPosnet ||
        voucher.lote.trim() !== "" ||
        voucher.cupon.trim() !== "" ||
        voucher.autorizacion.trim() !== "" ||
        voucher.ultimos4.trim() !== "");
    const brandInfo = isPosnet ? cardBrandByKey(cardBrand) : null;
    const kindLabel = cardKind === "debit" ? "Débito" : "Crédito";
    addLine({
      key: `l${++keySeq}`,
      tenderId: active.id,
      title:
        active.flow === "terminal"
          ? `${active.brandLabel} Point`
          : isPosnet
            ? `${brandInfo && brandInfo.key !== "other" ? brandInfo.label : "Tarjeta"} ${kindLabel.toLowerCase()}`
            : active.label,
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
      logo: isPosnet && cardBrand ? cardBrandLogo(cardBrand, cardKind) : active.logo,
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
            ...(brandInfo ? { marca: brandInfo.label } : {}),
            ...(voucher.ultimos4.trim() ? { ultimos4: voucher.ultimos4.trim() } : {}),
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
    else if (isPosnet && cardStep < 3) ctaLabel = cardBrand ? "Continuar" : "Elegí la entidad de la tarjeta";
    else if (isPosnet) ctaLabel = `Registrar cobro con tarjeta ${amt}`;
    else ctaLabel = settle.closes ? `Cobrar ${amt}` : `Agregar pago ${amt}`;
  }
  const posnetNext = !readyToConfirm && isPosnet && cardStep < 3;
  const ctaDisabled = readyToConfirm
    ? loading
    : posnetNext
      ? cardBrand === null || portion <= 0
      : !canCommit || loading;
  function onCta() {
    if (readyToConfirm) finalize(lines);
    else if (posnetNext) {
      if (cardBrand) setCardStep(3);
    } else commit();
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

  const keypadTarget = keypadFieldFor(active?.flow, keypadChoice);
  const onKeypad = (k: KeypadKey) => {
    if (keypadTarget === "received") setReceivedStr((v) => applyKey(v, k));
    else setPortionStr((v) => applyKey(v, k));
  };
  const leftover = splitRemainder(remaining, portion);
  // ¿Se puede editar el monto? En el cupón de la tarjeta en posnet ya quedó fijo.
  const kfEditable = Boolean(active) && !(isPosnet && cardStep === 3);

  const dense = checkout.density === "compact";
  const layoutKind = checkout.layout;
  const big = layoutKind === "big_buttons";

  // Partido rápido del monto (Todo / ½ / ⅓ / ¼) como control segmentado.
  const splitValue =
    portionStr === ""
      ? "all"
      : (SPLITS.find((s) => Math.abs(portion - splitShare(maxPortion, s.n)) < 0.005)?.n.toString() ?? "custom");
  const onSplit = (v: string) => {
    if (v === "all") setPortionStr("");
    else setPortionStr(String(splitShare(maxPortion, Number(v))).replace(".", ","));
  };

  const pending = lines.length > 0 && !totals.settled;

  // ── Piezas ──────────────────────────────────────────────────────────────────
  const totalBlock = (
    <div>
      <p className={LABEL}>{pending ? "Resta cobrar" : "Total a cobrar"}</p>
      <p
        key={pending ? remaining : totals.grandTotal}
        className={cn(
          "font-price font-bold leading-tight tracking-tight tabular-nums text-foreground",
          layoutKind === "keypad_first" || big ? "text-5xl" : "text-4xl",
        )}
      >
        {money(pending ? remaining : totals.grandTotal)}
      </p>
      {(lines.length > 0 || totals.change > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {pending && (
            <span className="text-xs text-muted-foreground">
              Pagado {money(totals.paid)} de {money(totals.grandTotal)}
            </span>
          )}
          {totals.settled && lines.length > 0 && (
            <Badge tone="success">
              <Check size={12} /> Cubierto
            </Badge>
          )}
          {totals.change > 0 && <Badge tone="success">Vuelto {money(totals.change)}</Badge>}
        </div>
      )}
    </div>
  );

  const hasBreakdown =
    deliveryFee > 0 || warranty > 0 || totals.surcharges > 0 || promoExtra > 0 || Math.abs(roundingAdj) >= 0.01 || tip > 0;
  const breakdown = hasBreakdown ? (
    <dl className="mt-3 space-y-1 border-t border-border pt-3 text-[13px]">
      {deliveryFee > 0 && <Row label="Envío" value={`+${money(deliveryFee)}`} />}
      {warranty > 0 && <Row label={`Garantía ${wplan?.label ?? ""}`} value={`+${money(warranty)}`} />}
      {totals.surcharges > 0 && <Row label="Recargos" value={`+${money(totals.surcharges)}`} />}
      {promoExtra > 0 && (
        <Row label={promo?.name ?? "Promo por medio de pago"} value={`-${money(promoExtra)}`} tone="success" />
      )}
      {Math.abs(roundingAdj) >= 0.01 && (
        <Row label="Redondeo" value={`${roundingAdj > 0 ? "+" : "-"}${money(Math.abs(roundingAdj))}`} />
      )}
      {tip > 0 && <Row label="Propina" value={`+${money(tip)}`} />}
    </dl>
  ) : null;

  const paidList =
    lines.length > 0 ? (
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card" aria-label="Pagos">
        {lines.map((l) => (
          <li key={l.key} className="flex items-center gap-2.5 px-3 py-2">
            <TenderLogo source={l} alt={l.title} size={24} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 truncate text-[13px] font-semibold">
                {l.title}
                {l.locked && <Check size={13} className="shrink-0 text-success" aria-label="Aprobado" />}
              </span>
              {l.detail && <span className="block truncate text-[11px] text-muted-foreground">{l.detail}</span>}
            </span>
            <span className="font-price text-sm font-semibold tabular-nums">{money(l.amount)}</span>
            {l.locked ? (
              <Lock size={14} className="text-muted-foreground" aria-label="Cobro aprobado" />
            ) : (
              <button
                type="button"
                onClick={() => removeLine(l.key)}
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-danger/10 hover:text-danger"
                aria-label={`Quitar pago ${l.title}`}
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    ) : null;

  const activeDesc = !active
    ? ""
    : active.flow === "qr"
      ? active.channel === "link"
        ? "Se genera un link para compartir y se acredita solo."
        : "El cliente escanea y se acredita solo."
      : active.flow === "point"
        ? "La terminal recibe el cobro y el cliente pasa la tarjeta."
        : active.flow === "terminal"
          ? "Cobrá en la terminal y confirmá acá."
          : active.flow === "store_credit"
            ? `Saldo disponible ${money(storeCreditBalance)}`
            : active.flow === "account"
              ? "Queda en la cuenta corriente del cliente."
              : (active.hint ?? "Se registra al confirmar.");

  const editorHeader = active ? (
    <div className="flex items-center gap-2.5">
      <TenderLogo
        source={active}
        alt={active.brandLabel}
        size={30}
        fallback={tenderFallback(active)}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {active.group === "cash" || active.group === "transfer" || active.group === "card" || active.group === "customer"
            ? active.label
            : `${active.brandLabel} ${active.label}`}
        </p>
        <p className="truncate text-xs text-muted-foreground">{activeDesc}</p>
      </div>
    </div>
  ) : null;

  // Partir el pago: Todo / ½ / ⅓ / ¼ + por ítem + lo que queda para otro medio.
  // Lo comparten todas las variantes (con o sin teclado).
  const splitControls = (fill: boolean) => (
    <div>
      <div className={cn("flex flex-wrap items-center gap-2", fill && "flex-nowrap")}>
        <Segmented
          size={fill ? undefined : "sm"}
          fill={fill}
          className={fill ? "min-w-0 flex-1" : undefined}
          aria-label="Dividir el monto"
          value={splitValue}
          onChange={onSplit}
          options={[
            { value: "all", label: "Todo" },
            ...SPLITS.map((s) => ({ value: String(s.n), label: s.label })),
          ]}
        />
        {splitItems.length > 1 && (
          <button
            type="button"
            onClick={() => setItemsOpen((o) => !o)}
            aria-pressed={itemsOpen}
            className={cn(PILL, itemsOpen ? "choice-on" : PILL_IDLE)}
          >
            Por ítem
          </button>
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
                aria-pressed={on}
                onClick={() => {
                  const next = on ? pickedItems.filter((x) => x !== it.id) : [...pickedItems, it.id];
                  setPickedItems(next);
                  const sum = splitItems.filter((x) => next.includes(x.id)).reduce((a, x) => a + x.amount, 0);
                  setPortionStr(sum > 0 ? String(round2(sum)).replace(".", ",") : "");
                }}
                className={cn(PILL, "h-8 text-xs", on ? "choice-on" : PILL_IDLE)}
              >
                {it.label} · {money(it.amount)}
              </button>
            );
          })}
        </div>
      )}
      {leftover > 0.005 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Quedan {money(leftover)} para cobrar con otro medio.
        </p>
      )}
    </div>
  );

  // Monto de esta línea (input + partir el pago). En el cupón de la tarjeta en
  // posnet el monto ya quedó fijo (se ve en el resumen).
  const amountField = active && !(isPosnet && cardStep === 3) ? (
    <div>
      <label htmlFor="checkout-portion" className={LABEL}>
        Monto con este medio
      </label>
      <input
        id="checkout-portion"
        inputMode="decimal"
        value={portionStr}
        onChange={(e) => setPortionStr(e.target.value.replace(/[^\d,.]/g, ""))}
        onFocus={() => setKeypadChoice("portion")}
        onKeyDown={(e) => e.key === "Enter" && onCta()}
        placeholder={money(maxPortion)}
        className={cn(
          INPUT,
          "mt-1.5 h-12 w-full px-3.5 font-price text-xl font-semibold tabular-nums placeholder:text-foreground",
          keypad && active.flow === "cash" && keypadTarget === "portion" && "border-ring",
        )}
      />
      <div className="mt-2">{splitControls(false)}</div>
    </div>
  ) : null;

  // Efectivo: recibido rápido + vuelto.
  const cashBlock =
    active?.flow === "cash" ? (
      <div>
        <p className={LABEL}>Recibido</p>
        <div className={cn("mt-1.5 grid gap-1.5", big ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-3")}>
          <AmountButton on={receivedStr === ""} onClick={() => setReceivedStr("")} big={big}>
            Exacto
          </AmountButton>
          {quick.map((q) => (
            <AmountButton key={q} on={received === q} onClick={() => setReceivedStr(String(q))} big={big}>
              {money(q)}
            </AmountButton>
          ))}
          {layoutKind !== "keypad_first" && (
            <input
              inputMode="decimal"
              value={quick.includes(received ?? -1) ? "" : receivedStr}
              onChange={(e) => setReceivedStr(e.target.value.replace(/[^\d,.]/g, ""))}
              onFocus={() => setKeypadChoice("received")}
              onKeyDown={(e) => e.key === "Enter" && onCta()}
              placeholder="Otro"
              aria-label="Monto recibido"
              className={cn(
                INPUT,
                "min-w-0 px-3 text-center font-price text-sm font-semibold tabular-nums",
                big ? "h-14" : "h-11",
                keypad && keypadTarget === "received" && "border-ring",
              )}
            />
          )}
        </div>
        <ChangeBox short={receivedShort} amount={receivedShort ? settle.amount - (received ?? 0) : changePreview} />
      </div>
    ) : null;

  // Tarjeta en posnet: asistente entidad, tipo y cuotas, cupón.
  const cardBlock = isPosnet ? (
    <CardWizard
      brands={cardBrands}
      brand={cardBrand}
      onBrand={setCardBrand}
      step={cardStep}
      onStep={setCardStep}
      kind={cardKind}
      onKind={setCardKind}
      plans={plansForActive}
      planId={planId}
      onPlan={setPlanId}
      portion={portion}
      amount={settle.amount}
      surcharge={settle.surcharge}
      voucher={voucher}
      onVoucher={setVoucher}
      voucherRequired={voucherRequired}
      onEnter={onCta}
    />
  ) : // Terminal de la marca sin integración: débito / crédito + cuotas + voucher.
  active ? (
    <>
      {active.flow === "terminal" && (
        <Segmented
          fill
          aria-label="Tipo de tarjeta"
          value={cardKind}
          onChange={(v) => setCardKind(v)}
          options={[
            { value: "debit", label: "Débito" },
            { value: "credit", label: "Crédito" },
          ]}
        />
      )}
      {isCard && plansForActive.length > 0 && (
        <div>
          <p className={LABEL}>Cuotas</p>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Cuotas">
            <PlanChip on={planId === ""} onClick={() => setPlanId("")} title="Sin plan" sub={money(portion)} />
            {plansForActive.map((p) => {
              const pct = Number(p.surcharge_pct) || 0;
              return (
                <PlanChip
                  key={p.id}
                  on={planId === p.id}
                  onClick={() => setPlanId(p.id)}
                  title={p.label}
                  brand={cardLogoKey(p.brand)}
                  sub={pct > 0 ? `+${pct}% · ${money(round2(portion * (1 + pct / 100)))}` : "Sin recargo"}
                />
              );
            })}
          </div>
        </div>
      )}
      {isCard && voucherRequired && (
        <div>
          <p className={LABEL}>Voucher de la tarjeta</p>
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
                className={cn(INPUT, "h-11 min-w-0 px-3 text-sm font-medium")}
              />
            ))}
          </div>
          {!voucherOk && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Completá lote, cupón y autorización para registrar el pago.
            </p>
          )}
        </div>
      )}
    </>
  ) : null;

  const otherBlock = active ? (
    <>
      {active.requiresReference && (
        <div>
          <label htmlFor="checkout-opref" className={LABEL}>
            Número de operación
          </label>
          <input
            id="checkout-opref"
            value={opRef}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => setOpRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onCta()}
            placeholder="Ej. 123456"
            className={cn(INPUT, "mt-1.5 h-11 w-full px-3 text-sm font-medium")}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Cobrá {money(settle.amount)} en el portal de {active.brandLabel} y cargá el número que te da al
            aprobarse.
          </p>
        </div>
      )}
      {/* Cuenta corriente v2: saldo, disponible, vencido, cuotas y bloqueo
          con autorización (motivo de encargado o PIN de supervisor). */}
      {isAccount && renderAccount && settle.amount > 0 && (
        <div>{renderAccount({ amount: settle.amount, onChange: onAccountChange })}</div>
      )}
      {belowMin && active.minAmount && (
        <Callout tone="warning" className="p-3 text-xs">
          {active.brandLabel} acepta cobros desde {money(active.minAmount)}. Usá otro medio para montos menores.
        </Callout>
      )}
      {settle.surcharge > 0 && !isPosnet && (
        <p className="text-xs text-muted-foreground">Incluye recargo de {money(settle.surcharge)}.</p>
      )}
      {isElectronic && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {active.flow === "point" ? <Smartphone size={13} /> : active.channel === "link" ? <Link2 size={13} /> : <QrCode size={13} />}
          Al aprobarse se registra solo{settle.closes ? " y se cierra la venta" : ""}.
        </p>
      )}
    </>
  ) : null;

  // Editor completo (Dos columnas / Botones grandes / Lista compacta).
  const showEditor = Boolean(active) && !readyToConfirm;
  const editorBody = (
    <div className={cn("space-y-4", dense && "space-y-3")}>
      {amountField}
      {cashBlock}
      {cardBlock}
      {otherBlock}
      {keypad && <Keypad square compact={!big} lastKey="," onKey={onKeypad} />}
    </div>
  );
  const editorCard = showEditor ? (
    <div ref={editorRef} className={cn("mt-4 rounded-lg border border-border bg-card", dense ? "p-3" : "p-4")}>
      {editorHeader}
      <div className="mt-4">{editorBody}</div>
    </div>
  ) : null;

  const extras =
    tipPresets.length > 0 || warrantyPlans.length > 0 || professionals.length > 0 ? (
      <div className="mt-4 rounded-lg border border-border bg-card">
        <button
          type="button"
          onClick={() => setExtrasOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={extrasOpen}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal size={15} className="text-muted-foreground" />
            Propina, garantía y vendedor
          </span>
          <ChevronDown size={16} className={cn("text-muted-foreground transition", extrasOpen && "rotate-180")} />
        </button>
        {extrasOpen && (
          <div className="space-y-4 border-t border-border px-3.5 pb-4 pt-3">
            {tipPresets.length > 0 && (
              <div>
                <p className={cn(LABEL, "mb-1.5 flex items-center gap-1.5")}>
                  <Gift size={12} /> Propina
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    size="sm"
                    aria-label="Propina"
                    value={tipPct == null ? ((Number(tipCustom) || 0) === 0 ? "none" : "custom") : String(tipPct)}
                    onChange={(v) => {
                      setTipCustom("");
                      setTipPct(v === "none" ? null : Number(v));
                    }}
                    options={[
                      { value: "none", label: "Sin propina" },
                      ...tipPresets.map((p) => ({ value: String(p), label: `${p}%` })),
                    ]}
                  />
                  <input
                    inputMode="decimal"
                    value={tipCustom}
                    onChange={(e) => {
                      setTipPct(null);
                      setTipCustom(e.target.value.replace(/[^\d.]/g, ""));
                    }}
                    placeholder="Otro $"
                    aria-label="Propina en pesos"
                    className={cn(INPUT, "h-9 w-24 px-3 text-center text-[13px] font-medium")}
                  />
                </div>
              </div>
            )}
            {warrantyPlans.length > 0 && (
              <div>
                <p className={cn(LABEL, "mb-1.5 flex items-center gap-1.5")}>
                  <ShieldCheck size={12} /> Garantía extendida
                </p>
                <Segmented
                  size="sm"
                  aria-label="Garantía extendida"
                  value={warrantyId || "none"}
                  onChange={(v) => setWarrantyId(v === "none" ? "" : v)}
                  options={[
                    { value: "none", label: "Sin garantía" },
                    ...warrantyPlans.map((w) => ({ value: w.id, label: `${w.label} · ${w.months} meses` })),
                  ]}
                />
              </div>
            )}
            {professionals.length > 0 && (
              <div>
                <p className={cn(LABEL, "mb-1.5 flex items-center gap-1.5")}>
                  <UserRound size={12} /> Vendedor
                </p>
                <Segmented
                  size="sm"
                  aria-label="Vendedor"
                  value={professionalId || "none"}
                  onChange={(v) => setProfessionalId(v === "none" ? "" : v)}
                  options={[
                    { value: "none", label: "Sin asignar" },
                    ...professionals.map((p) => ({
                      value: p.id,
                      label: `${p.name}${p.commission_pct != null ? ` · ${Number(p.commission_pct)}%` : ""}`,
                    })),
                  ]}
                />
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  const ctaHint = readyToConfirm
    ? "Se registra la venta y se imprime el ticket si está activo."
    : lines.length > 0
      ? "Elegí otro medio para cobrar lo que resta."
      : "Podés dividir el pago entre varios medios.";
  const cta = (
    <div className={cn("shrink-0 border-t border-border bg-popover px-4 pb-4 pt-3", layoutKind === "two_columns" || big ? "md:px-5" : "md:px-6")}>
      <button
        type="button"
        onClick={onCta}
        disabled={ctaDisabled}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg font-semibold tracking-tight",
          // Mismo CTA sólido que "Cobrar" en el POS (posStyles, --pos-solid).
          POS_CTA,
          // Deshabilitado ("Elegí la entidad…"): relleno neutro legible, no el acento al 40%.
          "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
          big ? "h-16 text-lg" : "h-14 text-base",
        )}
      >
        {loading || electronic ? <Spinner size={18} className="border-current/30 border-t-current" /> : null}
        <span>{electronic ? "Esperando el cobro" : ctaLabel}</span>
      </button>
      <p className="mt-2 text-center text-xs text-muted-foreground">{ctaHint}</p>
    </div>
  );

  const emptyTenders = (
    <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
      No hay medios de cobro habilitados. Activalos en Configuración, Medios de pago.
    </p>
  );

  const picker = (variant: TenderPickerVariant, extra?: { renderExpanded?: () => React.ReactNode }) =>
    sections.length === 0 ? (
      emptyTenders
    ) : (
      <TenderPicker
        sections={sections}
        activeId={activeId}
        onPick={pickTender}
        promoBadge={promoBadge}
        disabled={readyToConfirm || Boolean(electronic)}
        variant={variant}
        channelChips={checkout.channelChips}
        dense={dense}
        renderExpanded={extra?.renderExpanded}
      />
    );

  const heading = <h2 className="font-display text-lg font-bold tracking-tight">¿Cómo paga?</h2>;

  // ── Distribuciones ─────────────────────────────────────────────────────────
  let content: React.ReactNode;
  if (layoutKind === "compact_list") {
    content = (
      <>
        <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 md:px-6 md:pt-6">
          <div className="pr-10">{totalBlock}</div>
          {breakdown}
          {paidList}
          <div className="mb-2 mt-5">{heading}</div>
          {picker("list", {
            renderExpanded: showEditor ? () => <div ref={editorRef}>{editorBody}</div> : undefined,
          })}
          {extras}
        </div>
        {cta}
      </>
    );
  } else if (layoutKind === "keypad_first") {
    content = (
      <>
        <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_minmax(340px,380px)] md:overflow-hidden">
          <section className="px-4 pb-4 pt-3 md:slim-scrollbar md:overflow-y-auto md:px-6 md:pt-6">
            <div className="pr-10 md:pr-0">{totalBlock}</div>
            {breakdown}
            {showEditor && active && (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                  <TenderLogo source={active} alt={active.brandLabel} size={18} fallback={tenderFallback(active)} />
                  {active.group === "cash" || active.group === "transfer" || active.group === "card" || active.group === "customer"
                    ? active.label
                    : `${active.brandLabel} ${active.label}`}
                </div>
                {/* Campos del teclado: el que está marcado es el que escribe. En
                    efectivo hay dos (monto con este medio y recibido). */}
                {kfEditable ? (
                  <div className={cn("grid gap-2", active.flow === "cash" && "grid-cols-2")}>
                    <KeypadFieldBox
                      label="Monto con este medio"
                      value={portionStr === "" ? money(maxPortion) : `$ ${portionStr}`}
                      sub={portionStr === "" ? "Todo el saldo" : settle.closes ? "Cierra la cuenta" : "Pago parcial"}
                      on={keypadTarget === "portion"}
                      showOn={active.flow === "cash"}
                      ariaLabel="Escribir con el teclado el monto con este medio"
                      onClick={() => setKeypadChoice("portion")}
                    />
                    {active.flow === "cash" && (
                      <KeypadFieldBox
                        label="Recibido"
                        value={receivedStr === "" ? money(settle.amount) : `$ ${receivedStr}`}
                        sub={receivedStr === "" ? "Exacto" : `Cobro ${money(settle.amount)}`}
                        on={keypadTarget === "received"}
                        showOn
                        ariaLabel="Escribir con el teclado el monto recibido"
                        onClick={() => setKeypadChoice("received")}
                      />
                    )}
                  </div>
                ) : null}
                {kfEditable && splitControls(true)}
                {active.flow === "cash" && (
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    <AmountButton
                      on={receivedStr === ""}
                      onClick={() => {
                        setReceivedStr("");
                        setKeypadChoice("received");
                      }}
                    >
                      Exacto
                    </AmountButton>
                    {quick.map((q) => (
                      <AmountButton
                        key={q}
                        on={received === q}
                        onClick={() => {
                          setReceivedStr(String(q));
                          setKeypadChoice("received");
                        }}
                      >
                        {money(q)}
                      </AmountButton>
                    ))}
                  </div>
                )}
                {kfEditable && <Keypad square lastKey="," onKey={onKeypad} />}
                {active.flow === "cash" && (
                  <ChangeBox short={receivedShort} amount={receivedShort ? settle.amount - (received ?? 0) : changePreview} />
                )}
              </div>
            )}
          </section>
          <aside className="border-t border-border bg-fg-4 px-4 pb-4 pt-4 md:slim-scrollbar md:overflow-y-auto md:border-l md:border-t-0 md:px-5 md:pt-6">
            <div className="mb-2">{heading}</div>
            {picker("compact")}
            {paidList}
            {showEditor && active && active.flow !== "cash" && (
              <div ref={editorRef} className={cn("mt-4 space-y-4 rounded-lg border border-border bg-card", dense ? "p-3" : "p-4")}>
                {editorHeader}
                {cardBlock}
                {otherBlock}
              </div>
            )}
            {extras}
          </aside>
        </div>
        {cta}
      </>
    );
  } else {
    // Dos columnas (y Botones grandes, con la misma estructura en grande).
    content = (
      <div
        className={cn(
          "grid min-h-0 flex-1 md:h-[min(92dvh,860px)]",
          big ? "md:grid-cols-[minmax(0,1fr)_minmax(380px,430px)]" : "md:grid-cols-[minmax(0,1fr)_minmax(340px,390px)]",
        )}
      >
        <section
          className={cn(
            "slim-scrollbar min-h-0 overflow-y-auto px-4 pb-6 pt-3 md:px-6 md:pt-6",
            view === "editor" && "max-md:hidden",
          )}
        >
          <div className="mb-4 pr-10 md:hidden">{totalBlock}</div>
          <div className="mb-3 hidden md:block">{heading}</div>
          {picker(big ? "big" : "tiles")}
        </section>

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
            <div className="pr-10 md:pr-8">{totalBlock}</div>
            {breakdown}
            {paidList}
            {editorCard}
            {extras}
          </div>
          {cta}
        </aside>
      </div>
    );
  }

  return (
    <PosSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}
      onRequestClose={requestClose}
      title="Cobrar"
      description={`Total ${money(totals.grandTotal)}`}
      size="xl"
      style={style}
      focusContainer
      className={cn(
        "rounded-t-xl md:rounded-xl",
        layoutKind === "compact_list" && "md:h-[min(92dvh,860px)] md:max-w-xl",
        layoutKind === "keypad_first" && "md:h-[min(92dvh,860px)] md:max-w-4xl",
      )}
    >
      {content}

      {/* Confirmación inline: salir con cobros electrónicos aprobados */}
      {confirmLeave && (
        <div className="absolute inset-0 z-10 flex items-end bg-[color-mix(in_srgb,var(--popover)_92%,transparent)] backdrop-blur-sm md:items-center md:justify-center">
          <div className="w-full rounded-t-xl border border-border bg-popover p-5 shadow-2xl md:max-w-md md:rounded-xl">
            <p className="font-display text-lg font-bold">Hay cobros aprobados</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Ya se cobraron {money(lockedTotal)} con QR o Point. Si salís sin confirmar la venta, el cobro queda
              en Cobros QR para conciliar y el carrito sigue abierto.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button variant="secondary" size="lg" onClick={() => setConfirmLeave(false)}>
                Volver al cobro
              </Button>
              <Button
                variant="destructive"
                size="lg"
                onClick={() => {
                  setConfirmLeave(false);
                  onOpenChange(false);
                }}
              >
                Salir igual
              </Button>
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

function AmountButton({
  on,
  onClick,
  big,
  children,
}: {
  on: boolean;
  onClick: () => void;
  big?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-lg font-price text-sm font-semibold tabular-nums transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        big ? "h-14 text-base" : "h-11",
        on ? "choice-on border border-transparent" : "border border-border bg-card text-foreground hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}

// Campo del teclado en "Teclado primero": tocarlo lo vuelve el destino del
// teclado. `showOn` marca el activo sólo cuando hay más de un campo.
function KeypadFieldBox({
  label,
  value,
  sub,
  on,
  showOn,
  ariaLabel,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  on: boolean;
  showOn: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  const marked = on && showOn;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={ariaLabel}
      className={cn(
        "min-w-0 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        marked ? "border-ring bg-card ring-1 ring-ring" : "border-border bg-card hover:bg-muted/60",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={cn(LABEL, "truncate")}>{label}</span>
        {marked && (
          <span className="shrink-0 rounded bg-fg-10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
            Teclado
          </span>
        )}
      </span>
      <span className="mt-1 block truncate text-right font-price text-3xl font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="block truncate text-right text-xs text-muted-foreground">{sub}</span>
    </button>
  );
}

function ChangeBox({ short, amount }: { short: boolean; amount: number }) {
  return (
    <div
      className={cn(
        "mt-3 flex items-center justify-between rounded-lg px-4 py-3",
        short ? "bg-danger/10" : "bg-success/10",
      )}
    >
      <span className={cn("text-sm font-semibold", short ? "text-danger" : "text-success")}>
        {short ? "Falta" : "Vuelto"}
      </span>
      <span
        key={amount}
        className={cn("pos-pop font-price text-2xl font-bold tabular-nums", short ? "text-danger" : "text-success")}
      >
        {money(amount)}
      </span>
    </div>
  );
}
