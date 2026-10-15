"use client";

import { useState } from "react";
import { AlertTriangle, Info, SearchCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { PadronResult } from "@/components/arca/PadronResult";
import { cuitFieldError, cuitReady } from "@/lib/arca/certUpload";
import { padronErrorMessage, type PadronPersona } from "@/lib/customers/padron";
import { conditionLabel } from "@/lib/billing/letter";
import { inferLetter } from "@/lib/tax/comprobante";
import { useInternalPadronMutations } from "@/modules/padron/hooks";
import type { PadronInternal, PadronLookup } from "@/modules/padron/api";

const fmtWhen = (iso: string) =>
  new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

/** Qué factura le emitiría NinjaSoft y, de ejemplo, un negocio RI o monotributista. */
export function LetterHint({ persona, issuerCondition }: { persona: PadronPersona; issuerCondition: string | null }) {
  const own = issuerCondition ? inferLetter(issuerCondition, persona.iva_condition) : null;
  const ri = inferLetter("responsable_inscripto", persona.iva_condition);
  const mono = inferLetter("monotributo", persona.iva_condition);
  return (
    <div className="space-y-1.5 rounded-lg bg-background p-3">
      {own ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">NinjaSoft ({conditionLabel(issuerCondition).toLowerCase()}) le emitiría</span>
          <Badge tone="info">Factura {own}</Badge>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Cargá la condición frente al IVA de NinjaSoft en Plataforma › ARCA para ver qué factura le emitiría.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        De ejemplo: un negocio responsable inscripto le emitiría Factura {ri ?? "pendiente"}; uno monotributista, Factura {mono ?? "pendiente"}.
      </p>
    </div>
  );
}

// Pestaña "Probar con un CUIT": consulta ARCA con el certificado de la
// plataforma, sin cache y aunque el padrón esté apagado (Edge arca_padron ·
// internal_test). No crea ni modifica clientes.
export function PadronTestTab({
  cfg,
  issuerCondition,
}: {
  cfg: PadronInternal["config"] | undefined;
  issuerCondition: string | null;
}) {
  const m = useInternalPadronMutations();
  const [cuit, setCuit] = useState("");
  const [result, setResult] = useState<PadronLookup | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const err = cuitFieldError(cuit);
  const ready = cuitReady(cuit);

  const run = async () => {
    if (!ready) return;
    setResult(null);
    setFailure(null);
    try {
      setResult(await m.test.mutateAsync(cuit.replace(/\D/g, "")));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "No se pudo consultar ARCA.");
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Consulta el padrón de ARCA con el certificado de NinjaSoft, sin usar lo guardado y aunque el padrón esté apagado.
        No crea ni modifica clientes.
      </p>

      {cfg && cfg.environment !== "produccion" && (
        <Callout tone="warning" icon={Info} title="El padrón todavía apunta a homologación">
          Guardá la pestaña Configuración para pasarlo a producción; mientras tanto la prueba usa homologación.
        </Callout>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="padron-test-cuit" className="block text-sm font-medium text-muted-foreground">
          CUIT a consultar
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <Input
              id="padron-test-cuit"
              inputMode="numeric"
              autoComplete="off"
              placeholder="30-12345678-9"
              maxLength={13}
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              error={err ?? undefined}
            />
          </div>
          <Button type="submit" loading={m.test.isPending} disabled={!ready} className="w-full sm:w-auto">
            <SearchCheck size={16} aria-hidden /> Consultar
          </Button>
        </div>
        {cfg?.last_test_at && (
          <p className="text-xs text-muted-foreground">
            Última prueba: {fmtWhen(cfg.last_test_at)}, {cfg.last_test_ok ? "OK" : "con error"}
            {cfg.last_test_message ? ` (${cfg.last_test_message})` : ""}.
          </p>
        )}
      </form>

      <div aria-live="polite">
        {m.test.isPending && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-4" aria-busy="true" aria-label="Consultando ARCA">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {result?.ok && result.status === "ok" && (
          <PadronResult
            persona={result.persona}
            fetchedAt={result.fetched_at}
            extra={<LetterHint persona={result.persona} issuerCondition={issuerCondition} />}
          />
        )}
        {result?.ok && result.status === "no_encontrado" && (
          <Callout tone="info" icon={Info} title="La conexión anda, pero ARCA no tiene esa CUIT">
            {result.message ? `ARCA respondió: ${result.message}` : "Revisá el número."}
          </Callout>
        )}
        {result && !result.ok && (
          <Callout tone="danger" icon={AlertTriangle} title="La prueba falló">
            {result.message ?? padronErrorMessage(result.error, { reason: result.reason, scope: result.scope })}
            {result.code ? ` (código ${result.code})` : ""}
            {result.error === "arca_auth_failed" && (
              <span className="mt-1 block">
                Revisá que el certificado tenga asociado el servicio ws_sr_constancia_inscripcion en ARCA (pestaña Generar certificado, paso 4).
              </span>
            )}
          </Callout>
        )}
        {failure && (
          <Callout tone="danger" icon={AlertTriangle} title="No se pudo consultar">
            {failure}
          </Callout>
        )}
      </div>
    </div>
  );
}
PadronTestTab.displayName = "PadronTestTab";
