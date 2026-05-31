"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { resizeToWebp } from "@/lib/utils/image";

export function ProfileEditModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("users")
        .select("full_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      setName(data?.full_name ?? "");
      setAvatarUrl(data?.avatar_url ?? null);
    })();
  }, [open, supabase]);

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("sin sesión");
      const webp = await resizeToWebp(file, 256, 0.85);
      const path = `${user.id}/${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from("user-avatars")
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from("user-avatars").getPublicUrl(path);
      setAvatarUrl(pub.publicUrl);
    } catch {
      toast({ title: "No se pudo subir la foto", variant: "error" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("sin sesión");
      const { error } = await supabase
        .from("users")
        .update({ full_name: name.trim() || null, avatar_url: avatarUrl })
        .eq("id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Perfil actualizado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["internal-shell-profile"] });
      qc.invalidateQueries({ queryKey: ["account-profile"] });
      onOpenChange(false);
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Mi perfil">
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <Avatar name={name || "?"} avatar={avatarUrl} size={56} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {avatarUrl ? "Cambiar foto" : "Subir foto"}
          </Button>
          {avatarUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => setAvatarUrl(null)}
            >
              Quitar
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => onPhoto(e.target.files?.[0])}
          />
        </div>
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || busy}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
