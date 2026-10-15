"use client";

import { useEffect, useRef } from "react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { useOnboardingChecklist } from "@/modules/onboarding/checklist";
import {
  newlyCompletedSteps,
  nextPendingStep,
} from "@/lib/onboarding/activationChecklist";

// Avisos de la puesta en marcha (ADR-150): cuando el dueño completa un paso
// (con datos reales, en cualquier pantalla), un aviso le dice qué sigue y un
// botón lo lleva directo. Los pasos ya avisados se recuerdan por negocio en
// este navegador para no repetirlos; la primera carga sólo los registra.
const REFRESH_MS = 5_000;

function storageKey(tenantId: string) {
  return `onboarding-done:${tenantId}`;
}

function readKnown(tenantId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : null;
  } catch {
    return null;
  }
}

function writeKnown(tenantId: string, keys: string[]) {
  try {
    window.localStorage.setItem(storageKey(tenantId), JSON.stringify(keys));
  } catch {
    /* sin storage: no se avisa, no se rompe nada */
  }
}

export function OnboardingNextStepToasts() {
  const { tenantId, steps, status, dismissed } = useOnboardingChecklist();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Al moverse por el panel, las señales se vuelven a pedir (con un mínimo de
  // 5 s entre pedidos) para enterarse del paso recién hecho.
  const lastRefresh = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastRefresh.current < REFRESH_MS) return;
    lastRefresh.current = now;
    qc.invalidateQueries({ queryKey: ["onboarding-status"] });
    qc.invalidateQueries({ queryKey: ["onboarding-activation"] });
  }, [pathname, qc]);

  const doneKeys = status
    ? steps.filter((s) => status[s.key] === true).map((s) => s.key)
    : null;
  const doneSig = doneKeys ? doneKeys.join(",") : null;
  const latest = useRef({ steps, status });
  latest.current = { steps, status };

  useEffect(() => {
    if (!tenantId || doneSig === null || dismissed !== false) return;
    const { steps: s, status: st } = latest.current;
    if (!st) return;
    const known = readKnown(tenantId);
    const done = doneSig ? doneSig.split(",") : [];
    if (known) {
      const fresh = newlyCompletedSteps(s, st, known);
      const justDone = fresh[fresh.length - 1];
      if (justDone) {
        const next = nextPendingStep(s, st);
        if (next) {
          toast({
            title: `Listo: ${justDone.label}`,
            description: `Lo que sigue: ${next.label}. ${next.desc}`,
            variant: "success",
            duration: 10_000,
            actions: [
              {
                label: next.cta,
                onClick: () => router.push(next.href as Route),
              },
            ],
          });
        } else {
          toast({
            title: "¡Negocio configurado!",
            description:
              "Completaste la puesta en marcha. Ya tenés todo listo para vender.",
            variant: "success",
          });
        }
      }
    }
    writeKnown(tenantId, Array.from(new Set([...(known ?? []), ...done])));
  }, [tenantId, doneSig, dismissed, router, toast]);

  return null;
}
