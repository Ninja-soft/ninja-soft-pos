"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { ProfileModalBody } from "@/components/account/ProfileModalBody";

// Perfil del usuario en el POS = su membresía (tenant_users.display_name/avatar),
// lo mismo que se ve y edita en la sección Equipo. La UI (recorte de foto,
// ver/descargar, campos) la aporta ProfileModalBody, idéntica a la de Internal;
// acá solo cambia la fuente de datos (tenant_users) y el guardado (Edge Fn).
export function MembershipProfileModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setTenantId(
        ((user.app_metadata as { current_tenant_id?: string } | null)
          ?.current_tenant_id) ?? null,
      );
      const { data } = await supabase
        .from("tenant_users")
        .select("display_name, avatar")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      setName(data?.display_name ?? "");
      setAvatar(data?.avatar ?? null);
    })();
  }, [open, supabase]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke("member_admin", {
        body: { action: "update_my_profile", display_name: name.trim(), avatar },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Perfil actualizado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["my-membership-profile"] });
      qc.invalidateQueries({ queryKey: ["tenant-members"] });
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
      avatar={avatar}
      onAvatarChange={setAvatar}
      uploadBucket="tenant-assets"
      uploadPathPrefix={tenantId ? `${tenantId}/members` : null}
      onSave={() => save.mutate()}
      saving={save.isPending}
    />
  );
}
