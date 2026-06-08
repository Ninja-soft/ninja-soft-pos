"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { ProfileModalBody } from "@/components/account/ProfileModalBody";

// Editar mi perfil en Internal = la cuenta global del usuario (tabla `users`:
// full_name / avatar_url). La UI (recorte de foto, ver/descargar, campos) la
// aporta ProfileModalBody, compartida con el POS para que la experiencia sea
// idéntica; acá solo cambia la fuente de datos y el guardado.
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
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data } = await supabase
        .from("users")
        .select("full_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      setName(data?.full_name ?? "");
      setAvatarUrl(data?.avatar_url ?? null);
    })();
  }, [open, supabase]);

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
    <ProfileModalBody
      open={open}
      onOpenChange={onOpenChange}
      name={name}
      onNameChange={setName}
      avatar={avatarUrl}
      onAvatarChange={setAvatarUrl}
      uploadBucket="user-avatars"
      uploadPathPrefix={userId}
      onSave={() => save.mutate()}
      saving={save.isPending}
    />
  );
}
