"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, MapPin, MapPinOff, Pencil, QrCode, Store } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { posApi, type MpQrGeocodeResult } from "@/modules/pos/api";
import {
  MP_AR_STATES,
  mapMpQrError,
  type MpQrError,
  splitStreet,
} from "@/supabase/functions/_shared/mpOrders";
import { MpQrExplainer } from "./MpQrExplainer";
import { mpEnvOf, type Env, type Method, type MpQrPos } from "./types";

// "QR en el mostrador" (ADR-032): para cobrar con el QR de cobro presencial de
// Mercado Pago (trae el monto), MP pide registrar el local una vez. Lo hacemos
// con los datos del negocio y la ubicación en el mapa (Edge mp_qr geocode):
// el dueño sólo confirma. Sin activar, el POS cobra con el QR del link de pago.

export type MpQrDraft = {
  name: string;
  street_name: string;
  street_number: string;
  city_name: string;
  state_name: string;
};
export type MpQrPlace = MpQrGeocodeResult["place"];
type Address = Omit<MpQrDraft, "name">;

export type MpQrActivateInput = Address & {
  name: string;
  latitude?: number;
  longitude?: number;
  coordinates?: string;
};

export interface MpQrPosSetupViewProps {
  env: Env;
  pos: MpQrPos | undefined;
  loadingDraft: boolean;
  draft: MpQrDraft | undefined;
  /** Ubicación en el mapa de la dirección del borrador (null = no encontrada). */
  place: MpQrPlace | undefined;
  onLocate: (a: Address) => Promise<MpQrGeocodeResult>;
  onActivate: (input: MpQrActivateInput) => Promise<void>;
  onDeactivate: () => Promise<void>;
  onReconnect?: () => void;
  onOpenPlans?: () => void;
}

const EMPTY: MpQrDraft = { name: "", street_name: "", street_number: "", city_name: "", state_name: "" };

const errCode = (e: unknown) => {
  const [code = "", field] = (e instanceof Error ? e.message : String(e)).split(":");
  return mapMpQrError(code, field);
};

// MP la llama "Capital Federal"; al dueño se la mostramos como la conoce.
const stateLabel = (st: string) => (st === "Capital Federal" ? "Ciudad de Buenos Aires" : st);

const addressLine = (d: Address) =>
  [`${d.street_name} ${d.street_number}`.trim(), d.city_name, stateLabel(d.state_name)]
    .filter(Boolean)
    .join(", ");

export function MpQrPosSetupView(props: MpQrPosSetupViewProps) {
  const { env, pos, draft } = props;
  const active = Boolean(pos?.external_pos_id || pos?.store_name);
  const [error, setError] = useState<MpQrError | null>(null);

  return (
    <section className="space-y-3 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-3.5">
      <header className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ninja-flame/[0.12] text-ninja-flameSoft">
          <QrCode size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-semibold text-foreground">QR en el mostrador</h4>
            {active ? (
              <Badge tone="success">Activo</Badge>
            ) : error ? (
              <Badge tone="danger">Revisá</Badge>
            ) : (
              <Badge tone="neutral">Sin activar</Badge>
            )}
            {env === "test" && <Badge tone="info">Modo prueba</Badge>}
          </div>
          {!active && (
            <p className="mt-1 text-sm text-muted-foreground">
              Para cobrar con un QR que ya trae el monto, Mercado Pago pide registrar tu local una
              sola vez. Lo hacemos por vos con los datos de tu negocio.
            </p>
          )}
        </div>
      </header>

      {active && pos ? (
        <ActiveState env={env} pos={pos} onDeactivate={props.onDeactivate} />
      ) : (
        <InactiveState
          {...props}
          draft={draft}
          error={error}
          setError={setError}
        />
      )}

      <MpQrExplainer key={active ? "on" : "off"} defaultOpen={!active} />
    </section>
  );
}

function ActiveState({
  env,
  pos,
  onDeactivate,
}: {
  env: Env;
  pos: MpQrPos;
  onDeactivate: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MpQrError | null>(null);

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDeactivate();
      setConfirming(false);
    } catch (e) {
      setError(errCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Callout tone="success" icon={CheckCircle2} title={`Activo en ${pos.store_name ?? "tu local"}`}>
        {pos.address && <p>{pos.address.replace("Capital Federal", stateLabel("Capital Federal"))}</p>}
        <p className="mt-1">
          Cada cobro con Mercado Pago muestra un QR con el monto listo. El cliente lo escanea con
          la app, confirma y la venta se cierra sola.
        </p>
      </Callout>

      {error && (
        <Callout tone="danger" icon={AlertCircle} title={error.title}>
          {error.message}
        </Callout>
      )}

      {confirming ? (
        <div className="rounded-xl bg-danger/10 p-3.5 text-sm">
          <p className="font-semibold text-foreground">¿Desactivar el QR en el mostrador?</p>
          <p className="mt-0.5 text-muted-foreground">
            El POS vuelve a cobrar con el QR del link de pago. Podés activarlo de nuevo cuando
            quieras.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" loading={busy} onClick={deactivate}>
              Sí, desactivar
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Desactivar
        </Button>
      )}

      <Disclosure title="Detalles técnicos">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt>Ambiente</dt>
          <dd className="text-foreground">{env === "test" ? "Prueba" : "Producción"}</dd>
          {pos.store_id && (
            <>
              <dt>Sucursal (store_id)</dt>
              <dd className="break-all font-mono text-foreground">{pos.store_id}</dd>
            </>
          )}
          {pos.pos_id && (
            <>
              <dt>Caja (pos_id)</dt>
              <dd className="break-all font-mono text-foreground">{pos.pos_id}</dd>
            </>
          )}
          {pos.external_pos_id && (
            <>
              <dt>external_pos_id</dt>
              <dd className="break-all font-mono text-foreground">{pos.external_pos_id}</dd>
            </>
          )}
          {pos.created_at && (
            <>
              <dt>Activado</dt>
              <dd className="text-foreground">
                {new Date(pos.created_at).toLocaleDateString("es-AR")}
              </dd>
            </>
          )}
        </dl>
      </Disclosure>
    </div>
  );
}

function InactiveState({
  loadingDraft,
  draft,
  place: placeProp,
  onLocate,
  onActivate,
  onReconnect,
  onOpenPlans,
  error,
  setError,
}: MpQrPosSetupViewProps & {
  error: MpQrError | null;
  setError: (e: MpQrError | null) => void;
}) {
  const [form, setForm] = useState<MpQrDraft>(draft ?? EMPTY);
  const [street, setStreet] = useState("");
  const [place, setPlace] = useState<MpQrPlace | undefined>(placeProp);
  const [editing, setEditing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState("");

  // El borrador llega después del primer render (Edge geocode).
  useEffect(() => {
    if (!draft) return;
    setForm(draft);
    setStreet(`${draft.street_name} ${draft.street_number}`.trim());
    if (!draft.street_name || !draft.name) setEditing(true);
  }, [draft]);
  useEffect(() => setPlace(placeProp), [placeProp]);

  const fieldErr = (f: string) =>
    error?.field === f ||
    (f === "street" && (error?.field === "street_name" || error?.field === "street_number"))
      ? error?.message
      : undefined;

  const set = (k: keyof MpQrDraft) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (error) setError(null);
  };

  const formAddress = (): Address => {
    const s = splitStreet(street);
    return {
      street_name: s.street_name,
      street_number: s.street_number,
      city_name: form.city_name.trim(),
      state_name: form.state_name,
    };
  };

  // Ubica la dirección editada. Devuelve el lugar encontrado (o null).
  const saveAddress = async (): Promise<NonNullable<MpQrPlace> | null> => {
    const a = formAddress();
    if (!form.name.trim()) {
      setError(mapMpQrError("invalid_store", "name"));
      return null;
    }
    if (!a.street_name || !a.street_number) {
      setError(mapMpQrError("invalid_store", a.street_name ? "street_number" : "street_name"));
      return null;
    }
    setLocating(true);
    setError(null);
    try {
      const res = await onLocate(a);
      setForm((f) => ({
        ...f,
        ...a,
        state_name: a.state_name || res.place?.state_name || "",
        city_name: a.city_name || res.place?.city_name || "",
      }));
      setPlace(res.place);
      if (res.place) {
        setLocateFailed(false);
        setManualOpen(false);
        setEditing(false);
        return res.place;
      }
      setLocateFailed(true);
      setError(mapMpQrError(res.geocode_error ?? "geocode_not_found"));
      return null;
    } catch (e) {
      setError(errCode(e));
      return null;
    } finally {
      setLocating(false);
    }
  };

  const activate = async () => {
    // Con la dirección en edición, primero se ubica en el mapa y sigue de largo.
    let at = place;
    let base = form;
    if (editing && !manual.trim()) {
      at = await saveAddress();
      if (!at) return;
      const a = formAddress();
      base = {
        ...form,
        ...a,
        state_name: a.state_name || at.state_name,
        city_name: a.city_name || at.city_name,
      };
    } else if (editing) {
      base = { ...form, ...formAddress() };
    }
    if (!base.name.trim() || !base.street_name) {
      setEditing(true);
      setError(mapMpQrError("invalid_store", base.name.trim() ? "street_name" : "name"));
      return;
    }
    setActivating(true);
    setError(null);
    try {
      await onActivate({
        ...base,
        name: base.name.trim(),
        ...(manual.trim()
          ? { coordinates: manual.trim() }
          : at
            ? { latitude: at.lat, longitude: at.lon }
            : {}),
      });
    } catch (e) {
      const mapped = errCode(e);
      setError(mapped);
      if (mapped.fix === "address") setEditing(true);
      if (e instanceof Error && e.message.startsWith("geocode_not_found")) setLocateFailed(true);
    } finally {
      setActivating(false);
    }
  };

  const errorAction = (() => {
    if (!error) return null;
    switch (error.fix) {
      case "address":
        return editing ? null : (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Corregir dirección
          </Button>
        );
      case "retry":
        return (
          <Button size="sm" variant="secondary" onClick={activate}>
            Probar de nuevo
          </Button>
        );
      case "reconnect":
        return onReconnect ? (
          <Button size="sm" variant="secondary" onClick={onReconnect}>
            Conectar Mercado Pago
          </Button>
        ) : null;
      case "plan":
        return onOpenPlans ? (
          <Button size="sm" variant="secondary" onClick={onOpenPlans}>
            Ver planes
          </Button>
        ) : null;
      default:
        return null;
    }
  })();

  if (loadingDraft) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg bg-background/60 p-3 text-sm text-muted-foreground">
        <Spinner size={16} label="Buscando los datos de tu negocio" />
        Buscando los datos de tu negocio
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {editing ? (
        <div className="space-y-3 rounded-lg bg-background/60 p-3">
          <p className="text-sm font-semibold text-foreground">Datos de tu local</p>
          <Input
            label="Nombre del local"
            value={form.name}
            onChange={set("name")}
            hint="Lo ven tus clientes al pagar."
            error={fieldErr("name")}
          />
          <Input
            label="Calle y altura"
            value={street}
            onChange={(e) => {
              setStreet(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Ej: Av. Corrientes 1234"
            error={fieldErr("street")}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Localidad o barrio"
              value={form.city_name}
              onChange={set("city_name")}
              placeholder="Ej: Palermo"
              error={fieldErr("city_name")}
            />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Provincia</span>
              <select
                value={form.state_name}
                onChange={set("state_name")}
                className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
              >
                <option value="">Elegí</option>
                {MP_AR_STATES.map((st) => (
                  <option key={st} value={st}>
                    {stateLabel(st)}
                  </option>
                ))}
              </select>
              {fieldErr("state_name") && (
                <span className="mt-2 block text-sm text-destructive">{fieldErr("state_name")}</span>
              )}
            </label>
          </div>

          {locateFailed && (
            <div className="space-y-2">
              {!manualOpen ? (
                <button
                  type="button"
                  onClick={() => setManualOpen(true)}
                  className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Marcar la ubicación a mano
                </button>
              ) : (
                <Input
                  label="Ubicación en el mapa"
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="-34.6037, -58.3816"
                  hint="En Google Maps tocá tu local y copiá los dos números que aparecen."
                  error={fieldErr("coordinates")}
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={locating} onClick={() => void saveAddress()}>
              {!locating && <MapPin size={14} />} Buscar en el mapa
            </Button>
            {draft?.street_name && (
              <Button
                size="sm"
                variant="ghost"
                disabled={locating}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg bg-background/60 p-3 text-sm">
          <p className="flex items-start gap-2 font-semibold text-foreground">
            <Store size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">{form.name}</span>
          </p>
          <p className="flex items-start gap-2 text-muted-foreground">
            <MapPin size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">{addressLine(form)}</span>
          </p>
          {place ? (
            <p className="flex items-start gap-2 text-success">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                Lo ubicamos en el mapa: {place.label}
                {!place.precise && (
                  <span className="text-muted-foreground"> (por la calle, sin la altura exacta)</span>
                )}
              </span>
            </p>
          ) : (
            <p className="flex items-start gap-2 text-warning">
              <MapPinOff size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">Todavía no lo ubicamos en el mapa.</span>
            </p>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <Pencil size={13} aria-hidden /> Corregir dirección
          </button>
        </div>
      )}

      {error && (
        <Callout tone="danger" icon={AlertCircle} title={error.title} actions={errorAction}>
          {/* Si el mensaje ya se ve debajo del campo, no se repite. */}
          {editing && error.field && error.field !== "coordinates" ? null : error.message}
        </Callout>
      )}

      <div className="space-y-2">
        <Button
          className="w-full sm:w-auto"
          loading={activating}
          disabled={locating}
          onClick={activate}
        >
          {!activating && <QrCode size={16} />}
          {activating ? "Activando" : "Activar QR en el mostrador"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Mientras no lo actives, el POS sigue cobrando con el QR del link de pago.
        </p>
      </div>
    </div>
  );
}

export function MpQrPosSetup({
  method,
  onReconnect,
  onOpenPlans,
}: {
  method: Method | undefined;
  onReconnect?: () => void;
  onOpenPlans?: () => void;
}) {
  const qc = useQueryClient();
  const env = mpEnvOf(method);
  const pos = method?.config?.mp_qr?.[env];
  const active = Boolean(pos?.external_pos_id || pos?.store_name);

  const draftQ = useQuery({
    queryKey: ["mp-qr-draft"],
    queryFn: () => posApi.mpQrGeocode(),
    enabled: !active,
    staleTime: Infinity,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
  const setup = useMutation({ mutationFn: posApi.mpQrSetup, onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => posApi.mpQrReset(), onSuccess: refresh });

  return (
    <MpQrPosSetupView
      env={env}
      pos={active ? pos : undefined}
      loadingDraft={!active && draftQ.isLoading}
      draft={draftQ.data?.draft ?? (draftQ.isError ? EMPTY : undefined)}
      place={draftQ.data?.place}
      onLocate={(a) => posApi.mpQrGeocode(a)}
      onActivate={async (input) => {
        await setup.mutateAsync(input);
      }}
      onDeactivate={async () => {
        await reset.mutateAsync();
      }}
      onReconnect={onReconnect}
      onOpenPlans={onOpenPlans}
    />
  );
}
