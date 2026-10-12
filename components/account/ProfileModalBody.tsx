"use client";

import { Camera, Download, Eye, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { useAvatarUpload } from "@/components/account/AvatarUploader";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Cuerpo compartido de "Editar mi perfil". Garantiza UNA sola experiencia
// (mismo uploader con recorte/ver/descargar, mismos campos y layout) en
// los dos lugares que lo usan:
//   - Internal (InternalShell): edita la cuenta global (tabla `users`).
//   - POS (AppShell): edita la membresía del tenant (tabla `tenant_users`).
// La diferencia es SOLO la fuente de datos / el guardado (bucket + handler), no
// la UI. Cada modal envuelve este cuerpo y le pasa su contexto.

const FORM_ID = "profile-modal-form";

export function ProfileModalBody({
  open,
  onOpenChange,
  name,
  onNameChange,
  avatar,
  onAvatarChange,
  // Contexto del uploader: cuando hay `pathPrefix` se permite subir/recortar; si
  // todavía no lo conocemos (sesión cargando) se muestra solo el avatar.
  uploadBucket,
  uploadPathPrefix,
  onSave,
  saving,
  title = "Mi perfil",
  email,
  roleLabel,
  contextLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
  onNameChange: (v: string) => void;
  avatar: string | null;
  onAvatarChange: (v: string | null) => void;
  uploadBucket: string;
  uploadPathPrefix: string | null;
  onSave: () => void;
  saving: boolean;
  title?: string;
  /** Email de la cuenta (solo lectura). */
  email?: string | null;
  /** Rol visible (ej. "Encargado", "Soporte"). */
  roleLabel?: string | null;
  /** Contexto del rol (ej. nombre del negocio). */
  contextLabel?: string | null;
}) {
  const display = name.trim() ? capitalizeName(name.trim()) : email || "Tu nombre";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form={FORM_ID} loading={saving}>
            Guardar
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        className="space-y-5"
      >
        <div className="flex items-center gap-4 rounded-xl border border-border bg-muted p-4">
          {uploadPathPrefix ? (
            <EditableAvatar
              name={name}
              avatar={avatar}
              onAvatarChange={onAvatarChange}
              bucket={uploadBucket}
              pathPrefix={uploadPathPrefix}
            />
          ) : (
            <Avatar name={name || "?"} avatar={avatar} size={72} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">{display}</p>
            {email && display !== email && (
              <p className="truncate text-sm text-muted-foreground">{email}</p>
            )}
            {(roleLabel || contextLabel) && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                {roleLabel && (
                  <span className="rounded-md bg-background px-2 py-0.5 font-medium text-foreground">
                    {roleLabel}
                  </span>
                )}
                {contextLabel && (
                  <span className="min-w-0 truncate text-muted-foreground">{contextLabel}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <Input
          label="Nombre"
          hint="Así te ven en el equipo y en el POS."
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </form>
    </Modal>
  );
}

// Avatar grande con acceso directo a cambiar la foto (insignia de cámara) y
// acciones compactas de la foto (ver / descargar / quitar) pegadas al avatar.
function EditableAvatar({
  name,
  avatar,
  onAvatarChange,
  bucket,
  pathPrefix,
}: {
  name: string;
  avatar: string | null;
  onAvatarChange: (v: string | null) => void;
  bucket: string;
  pathPrefix: string;
}) {
  const { hasPhoto, uploading, downloading, openPicker, openViewer, download, dialogs } =
    useAvatarUpload({ value: avatar, onChange: onAvatarChange, name, bucket, pathPrefix });

  const iconBtn =
    "grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

  return (
    <div className="flex shrink-0 flex-col items-center gap-2">
      <button
        type="button"
        onClick={openPicker}
        disabled={uploading}
        className="group relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={hasPhoto ? "Cambiar foto" : "Subir foto"}
        title={hasPhoto ? "Cambiar foto" : "Subir foto"}
      >
        <Avatar name={name || "?"} avatar={avatar} size={72} loading={uploading} />
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition group-hover:opacity-100"
        >
          <Camera size={20} />
        </span>
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 grid h-7 w-7 place-items-center rounded-full border border-border bg-popover text-foreground shadow-sm"
        >
          <Camera size={14} />
        </span>
      </button>
      {hasPhoto && (
        <div className="flex items-center rounded-lg border border-border bg-popover p-0.5">
          <button type="button" className={iconBtn} onClick={openViewer} aria-label="Ver foto" title="Ver foto">
            <Eye size={15} />
          </button>
          <button
            type="button"
            className={iconBtn}
            onClick={download}
            disabled={downloading}
            aria-label="Descargar foto"
            title="Descargar foto"
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            className={cn(iconBtn, "hover:text-destructive")}
            onClick={() => onAvatarChange(null)}
            aria-label="Quitar foto"
            title="Quitar foto"
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
      {dialogs}
    </div>
  );
}
