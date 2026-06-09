"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BadgeDollarSign, Bike, CalendarDays, CreditCard, Lock, Mail, MonitorSmartphone, Package, Palette, Printer, ReceiptText, RotateCcw, ScanLine, ShieldCheck, SlidersHorizontal, Store, Tag, Users, Utensils, Wrench } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { Card, CardContent } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils/cn";
import { useTheme, THEMES, type ThemeName } from "@/lib/theme/ThemeProvider";
import {
  useAppearance,
  DISPLAY_FONTS,
  PRICE_FONTS,
  BG_STYLES,
  PRICE_ACCENTS,
  type DisplayFont,
  type PriceFont,
  type BgStyle,
  type PriceAccent,
} from "@/lib/theme/AppearanceProvider";
import { formatCurrency } from "@/lib/utils/format";
import { BrandingCard } from "@/components/dashboard-team/BrandingCard";
import { PaymentMethodsCard } from "@/components/dashboard-team/PaymentMethodsCard";
import { OperationSettingsCard } from "@/components/dashboard-team/OperationSettingsCard";
import { ReturnsSettingsCard } from "@/components/dashboard-team/ReturnsSettingsCard";
import { ScannerCard } from "@/components/dashboard-team/ScannerCard";
import { CustomerDisplayCard } from "@/components/dashboard-team/CustomerDisplayCard";
import { HardwareCard } from "@/components/dashboard-team/HardwareCard";
import { WarrantyPlansManager } from "@/components/products/WarrantyPlansManager";
import { RubroCard } from "@/components/dashboard-team/RubroCard";
import { ProfessionalsManager } from "@/components/agenda/ProfessionalsManager";
import { SalonesManager } from "@/components/dining/SalonesManager";
import { ZonasManager } from "@/components/delivery/ZonasManager";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import { ServicePacksManager } from "@/components/packs/ServicePacksManager";
import { TenantEmailCard } from "@/components/dashboard-team/TenantEmailCard";
import { TicketTemplatesCard } from "@/components/tickets/TicketTemplatesCard";
import { PrintSettingsCard } from "@/components/dashboard-team/PrintSettingsCard";
import { PriceListsCard } from "@/components/prices/PriceListsCard";
import { useFeature } from "@/modules/saas/gating";
import { UpgradeModal } from "@/components/saas/UpgradeModal";

type Section =
  | "apariencia"
  | "rubro"
  | "marca"
  | "tickets"
  | "impresion"
  | "email"
  | "pagos"
  | "operacion"
  | "salones"
  | "zonas"
  | "profesionales"
  | "paquetes"
  | "clientes"
  | "devoluciones"
  | "escaner"
  | "pantalla-cliente"
  | "hardware"
  | "precios"
  | "garantias";

type SectionDef = {
  key: Section;
  label: string;
  icon: React.ElementType;
  // `feature` (opcional): si el plan no la incluye, la sección queda
  // deshabilitada (candado) y el click abre el UpgradeModal en lugar de entrar.
  feature?: string;
  // `requiresDining` (opcional): la sección sólo se muestra si el modo
  // gastronómico (pos_settings.dining_enabled · H43) está activo. No es gating
  // de plan: es un toggle del propio tenant, así que se oculta (no candado).
  requiresDining?: boolean;
  // `requiresDelivery` (opcional): la sección sólo se muestra si delivery
  // (pos_settings.delivery_enabled · H49) está activo. Mismo criterio que
  // requiresDining: toggle del tenant, se oculta (no candado).
  requiresDelivery?: boolean;
};

// Las secciones se agrupan en bloques temáticos para que el menú sea navegable
// (Negocio / Operación / Cobro / Clientes / Comprobantes / Apariencia). El orden
// y el agrupado son visuales: cada sección sigue siendo independiente.
const SECTION_GROUPS: { title: string; sections: SectionDef[] }[] = [
  {
    title: "Negocio",
    sections: [
      { key: "rubro", label: "Rubro del negocio", icon: Tag },
      { key: "marca", label: "Marca del negocio", icon: Store, feature: "personalizacion_marca" },
    ],
  },
  {
    title: "Operación del POS",
    sections: [
      { key: "operacion", label: "Operación y productos", icon: SlidersHorizontal },
      { key: "salones", label: "Salones y mesas", icon: Utensils, requiresDining: true },
      { key: "zonas", label: "Zonas de envío", icon: Bike, requiresDelivery: true },
      { key: "profesionales", label: "Profesionales (agenda)", icon: CalendarDays, feature: "agenda" },
      { key: "paquetes", label: "Paquetes y sesiones", icon: Package, feature: "packs" },
      { key: "escaner", label: "Escáner", icon: ScanLine },
      { key: "pantalla-cliente", label: "Pantalla del cliente", icon: MonitorSmartphone },
      { key: "hardware", label: "Diagnóstico de hardware", icon: Wrench },
    ],
  },
  {
    title: "Cobro",
    sections: [
      { key: "pagos", label: "Medios de pago", icon: CreditCard },
      { key: "precios", label: "Listas de precios", icon: BadgeDollarSign, feature: "listas_precios" },
      { key: "devoluciones", label: "Devoluciones", icon: RotateCcw, feature: "devoluciones" },
      { key: "garantias", label: "Garantías extendidas", icon: ShieldCheck, feature: "garantias" },
    ],
  },
  {
    title: "Clientes",
    sections: [{ key: "clientes", label: "Datos del cliente", icon: Users }],
  },
  {
    title: "Comprobantes",
    sections: [
      // Tickets: NO se gatea el ingreso. El ticket PREDETERMINADO siempre se
      // imprime y se envía (esté o no `tickets_pro` en el plan). Dentro de la
      // sección, la PERSONALIZACIÓN (modelos custom) sí queda detrás de
      // `tickets_pro` con su propio aviso de upgrade.
      { key: "tickets", label: "Tickets", icon: ReceiptText },
      { key: "impresion", label: "Impresión", icon: Printer },
      { key: "email", label: "Email", icon: Mail, feature: "email_comprobantes" },
    ],
  },
  {
    title: "Apariencia",
    sections: [{ key: "apariencia", label: "Apariencia", icon: Palette }],
  },
];

// Lista plana derivada de los grupos (validación del query param, etc.).
const SECTIONS: SectionDef[] = SECTION_GROUPS.flatMap((g) => g.sections);

const THEME_SWATCH: Record<ThemeName, { bg: string; a: string; b: string }> = {
  "ninja-dark": { bg: "#0a0518", a: "#ff5a2c", b: "#ffd21f" },
  "ninja-noir": { bg: "#0b0c0f", a: "#ff5a2c", b: "#ffc23d" },
  "ninja-light": { bg: "#f6f5fc", a: "#e8431b", b: "#e8a400" },
  "ninja-sand": { bg: "#fbf7f1", a: "#e8431b", b: "#e08900" },
};

// Preview del patrón de fondo sobre un mini tile oscuro.
const BG_PREVIEW: Record<BgStyle, React.CSSProperties> = {
  dots: {
    backgroundImage: "radial-gradient(rgba(255,255,255,0.35) 1px, transparent 1px)",
    backgroundSize: "9px 9px",
  },
  grid: {
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.28) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.28) 1px, transparent 1px)",
    backgroundSize: "12px 12px",
  },
  crosses: {
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.2) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(255,255,255,0.2) 1.5px, transparent 1.5px), linear-gradient(rgba(255,75,34,0.6) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(255,75,34,0.6) 1.5px, transparent 1.5px)",
    backgroundSize: "14px 14px, 14px 14px, 42px 42px, 42px 42px",
  },
  diagonal: {
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0, rgba(255,255,255,0.28) 1px, transparent 1px, transparent 8px)",
  },
  mesh: {
    backgroundImage:
      "radial-gradient(circle at 25% 20%, rgba(255,75,34,0.5), transparent 45%), radial-gradient(circle at 80% 30%, rgba(95,58,214,0.6), transparent 50%)",
  },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {children}
    </div>
  );
}

// Ítem del menú de secciones. Si la sección tiene `feature` y el plan no la
// incluye, se ve deshabilitado (candado) y el click abre el UpgradeModal en vez
// de cambiar de sección (gating universal — el backend igual bloquea la escritura).
function SectionNavButton({
  section: s,
  active,
  onSelect,
}: {
  section: SectionDef;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = s.icon;
  const allowed = useFeature(s.feature ?? "");
  const [upOpen, setUpOpen] = useState(false);
  const locked = Boolean(s.feature) && allowed === false;

  return (
    <>
      <button
        onClick={() => (locked ? setUpOpen(true) : onSelect())}
        title={locked ? `${s.label}: función no incluida en tu plan` : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition md:w-full",
          locked
            ? "text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground"
            : active
              ? "bg-ninja-flame/12 font-medium text-ninja-flameSoft"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Icon size={17} />
        <span className="flex-1">{s.label}</span>
        {locked && <Lock size={13} className="text-ninja-flameSoft" />}
      </button>
      {locked && s.feature && (
        <UpgradeModal
          open={upOpen}
          onOpenChange={setUpOpen}
          featureKey={s.feature}
          featureLabel={s.label}
        />
      )}
    </>
  );
}

export default function ConfiguracionPage() {
  return (
    <Suspense fallback={null}>
      <ConfiguracionInner />
    </Suspense>
  );
}

function ConfiguracionInner() {
  const { theme, setTheme } = useTheme();
  const {
    display,
    price,
    bg,
    priceAccent,
    setDisplay,
    setPrice,
    setBg,
    setPriceAccent,
  } = useAppearance();
  const params = useSearchParams();
  // Modo gastronómico (H43): oculta la sección "Salones y mesas" si está apagado.
  const { data: diningEnabled } = useDiningEnabled();
  // Delivery (H49): oculta la sección "Zonas de envío" si delivery está apagado.
  const { data: deliveryEnabled } = useDeliveryEnabled();
  const initialSection = (() => {
    const q = params.get("seccion");
    return SECTIONS.some((s) => s.key === q) ? (q as Section) : "apariencia";
  })();
  const [section, setSection] = useState<Section>(initialSection);

  // Grupos visibles: filtra las secciones gated por dining/delivery cuando están
  // apagados (toggles del tenant, no gating de plan → se ocultan, sin candado).
  const visibleGroups = SECTION_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter(
      (s) =>
        (!s.requiresDining || diningEnabled) &&
        (!s.requiresDelivery || deliveryEnabled),
    ),
  })).filter((g) => g.sections.length > 0);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Eyebrow>Preferencias</Eyebrow>
      <Display className="mt-3 flex items-center gap-2">
        Configuración
        <InfoHint section="configuracion" size={18} />
      </Display>
      <p className="mt-2 text-muted-foreground">
        Ajustá NinjaPos a tu medida. Los cambios se aplican al instante y quedan
        guardados en tu cuenta, disponibles en cualquier dispositivo.
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-[210px_1fr]">
        {/* Menú de secciones, agrupado por bloque temático. En mobile es una
            tira horizontal de pills (sin títulos); en desktop, lista vertical
            con encabezados de grupo. */}
        <nav className="flex gap-2 overflow-x-auto md:flex-col md:gap-4 md:overflow-visible">
          {visibleGroups.map((group) => (
            <div key={group.title} className="flex shrink-0 gap-2 md:flex-col md:gap-1">
              <div className="hidden px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 md:block">
                {group.title}
              </div>
              {group.sections.map((s) => (
                <SectionNavButton
                  key={s.key}
                  section={s}
                  active={section === s.key}
                  onSelect={() => setSection(s.key)}
                />
              ))}
            </div>
          ))}
        </nav>

        {/* Contenido de la sección */}
        <div className="min-w-0">
          {section === "apariencia" && (
            <Card>
              <CardContent className="space-y-7 p-6">
            <Field label="Tema">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {THEMES.map((t) => {
                  const sw = THEME_SWATCH[t.name];
                  const active = theme === t.name;
                  return (
                    <button
                      key={t.name}
                      onClick={() => setTheme(t.name)}
                      className={cn(
                        "rounded-lg border p-2 text-left transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <div
                        className="relative h-16 w-full overflow-hidden rounded-lg border border-black/5"
                        style={{ background: sw.bg }}
                      >
                        <span
                          className="absolute bottom-2 left-2 h-3.5 w-3.5 rounded-full"
                          style={{ background: sw.a }}
                        />
                        <span
                          className="absolute bottom-2 left-7 h-3.5 w-3.5 rounded-full"
                          style={{ background: sw.b }}
                        />
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            active ? "bg-ninja-flame" : "bg-transparent",
                          )}
                        />
                        {t.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Fuente de títulos">
              <Segmented
                value={display}
                onChange={(v) => setDisplay(v as DisplayFont)}
                options={Object.entries(DISPLAY_FONTS).map(([k, v]) => ({
                  value: k,
                  label: v.label,
                  preview: (
                    <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>
                  ),
                }))}
              />
              <p
                className="pt-1 text-2xl font-extrabold tracking-tight"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Ninja Pos es ágil y seguro
              </p>
            </Field>

            <Field label="Fuente de precios">
              <Segmented
                value={price}
                onChange={(v) => setPrice(v as PriceFont)}
                options={Object.entries(PRICE_FONTS).map(([k, v]) => ({
                  value: k,
                  label: v.label,
                  preview: (
                    <span style={{ fontFamily: `var(${v.var})` }}>{v.label}</span>
                  ),
                }))}
              />
              <p className="price-hl pt-1 font-price text-2xl font-bold tabular-nums">
                {formatCurrency(1234567.89)}
              </p>
            </Field>

            <Field label="Resalte de precios">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PRICE_ACCENTS) as PriceAccent[]).map((k) => {
                  const active = priceAccent === k;
                  const grad = PRICE_ACCENTS[k].gradient;
                  return (
                    <button
                      key={k}
                      onClick={() => setPriceAccent(k)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <span
                        className="h-5 w-5 rounded-full border border-black/10"
                        style={{
                          background: grad || "var(--foreground)",
                        }}
                      />
                      {PRICE_ACCENTS[k].label}
                    </button>
                  );
                })}
              </div>
              <p className="price-hl pt-2 font-price text-2xl font-bold tabular-nums">
                {formatCurrency(98765.43)}
              </p>
            </Field>

            <Field label="Fondo">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {(Object.keys(BG_STYLES) as BgStyle[]).map((k) => {
                  const active = bg === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setBg(k)}
                      className={cn(
                        "rounded-lg border p-2 transition",
                        active
                          ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                          : "border-border hover:border-ninja-flameSoft/40",
                      )}
                    >
                      <div
                        className="h-12 w-full rounded-lg border border-black/10"
                        style={{ backgroundColor: "#14102e", ...BG_PREVIEW[k] }}
                      />
                      <div className="mt-1.5 truncate text-xs font-medium">
                        {BG_STYLES[k]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>
              </CardContent>
            </Card>
          )}

          {/* Rubro del negocio (solo owner/manager; se auto-oculta) */}
          {section === "rubro" && <RubroCard />}

          {/* Marca del negocio (solo owner/manager; el componente se auto-oculta) */}
          {section === "marca" && <BrandingCard />}

          {/* Modelos de ticket (escritura protegida por RLS) */}
          {section === "tickets" && <TicketTemplatesCard />}

          {/* Impresión por tipo de documento: formato, copias, auto/manual
              (F10 · H22; solo owner/manager, el componente se auto-oculta) */}
          {section === "impresion" && <PrintSettingsCard />}

          {/* Email del negocio (solo owner/manager; el componente se auto-oculta) */}
          {section === "email" && <TenantEmailCard />}

          {/* Medios de pago (solo owner/manager; se auto-oculta) */}
          {section === "pagos" && (
            <Suspense fallback={null}>
              <PaymentMethodsCard />
            </Suspense>
          )}

          {/* Operación del POS + productos (solo owner; se auto-oculta) */}
          {section === "operacion" && <OperationSettingsCard view="operacion" />}

          {/* Salones y mesas (F13 · H44): CRUD de salones/sectores y sus mesas. La
              atención por mesas vive en la sección Salón del menú. Sólo visible
              con el modo gastronómico activo (H43). Escritura RLS por tenant. */}
          {section === "salones" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <Utensils size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Salones y mesas</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Definí tus salones (ej. Salón principal, Terraza, Barra) y las
                  mesas de cada uno con su capacidad. La atención por mesas está en
                  la sección{" "}
                  <span className="font-medium text-foreground">Salón</span> del
                  menú.
                </p>
                <SalonesManager />
              </CardContent>
            </Card>
          )}

          {/* Zonas de envío (F13 · H49 follow-up): CRUD de zonas con tarifa
              automática. Al tomar un pedido de delivery, elegir la zona
              autocompleta el costo de envío. Sólo visible con delivery activo.
              Escritura RLS sólo owner/manager (la DB lo enforcea). */}
          {section === "zonas" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <Bike size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Zonas de envío</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Definí tus zonas de reparto (ej. Centro, Zona Norte) con su
                  tarifa y tiempo estimado. Al tomar un pedido de delivery elegís
                  la zona y el costo de envío se completa solo (igual lo podés
                  ajustar a mano). El tablero de pedidos está en la sección{" "}
                  <span className="font-medium text-foreground">Delivery</span> del
                  menú.
                </p>
                <ZonasManager />
              </CardContent>
            </Card>
          )}

          {/* Profesionales para la agenda (F12 · H38): quienes prestan los
              servicios, con color y comisión. La agenda vive en /agenda. */}
          {section === "profesionales" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <CalendarDays size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Profesionales y agenda</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Cargá a quienes prestan los servicios (peluquería, estética,
                  turnos). La agenda de turnos está en la sección{" "}
                  <span className="font-medium text-foreground">Agenda</span> del
                  menú.
                </p>
                <ProfessionalsManager />
              </CardContent>
            </Card>
          )}

          {/* Paquetes / packs de sesiones (F12 · H41): bonos que el cliente
              compra y consume por sesión al cobrar. Escritura RLS por tenant. */}
          {section === "paquetes" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <Package size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Paquetes y sesiones</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Definí bonos de sesiones (ej. &quot;4 cortes&quot;, &quot;10
                  sesiones de estética&quot;). Al vender un pack se le acreditan
                  las sesiones al cliente; cada visita consume una al cobrar el
                  servicio cubierto.
                </p>
                <ServicePacksManager />
              </CardContent>
            </Card>
          )}

          {/* Datos del cliente: requeridos, documento obligatorio, c/c y email
              automático del comprobante (solo owner; se auto-oculta) */}
          {section === "clientes" && <OperationSettingsCard view="clientes" />}

          {/* Devoluciones: política, validez de vale y motivos (se auto-oculta) */}
          {section === "devoluciones" && <ReturnsSettingsCard />}

          {/* Escáner: perfil del lector + diagnóstico (solo owner; se auto-oculta) */}
          {section === "escaner" && <ScannerCard />}

          {/* Pantalla del cliente / doble pantalla (F10 · H25; se auto-oculta) */}
          {section === "pantalla-cliente" && <CustomerDisplayCard />}

          {/* Centro de diagnóstico de hardware (F10 · H26) */}
          {section === "hardware" && <HardwareCard />}

          {/* Listas de precios por canal (escritura protegida por RLS) */}
          {section === "precios" && <PriceListsCard />}

          {/* Garantías extendidas */}
          {section === "garantias" && (
            <Card>
              <CardContent className="p-6">
                <div className="mb-3 flex items-center gap-2">
                  <ShieldCheck size={18} className="text-ninja-flameSoft" />
                  <span className="font-semibold">Planes de garantía extendida</span>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Definí los planes que ofrecés al cobrar (meses, prima fija o % del
                  precio, comisión del vendedor).
                </p>
                <WarrantyPlansManager />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
