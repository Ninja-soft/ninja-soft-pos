"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";

export function ChangePasswordModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validatePassword(value: string) {
    if (value.length < 10) return "Mínimo 10 caracteres.";
    if (!/[A-Z]/.test(value)) return "Debe incluir al menos una mayúscula.";
    if (!/[a-z]/.test(value)) return "Debe incluir al menos una minúscula.";
    if (!/[0-9]/.test(value)) return "Debe incluir al menos un número.";
    return null;
  }

  async function submit() {
    setError(null);
    if (!currentPassword) {
      setError("Ingresá tu contraseña actual.");
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) {
      setLoading(false);
      setError("No se pudo validar la sesión.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (signInError) {
      setLoading(false);
      setError("La contraseña actual es incorrecta.");
      return;
    }

    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }

    toast({ title: "Contraseña actualizada", variant: "success" });
    setCurrentPassword("");
    setPassword("");
    setConfirm("");
    onOpenChange(false);
  }

  async function sendResetEmail() {
    setError(null);
    setResetLoading(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) {
      setResetLoading(false);
      setError("No se pudo obtener el email de la cuenta.");
      return;
    }

    const { error: err } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetLoading(false);
    if (err) {
      setError(err.message);
      return;
    }

    toast({
      title: "Email enviado",
      description: "Te mandamos un enlace para blanquear la contraseña.",
      variant: "success",
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cambiar contraseña"
      description="Por seguridad, primero validamos tu contraseña actual."
    >
      <div className="space-y-4">
        <Input
          label="Contraseña actual"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <Input
          label="Nueva contraseña"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Mínimo 10 caracteres, una mayúscula, una minúscula y un número."
        />
        <Input
          label="Repetir contraseña"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Si no recordás la contraseña actual, podés blanquearla por email.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            loading={resetLoading}
            onClick={sendResetEmail}
          >
            Enviar email de blanqueo
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={loading} onClick={submit}>
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
