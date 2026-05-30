"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};
const STATUS_LABELS: Record<string, string> = {
  active: "Activo",
  suspended: "Suspendido",
  invited: "Invitado",
};
type AssignableRole = "manager" | "cashier" | "viewer";

type Member = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  status: string;
  joined_at: string | null;
};

export function TeamSection({
  currentUserId,
  tenantId,
}: {
  currentUserId: string;
  tenantId: string;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("cashier");

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["tenant-members", tenantId],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase.rpc("tenant_members");
      if (error) {
        // Fallback si la RPC aún no está desplegada: sin emails.
        const { data: tu } = await supabase
          .from("tenant_users")
          .select("user_id, role, status, joined_at")
          .eq("tenant_id", tenantId)
          .order("joined_at", { ascending: true });
        return (tu ?? []).map((m) => ({
          user_id: m.user_id,
          email: null,
          full_name: null,
          role: m.role,
          status: m.status,
          joined_at: m.joined_at,
        }));
      }
      return data as Member[];
    },
  });

  const invite = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("invite_user", {
        body: { email: email.trim().toLowerCase(), role },
      });
      if (error) throw error;
      return data as { existed: boolean };
    },
    onSuccess: (data) => {
      toast({
        variant: "success",
        title: data?.existed ? "Usuario agregado" : "Invitación enviada",
        description: data?.existed
          ? "Ya tenía cuenta; ahora forma parte del equipo."
          : "Le mandamos un email para que defina su contraseña.",
      });
      setOpen(false);
      setEmail("");
      setRole("cashier");
      qc.invalidateQueries({ queryKey: ["tenant-members"] });
    },
    onError: () => {
      toast({
        variant: "error",
        title: "No se pudo invitar",
        description: "Revisá el email o intentá de nuevo.",
      });
    },
  });

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <Heading as="h2" className="flex items-center gap-2">
          Equipo
        </Heading>
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus size={16} /> Invitar usuario
        </Button>
      </div>

      <Card className="mt-3">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Miembro</th>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Desde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted-foreground">
                    Cargando…
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted-foreground">
                    Todavía no hay miembros.
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.user_id}>
                    <td className="px-4 py-3">
                      {m.full_name || m.email || "Miembro"}
                      {m.user_id === currentUserId && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (vos)
                        </span>
                      )}
                      {m.full_name && m.email && (
                        <span className="block text-xs text-muted-foreground">
                          {m.email}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{ROLE_LABELS[m.role] ?? m.role}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {STATUS_LABELS[m.status] ?? m.status}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {m.joined_at
                        ? new Date(m.joined_at).toLocaleDateString("es-AR")
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Invitar usuario"
        description="Le enviamos un email para sumarse a tu negocio."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
          className="space-y-5"
        >
          <Input
            label="Email"
            type="email"
            required
            placeholder="persona@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Rol
            </span>
            <Segmented<AssignableRole>
              value={role}
              onChange={setRole}
              options={[
                { value: "manager", label: "Encargado" },
                { value: "cashier", label: "Cajero" },
                { value: "viewer", label: "Solo lectura" },
              ]}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? "Enviando…" : "Enviar invitación"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
