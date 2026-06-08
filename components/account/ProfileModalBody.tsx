"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { AvatarUploader } from "@/components/account/AvatarUploader";

// Cuerpo compartido de "Editar mi perfil". Garantiza UNA sola experiencia
// (mismo AvatarUploader con recorte/ver/descargar, mismos campos y layout) en
// los dos lugares que lo usan:
//   - Internal (InternalShell): edita la cuenta global (tabla `users`).
//   - POS (AppShell): edita la membresía del tenant (tabla `tenant_users`).
// La diferencia es SOLO la fuente de datos / el guardado (bucket + handler), no
// la UI. Cada modal envuelve este cuerpo y le pasa su contexto.

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
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="space-y-5">
        {uploadPathPrefix ? (
          <AvatarUploader
            value={avatar}
            onChange={onAvatarChange}
            name={name || "?"}
            bucket={uploadBucket}
            pathPrefix={uploadPathPrefix}
            size={56}
          />
        ) : (
          <Avatar name={name || "?"} avatar={avatar} size={56} />
        )}
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
        <div className="flex justify-end">
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
