"use client";

import { useState } from "react";
import { Check, ImagePlus, MapPin, Star } from "lucide-react";
import { Avatar, AVATAR_ICONS, AVATAR_PRESETS } from "@/components/ui/Avatar";
import { useAvatarUpload } from "@/components/account/AvatarUploader";
import { ChoiceCard, CHOICE_ON } from "@/components/ui/ChoiceCard";
import { Spinner } from "@/components/ui/Spinner";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Piezas de formulario del personal (extraídas de TeamSection: antes eran
// componentes definidos DENTRO de otro y se remontaban en cada render, B-02).

export type AssignableRole = "manager" | "cashier" | "viewer";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

const ROLE_OPTIONS: { value: AssignableRole; label: string; desc: string }[] = [
  { value: "manager", label: "Encargado", desc: "Opera todo: ventas, caja y stock. No cambia el plan." },
  { value: "cashier", label: "Cajero", desc: "Vende y cobra en el POS con su propia caja." },
  { value: "viewer", label: "Solo lectura", desc: "Ve reportes y comprobantes, no modifica nada." },
];

export function RolePicker({
  value,
  onChange,
  allowManager = true,
}: {
  value: AssignableRole;
  onChange: (v: AssignableRole) => void;
  allowManager?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Rol" className="grid gap-2 sm:grid-cols-3">
      {ROLE_OPTIONS.filter((o) => allowManager || o.value !== "manager").map((o) => (
        <ChoiceCard
          key={o.value}
          selected={value === o.value}
          onClick={() => onChange(o.value)}
          title={o.label}
          description={o.desc}
          className="p-3 pr-8"
        />
      ))}
    </div>
  );
}
RolePicker.displayName = "RolePicker";

// Insignia de check compacta para tiles chicos (la de .choice-check es para cards).
function TileCheck() {
  return (
    <span
      aria-hidden
      className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-ninja-flame text-white"
    >
      <Check size={10} strokeWidth={3.5} />
    </span>
  );
}

const TILE =
  "relative grid aspect-square w-full place-items-center rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const tileClass = (on: boolean) =>
  cn(TILE, on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary hover:text-foreground");

// Grilla de avatares: iniciales + iconos + foto propia (subir / la ya subida).
export function AvatarPicker({
  value,
  onChange,
  name,
  tenantId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  name: string;
  tenantId: string;
}) {
  const isUrl = !!value && /^https?:\/\//.test(value);
  const [photo, setPhoto] = useState<string | null>(isUrl ? value : null);
  const upload = useAvatarUpload({
    value: isUrl ? value : photo,
    onChange: (url) => {
      setPhoto(url);
      onChange(url);
    },
    name,
    bucket: "tenant-assets",
    pathPrefix: `${tenantId}/members`,
  });

  return (
    <div>
      <div role="radiogroup" aria-label="Avatar" className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          onClick={() => onChange(null)}
          className={tileClass(value === null)}
          title="Iniciales"
          aria-label="Iniciales"
        >
          <Avatar name={name || "?"} size={26} />
          {value === null && <TileCheck />}
        </button>
        {AVATAR_PRESETS.map((key) => {
          const Icon = AVATAR_ICONS[key];
          const on = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(key)}
              className={tileClass(on)}
              title={key}
              aria-label={key}
            >
              {Icon ? <Icon size={20} strokeWidth={1.9} /> : null}
              {on && <TileCheck />}
            </button>
          );
        })}
        {photo && (
          <button
            type="button"
            role="radio"
            aria-checked={value === photo}
            onClick={() => onChange(photo)}
            className={cn(tileClass(value === photo), "p-1")}
            title="Foto propia"
            aria-label="Foto propia"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="" className="h-full w-full rounded object-cover" />
            {value === photo && <TileCheck />}
          </button>
        )}
        <button
          type="button"
          onClick={upload.openPicker}
          disabled={upload.uploading}
          className={cn(TILE, "border border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50")}
          title={photo ? "Subir otra foto" : "Subir foto"}
          aria-label={photo ? "Subir otra foto" : "Subir foto"}
        >
          {upload.uploading ? <Spinner /> : <ImagePlus size={20} strokeWidth={1.9} />}
        </button>
      </div>
      {isUrl && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Foto propia</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={upload.openViewer} className="font-medium text-foreground hover:underline">
            Ver
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={upload.download}
            disabled={upload.downloading}
            className="font-medium text-foreground hover:underline disabled:opacity-50"
          >
            Descargar
          </button>
        </div>
      )}
      {upload.dialogs}
    </div>
  );
}
AvatarPicker.displayName = "AvatarPicker";

// Vista previa del miembro: se actualiza mientras se completa el formulario.
export function MemberPreview({
  name,
  email,
  avatar,
  role,
  branches,
}: {
  name: string;
  email: string;
  avatar: string | null;
  role: AssignableRole;
  branches?: string[];
}) {
  const n = name.trim();
  const e = email.trim();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted p-3.5">
      <Avatar name={n || e || "?"} avatar={avatar} size={48} />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm font-semibold", n ? "text-foreground" : "text-muted-foreground")}>
          {n ? capitalizeName(n) : "Nombre del miembro"}
        </p>
        <p className="truncate text-xs text-muted-foreground">{e || "persona@ejemplo.com"}</p>
        {branches && branches.length > 0 && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <MapPin size={11} className="mr-1 inline" aria-hidden />
            {branches.join(" · ")}
          </p>
        )}
      </div>
      <span className="shrink-0 rounded-md bg-background px-2 py-0.5 text-xs font-medium text-foreground">
        {ROLE_LABELS[role]}
      </span>
    </div>
  );
}
MemberPreview.displayName = "MemberPreview";

// Sucursal base (una) + adicionales (varias), como tarjetas neutras.
export function BranchAssignPicker({
  branches,
  home,
  extras,
  onChange,
}: {
  branches: { id: string; name: string; short_name: string | null; color: string | null; is_default: boolean }[];
  home: string | null;
  extras: string[];
  onChange: (v: { home: string | null; extras: string[] }) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <span className="mb-2 block text-sm font-medium text-muted-foreground">Sucursal base</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={home === b.id}
              onClick={() => onChange({ home: b.id, extras: extras.filter((x) => x !== b.id) })}
              className={cn(
                "flex items-center gap-2.5 rounded-lg p-3 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                home === b.id ? cn(CHOICE_ON, "choice-check") : "bg-muted hover:bg-secondary",
              )}
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/50"
                style={b.color ? { background: b.color } : undefined}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
              {b.is_default && <Star size={13} className="shrink-0 text-muted-foreground" aria-label="Principal" />}
            </button>
          ))}
        </div>
      </div>
      {home && branches.length > 1 && (
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">También puede trabajar en</span>
          <div className="flex flex-wrap gap-2">
            {branches
              .filter((b) => b.id !== home)
              .map((b) => {
                const on = extras.includes(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ home, extras: on ? extras.filter((x) => x !== b.id) : [...extras, b.id] })}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? cn(CHOICE_ON, "text-foreground") : "bg-muted text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {on && <Check size={13} aria-hidden />}
                    {b.short_name || b.name}
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
BranchAssignPicker.displayName = "BranchAssignPicker";
