"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldPlus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";

type Level = "support" | "admin" | "super_admin";
const LEVEL_LABELS: Record<string, string> = {
  support: "Soporte",
  admin: "Admin",
  super_admin: "Super admin",
};
type Staff = {
  id: string;
  email: string;
  full_name: string | null;
  internal_level: string | null;
};

export default function InternalStaffPage() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<Level>("admin");

  const { data: me } = useQuery({
    queryKey: ["my-internal-level"],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return {
        id: user?.id ?? null,
        level: ((user?.app_metadata as { internal_level?: string } | null)
          ?.internal_level ?? null) as string | null,
      };
    },
  });

  const { data: staff = [], isLoading } = useQuery({
    queryKey: ["internal-staff"],
    queryFn: async (): Promise<Staff[]> => {
      const { data, error } = await supabase.rpc("internal_list_staff");
      if (error) throw error;
      return (data ?? []) as Staff[];
    },
  });

  const isSuper = me?.level === "super_admin";
  const noSuper = staff.every((s) => s.internal_level !== "super_admin");
  const canBootstrap = !isSuper && noSuper;

  const setLevelMut = useMutation({
    mutationFn: async (vars: { email?: string; user_id?: string; level: Level | null }) => {
      const { data, error } = await supabase.functions.invoke("staff_admin", {
        body: { action: "set_level", ...vars },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Staff actualizado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["internal-staff"] });
      qc.invalidateQueries({ queryKey: ["my-internal-level"] });
      setEmail("");
    },
    onError: (e) =>
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Staff NinjaSoft</Display>
      <p className="mt-2 text-muted-foreground">
        Quién puede operar el panel interno y con qué nivel. Solo un super admin
        asigna niveles.
      </p>

      {canBootstrap && (
        <Card className="mt-6 border-ninja-flame/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div className="font-semibold">Todavía no hay un super admin</div>
              <div className="text-sm text-muted-foreground">
                Reclamá el rol de super admin para gestionar el staff.
              </div>
            </div>
            <Button
              onClick={() =>
                setLevelMut.mutate({ user_id: me?.id ?? undefined, level: "super_admin" })
              }
              disabled={setLevelMut.isPending}
            >
              <ShieldPlus size={16} /> Reclamar super admin
            </Button>
          </CardContent>
        </Card>
      )}

      {isSuper && (
        <Card className="mt-6">
          <CardContent className="p-5">
            <div className="font-semibold">Agregar staff</div>
            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setLevelMut.mutate({ email: email.trim().toLowerCase(), level });
              }}
            >
              <div className="min-w-[220px] flex-1">
                <Input
                  label="Email (cuenta existente)"
                  type="email"
                  required
                  placeholder="persona@ninjasoft.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Segmented<Level>
                value={level}
                onChange={setLevel}
                options={[
                  { value: "support", label: "Soporte" },
                  { value: "admin", label: "Admin" },
                  { value: "super_admin", label: "Super" },
                ]}
              />
              <Button type="submit" disabled={setLevelMut.isPending}>
                Agregar
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              La persona ya debe tener cuenta en NinjaPos (haberse registrado).
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Persona</th>
                <th className="px-4 py-3">Nivel</th>
                {isSuper && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-muted-foreground">Cargando…</td>
                </tr>
              ) : staff.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-muted-foreground">Sin staff.</td>
                </tr>
              ) : (
                staff.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.full_name || s.email}</div>
                      {s.full_name && (
                        <div className="text-xs text-muted-foreground">{s.email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isSuper ? (
                        <Segmented<Level>
                          value={(s.internal_level as Level) ?? "support"}
                          onChange={(v) => setLevelMut.mutate({ user_id: s.id, level: v })}
                          options={[
                            { value: "support", label: "Soporte" },
                            { value: "admin", label: "Admin" },
                            { value: "super_admin", label: "Super" },
                          ]}
                        />
                      ) : (
                        LEVEL_LABELS[s.internal_level ?? ""] ?? s.internal_level
                      )}
                    </td>
                    {isSuper && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setLevelMut.mutate({ user_id: s.id, level: null })}
                          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                          title="Quitar del staff"
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
