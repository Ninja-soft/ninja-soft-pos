"use client";

import { useState } from "react";
import { Calculator, MapPin, Plus, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  EMPTY_PACKAGE,
  buildCreatePayload,
  newIdempotencyKey,
  shipmentFormSchema,
  shippingErrorMessage,
  type QuoteChoice,
  type ShipmentForm,
} from "@/lib/shipping/form";
import { shippingApi, type PickupPointView, type Shipment } from "@/modules/shipping/api";
import { useShippingMutations, useShippingProviders } from "@/modules/shipping/hooks";
import type { Branch } from "@/modules/branches/logic";

// Nuevo envío (ADR-103): desde una venta del POS, un pedido o a mano. Paso 1
// datos; paso 2 cotizar entre las logísticas conectadas de la sucursal,
// elegir (y la sucursal de retiro si el servicio es a sucursal) y crear. La
// clave de idempotencia es por apertura del formulario: un doble clic o un
// reintento no crea dos envíos.

type Source = "pos_sale" | "order" | "manual";

const emptyForm = (storeId: string): ShipmentForm => ({
  store_id: storeId,
  source: "manual",
  sale_id: null,
  order_ref: "",
  service_type: "door",
  recipient: { name: "", document: "", email: "", phone: "" },
  destination: { street: "", number: "", floor: "", apartment: "", city: "", province: "", postal_code: "", reference: "" },
  pickup_point: null,
  packages: [{ ...EMPTY_PACKAGE }],
  declared_value: 0,
  notes: "",
});

export function ShipmentFormModal({
  open,
  onOpenChange,
  stores,
  defaultStoreId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: Branch[];
  defaultStoreId: string | null;
  onCreated: (s: Shipment) => void;
}) {
  const { toast } = useToast();
  const m = useShippingMutations();
  const { data: providers = [] } = useShippingProviders();
  const [form, setForm] = useState<ShipmentForm>(() => emptyForm(defaultStoreId ?? stores[0]?.id ?? ""));
  const [step, setStep] = useState<1 | 2>(1);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());
  const [saleNumber, setSaleNumber] = useState("");
  const [saleLabel, setSaleLabel] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<QuoteChoice[] | null>(null);
  const [quoteErrors, setQuoteErrors] = useState<{ provider_key: string; error: string }[]>([]);
  const [quoting, setQuoting] = useState(false);
  const [choice, setChoice] = useState<QuoteChoice | null>(null);
  const [points, setPoints] = useState<PickupPointView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(emptyForm(defaultStoreId ?? stores[0]?.id ?? ""));
      setStep(1);
      setIdemKey(newIdempotencyKey());
      setSaleNumber("");
      setSaleLabel(null);
      setErrors([]);
      setQuotes(null);
      setChoice(null);
      setPoints(null);
    }
  }

  const providerName = (k: string) => providers.find((p) => p.key === k)?.name ?? k;
  const set = <K extends keyof ShipmentForm>(k: K, v: ShipmentForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setDest = (k: keyof ShipmentForm["destination"], v: string) =>
    setForm((f) => ({ ...f, destination: { ...f.destination, [k]: v } }));
  const setRec = (k: keyof ShipmentForm["recipient"], v: string) =>
    setForm((f) => ({ ...f, recipient: { ...f.recipient, [k]: v } }));
  const setPkg = (i: number, k: string, v: string) =>
    setForm((f) => ({ ...f, packages: f.packages.map((p, j) => (j === i ? { ...p, [k]: v as unknown as number } : p)) }));

  async function findSale() {
    const n = Number(saleNumber.replace(/\D/g, ""));
    if (!n) return;
    try {
      const sale = await shippingApi.saleByNumber(form.store_id || null, n);
      if (!sale) {
        toast({ title: `No hay una venta #${n} completada en esta sucursal`, variant: "error" });
        return;
      }
      setSaleLabel(`Venta #${sale.number} · ${formatCurrency(sale.total)}`);
      setForm((f) => ({
        ...f,
        sale_id: sale.id,
        store_id: sale.store_id,
        declared_value: Number(sale.total) || f.declared_value,
        recipient: sale.customer
          ? {
              name: sale.customer.name ?? "",
              email: sale.customer.email ?? "",
              phone: sale.customer.phone ?? "",
              document: sale.customer.document_number ?? "",
            }
          : f.recipient,
        destination: sale.customer?.address && !f.destination.street ? { ...f.destination, street: sale.customer.address } : f.destination,
      }));
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    }
  }

  // Validación del paso 1 (el tipo de servicio todavía no importa).
  function validateData(): boolean {
    const probe = shipmentFormSchema.safeParse({ ...form, service_type: "branch", pickup_point: { id: "x" } });
    const door = form.destination.street?.trim()
      ? shipmentFormSchema.safeParse({ ...form, service_type: "door" })
      : null;
    const issues = [...(probe.success ? [] : probe.error.issues), ...(door && !door.success ? door.error.issues : [])];
    const msgs = Array.from(new Set(issues.map((i) => i.message)));
    setErrors(msgs);
    return msgs.length === 0;
  }

  async function quote() {
    if (!validateData()) return;
    setStep(2);
    setQuoting(true);
    setChoice(null);
    setPoints(null);
    try {
      const r = await shippingApi.quote({
        store_id: form.store_id,
        destination: form.destination,
        packages: form.packages,
        declared_value: Number(form.declared_value) || 0,
      });
      setQuotes(r.quotes);
      setQuoteErrors(r.errors);
    } catch (e) {
      setQuotes([]);
      setQuoteErrors([{ provider_key: "", error: shippingErrorMessage(e) }]);
    } finally {
      setQuoting(false);
    }
  }

  async function pick(q: QuoteChoice) {
    setChoice(q);
    set("service_type", q.service_type);
    set("pickup_point", null);
    setPoints(null);
    if (q.service_type === "branch") {
      try {
        const r = await shippingApi.points(form.store_id, q.provider_key, form.destination.postal_code);
        setPoints(r.points);
      } catch (e) {
        setPoints([]);
        toast({ title: shippingErrorMessage(e), variant: "error" });
      }
    }
  }

  async function create(submit: boolean) {
    // Borrador: a domicilio si hay calle; si no, a la sucursal elegida.
    const serviceType = submit && choice ? choice.service_type : form.destination.street?.trim() ? "door" : "branch";
    const parsed = shipmentFormSchema.safeParse({
      ...form,
      service_type: serviceType,
      pickup_point: serviceType === "branch" ? form.pickup_point : null,
    });
    if (!parsed.success) {
      setErrors(Array.from(new Set(parsed.error.issues.map((i) => i.message))));
      return;
    }
    setBusy(true);
    try {
      const payload = buildCreatePayload(parsed.data, { idempotencyKey: idemKey, quote: submit ? choice : null, submit });
      const created = await m.create.mutateAsync(payload);
      let final: Shipment = created;
      if (submit) {
        // Procesa el alta y la etiqueta ya (si tarda, sigue el cron).
        try {
          const r = await m.process.mutateAsync(created.id);
          if (r.shipment) final = r.shipment;
        } catch {
          /* queda en la cola */
        }
      }
      toast({
        title: created.replayed ? "El envío ya estaba creado" : submit ? "Envío creado" : "Borrador guardado",
        variant: "success",
      });
      onCreated(final);
      onOpenChange(false);
    } catch (e) {
      toast({ title: shippingErrorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const sourceOpts: { value: Source; label: string }[] = [
    { value: "pos_sale", label: "Venta del POS" },
    { value: "order", label: "Pedido" },
    { value: "manual", label: "A mano" },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nuevo envío"
      description={step === 1 ? "Paso 1 de 2: a quién, adónde y qué se manda." : "Paso 2 de 2: elegí la logística y el servicio."}
      className="sm:max-w-3xl"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {step === 2 ? (
            <Button variant="secondary" onClick={() => setStep(1)} disabled={busy}>
              Volver
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          )}
          <Button variant="secondary" onClick={() => create(false)} loading={busy && !choice}>
            Guardar borrador
          </Button>
          {step === 1 ? (
            <Button onClick={quote}>
              <Calculator size={15} /> Cotizar
            </Button>
          ) : (
            <Button
              onClick={() => create(true)}
              loading={busy}
              disabled={!choice || (choice.service_type === "branch" && !form.pickup_point)}
            >
              Crear envío
            </Button>
          )}
        </div>
      }
    >
      {step === 1 ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {stores.length > 1 && (
              <Select
                label="Despacha desde"
                value={form.store_id}
                onChange={(v) => set("store_id", v)}
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">Origen</p>
              <Segmented<Source> value={form.source} onChange={(v) => set("source", v)} size="sm" options={sourceOpts} />
            </div>
          </div>

          {form.source === "pos_sale" && (
            <div className="flex items-end gap-2">
              <Input
                label="Número de venta"
                inputMode="numeric"
                value={saleNumber}
                onChange={(e) => setSaleNumber(e.target.value)}
                hint={saleLabel ?? "Trae el cliente y el total de la venta."}
              />
              <Button variant="secondary" onClick={findSale} className="mb-6">
                <Search size={15} /> Buscar
              </Button>
            </div>
          )}
          {form.source === "order" && (
            <Input label="Número de pedido" value={form.order_ref ?? ""} maxLength={80} onChange={(e) => set("order_ref", e.target.value)} />
          )}

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">Destinatario</legend>
            <Input label="Nombre y apellido" value={form.recipient.name} onChange={(e) => setRec("name", e.target.value)} />
            <Input label="DNI o CUIT" value={form.recipient.document ?? ""} onChange={(e) => setRec("document", e.target.value)} />
            <Input label="Teléfono" value={form.recipient.phone ?? ""} onChange={(e) => setRec("phone", e.target.value)} />
            <Input label="Email" type="email" value={form.recipient.email ?? ""} onChange={(e) => setRec("email", e.target.value)} />
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-6">
            <legend className="mb-2 text-sm font-semibold">Destino</legend>
            <div className="sm:col-span-2">
              <Input label="Código postal" value={form.destination.postal_code} onChange={(e) => setDest("postal_code", e.target.value)} />
            </div>
            <div className="sm:col-span-4">
              <Input label="Calle" value={form.destination.street ?? ""} onChange={(e) => setDest("street", e.target.value)} hint="Vacío si retira en una sucursal." />
            </div>
            <div className="sm:col-span-2">
              <Input label="Número" value={form.destination.number ?? ""} onChange={(e) => setDest("number", e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Input label="Piso" value={form.destination.floor ?? ""} onChange={(e) => setDest("floor", e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Input label="Depto." value={form.destination.apartment ?? ""} onChange={(e) => setDest("apartment", e.target.value)} />
            </div>
            <div className="sm:col-span-3">
              <Input label="Localidad" value={form.destination.city ?? ""} onChange={(e) => setDest("city", e.target.value)} />
            </div>
            <div className="sm:col-span-3">
              <Input label="Provincia" value={form.destination.province ?? ""} onChange={(e) => setDest("province", e.target.value)} />
            </div>
            <div className="sm:col-span-6">
              <Input label="Referencias" value={form.destination.reference ?? ""} onChange={(e) => setDest("reference", e.target.value)} />
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">Bultos</legend>
            {form.packages.map((p, i) => (
              <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
                <Input label="Peso (kg)" inputMode="decimal" value={String(p.weight_kg)} onChange={(e) => setPkg(i, "weight_kg", e.target.value)} />
                <Input label="Largo (cm)" inputMode="decimal" value={String(p.length_cm)} onChange={(e) => setPkg(i, "length_cm", e.target.value)} />
                <Input label="Ancho (cm)" inputMode="decimal" value={String(p.width_cm)} onChange={(e) => setPkg(i, "width_cm", e.target.value)} />
                <Input label="Alto (cm)" inputMode="decimal" value={String(p.height_cm)} onChange={(e) => setPkg(i, "height_cm", e.target.value)} />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Quitar bulto"
                  disabled={form.packages.length === 1}
                  onClick={() => set("packages", form.packages.filter((_, j) => j !== i))}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
            {form.packages.length < 20 && (
              <Button variant="ghost" size="sm" onClick={() => set("packages", [...form.packages, { ...EMPTY_PACKAGE }])}>
                <Plus size={15} /> Agregar bulto
              </Button>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Valor declarado ($)"
              inputMode="decimal"
              value={String(form.declared_value)}
              onChange={(e) => set("declared_value", e.target.value as unknown as number)}
              hint="Lo que cubre el seguro del envío."
            />
            <Input label="Contenido u observaciones" value={form.notes ?? ""} maxLength={500} onChange={(e) => set("notes", e.target.value)} />
          </div>

          {errors.length > 0 && <Callout tone="danger">{errors.join(" · ")}</Callout>}
        </div>
      ) : (
        <div className="space-y-4">
          {quoting ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Cotizando con tus logísticas…</p>
          ) : (
            <>
              {(quotes ?? []).length === 0 && (
                <Callout tone="warning">
                  Ninguna logística conectada pudo cotizar. Conectá una en Configuración &gt; Envíos o guardá el envío como borrador.
                </Callout>
              )}
              <ul className="space-y-2">
                {(quotes ?? []).map((q) => {
                  const on = choice?.provider_key === q.provider_key && choice.service_code === q.service_code;
                  return (
                    <li key={`${q.provider_key}-${q.service_code}`}>
                      <button
                        type="button"
                        onClick={() => pick(q)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition",
                          on ? "bg-ninja-flame/10 ring-2 ring-ninja-flameSoft" : "bg-muted/50 hover:bg-muted",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {providerName(q.provider_key)} · {q.service_name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {q.service_type === "branch" ? "Retira en sucursal o punto" : "A domicilio"}
                            {q.eta_days ? ` · ${q.eta_days.min} a ${q.eta_days.max} días hábiles` : ""}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          {q.sandbox && <Badge tone="info">Prueba</Badge>}
                          <span className="font-semibold tabular-nums">{formatCurrency(q.cost)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {quoteErrors.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {quoteErrors.map((e) => (
                    <li key={e.provider_key + e.error}>
                      {e.provider_key ? `${providerName(e.provider_key)}: ` : ""}
                      {e.error}
                    </li>
                  ))}
                </ul>
              )}
              {choice?.service_type === "branch" && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">
                    <MapPin size={15} className="mr-1 inline" /> ¿Dónde retira?
                  </p>
                  {points === null ? (
                    <p className="text-sm text-muted-foreground">Buscando sucursales…</p>
                  ) : points.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No hay sucursales para ese código postal.</p>
                  ) : (
                    <ul className="max-h-60 space-y-1 overflow-y-auto">
                      {points.map((p) => {
                        const on = form.pickup_point?.id === p.id;
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => set("pickup_point", { id: p.id, name: p.name })}
                              className={cn(
                                "w-full rounded-lg px-3 py-2 text-left text-sm transition",
                                on ? "bg-ninja-flame/10 ring-2 ring-ninja-flameSoft" : "bg-muted/50 hover:bg-muted",
                              )}
                            >
                              <span className="block font-medium">{p.name}</span>
                              <span className="block text-xs text-muted-foreground">
                                {[p.address, p.city, p.hours].filter(Boolean).join(" · ")}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {errors.length > 0 && <Callout tone="danger">{errors.join(" · ")}</Callout>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
ShipmentFormModal.displayName = "ShipmentFormModal";
