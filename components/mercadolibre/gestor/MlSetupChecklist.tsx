"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { setupSteps, showSetup, type GestorSection, type SetupStep } from "@/lib/mercadolibre/gestor";
import { useMlListingRules, useMlWebhookSeen, type MlAccount } from "@/modules/mercadolibre/hooks";

// Puesta en marcha de una cuenta recién conectada (H141 · ADR-132): qué falta
// para operar tranquilo. Se oculta sola cuando está todo o a los 30 días, y
// se puede cerrar (preferencia del navegador).

const KEY = (id: string) => `ml-setup-hidden:${id}`;
const INVOICE_KEY = (id: string) => `ml-setup-invoice-ok:${id}`;

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Sin storage: se vuelve a mostrar la próxima vez.
  }
}

const TARGET: Record<SetupStep["key"], GestorSection> = {
  account: "config",
  stock: "config",
  prices: "config",
  invoice: "billing",
  topics: "config",
};

export function MlSetupChecklist({ account, onGo }: { account: MlAccount; onGo: (s: GestorSection) => void }) {
  const { data: rules = [] } = useMlListingRules(account.id);
  const { data: webhookSeen = false } = useMlWebhookSeen(account.id);
  const [hidden, setHidden] = useState(true);
  const [invoiceOk, setInvoiceOk] = useState(false);
  useEffect(() => {
    setHidden(readFlag(KEY(account.id)));
    setInvoiceOk(readFlag(INVOICE_KEY(account.id)));
  }, [account.id]);

  const steps = setupSteps({
    status: account.status,
    storeId: account.location?.store_id ?? null,
    rulesCount: rules.length,
    invoiceMode: account.invoice_mode,
    invoiceConfirmed: invoiceOk,
    webhookSeen,
  });
  if (hidden || !showSetup(steps, account.connected_at)) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <section aria-labelledby="ml-setup-title" className="rounded-xl bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="ml-setup-title" className="text-sm font-semibold">
            Puesta en marcha · {done} de {steps.length}
          </h2>
          <p className="text-xs text-muted-foreground">Dejá esto listo una vez y el resto funciona solo.</p>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Ocultar la puesta en marcha"
          onClick={() => {
            writeFlag(KEY(account.id));
            setHidden(true);
          }}
        >
          <X size={16} />
        </button>
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => (
          <li key={s.key} className={cn("flex gap-2 rounded-lg px-3 py-2", s.done ? "bg-muted/50" : "bg-muted")}>
            {s.done ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
            ) : (
              <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", s.done && "text-muted-foreground")}>
                {s.label}
                <span className="sr-only">{s.done ? " (listo)" : " (pendiente)"}</span>
              </p>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
              {!s.done && s.key !== "topics" && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onGo(TARGET[s.key])}>
                    Configurar
                  </Button>
                  {s.key === "invoice" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => {
                        writeFlag(INVOICE_KEY(account.id));
                        setInvoiceOk(true);
                      }}
                    >
                      Facturo a mano
                    </Button>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
