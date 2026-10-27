"use client";

// Directo (ADR-181): paso previo al QR. La API Ecommerce 2.0 exige el DNI y el
// nombre del comprador ("APELLIDOS,NOMBRES") para crear la orden. Se prellenan
// con el cliente de la venta (si tiene) y el cajero los confirma. "Consultar
// oferta" es opcional y sólo corre cuando el cajero lo pide (el documento de
// Directo prohíbe el scoring masivo; el servidor limita a 20 por hora).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";
import {
  buildFullName,
  directoErrorCopy,
  dniFromDocument,
  normalizeDni,
  splitCustomerName,
} from "@/lib/payments/directo";
import { posApi, type DirectoBuyer, type DirectoOfferResult } from "@/modules/pos/api";

type Sex = "M" | "F";

export function DirectoBuyerStep({
  amount,
  customerId,
  initial,
  onSubmit,
}: {
  amount: number;
  customerId: string | null;
  /** Datos ya confirmados (volver a corregir después de un error). */
  initial?: DirectoBuyer | null;
  onSubmit: (buyer: DirectoBuyer) => void;
}) {
  const [dni, setDni] = useState(initial?.dni ?? "");
  const [lastName, setLastName] = useState(initial?.last_name ?? "");
  const [firstName, setFirstName] = useState(initial?.first_name ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [sex, setSex] = useState<Sex | "">("");
  const [offer, setOffer] = useState<DirectoOfferResult | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // Prellenado con el cliente de la venta (DNI, o el del medio de un CUIL).
  const { data: customer } = useQuery({
    queryKey: ["directo-buyer", customerId],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data } = await createClient()
        .from("customers")
        .select("name, document_type, document_number")
        .eq("id", customerId!)
        .maybeSingle();
      return data as { name: string; document_type: string | null; document_number: string | null } | null;
    },
  });
  useEffect(() => {
    if (!customer) return;
    const parts = splitCustomerName(customer.name);
    setDni((v) => v || (dniFromDocument(customer.document_type, customer.document_number) ?? ""));
    setLastName((v) => v || parts.lastName);
    setFirstName((v) => v || parts.firstName);
  }, [customer]);

  const cleanDni = normalizeDni(dni);
  const fullName = useMemo(() => buildFullName(lastName, firstName), [lastName, firstName]);
  const valid = Boolean(cleanDni && fullName);
  const buyer: DirectoBuyer = { dni: cleanDni ?? "", last_name: lastName, first_name: firstName };

  // Cambiar los datos invalida la oferta consultada.
  useEffect(() => {
    setOffer(null);
    setOfferError(null);
  }, [dni, lastName, firstName, sex]);

  async function checkOffer() {
    if (!valid || !sex) {
      setShowErrors(true);
      if (valid && !sex) setOfferError(directoErrorCopy("directo_sex_required"));
      return;
    }
    setChecking(true);
    setOfferError(null);
    try {
      setOffer(await posApi.directoOffer({ buyer, sex, amount }));
    } catch (e) {
      const ctx = (e as { context?: Response })?.context;
      const body = ctx ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
      const code = body?.error ?? (e instanceof Error ? e.message : "");
      setOfferError(directoErrorCopy(code) ?? "No se pudo consultar la oferta.");
    } finally {
      setChecking(false);
    }
  }

  function submit() {
    if (!valid) {
      setShowErrors(true);
      return;
    }
    onSubmit(buyer);
  }

  const range = offer?.offers[0];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Directo pide los datos del cliente tal como figuran en su DNI. Después el cliente arma su crédito desde el QR o el link.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="DNI"
          inputMode="numeric"
          autoComplete="off"
          value={dni}
          onChange={(e) => setDni(e.target.value)}
          placeholder="Sin puntos"
          error={showErrors && !cleanDni ? "Ingresá un DNI válido." : undefined}
          className="sm:col-span-2"
        />
        <Input
          label="Apellido"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="Como en el DNI"
          error={showErrors && !lastName.trim() ? "Falta el apellido." : undefined}
        />
        <Input
          label="Nombre"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="Todos los nombres"
          error={showErrors && !firstName.trim() ? "Falta el nombre." : undefined}
        />
      </div>
      {fullName && <p className="text-xs text-muted-foreground">Se envía a Directo como {fullName}</p>}

      <div className="space-y-2 rounded-lg bg-fg-4 p-3">
        <div className="text-sm font-medium">Consultar oferta (opcional)</div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Sexo según el DNI" className="flex gap-1.5">
            {(["M", "F"] as const).map((v) => (
              <Button
                key={v}
                type="button"
                size="sm"
                variant={sex === v ? "primary" : "ghost"}
                aria-pressed={sex === v}
                onClick={() => setSex(v)}
              >
                {v === "M" ? "Masculino" : "Femenino"}
              </Button>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={checkOffer} disabled={checking}>
            <Search size={14} aria-hidden /> {checking ? "Consultando…" : "Consultar oferta"}
          </Button>
        </div>
        {!sex && !offer && (
          <p className="text-xs text-muted-foreground">Elegí el sexo que figura en el DNI para consultar.</p>
        )}
        {offerError && <p className="text-xs text-danger">{offerError}</p>}
        {offer && (
          <div className="space-y-2 text-sm">
            {range ? (
              <p>
                Oferta de {formatCurrency(range.minimumAmount ?? 0)} a {formatCurrency(range.maximumAmount ?? 0)}
                {range.maximumRate !== null ? `, hasta ${range.maximumRate} cuotas` : ""}.
              </p>
            ) : (
              <p>Directo respondió sin un rango de oferta.</p>
            )}
            {offer.campaign_message && (
              <p className="text-xs text-muted-foreground">Campaña: {offer.campaign_message}</p>
            )}
            {!offer.amount_in_range && (
              <Callout tone="warning" icon={Info}>
                El total ({formatCurrency(amount)}) está fuera del rango ofrecido.
              </Callout>
            )}
            {offer.plans.length > 0 && (
              <ul className="grid grid-cols-2 gap-1.5">
                {offer.plans.map((p, i) => (
                  <li key={i} className="rounded-md bg-fg-6 px-2.5 py-1.5 text-xs tabular-nums">
                    {p.installments ?? "?"} cuotas de {formatCurrency(p.installmentAmount ?? 0)}
                  </li>
                ))}
              </ul>
            )}
            {offer.plans_error && (
              <p className="text-xs text-muted-foreground">{directoErrorCopy(offer.plans_error)}</p>
            )}
          </div>
        )}
      </div>

      <Button type="button" className="w-full" onClick={submit}>
        Generar QR y link
      </Button>
    </div>
  );
}
DirectoBuyerStep.displayName = "DirectoBuyerStep";
