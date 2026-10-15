"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, KeyRound, ListChecks, SearchCheck, Store, XCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { InfoHint } from "@/components/ui/InfoHint";
import { cn } from "@/lib/utils/cn";
import { isValidCuit, type EmitterCondition } from "@/lib/tax/catalog";
import {
  compareConditionWithPadron,
  conditionLabel,
  letterGuide,
  letterGuideSummary,
  type ConditionCheck,
} from "@/lib/billing/letter";
import { ARCA_LINKS, connectionFor, envConnected, formatFiscalDate, type ArcaEnv, type WizardStepKey } from "@/lib/arca/labels";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import type { ArcaConfig } from "@/modules/arca/api";
import type { PadronPersona } from "@/modules/fiscalProfile/api";
import { usePadronLookup } from "@/modules/fiscalProfile/hooks";
import { taxErrorMessage } from "@/modules/tax/api";
import { useSaveTaxSettings } from "@/modules/tax/hooks";
import { useToast } from "@/components/ui/Toast";
import { Dot, ExtLink } from "./shared";

// Guía "qué facturas vas a emitir y qué necesitás de ARCA" (ADR-125). Todo lo
// que dice de letras sale de lib/billing/letter.ts (inferLetter); el estado de
// cada requisito, de la configuración real de ARCA.

/** Consulta pública de la constancia de inscripción (no pide clave fiscal). */
const CONSTANCIA_URL = "https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do";

/** Letra grande, en un cuadrado neutro (rounded-md, sin color de estado). */
export function LetterTile({ letter, className }: { letter: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted font-display text-base font-bold text-foreground",
        className,
      )}
      aria-label={`Factura ${letter}`}
    >
      {letter}
    </span>
  );
}
LetterTile.displayName = "LetterTile";

/** "A quién le vendés → Letra", en vivo según la condición elegida. */
export function LetterGuide({
  condition,
  issuesM = false,
  className,
}: {
  condition: string | null | undefined;
  issuesM?: boolean;
  className?: string;
}) {
  const rows = letterGuide(condition, { issuesM });
  const ri = condition === "responsable_inscripto";
  return (
    <div className={cn("space-y-3 text-sm", className)}>
      <p className="font-medium text-foreground">{letterGuideSummary(condition, { issuesM })}</p>
      {condition && (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-left">
            <caption className="sr-only">Qué factura le hacés a cada cliente</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  A quién le vendés
                </th>
                <th scope="col" className="w-20 px-3 py-2 text-center font-medium">
                  Factura
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-3 py-2">
                    <p className="font-medium text-foreground">{r.who}</p>
                    <p className="text-xs text-muted-foreground">{r.example}</p>
                  </td>
                  <td className="px-3 py-2 text-center">{r.letter && <LetterTile letter={r.letter} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>Las notas de crédito y de débito llevan la misma letra que la factura que corrigen.</li>
        {ri && (
          <li>
            Si ARCA te indicó emitir M, activá &quot;Emitís comprobantes M&quot; en Impuestos: las A pasan a ser M.
          </li>
        )}
        <li>Las facturas de exportación (E) todavía no se emiten desde NinjaSoft.</li>
      </ul>
    </div>
  );
}
LetterGuide.displayName = "LetterGuide";

/** Aclaración corta: la letra no la define el certificado. */
export function CertificateIsNotTheLetter({ className }: { className?: string }) {
  return (
    <Callout tone="neutral" icon={KeyRound} title="El certificado no define la letra" className={className}>
      La letra sale de tu condición frente al IVA en ARCA. El certificado sólo autoriza a NinjaSoft a pedirle a ARCA cada
      factura en tu nombre. Si la condición que cargás acá no es la misma que tenés en ARCA, ARCA rechaza las facturas.
    </Callout>
  );
}
CertificateIsNotTheLetter.displayName = "CertificateIsNotTheLetter";

type LookupState =
  | { kind: "idle" }
  | { kind: "result"; check: ConditionCheck; persona: PadronPersona }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "error"; text: string };

const LOOKUP_ERROR: Record<string, string> = {
  invalid_cuit: "El CUIT no es válido.",
  rate_limited: "Hiciste muchas consultas seguidas. Probá de nuevo en un rato.",
  padron_error: "ARCA no respondió. Probá de nuevo en un rato.",
};

/**
 * Compara la condición elegida con la del padrón de ARCA (consulta de la
 * plataforma, la misma de Datos de facturación). Si difiere, ofrece usar la de
 * ARCA. Sin padrón disponible, explica cómo verlo a mano.
 */
export function PadronConditionCheck({
  cuit,
  condition,
  canWrite,
  onUseArca,
  fixing = false,
}: {
  cuit: string | null | undefined;
  condition: string | null | undefined;
  canWrite: boolean;
  /** Guarda la condición que informa ARCA. Sin esto, se muestra el link a Impuestos. */
  onUseArca?: (arcaCondition: string) => void;
  fixing?: boolean;
}) {
  const lookup = usePadronLookup();
  const [state, setState] = useState<LookupState>({ kind: "idle" });
  const validCuit = Boolean(cuit && isValidCuit(cuit));

  const run = async () => {
    if (!cuit) return;
    try {
      const r = await lookup.mutateAsync({ cuit });
      if (r.ok && r.status === "ok") {
        setState({ kind: "result", persona: r.persona, check: compareConditionWithPadron(condition, r.persona.iva_condition) });
      } else if (r.ok) {
        setState({ kind: "not_found" });
      } else if (r.error === "platform_not_configured") {
        setState({ kind: "unavailable" });
      } else {
        setState({ kind: "error", text: LOOKUP_ERROR[r.error] ?? r.message ?? "No pudimos consultar a ARCA." });
      }
    } catch {
      setState({ kind: "error", text: "No pudimos consultar a ARCA." });
    }
  };

  // La condición elegida puede cambiar después de consultar: se recompara en vivo.
  const check = state.kind === "result" ? compareConditionWithPadron(condition, state.persona.iva_condition) : null;
  const canFix = check?.status === "mismatch" && canWrite;

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={run} loading={lookup.isPending} disabled={!validCuit || !canWrite}>
          <SearchCheck size={15} /> Verificar mi condición en ARCA
        </Button>
        {!validCuit && <span className="text-xs text-muted-foreground">Cargá un CUIT válido para verificar.</span>}
      </div>

      {check?.status === "match" && state.kind === "result" && (
        <Callout tone="success" icon={CheckCircle2} title={`ARCA confirma: ${conditionLabel(state.persona.iva_condition)}`}>
          Tu condición coincide con la de ARCA.
        </Callout>
      )}
      {check?.status === "mismatch" && (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          title={`En ARCA figurás como ${conditionLabel(check.arca)}`}
          actions={
            canFix && onUseArca ? (
              <Button size="sm" onClick={() => onUseArca(check.arca)} loading={fixing}>
                Usar {conditionLabel(check.arca)}
              </Button>
            ) : (
              <Link href={"/configuracion?seccion=impuestos" as never}>
                <Button size="sm" variant="secondary">
                  Corregir en Impuestos
                </Button>
              </Link>
            )
          }
        >
          Acá tenés {condition ? conditionLabel(condition) : "la condición sin cargar"}. Si no coinciden, ARCA rechaza las
          facturas. Si cambiaste de categoría hace poco, ARCA puede tardar unos días en actualizarse: ante la duda,
          consultalo con tu contador.
        </Callout>
      )}
      {check?.status === "not_registered" && (
        <Callout tone="danger" icon={XCircle} title="ARCA no te tiene inscripto en IVA ni en monotributo">
          Así no se pueden emitir facturas electrónicas. Primero hay que inscribirse (lo hace tu contador o vos desde ARCA).
        </Callout>
      )}
      {state.kind === "not_found" && (
        <Callout tone="warning" icon={AlertTriangle} title="ARCA no encontró ese CUIT">
          Revisá que el CUIT esté bien escrito.
        </Callout>
      )}
      {state.kind === "unavailable" && (
        <Callout tone="info" title="La verificación automática todavía no está disponible">
          Podés verlo vos en un minuto: entrá a la <ExtLink href={CONSTANCIA_URL}>constancia de inscripción</ExtLink>,
          escribí tu CUIT y fijate qué dice en IVA o Monotributo. Tiene que ser lo mismo que elegiste acá.
        </Callout>
      )}
      {state.kind === "error" && (
        <Callout tone="danger" icon={XCircle} title="No se pudo verificar">
          {state.text}
        </Callout>
      )}
    </div>
  );
}
PadronConditionCheck.displayName = "PadronConditionCheck";

type ReqState = "ok" | "pending" | "partial";

function ReqRow({
  icon: Icon,
  title,
  state,
  status,
  how,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  state: ReqState;
  status: React.ReactNode;
  how: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{title}</p>
            <Badge tone={state === "ok" ? "success" : state === "partial" ? "info" : "warning"}>
              {state === "ok" ? "Listo" : state === "partial" ? "A medias" : "Falta"}
            </Badge>
          </div>
          <p className="mt-0.5 flex items-center gap-2 text-muted-foreground">
            <Dot tone={state === "ok" ? "success" : state === "partial" ? "info" : "warning"} />
            {status}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{how}</p>
          {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
        </div>
      </div>
      {children && <div className="sm:pl-[30px]">{children}</div>}
    </li>
  );
}

/**
 * Checklist de lo que pide ARCA, con el estado que ya conoce NinjaSoft:
 * condición frente al IVA, punto de venta Web Services, certificado (o
 * delegación) y autorización del servicio de factura electrónica.
 */
export function ArcaRequirements({
  config,
  canWrite,
  onGo,
}: {
  config: ArcaConfig;
  canWrite: boolean;
  /** Abre el paso del asistente que resuelve el requisito. */
  onGo?: (step: WizardStepKey) => void;
}) {
  const qc = useQueryClient();
  const saveTax = useSaveTaxSettings();
  const { toast } = useToast();
  const s = config.settings;
  const env: ArcaEnv = s?.environment ?? "homologacion";
  const deleg = s?.auth_mode === "delegado";

  // 1. Condición
  const cond = config.emitter.iva_condition;
  const condOk = Boolean(config.emitter.cuit && cond);

  // 2. Punto de venta
  const stores = config.stores;
  const withPos = stores.filter((x) => x.afip_pos_number != null).length;
  const posItem = config.checklist.items.find((i) => i.key === "puntos_de_venta");
  const posVerified = env === "produccion" && Boolean(posItem?.ok);
  const posState: ReqState = stores.length > 0 && withPos === stores.length ? (env === "produccion" && !posVerified ? "partial" : "ok") : withPos > 0 ? "partial" : "pending";

  // 3. Certificado o delegación
  const cert = config.certificates.find((c) => c.environment === env && c.status === "active");
  const certState: ReqState = deleg || cert ? "ok" : "pending";

  // 4. Autorización del servicio: última prueba guardada DE ESTE ambiente
  // (ADR-153: la prueba de producción ya no pisa la de homologación).
  const conn = connectionFor(s, env);
  const connected = envConnected(config, env);
  const tested = conn != null;
  const authState: ReqState = connected ? "ok" : "pending";
  const connHelp = conn && !conn.ok ? humanError(conn.code, conn.message) : null;

  const adoptArca = async (arca: string) => {
    try {
      await saveTax.mutateAsync({
        iva_condition: arca as EmitterCondition,
        ...(arca !== "responsable_inscripto" ? { issues_cbte_m: false } : {}),
      });
      await qc.invalidateQueries({ queryKey: ["arca"] });
      toast({ title: `Condición actualizada: ${conditionLabel(arca)}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se guardó", description: taxErrorMessage(e), variant: "error" });
    }
  };

  const envName = env === "produccion" ? "real" : "de prueba";

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ListChecks size={18} className="text-muted-foreground" aria-hidden />
        <p className="font-semibold">Qué necesitás de ARCA</p>
        <InfoHint title="Qué necesitás de ARCA" label="Qué pide ARCA">
          Tres cosas: que tu condición frente al IVA en NinjaSoft sea la misma que en ARCA, un punto de venta del tipo
          Web Services y el certificado (o la delegación) autorizado para Factura Electrónica.
        </InfoHint>
      </div>
      <ul className="divide-y divide-border text-sm">
        <ReqRow
          icon={FileText}
          title="Tu condición frente al IVA, igual que en ARCA"
          state={condOk ? "ok" : "pending"}
          status={
            condOk ? (
              <>
                {conditionLabel(cond)} · CUIT <span className="font-mono">{config.emitter.cuit}</span>
              </>
            ) : (
              "Falta cargar el CUIT y la condición."
            )
          }
          how="Es lo que define la letra de tus facturas. Se carga en Configuración > Impuestos."
          action={
            <Link href={"/configuracion?seccion=impuestos" as never}>
              <Button size="sm" variant={condOk ? "ghost" : "primary"}>
                {condOk ? "Cambiar" : "Cargar CUIT y condición"}
              </Button>
            </Link>
          }
        >
          {condOk && (
            <PadronConditionCheck
              cuit={config.emitter.cuit}
              condition={cond}
              canWrite={canWrite}
              onUseArca={(a) => void adoptArca(a)}
              fixing={saveTax.isPending}
            />
          )}
        </ReqRow>

        <ReqRow
          icon={Store}
          title="Punto de venta para Web Services"
          state={posState}
          status={
            stores.length === 0
              ? "Todavía no hay sucursales."
              : posVerified
                ? "ARCA confirmó los puntos de venta de tus sucursales."
                : `Sucursales con punto de venta: ${withPos} de ${stores.length}${env === "produccion" && withPos === stores.length ? " (falta verificarlos en ARCA)" : ""}.`
          }
          how={
            <>
              En ARCA, Administración de puntos de venta y domicilios, dalo de alta como &quot;Factura Electrónica -
              Monotributo - Web Services&quot; o &quot;RECE para aplicativo y web services&quot;. El de &quot;Comprobantes
              en línea&quot; no sirve para NinjaSoft.
            </>
          }
          action={
            onGo && (
              <Button size="sm" variant="secondary" onClick={() => onGo("punto_venta")}>
                Ver cómo y cargarlo
              </Button>
            )
          }
        />

        <ReqRow
          icon={KeyRound}
          title={deleg ? "Delegación en NinjaSoft" : "Certificado digital"}
          state={certState}
          status={
            deleg
              ? "Elegiste delegar: no necesitás certificado propio."
              : cert
                ? `Certificado ${envName} cargado, vence el ${formatFiscalDate(cert.not_after)}.`
                : `Falta el certificado ${envName}.`
          }
          how={
            deleg
              ? "Autorizás a NinjaSoft en ARCA, desde el Administrador de Relaciones de Clave Fiscal."
              : "NinjaSoft genera el pedido; vos lo pegás en ARCA y traés el certificado. Tarda unos minutos."
          }
          action={
            onGo &&
            !deleg && (
              <Button size="sm" variant="secondary" onClick={() => onGo(env === "produccion" ? "produccion" : "certificado")}>
                {cert ? "Ver certificado" : "Cargar certificado"}
              </Button>
            )
          }
        />

        <ReqRow
          icon={CheckCircle2}
          title="Autorizado para Factura Electrónica"
          state={authState}
          status={
            connected
              ? conn?.at
                ? `Conexión ${envName} probada el ${formatFiscalDate(conn.at)}.`
                : `ARCA ya aprobó facturas ${envName}.`
              : tested
                ? `La última prueba ${envName} falló: ${connHelp?.title ?? "revisá la autorización"}.`
                : "Todavía no probaste la conexión."
          }
          how={
            <>
              En ARCA hay que asociar el {deleg ? "servicio" : "certificado"} a &quot;Facturación Electrónica&quot;
              (WSFE).{" "}
              <ExtLink href={ARCA_LINKS.login}>Entrar a ARCA</ExtLink>
            </>
          }
          action={
            onGo && (
              <Button size="sm" variant="secondary" onClick={() => onGo("autorizar")}>
                Autorizar y probar
              </Button>
            )
          }
        />
      </ul>
    </div>
  );
}
ArcaRequirements.displayName = "ArcaRequirements";
