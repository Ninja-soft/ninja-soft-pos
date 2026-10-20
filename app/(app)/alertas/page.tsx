"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BellRing, Lock, Settings } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { AlertItemsList } from "@/components/alerts/AlertItemsList";
import { ALERT_CATALOG, alertErrorMessage, isAlertKind } from "@/lib/alerts/catalog";
import { useFeature } from "@/modules/saas/gating";
import { useAlertEvents, type AlertEmailStatus, type AlertEvent } from "@/modules/alerts/api";

const EMAIL_LABEL: Record<AlertEmailStatus, { label: string; tone: BadgeTone } | null> = {
  none: null,
  pending: { label: "Mail pendiente", tone: "neutral" },
  sent: { label: "Mail enviado", tone: "success" },
  failed: { label: "Mail con error", tone: "danger" },
  skipped: { label: "Mail no enviado", tone: "warning" },
};

const EMAIL_REASON: Record<string, string> = {
  tenant_email_not_configured: "El negocio no tiene email configurado (Configuración › Email).",
  no_recipients: "Nadie de la audiencia tiene email.",
  expired: "Quedó pendiente más de 2 días.",
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

// Historial de alertas programadas (F24 · H162, ADR-176). Lo abre la campana
// (?evento=) y la configuración (?regla=). Ver: reports.view (servidor).
export default function AlertasPage() {
  return (
    <Suspense fallback={<SpinnerBlock className="py-16" />}>
      <AlertasHistory />
    </Suspense>
  );
}

function AlertasHistory() {
  const params = useSearchParams();
  const eventId = params.get("evento");
  const ruleId = params.get("regla");
  const enabled = useFeature("alertas_programadas");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [pages, setPages] = useState<(string | null)[]>([null]);

  const header = (
    <PageHeader
      eyebrow="Gestión"
      title="Alertas"
      icon={BellRing}
      description="Lo que encontró cada alerta programada, con los casos de cada corrida y si se avisó por mail."
      actions={
        <Link href="/configuracion?seccion=alertas" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <Settings size={15} aria-hidden /> Configurar
        </Link>
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Las alertas programadas no están incluidas en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Recibí por la campana y por mail el stock bajo, las cajas sin cerrar, los cheques por vencer y más, sólo con los casos nuevos.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="alertas_programadas"
            featureLabel="Alertas programadas"
          />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      {(eventId || ruleId) && (
        <div className="mt-4">
          <Link href="/alertas" className="text-sm font-medium text-muted-foreground hover:underline">
            Ver todas las alertas
          </Link>
        </div>
      )}
      <div className="mt-4 space-y-3">
        {pages.map((before, i) => (
          <EventsPage
            key={before ?? "first"}
            ruleId={ruleId}
            eventId={eventId}
            before={before}
            ready={enabled === true}
            isLast={i === pages.length - 1}
            expandAll={Boolean(eventId)}
            onMore={(next) => setPages((p) => [...p, next])}
          />
        ))}
      </div>
    </PageContainer>
  );
}

function EventsPage({
  ruleId,
  eventId,
  before,
  ready,
  isLast,
  expandAll,
  onMore,
}: {
  ruleId: string | null;
  eventId: string | null;
  before: string | null;
  ready: boolean;
  isLast: boolean;
  expandAll: boolean;
  onMore: (before: string) => void;
}) {
  const q = useAlertEvents({ ruleId, eventId, before }, ready);
  if (!ready || q.isLoading) return <SpinnerBlock className="py-10" />;
  if (q.error) {
    return <p className="rounded-lg bg-warning/10 p-4 text-sm">{alertErrorMessage(q.error)}</p>;
  }
  const events = q.data ?? [];
  if (events.length === 0 && before === null) {
    return (
      <EmptyState
        icon={BellRing}
        title="Todavía no hay alertas"
        description="Encendé alguna en Configuración › Alertas: cuando corra, lo que encuentre aparece acá."
      />
    );
  }
  return (
    <>
      {events.map((ev) => (
        <EventCard key={ev.id} ev={ev} defaultOpen={expandAll} />
      ))}
      {isLast && !eventId && events.length >= 30 && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => onMore(events[events.length - 1]!.ran_at)}>
            Ver más
          </Button>
        </div>
      )}
    </>
  );
}

function EventCard({ ev, defaultOpen }: { ev: AlertEvent; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const def = isAlertKind(ev.kind) ? ALERT_CATALOG[ev.kind] : null;
  const email = EMAIL_LABEL[ev.email_status];
  const shown = ev.only_new ? ev.items.filter((i) => i.new !== false) : ev.items;
  return (
    <Card className="p-4">
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="min-w-0">
          <p className="font-semibold">
            {def?.label ?? ev.kind}
            {ev.store_name ? <span className="font-normal text-muted-foreground"> · {ev.store_name}</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{fmtWhen(ev.ran_at)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ev.error ? (
              <Badge tone="danger">No pudo correr</Badge>
            ) : (
              <>
                <Badge tone={ev.hits > 0 ? "warning" : "neutral"}>
                  {ev.hits} {ev.hits === 1 ? "caso" : "casos"}
                </Badge>
                {ev.only_new && <Badge tone={ev.new_hits > 0 ? "info" : "neutral"}>{ev.new_hits} nuevos</Badge>}
                {ev.notified && <Badge tone="neutral">Avisado</Badge>}
                {email && <Badge tone={email.tone}>{email.label}</Badge>}
              </>
            )}
          </div>
        </div>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{open ? "Ocultar" : "Ver"}</span>
      </button>
      {open && (
        <div className="mt-3 border-t border-border pt-2">
          {ev.error ? (
            <p className="text-sm text-muted-foreground">{ev.error}</p>
          ) : (
            <>
              <AlertItemsList items={ev.items} total={ev.hits} showNew={ev.only_new} empty="No encontró casos." />
              {ev.only_new && shown.length === 0 && ev.hits > 0 && (
                <p className="pt-1 text-xs text-muted-foreground">Nada nuevo: estos casos ya se habían avisado.</p>
              )}
            </>
          )}
          {ev.email_status === "skipped" || ev.email_status === "failed" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {EMAIL_REASON[ev.email_error ?? ""] ?? ev.email_error ?? ""}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
