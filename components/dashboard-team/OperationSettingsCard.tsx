"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SlidersHorizontal,
  Percent,
  CircleDollarSign,
  PackageMinus,
  Barcode,
  Lock,
  UserCheck,
  Hash,
  ClipboardCheck,
  Mail,
  CalendarClock,
  Rows3,
  Users,
  IdCard,
  ScanLine,
  TrendingUp,
  ShieldCheck,
  CreditCard,
  Banknote,
  Utensils,
} from "lucide-react";
import {
  CUSTOMER_FIELDS,
  type CustomerRequired,
} from "@/modules/customers/schemas";
import { useHasCatalog } from "@/modules/catalog/hooks";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";

type PluMode = "random" | "incremental";

type Settings = {
  max_discount: Record<string, number>;
  rounding_multiple: number;
  allow_negative_stock: boolean;
  sku_auto: boolean;
  sku_prefix: string;
  require_close_reason: boolean;
  close_tolerance: number;
  require_customer: boolean;
  sale_prefix: string;
  sale_pad: number;
  customer_required: CustomerRequired;
  auto_email_receipt: boolean;
  account_due_days: number;
  page_size: number;
  require_customer_doc: boolean;
  plu_enabled: boolean;
  plu_mode: PluMode;
  show_catalog_price_hints: boolean;
  offer_warranty: boolean;
  require_card_voucher: boolean;
  allow_free_sale: boolean;
  staff_sees_own_only: boolean;
  dining_enabled: boolean;
};

// Vista del card: el mismo settings/save se reparte en dos secciones de la
// pantalla de Configuración. "operacion" muestra reglas de cobro + productos;
// "clientes" muestra los datos del cliente, c/c y comprobante por email.
type View = "operacion" | "clientes";

// page_size aún no vive en los tipos generados (no se regeneran). Acotamos la
// lectura/escritura a este rango; la DB también lo valida con un CHECK.
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 20;

const ROLES: { key: string; label: string }[] = [
  { key: "owner", label: "Dueño" },
  { key: "manager", label: "Encargado" },
  { key: "cashier", label: "Cajero" },
];

const numCls =
  "h-9 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft";

export function OperationSettingsCard({ view = "operacion" }: { view?: View }) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["op-settings-ctx"],
    queryFn: async (): Promise<{ tenantId: string; role: string } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return { tenantId: mem.tenant_id, role: mem.role };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["pos-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<Settings> => {
      // select("*") incluye page_size (aún no tipado): casteamos vía unknown.
      const { data } = await supabase
        .from("pos_settings")
        .select("*")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return (
        (data as unknown as Settings) ?? {
          max_discount: { owner: 100, manager: 100, cashier: 100, viewer: 100 },
          rounding_multiple: 0,
          allow_negative_stock: true,
          sku_auto: false,
          sku_prefix: "",
          require_close_reason: false,
          close_tolerance: 0,
          require_customer: false,
          sale_prefix: "",
          sale_pad: 0,
          customer_required: {},
          auto_email_receipt: false,
          account_due_days: 30,
          page_size: PAGE_SIZE_DEFAULT,
          require_customer_doc: true,
          plu_enabled: false,
          plu_mode: "random",
          show_catalog_price_hints: true,
          offer_warranty: true,
          require_card_voucher: false,
          allow_free_sale: true,
          staff_sees_own_only: false,
          dining_enabled: false,
        }
      );
    },
  });

  const [maxDisc, setMaxDisc] = useState<Record<string, number>>({});
  const [rounding, setRounding] = useState(0);
  const [allowNeg, setAllowNeg] = useState(false);
  const [skuAuto, setSkuAuto] = useState(false);
  const [skuPrefix, setSkuPrefix] = useState("");
  const [requireReason, setRequireReason] = useState(false);
  const [tolerance, setTolerance] = useState(0);
  const [requireCustomer, setRequireCustomer] = useState(false);
  const [salePrefix, setSalePrefix] = useState("");
  const [salePad, setSalePad] = useState(0);
  const [customerReq, setCustomerReq] = useState<CustomerRequired>({});
  const [autoEmailReceipt, setAutoEmailReceipt] = useState(false);
  const [accountDueDays, setAccountDueDays] = useState(30);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [requireCustomerDoc, setRequireCustomerDoc] = useState(true);
  const [pluEnabled, setPluEnabled] = useState(false);
  const [pluMode, setPluMode] = useState<PluMode>("random");
  const [showCatalogPriceHints, setShowCatalogPriceHints] = useState(true);
  const [offerWarranty, setOfferWarranty] = useState(true);
  const [requireCardVoucher, setRequireCardVoucher] = useState(false);
  const [allowFreeSale, setAllowFreeSale] = useState(true);
  const [staffSeesOwnOnly, setStaffSeesOwnOnly] = useState(false);
  const [diningEnabled, setDiningEnabled] = useState(false);

  // El control de sugerencias de precio vs catálogo SÓLO se muestra si el tenant
  // compró/recibió al menos un catálogo.
  const { data: hasCatalog } = useHasCatalog();

  useEffect(() => {
    if (!settings) return;
    setMaxDisc({
      owner: settings.max_discount?.owner ?? 100,
      manager: settings.max_discount?.manager ?? 100,
      cashier: settings.max_discount?.cashier ?? 100,
    });
    setRounding(settings.rounding_multiple ?? 0);
    setAllowNeg(settings.allow_negative_stock ?? true);
    setSkuAuto(settings.sku_auto ?? false);
    setSkuPrefix(settings.sku_prefix ?? "");
    setRequireReason(settings.require_close_reason ?? false);
    setTolerance(settings.close_tolerance ?? 0);
    setRequireCustomer(settings.require_customer ?? false);
    setSalePrefix(settings.sale_prefix ?? "");
    setSalePad(settings.sale_pad ?? 0);
    setCustomerReq((settings.customer_required as CustomerRequired) ?? {});
    setAutoEmailReceipt(settings.auto_email_receipt ?? false);
    setAccountDueDays(settings.account_due_days ?? 30);
    setPageSize(settings.page_size ?? PAGE_SIZE_DEFAULT);
    setRequireCustomerDoc(settings.require_customer_doc ?? true);
    setPluEnabled(settings.plu_enabled ?? false);
    setPluMode(settings.plu_mode === "incremental" ? "incremental" : "random");
    setShowCatalogPriceHints(settings.show_catalog_price_hints ?? true);
    setOfferWarranty(settings.offer_warranty ?? true);
    setRequireCardVoucher(settings.require_card_voucher ?? false);
    setAllowFreeSale(settings.allow_free_sale ?? true);
    setStaffSeesOwnOnly(settings.staff_sees_own_only ?? false);
    setDiningEnabled(settings.dining_enabled ?? false);
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      // page_size aún no está tipado en el Insert generado: casteamos el payload.
      const { error } = await supabase.from("pos_settings").upsert(
        {
          tenant_id: tenantId,
          max_discount: {
            owner: clampPct(maxDisc.owner),
            manager: clampPct(maxDisc.manager),
            cashier: clampPct(maxDisc.cashier),
            viewer: 0,
          },
          rounding_multiple: Math.max(0, Number(rounding) || 0),
          allow_negative_stock: allowNeg,
          sku_auto: skuAuto,
          sku_prefix: skuPrefix.trim(),
          require_close_reason: requireReason,
          close_tolerance: Math.max(0, Number(tolerance) || 0),
          require_customer: requireCustomer,
          sale_prefix: salePrefix.trim(),
          sale_pad: Math.max(0, Math.min(12, Number(salePad) || 0)),
          customer_required: customerReq,
          auto_email_receipt: autoEmailReceipt,
          account_due_days: Math.max(1, Number(accountDueDays) || 30),
          page_size: clampPageSize(pageSize),
          require_customer_doc: requireCustomerDoc,
          plu_enabled: pluEnabled,
          plu_mode: pluMode,
          show_catalog_price_hints: showCatalogPriceHints,
          offer_warranty: offerWarranty,
          require_card_voucher: requireCardVoucher,
          allow_free_sale: allowFreeSale,
          staff_sees_own_only: staffSeesOwnOnly,
          dining_enabled: diningEnabled,
        } as never,
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["pos-settings", tenantId] });
      // El POS lee los settings operativos (incl. la oferta de garantía H28):
      // refrescá para que el toggle impacte de inmediato al cobrar.
      qc.invalidateQueries({ queryKey: ["pos", "settings"] });
      // Refresca el tamaño de página que usan los listados paginados.
      qc.invalidateQueries({ queryKey: ["pos", "page-size"] });
      // El formulario de cliente lee qué campos son obligatorios (incl. el
      // documento obligatorio): refrescá su query para que tome el cambio.
      qc.invalidateQueries({ queryKey: ["customers", "required-fields"] });
      // Las flechas de precio vs catálogo leen el toggle: refrescá para que el
      // cambio (activar/desactivar) impacte de inmediato en Productos/Listas.
      qc.invalidateQueries({ queryKey: ["catalog", "hint-setting"] });
      // Modo gastronómico (H43): el nav del POS y la vista de Salón leen el flag.
      qc.invalidateQueries({ queryKey: ["dining", "enabled"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || ctx.role !== "owner") return null;

  return (
    <section className="space-y-4">
      {view === "operacion" ? (
        <div>
          <Heading as="h2" className="flex items-center gap-2 text-base">
            <SlidersHorizontal size={18} /> Operación y productos
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            Reglas de cobro y de productos que se aplican en el punto de venta.
          </p>
        </div>
      ) : (
        <div>
          <Heading as="h2" className="flex items-center gap-2 text-base">
            <Users size={18} /> Datos del cliente
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">
            Qué pedir al crear o editar un cliente y cómo se maneja su cuenta.
          </p>
        </div>
      )}

      {/* ===================== Vista: OPERACIÓN Y PRODUCTOS ===================== */}
      {view === "operacion" && (
        <>
          <GroupHeading icon={Utensils}>Modo de operación</GroupHeading>

      {/* Modo gastronómico (F13 · H43): habilita salones y mesas (vista de Salón).
          ADITIVO: con off, el POS mostrador queda idéntico. Con on, aparece la
          sección "Salón" en el menú y "Salones y mesas" en Configuración. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Utensils size={16} className="text-ninja-flameSoft" /> Modo gastronómico (mesas)
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Habilita la atención por mesas: salones, estado de cada mesa, pedido
              por mesa y cobro desde la cuenta. Aparece la sección{" "}
              <span className="font-medium text-foreground">Salón</span> en el menú
              y la gestión de salones en Configuración. El POS de mostrador no
              cambia.
            </p>
          </div>
          <Switch
            checked={diningEnabled}
            onCheckedChange={setDiningEnabled}
            label="Activar modo gastronómico (salones y mesas)"
          />
        </CardContent>
      </Card>

          <GroupHeading icon={Percent}>Reglas de cobro</GroupHeading>

      {/* Descuento máximo por rol */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Percent size={16} className="text-ninja-flameSoft" /> Descuento máximo por rol
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Tope de % de descuento que cada rol puede aplicar al cobrar. El cajero
            no puede superarlo.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {ROLES.map((r) => (
              <label key={r.key} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="text-sm">{r.label}</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={maxDisc[r.key] ?? 0}
                    onChange={(e) =>
                      setMaxDisc((p) => ({ ...p, [r.key]: Number(e.target.value) }))
                    }
                    className={numCls}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Redondeo */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <CircleDollarSign size={16} className="text-ninja-flameSoft" /> Redondeo del total
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Redondea el total al múltiplo indicado. 0 = sin redondeo (ej. 10 → $1.237 cobra $1.240).
            </p>
          </div>
          <span className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="number"
              min="0"
              step="1"
              value={rounding}
              onChange={(e) => setRounding(Number(e.target.value) || 0)}
              className={numCls}
            />
          </span>
        </CardContent>
      </Card>

      {/* Cierre de caja */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Lock size={16} className="text-ninja-flameSoft" /> Motivo en el cierre de caja
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Exige escribir un motivo al cerrar si la diferencia (faltante o
                sobrante) supera la tolerancia.
              </p>
            </div>
            <Switch
              checked={requireReason}
              onCheckedChange={setRequireReason}
              label="Exigir motivo en el cierre"
            />
          </div>
          {requireReason && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Tolerancia $</span>
              <input
                type="number"
                min="0"
                step="1"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value) || 0)}
                className={numCls}
              />
              <span className="text-xs text-muted-foreground">
                Diferencias hasta este monto no piden motivo.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Oferta contextual de garantía extendida (H28): cuando el carrito tiene
          un producto con garantía de fábrica declarada, el POS ofrece solo los
          planes de garantía extendida aplicables (descartable, en un click). La
          prima entra como línea de la venta. Los planes se configuran en
          Configuración → Garantías. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck size={16} className="text-ninja-flameSoft" /> Ofrecer garantía extendida al cobrar
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Cuando hay un producto con garantía de fábrica en el carrito, el POS
              sugiere automáticamente los planes de garantía extendida para sumarlos
              en un click. El cajero puede descartarlo. Los planes se cargan en
              Configuración → Garantías.
            </p>
          </div>
          <Switch
            checked={offerWarranty}
            onCheckedChange={setOfferWarranty}
            label="Ofrecer garantía extendida automáticamente al cobrar productos con garantía"
          />
        </CardContent>
      </Card>

      {/* Voucher de tarjeta obligatorio (H27): cuando se cobra con débito o
          crédito, el POS pide lote, cupón y nº de autorización del voucher del
          POSNET. Quedan guardados junto al pago y visibles en el detalle de la
          venta. Por defecto desactivado. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <CreditCard size={16} className="text-ninja-flameSoft" /> Voucher de tarjeta obligatorio
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Al cobrar con débito o crédito, pide el lote, el cupón y el nº de
              autorización del voucher del POSNET. Se guardan con la venta para
              conciliar contra la terminal. No cambia el total.
            </p>
          </div>
          <Switch
            checked={requireCardVoucher}
            onCheckedChange={setRequireCardVoucher}
            label="Exigir lote, cupón y nº de autorización al cobrar con tarjeta"
          />
        </CardContent>
      </Card>

      {/* Venta libre (H36): habilita el botón de monto manual en el POS. El
          botón sólo lo ve owner/manager; este flag deja apagar la función por
          completo aun para roles habilitados. Default activado. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Banknote size={16} className="text-ninja-flameSoft" /> Permitir venta libre (monto manual)
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Muestra en el POS el botón “Venta libre” para cobrar un monto manual
              con un concepto, sin producto del catálogo (no descuenta stock). Sólo
              lo ven el dueño y el encargado.
            </p>
          </div>
          <Switch
            checked={allowFreeSale}
            onCheckedChange={setAllowFreeSale}
            label="Permitir venta libre (monto manual) en el POS"
          />
        </CardContent>
      </Card>

      {/* Staff ve sólo lo suyo (H39): si está activo, un profesional/cajero ve
          únicamente su propia agenda y su productividad/comisión; el dueño ve
          todo. El match usuario↔profesional usa el usuario vinculado a cada
          profesional. Default desactivado (todos ven todo). */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Users size={16} className="text-ninja-flameSoft" /> El staff ve sólo lo suyo
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Cada profesional/cajero ve únicamente su propia agenda y su
              productividad (servicios, comisión y propinas). El dueño sigue
              viendo a todo el equipo. Requiere vincular cada profesional con su
              usuario.
            </p>
          </div>
          <Switch
            checked={staffSeesOwnOnly}
            onCheckedChange={setStaffSeesOwnOnly}
            label="Cada profesional/cajero ve sólo su propia agenda y comisión"
          />
        </CardContent>
      </Card>

      <GroupHeading icon={PackageMinus}>Productos</GroupHeading>

      {/* Venta en negativo */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <PackageMinus size={16} className="text-ninja-flameSoft" /> Vender sin stock
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Permite vender productos aunque el stock quede en negativo. Se puede
              forzar por producto en su ficha.
            </p>
          </div>
          <Switch
            checked={allowNeg}
            onCheckedChange={setAllowNeg}
            label="Permitir venta en negativo"
          />
        </CardContent>
      </Card>

      {/* SKU automático */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Barcode size={16} className="text-ninja-flameSoft" /> SKU automático
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Si un producto se crea sin SKU, se genera solo con un prefijo + número.
              </p>
            </div>
            <Switch
              checked={skuAuto}
              onCheckedChange={setSkuAuto}
              label="SKU automático"
            />
          </div>
          {skuAuto && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Prefijo</span>
              <input
                value={skuPrefix}
                onChange={(e) => setSkuPrefix(e.target.value)}
                placeholder="Ej. ART-"
                maxLength={12}
                className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
              <span className="text-xs text-muted-foreground">
                → {(skuPrefix || "") + "00001"}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PLU: código corto de 6 dígitos para tipear rápido en el POS. La
          generación del PLU en cada producto la resuelve otro flujo; acá solo se
          habilita y se elige el modo. */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <ScanLine size={16} className="text-ninja-flameSoft" /> Usar PLU
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Código corto de 6 dígitos para tipear rápido un producto en el POS,
                sin escanear ni buscar por nombre.
              </p>
            </div>
            <Switch
              checked={pluEnabled}
              onCheckedChange={setPluEnabled}
              label="Usar PLU (código corto de 6 dígitos para tipear rápido en el POS)"
            />
          </div>
          {pluEnabled && (
            <div className="mt-3">
              <div className="mb-1.5 text-sm text-muted-foreground">Modo de generación</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    {
                      value: "random" as PluMode,
                      label: "Aleatorio",
                      hint: "Asigna un número de 6 dígitos al azar (no consecutivo).",
                    },
                    {
                      value: "incremental" as PluMode,
                      label: "Incremental",
                      hint: "Asigna el siguiente número disponible, de forma correlativa.",
                    },
                  ]
                ).map((m) => {
                  const active = pluMode === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setPluMode(m.value)}
                      className={
                        active
                          ? "flex items-start gap-2.5 rounded-lg border border-ninja-flame bg-ninja-flame/[0.06] px-3 py-2.5 text-left"
                          : "flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-ninja-flameSoft/40"
                      }
                    >
                      <span
                        className={
                          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border " +
                          (active ? "border-ninja-flame" : "border-muted-foreground/40")
                        }
                      >
                        {active && <span className="h-2 w-2 rounded-full bg-ninja-flame" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{m.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{m.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sugerencias de precio vs catálogo de referencia. SÓLO se muestra si el
          tenant compró/recibió un catálogo. Al activarse, en Productos y en las
          listas de precios aparecen flechas (verde = más barato, roja = más
          caro) comparando contra el precio de mercado. Es orientativo. */}
      {hasCatalog && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <TrendingUp size={16} className="text-ninja-flameSoft" /> Comparar precios con el catálogo
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Muestra flechas en Productos y en las listas de precios indicando
                si tu precio está por encima o por debajo del catálogo de
                referencia. Información orientativa de mercado, no vinculante.
              </p>
            </div>
            <Switch
              checked={showCatalogPriceHints}
              onCheckedChange={setShowCatalogPriceHints}
              label="Mostrar comparación de precios con el catálogo de referencia"
            />
          </CardContent>
        </Card>
      )}

      <GroupHeading icon={Hash}>Comprobante y listados</GroupHeading>

      {/* Numeración del comprobante */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Hash size={16} className="text-ninja-flameSoft" /> Numeración del comprobante
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Personalizá cómo se ve el N° de venta. El correlativo interno no cambia.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Prefijo</span>
              <input
                value={salePrefix}
                onChange={(e) => setSalePrefix(e.target.value)}
                placeholder="Ej. NINJA-"
                maxLength={12}
                className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Ceros (padding)</span>
              <input
                type="number"
                min={0}
                max={12}
                value={salePad}
                onChange={(e) => setSalePad(Number(e.target.value) || 0)}
                className={numCls}
              />
            </label>
            <span className="text-sm text-muted-foreground">
              Vista previa:{" "}
              <span className="font-mono font-semibold text-foreground">
                {formatSaleNumber(42, { prefix: salePrefix, pad: salePad })}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Tamaño de página de los listados */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Rows3 size={16} className="text-ninja-flameSoft" /> Filas por página
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Cuántas filas se muestran por página en los listados (ventas,
              productos, clientes). Entre {PAGE_SIZE_MIN} y {PAGE_SIZE_MAX}.
            </p>
          </div>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={PAGE_SIZE_MIN}
              max={PAGE_SIZE_MAX}
              step="1"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value) || PAGE_SIZE_DEFAULT)}
              onBlur={() => setPageSize((v) => clampPageSize(v))}
              className={numCls}
            />
            <span className="text-sm text-muted-foreground">filas</span>
          </span>
        </CardContent>
      </Card>
        </>
      )}

      {/* ========================= Vista: DATOS DEL CLIENTE ========================= */}
      {view === "clientes" && (
        <>
      {/* Requerir cliente */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <UserCheck size={16} className="text-ninja-flameSoft" /> Requerir cliente al cobrar
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Obliga a elegir un cliente antes de cobrar (no permite “consumidor final”).
            </p>
          </div>
          <Switch
            checked={requireCustomer}
            onCheckedChange={setRequireCustomer}
            label="Requerir cliente"
          />
        </CardContent>
      </Card>

      {/* Documento obligatorio: si está activo, el formulario de alta de cliente
          exige tipo + número de documento. Default activado. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <IdCard size={16} className="text-ninja-flameSoft" /> Documento obligatorio
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Al crear o editar un cliente, exige el tipo y el número de documento.
              Recomendado para emitir comprobantes válidos.
            </p>
          </div>
          <Switch
            checked={requireCustomerDoc}
            onCheckedChange={setRequireCustomerDoc}
            label="Exigir tipo y número de documento al dar de alta un cliente"
          />
        </CardContent>
      </Card>

      {/* Datos obligatorios del cliente */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 font-semibold">
            <ClipboardCheck size={16} className="text-ninja-flameSoft" /> Otros datos obligatorios del cliente
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Campos extra que se exigen al crear o editar un cliente. El nombre
            siempre es obligatorio. Por defecto no se exige nada.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {CUSTOMER_FIELDS.map((f) => (
              <label
                key={f.key}
                className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="text-sm">{f.label}</span>
                <Switch
                  checked={Boolean(customerReq[f.key])}
                  onCheckedChange={(v) =>
                    setCustomerReq((p) => ({ ...p, [f.key]: v }))
                  }
                  label={`Exigir ${f.label}`}
                />
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Plazo de cuenta corriente */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <CalendarClock size={16} className="text-ninja-flameSoft" /> Plazo de cuenta corriente (días)
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Vencimiento de cada venta fiada (cuenta corriente).
            </p>
          </div>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min="1"
              step="1"
              value={accountDueDays}
              onChange={(e) => setAccountDueDays(Number(e.target.value) || 30)}
              className={numCls}
            />
            <span className="text-sm text-muted-foreground">días</span>
          </span>
        </CardContent>
      </Card>

      {/* Comprobante por email automático */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Mail size={16} className="text-ninja-flameSoft" /> Comprobante por email automático
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Al completar una venta, envía el comprobante por email si el cliente
              tiene un email cargado en su ficha.
            </p>
          </div>
          <Switch
            checked={autoEmailReceipt}
            onCheckedChange={setAutoEmailReceipt}
            label="Enviar comprobante por email automáticamente (si el cliente tiene email)"
          />
        </CardContent>
      </Card>
        </>
      )}

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </section>
  );
}

// Subtítulo de grupo dentro del card: separa visualmente los bloques de cards
// por dominio (Reglas de cobro / Productos / Comprobante y listados).
function GroupHeading({
  icon: Icon,
  children,
}: {
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
      <Icon size={14} className="text-ninja-flameSoft" />
      {children}
    </div>
  );
}

function clampPct(v: number | undefined) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function clampPageSize(v: number | undefined) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, n));
}
