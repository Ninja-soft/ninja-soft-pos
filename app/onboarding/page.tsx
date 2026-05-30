"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createClient } from "@/lib/supabase/client";
import {
  CreateTenantSchema,
  INDUSTRIES,
  INDUSTRY_LABELS,
  type CreateTenantInput,
} from "@/modules/tenants/schemas";
import { createTenant } from "@/modules/tenants/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Accent, Eyebrow } from "@/components/ui/Typography";

export default function OnboardingPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTenantInput>({
    resolver: zodResolver(CreateTenantSchema),
    defaultValues: { industry: "kiosco" },
  });

  async function onSubmit(values: CreateTenantInput) {
    setServerError(null);
    try {
      await createTenant(values);
      // Refrescar la sesión para que el JWT tome app_metadata.current_tenant_id.
      await createClient().auth.refreshSession();
      router.push("/dashboard-team");
      router.refresh();
    } catch (e) {
      setServerError(
        e instanceof Error ? e.message : "No pudimos crear el negocio.",
      );
    }
  }

  return (
    <div className="ninja-dark-bg relative flex min-h-screen items-center justify-center px-4 py-12 text-ninja-softWhite">
      <div className="ninja-grid pointer-events-none absolute inset-0 opacity-20" />
      <div className="relative z-10 w-full max-w-lg">
        <Card>
          <CardHeader>
            <Eyebrow className="mb-2">Onboarding</Eyebrow>
            <CardTitle>
              Creá tu <Accent tone="gradient">negocio</Accent>
            </CardTitle>
            <CardDescription>
              Arrancás con un trial de 14 días en el plan Start. Podés cambiarlo
              después.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              <Input
                label="Nombre del negocio"
                placeholder="Kiosco La Esquina"
                error={errors.name?.message}
                {...register("name")}
              />
              <div className="w-full">
                <label
                  htmlFor="industry"
                  className="mb-2 block text-sm font-medium text-muted-foreground"
                >
                  Rubro
                </label>
                <select
                  id="industry"
                  className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
                  {...register("industry")}
                >
                  {INDUSTRIES.map((key) => (
                    <option key={key} value={key} className="bg-ninja-deepViolet">
                      {INDUSTRY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
              {serverError && (
                <p className="text-sm text-destructive">{serverError}</p>
              )}
              <Button type="submit" loading={isSubmitting} className="w-full">
                Crear negocio
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
