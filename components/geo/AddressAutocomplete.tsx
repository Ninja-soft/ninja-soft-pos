"use client";

import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, MapPin, PenLine, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils/cn";
import {
  formatShipTo,
  geoErrorMessage,
  GEO_QUALITY_LABEL,
  provinceCode,
  type GeoAddress,
  type GeoSuggestion,
} from "@/lib/geo/address";
import { geoApi } from "@/modules/geo/api";

const MiniMap = dynamic(() => import("./MiniMap").then((m) => m.MiniMap), { ssr: false });

// Dirección con autocompletar (ADR-157): se tipea, aparecen sugerencias en
// una lista flotante (position absolute, no empuja nada), se elige una y la
// Edge geo la normaliza con Georef (localidad, partido, provincia y
// coordenadas). Después: piso, depto, entre calles y el mini mapa con el pin
// arrastrable. Si no aparece, se carga a mano.

const QUALITY_TONE = { exacta: "success", calle: "info", localidad: "warning", sin_geo: "warning" } as const;

export function AddressAutocomplete({
  value,
  onChange,
  near = null,
  autoFocus = false,
  disabled = false,
  showMap = true,
  label = "Dirección de entrega",
}: {
  value: GeoAddress | null;
  onChange: (a: GeoAddress | null) => void;
  /** Sesgo de la búsqueda (la sucursal o la última dirección). */
  near?: { lat: number; lng: number } | null;
  autoFocus?: boolean;
  disabled?: boolean;
  showMap?: boolean;
  label?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<GeoSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const seq = useRef(0);

  // Búsqueda con pausa de 300 ms desde 3 letras.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || value) {
      setItems([]);
      setSearching(false);
      return;
    }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await geoApi.suggest(q, near);
      if (my !== seq.current) return;
      setSearching(false);
      if (!r.ok) {
        setItems([]);
        setNotice(geoErrorMessage(r.error));
        return;
      }
      setNotice(r.disabled ? geoErrorMessage("disabled") : null);
      setItems(r.suggestions);
      setActive(r.suggestions.length > 0 ? 0 : -1);
      setOpen(true);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, value]);

  // Tocar afuera cierra la lista.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  async function pick(s: GeoSuggestion) {
    setOpen(false);
    setItems([]);
    if (!s.address.street) {
      // Sólo la localidad: se completa calle y altura a mano.
      setManual(true);
      onChange({ ...s.address, street: "" });
      return;
    }
    setPicking(true);
    const r = await geoApi.normalize(s.address);
    setPicking(false);
    onChange(r.ok ? r.address : s.address);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) {
      if (e.key === "ArrowDown" && items.length > 0) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      void pick(items[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  function clear() {
    onChange(null);
    setManual(false);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const patch = (p: Partial<GeoAddress>) => value && onChange({ ...value, ...p });

  async function locateManual() {
    if (!value?.street) return;
    setPicking(true);
    const r = await geoApi.normalize({ ...value, province_code: value.province_code ?? provinceCode(value.province) });
    setPicking(false);
    if (r.ok && r.normalized) {
      onChange({ ...value, ...r.address, floor: value.floor, apartment: value.apartment });
      setNotice(null);
    } else {
      setNotice(r.ok ? "No la encontramos en el mapa: marcá el pin a mano si querés." : geoErrorMessage(r.error));
    }
  }

  // ── Sin dirección elegida: buscador ────────────────────────────────────────
  if (!value && !manual) {
    return (
      <div ref={boxRef} className="space-y-1.5">
        <label htmlFor={`${listId}-q`} className="block text-sm font-medium text-muted-foreground">
          {label}
        </label>
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            id={`${listId}-q`}
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={`${listId}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listId}-o${active}` : undefined}
            autoComplete="off"
            autoFocus={autoFocus}
            disabled={disabled || picking}
            placeholder="Calle y altura, por ejemplo San Martín 1234 Pilar"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNotice(null);
            }}
            onFocus={() => items.length > 0 && setOpen(true)}
            onKeyDown={onKey}
            className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-9 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20 disabled:opacity-60"
          />
          {(searching || picking) && (
            <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />
          )}
          {open && items.length > 0 && (
            <ul
              id={`${listId}-list`}
              role="listbox"
              aria-label="Sugerencias de direcciones"
              className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground"
            >
              {items.map((s, i) => (
                <li
                  key={s.id}
                  id={`${listId}-o${i}`}
                  role="option"
                  aria-selected={i === active}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    void pick(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2 text-sm",
                    i === active && "bg-fg-6",
                  )}
                >
                  <MapPin size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{s.title}</span>
                    {s.detail && <span className="block truncate text-xs text-muted-foreground">{s.detail}</span>}
                  </span>
                </li>
              ))}
              <li className="px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">© OpenStreetMap · Georef AR</li>
            </ul>
          )}
          {open && !searching && items.length === 0 && query.trim().length >= 3 && !notice && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm text-muted-foreground">
              No encontramos esa dirección.{" "}
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onPointerDown={(e) => { e.preventDefault(); setOpen(false); setManual(true); onChange({ street: query.trim(), geo_source: "manual", geo_quality: "sin_geo" }); }}>
                Cargala a mano
              </button>
            </div>
          )}
        </div>
        {notice && <p role="status" className="text-xs text-warning">{notice}</p>}
        <button
          type="button"
          onClick={() => {
            setManual(true);
            onChange({ street: query.trim(), geo_source: "manual", geo_quality: "sin_geo" });
          }}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <PenLine size={12} aria-hidden /> No aparece: cargarla a mano
        </button>
      </div>
    );
  }

  const a = value ?? { street: "", geo_source: "manual" as const, geo_quality: "sin_geo" as const };
  const located = a.lat != null && a.lng != null;

  return (
    <div className="space-y-2.5">
      {manual && !located ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <Input label="Calle" value={a.street} maxLength={120} autoFocus onChange={(e) => patch({ street: e.target.value })} />
            <Input label="Altura" inputMode="numeric" value={a.number ?? ""} maxLength={20} onChange={(e) => patch({ number: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Localidad" value={a.locality ?? ""} maxLength={120} onChange={(e) => patch({ locality: e.target.value })} />
            <Input
              label="Provincia"
              value={a.province ?? ""}
              maxLength={60}
              onChange={(e) => patch({ province: e.target.value, province_code: provinceCode(e.target.value) })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" loading={picking} disabled={!a.street || !a.number} onClick={locateManual}>
              <MapPin size={15} aria-hidden /> Ubicar en el mapa
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              Volver a buscar
            </Button>
          </div>
          {notice && <p role="status" className="text-xs text-warning">{notice}</p>}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
          <MapPin size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{formatShipTo({ ...a, floor: null, apartment: null }) || "Dirección sin calle"}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone={QUALITY_TONE[a.geo_quality]}>{GEO_QUALITY_LABEL[a.geo_quality]}</Badge>
              {a.partido && a.partido !== a.locality && <span className="text-xs text-muted-foreground">Partido de {a.partido}</span>}
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2" onClick={clear} aria-label="Cambiar la dirección">
            <X size={15} aria-hidden /> Cambiar
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Input label="Piso" value={a.floor ?? ""} maxLength={20} placeholder="Opcional" onChange={(e) => patch({ floor: e.target.value })} />
        <Input label="Depto." value={a.apartment ?? ""} maxLength={20} placeholder="Opcional" onChange={(e) => patch({ apartment: e.target.value })} />
      </div>
      <Input
        label="Entre calles o referencia"
        value={a.reference ?? ""}
        maxLength={200}
        placeholder="Portón verde, timbre 2"
        onChange={(e) => patch({ reference: e.target.value })}
      />
      {showMap && (located || !manual) && (
        <MiniMap
          lat={a.lat}
          lng={a.lng}
          onMove={(lat, lng) => patch({ lat, lng, geo_source: "pin", geo_quality: "exacta" })}
        />
      )}
      {showMap && located && <p className="text-xs text-muted-foreground">Si el pin no quedó justo, arrastralo o tocá el mapa.</p>}
    </div>
  );
}
AddressAutocomplete.displayName = "AddressAutocomplete";
