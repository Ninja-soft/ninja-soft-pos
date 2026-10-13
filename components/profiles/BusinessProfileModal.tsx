"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { useToast } from "@/components/ui/Toast";
import { BUSINESS_PROFILES, getProfile, type ProfileKey } from "@/lib/profiles/businessProfiles";
import { buildProfilePreview, type ProfilePreview } from "@/lib/profiles/preview";
import { FLAG_INFO } from "@/lib/profiles/businessProfiles";
import { PRESET_INFO } from "@/lib/pos/layout";
import { VERTICAL_LABELS, isVertical } from "@/lib/verticals/config";
import {
  profileErrorMessage,
  useApplyBusinessProfile,
  useProfileContext,
} from "@/modules/profiles/hooks";

// "Cambiar rubro" (F5 · ADR-075): elegir un perfil, ver qué cambia y confirmar.
// El servidor (apply_business_profile) repite las mismas reglas que la vista
// previa: sólo prende y crea lo que falta, nunca borra, no otorga features de
// plan y lo deja en la auditoría.
export function BusinessProfileModal({
  open,
  onOpenChange,
  initialKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKey?: ProfileKey | null;
}) {
  const { toast } = useToast();
  const { ctx, isOwner, isLoading } = useProfileContext();
  const apply = useApplyBusinessProfile();
  const [selected, setSelected] = useState<ProfileKey | null>(initialKey ?? null);
  const [step, setStep] = useState<"pick" | "preview">("pick");
  const [createCategories, setCreateCategories] = useState(true);

  // Cada apertura arranca en el selector con el perfil sugerido.
  useEffect(() => {
    if (!open) return;
    setStep("pick");
    setCreateCategories(true);
    setSelected((initialKey ?? (ctx?.currentProfile as ProfileKey | null)) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const profile = getProfile(selected);
  const preview = useMemo<ProfilePreview | null>(
    () => (profile && ctx ? buildProfilePreview(profile, ctx, { createCategories }) : null),
    [profile, ctx, createCategories],
  );

  function confirm() {
    if (!profile) return;
    apply.mutate(
      { key: profile.key, createCategories },
      {
        onSuccess: (r) => {
          const parts: string[] = [];
          if (r.activated.length) parts.push(`${r.activated.length} función(es) activada(s)`);
          if (r.categories_created.length) parts.push(`${r.categories_created.length} categoría(s) nueva(s)`);
          if (r.layout_applied) parts.push("diseño del POS ajustado");
          toast({
            title: `Perfil "${profile.label}" aplicado`,
            description: parts.length ? parts.join(", ") + "." : "No hizo falta cambiar nada.",
            variant: "success",
          });
          onOpenChange(false);
        },
        onError: (e: Error) =>
          toast({ title: "No se aplicó el perfil", description: profileErrorMessage(e.message), variant: "error" }),
      },
    );
  }

  const footer =
    step === "pick" ? (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancelar
        </Button>
        <Button disabled={!profile || !ctx} onClick={() => setStep("preview")}>
          Ver qué cambia
        </Button>
      </div>
    ) : (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => setStep("pick")} disabled={apply.isPending}>
          <ArrowLeft size={16} /> Elegir otro
        </Button>
        <Button onClick={confirm} loading={apply.isPending} disabled={!isOwner || !preview}>
          Aplicar perfil
        </Button>
      </div>
    );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={step === "pick" ? "¿Cuál es tu rubro?" : `Vista previa: ${profile?.label ?? ""}`}
      description={
        step === "pick"
          ? "El perfil adapta el POS a cómo trabajás. Antes de aplicar te mostramos qué cambia."
          : "Esto es lo que va a pasar al confirmar. No se borra nada."
      }
      footer={footer}
      className="sm:max-w-2xl"
    >
      {step === "pick" ? (
        <div role="radiogroup" aria-label="Perfil por rubro" className="grid gap-2 sm:grid-cols-2">
          {BUSINESS_PROFILES.map((p) => (
            <ChoiceCard
              key={p.key}
              indicator
              selected={selected === p.key}
              onClick={() => setSelected(p.key)}
              title={
                <span className="flex items-center gap-2">
                  {p.label}
                  {ctx?.currentProfile === p.key && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--pos-solid)]" />
                      Actual
                    </span>
                  )}
                </span>
              }
              description={p.tagline}
            />
          ))}
        </div>
      ) : isLoading || !preview ? (
        <p className="text-sm text-muted-foreground">Cargando la configuración actual…</p>
      ) : (
        <PreviewBody
          preview={preview}
          createCategories={createCategories}
          onCreateCategories={setCreateCategories}
          isOwner={isOwner}
        />
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t-2 border-border pt-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2 space-y-1.5 text-sm">{children}</div>
    </section>
  );
}

function Row({ tone, children }: { tone: "on" | "same" | "locked"; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className={
          tone === "on"
            ? "mt-0.5 text-[var(--pos-solid)]"
            : tone === "locked"
              ? "mt-0.5 text-muted-foreground"
              : "mt-0.5 text-muted-foreground/70"
        }
      >
        {tone === "locked" ? <Lock size={14} /> : <Check size={14} strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function verticalLabel(v: string | null): string {
  return v && isVertical(v) ? VERTICAL_LABELS[v] : "Sin rubro";
}

function PreviewBody({
  preview,
  createCategories,
  onCreateCategories,
  isOwner,
}: {
  preview: ProfilePreview;
  createCategories: boolean;
  onCreateCategories: (v: boolean) => void;
  isOwner: boolean;
}) {
  const { profile } = preview;
  const activate = preview.flags.filter((f) => f.status === "activate");
  const already = preview.flags.filter((f) => f.status === "already_on");
  const locked = preview.flags.filter((f) => f.status === "locked");

  return (
    <div className="space-y-5">
      {!isOwner && (
        <p className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          Sólo el dueño del negocio puede aplicar un perfil. Podés ver qué cambiaría.
        </p>
      )}
      {preview.sameProfile && (
        <p className="text-sm text-muted-foreground">
          Ya tenés este perfil. Volver a aplicarlo sólo completa lo que falte.
        </p>
      )}

      <Section title="Funciones del POS">
        {activate.map((f) => (
          <Row key={f.key} tone="on">
            <span className="font-medium">Se activa: {f.label}</span>
            <span className="block text-xs text-muted-foreground">{f.help}</span>
          </Row>
        ))}
        {already.map((f) => (
          <Row key={f.key} tone="same">
            <span className="text-muted-foreground">Ya estaba activa: {f.label}</span>
          </Row>
        ))}
        {locked.map((f) => (
          <Row key={f.key} tone="locked">
            <span className="text-muted-foreground">
              {f.label}: disponible en plan {f.minPlan ?? "superior"}. No se activa.
            </span>
          </Row>
        ))}
        {preview.flags.length === 0 && (
          <p className="text-muted-foreground">Este perfil no prende funciones especiales.</p>
        )}
        {preview.keptOn.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Siguen como están (no se apagan): {preview.keptOn.map((k) => FLAG_INFO[k].label).join(", ")}.
          </p>
        )}
      </Section>

      <Section title="Pantalla de venta">
        {preview.layout.status === "apply" ? (
          <Row tone="on">
            <span className="font-medium">Diseño {PRESET_INFO[preview.layout.preset].name}</span>
            <span className="block text-xs text-muted-foreground">
              {PRESET_INFO[preview.layout.preset].tagline}.
            </span>
          </Row>
        ) : preview.layout.status === "keep_custom" ? (
          <p className="text-muted-foreground">
            Ya personalizaste el diseño del POS: se mantiene. Sugerido para tu rubro:{" "}
            {PRESET_INFO[preview.layout.preset].name}.
          </p>
        ) : (
          <p className="text-muted-foreground">Sin cambios en el diseño.</p>
        )}
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {profile.shortcuts.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </Section>

      <Section title="Categorías">
        <label className="flex items-center gap-2">
          <Checkbox checked={createCategories} onCheckedChange={onCreateCategories} aria-label="Crear categorías sugeridas" />
          <span>Crear las categorías sugeridas que falten</span>
        </label>
        {createCategories && preview.categories.create.length > 0 && (
          <p className="text-muted-foreground">Nuevas: {preview.categories.create.join(", ")}.</p>
        )}
        {preview.categories.existing.length > 0 && (
          <p className="text-xs text-muted-foreground">Ya las tenés: {preview.categories.existing.join(", ")}.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Unidades habituales del rubro: {profile.units.join(", ")}. Las elegís en cada producto.
        </p>
      </Section>

      <Section title="Rubro del negocio">
        {preview.industry.changes ? (
          <p>
            {verticalLabel(preview.industry.from)} pasa a{" "}
            <span className="font-medium">{verticalLabel(preview.industry.to)}</span>.
          </p>
        ) : (
          <p className="text-muted-foreground">Queda en {verticalLabel(preview.industry.to)}.</p>
        )}
      </Section>

      {(preview.planFeatures.length > 0 || preview.payments.length > 0) && (
        <Section title="Sugerencias (no se activan solas)">
          {preview.planFeatures.map((f) => (
            <SuggestionRow key={f.key} label={f.label} included={f.included} minPlan={f.minPlan} />
          ))}
          {preview.payments.map((p) => (
            <SuggestionRow key={p.key} label={`Cobro: ${p.label}`} included={p.included} minPlan={p.minPlan} />
          ))}
          <p className="text-xs text-muted-foreground">
            Los medios de cobro se conectan en Configuración, Medios de pago. El perfil no cambia tu plan.
          </p>
        </Section>
      )}

      {profile.tips.length > 0 && (
        <Section title="Para tu rubro">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {profile.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function SuggestionRow({ label, included, minPlan }: { label: string; included: boolean; minPlan: string | null }) {
  return (
    <Row tone={included ? "same" : "locked"}>
      <span className={included ? "" : "text-muted-foreground"}>
        {label}
        <span className="ml-1 text-xs text-muted-foreground">
          {included ? "· incluida en tu plan" : `· disponible en plan ${minPlan ?? "superior"}`}
        </span>
      </span>
    </Row>
  );
}
