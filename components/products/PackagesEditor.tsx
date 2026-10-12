"use client";

import { useId, useMemo, useState } from "react";
import {
  Boxes,
  MoveDiagonal,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Ruler,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { NoData } from "@/components/ui/NoData";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import {
  chargeableWeightKg,
  formatCm3,
  formatM3,
  formatMeasure,
  formatWeight,
  isoBoxGeometry,
  newPackage,
  packageTotalCm3,
  packageVolumeCm3,
  toPositiveOrNull,
  unitVolumeCm3,
  volumetricWeightKg,
  type ProductPackage,
} from "@/lib/products/packages";

// ── Caja isométrica (SVG en código, escala con las proporciones reales) ─────
export function PackageBox({
  heightCm,
  widthCm,
  depthCm,
  className,
}: {
  heightCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  className?: string;
}) {
  const g = useMemo(
    () => isoBoxGeometry(heightCm, widthCm, depthCm),
    [heightCm, widthCm, depthCm],
  );
  const uid = useId().replace(/:/g, "");
  const id = (k: string) => `${k}-${uid}`;
  return (
    <svg viewBox={g.viewBox} className={className} role="img" aria-label="Caja del bulto">
      <defs>
        <linearGradient id={id("pkg-top")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f1d3a1" />
          <stop offset="1" stopColor="#e2b97c" />
        </linearGradient>
        <linearGradient id={id("pkg-left")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d4a464" />
          <stop offset="1" stopColor="#c08a49" />
        </linearGradient>
        <linearGradient id={id("pkg-right")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b98443" />
          <stop offset="1" stopColor="#a06f33" />
        </linearGradient>
      </defs>
      <polygon points={g.left} fill={`url(#${id("pkg-left")})`} />
      <polygon points={g.right} fill={`url(#${id("pkg-right")})`} />
      <polygon points={g.top} fill={`url(#${id("pkg-top")})`} />
      <path d={g.flap} stroke="#b98443" strokeOpacity="0.55" strokeWidth="0.9" fill="none" />
      <path d={g.tape} fill="#fbe9c8" fillOpacity="0.55" />
    </svg>
  );
}
PackageBox.displayName = "PackageBox";

function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "brand";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums",
        tone === "brand"
          ? "bg-ninja-flame/[0.12] text-ninja-flameSoft"
          : "bg-muted text-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function DimChip({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof MoveVertical;
  value: number | null;
  label: string;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 rounded-xl bg-muted px-2.5 py-1.5 text-xs font-semibold tabular-nums text-foreground"
      title={label}
    >
      <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}</span>
      {value != null ? `${formatMeasure(value)} cm` : <NoData />}
    </span>
  );
}

// ── Tarjeta de un bulto ────────────────────────────────────────────────────
export function PackageCard({
  pkg,
  index,
  productName,
  onEdit,
  editing,
  children,
}: {
  pkg: ProductPackage;
  index: number;
  productName?: string;
  onEdit?: () => void;
  editing?: boolean;
  children?: React.ReactNode;
}) {
  const vol = packageVolumeCm3(pkg);
  const unit = unitVolumeCm3(pkg);
  const total = packageTotalCm3(pkg);
  return (
    <div className="overflow-hidden rounded-2xl bg-card shadow-ninjaSoft">
      <div className="flex gap-4 p-4">
        <div className="grid h-[104px] w-[104px] shrink-0 place-items-center rounded-2xl bg-muted sm:h-[116px] sm:w-[116px]">
          <PackageBox
            heightCm={pkg.heightCm}
            widthCm={pkg.widthCm}
            depthCm={pkg.depthCm}
            className="h-[88px] w-[88px] drop-shadow-[0_10px_14px_rgba(0,0,0,0.25)] sm:h-[100px] sm:w-[100px]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Producto #{index + 1}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pkg.code.trim() && <Chip tone="brand">{pkg.code.trim().toUpperCase()}</Chip>}
            <Chip>x{formatMeasure(pkg.unitsPerPack, 3)}</Chip>
            {pkg.packCount > 1 && <Chip>{pkg.packCount} bultos</Chip>}
            <Chip>{pkg.weightKg != null ? formatWeight(pkg.weightKg) : <NoData />}</Chip>
          </div>
          {productName && (
            <p className="mt-2 line-clamp-2 text-sm font-bold leading-snug text-foreground">
              {productName}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <DimChip icon={MoveVertical} value={pkg.heightCm} label="Alto" />
            <DimChip icon={MoveHorizontal} value={pkg.widthCm} label="Ancho" />
            <DimChip icon={MoveDiagonal} value={pkg.depthCm} label="Profundidad" />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-muted px-4 py-2.5">
        <p className="min-w-0 text-xs tabular-nums text-muted-foreground">
          {vol == null ? (
            "Cargá alto, ancho y profundidad para calcular el volumen."
          ) : (
            <>
              Unidad <span className="font-semibold text-foreground">{formatCm3(unit ?? vol)}</span>
              {" · "}Total <span className="font-semibold text-foreground">{formatCm3(total ?? vol)}</span>
              {" · "}
              <span className="font-semibold text-foreground">{formatM3(total ?? vol)}</span>
            </>
          )}
        </p>
        {onEdit && (
          <Button
            type="button"
            size="sm"
            variant={editing ? "primary" : "secondary"}
            onClick={onEdit}
            className="h-8 rounded-full border-0 px-3.5"
          >
            <Ruler size={14} /> {editing ? "Listo" : "Medidas"}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}
PackageCard.displayName = "PackageCard";

// ── Editor inline de un bulto ──────────────────────────────────────────────
type Draft = Record<
  "code" | "unitsPerPack" | "packCount" | "weightKg" | "heightCm" | "widthCm" | "depthCm",
  string
>;

const toDraft = (p: ProductPackage): Draft => ({
  code: p.code,
  unitsPerPack: String(p.unitsPerPack ?? 1),
  packCount: String(p.packCount ?? 1),
  weightKg: p.weightKg == null ? "" : String(p.weightKg).replace(".", ","),
  heightCm: p.heightCm == null ? "" : String(p.heightCm).replace(".", ","),
  widthCm: p.widthCm == null ? "" : String(p.widthCm).replace(".", ","),
  depthCm: p.depthCm == null ? "" : String(p.depthCm).replace(".", ","),
});

function fromDraft(base: ProductPackage, d: Draft): ProductPackage {
  return {
    ...base,
    code: d.code.slice(0, 40),
    unitsPerPack: toPositiveOrNull(d.unitsPerPack) ?? 1,
    packCount: Math.max(1, Math.round(toPositiveOrNull(d.packCount) ?? 1)),
    weightKg: toPositiveOrNull(d.weightKg),
    heightCm: toPositiveOrNull(d.heightCm),
    widthCm: toPositiveOrNull(d.widthCm),
    depthCm: toPositiveOrNull(d.depthCm),
  };
}

function PackageFields({
  pkg,
  onChange,
  onRemove,
}: {
  pkg: ProductPackage;
  onChange: (p: ProductPackage) => void;
  onRemove: () => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(pkg));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...d, [k]: e.target.value };
    setD(next);
    onChange(fromDraft(pkg, next));
  };
  const vol = packageVolumeCm3(pkg);
  const volKg = volumetricWeightKg(vol);
  const charge = chargeableWeightKg(pkg);
  const num = { inputMode: "decimal" as const, autoComplete: "off" };

  return (
    <div className="space-y-4 px-4 pb-4 pt-4">
      <div className="grid grid-cols-3 gap-3">
        <Input variant="filled" label="Alto (cm)" placeholder="45" value={d.heightCm} onChange={set("heightCm")} {...num} />
        <Input variant="filled" label="Ancho (cm)" placeholder="22" value={d.widthCm} onChange={set("widthCm")} {...num} />
        <Input variant="filled" label="Prof. (cm)" placeholder="22" value={d.depthCm} onChange={set("depthCm")} {...num} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Input variant="filled" label="Código" placeholder="K-COMPACTA" value={d.code} onChange={set("code")} />
        <Input variant="filled" label="Peso (kg)" placeholder="3" value={d.weightKg} onChange={set("weightKg")} {...num} />
        <Input variant="filled" label="Unid. por bulto" value={d.unitsPerPack} onChange={set("unitsPerPack")} {...num} />
        <Input variant="filled" label="Cant. de bultos" value={d.packCount} onChange={set("packCount")} inputMode="numeric" />
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-3 text-xs sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground">Peso volumétrico</p>
          <p className="mt-0.5 font-semibold tabular-nums text-foreground">
            {volKg != null ? formatWeight(volKg) : <NoData />}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Peso a facturar</p>
          <p className="mt-0.5 font-semibold tabular-nums text-foreground">
            {charge != null ? formatWeight(charge) : <NoData />}
          </p>
        </div>
        <p className="col-span-2 self-center text-muted-foreground sm:col-span-1">
          Courier estándar: cm³ / 5.000. Se cobra el mayor.
        </p>
      </div>
      {confirmRemove ? (
        <div className="rounded-xl bg-danger/10 p-3">
          <p className="text-sm font-medium text-foreground">¿Quitar este bulto?</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Se aplica cuando guardes el producto.</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>
              Cancelar
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={onRemove}>
              Quitar
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-danger"
        >
          <Trash2 size={13} /> Quitar bulto
        </button>
      )}
    </div>
  );
}

// ── Lista editable de bultos (Producto #1, #2...) ──────────────────────────
export function PackagesEditor({
  value,
  onChange,
  productName,
}: {
  value: ProductPackage[];
  onChange: (next: ProductPackage[]) => void;
  productName?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  function add() {
    const p = newPackage();
    onChange([...value, p]);
    setEditing(p.key);
  }

  if (value.length === 0) {
    return (
      <div className="rounded-2xl bg-muted">
        <EmptyState
          compact
          icon={Boxes}
          title="Sin medidas por bulto"
          description="Cargá alto, ancho, profundidad y peso de cada bulto para calcular volumen y envíos."
          action={
            <Button type="button" size="sm" onClick={add}>
              <Plus size={15} /> Agregar bulto
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {value.map((p, i) => (
        <PackageCard
          key={p.key}
          pkg={p}
          index={i}
          productName={productName}
          editing={editing === p.key}
          onEdit={() => setEditing(editing === p.key ? null : p.key)}
        >
          {editing === p.key && (
            <PackageFields
              pkg={p}
              onChange={(np) => onChange(value.map((x) => (x.key === p.key ? np : x)))}
              onRemove={() => {
                onChange(value.filter((x) => x.key !== p.key));
                setEditing(null);
              }}
            />
          )}
        </PackageCard>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={add} className="border-0">
        <Plus size={15} /> Agregar otro bulto
      </Button>
    </div>
  );
}
PackagesEditor.displayName = "PackagesEditor";
