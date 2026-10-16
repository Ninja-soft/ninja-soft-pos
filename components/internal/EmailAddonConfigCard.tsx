"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Globe, Layers, Mail, Plus, RefreshCw, Send, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import {
  DOMAIN_STATUS_LABEL,
  OVERAGE_POLICY_LABEL,
  dnsHostLabel,
  senderAddress,
  usageLevel,
  type DnsRecord,
} from "@/lib/billing/emailAddon";
import { formatDay } from "@/lib/billing/ledger";
import { formatCurrency, formatInt } from "@/lib/utils/format";
import {
  EMAIL_ADMIN_ERROR,
  deleteEmailAddonTier,
  emailAddonAdmin,
  saveEmailAddonSettings,
  saveEmailAddonTier,
  type EmailAdminResponse,
  type InternalEmailAddonState,
  type InternalEmailAddonTier,
} from "@/modules/saas/emailAddon";

// Configuración del complemento "Email con dominio NinjaSoft" (ADR-156) en
// Plataforma › Complementos: API key de Resend (probada antes de guardar),
// dominio remitente verificado en Resend con los registros DNS, formato del
// remitente, escalones (emails por mes y precio) y política al pasar el cupo.

const QK = ["internal", "email-addon"];

function errText(code: string | undefined, detail?: string): string {
  const base = (code && EMAIL_ADMIN_ERROR[code]) || "No se pudo completar.";
  return detail && code === "resend_error" ? `${base} (${detail})` : base;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return <Badge tone={ok ? "success" : "neutral"}>{label}</Badge>;
}

function Section({ icon: Icon, title, children }: { icon: typeof Mail; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-0 first:pt-0">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon size={16} className="text-muted-foreground" aria-hidden /> {title}
      </div>
      {children}
    </section>
  );
}

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* sin portapapeles */
        }
      }}
      aria-label="Copiar"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function DnsTable({ records, domain }: { records: DnsRecord[]; domain: string }) {
  if (records.length === 0) return null;
  return (
    <div className="space-y-2">
      {records.map((r, i) => (
        <div key={`${r.record}-${i}`} className="rounded-lg bg-muted/50 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{r.type}</Badge>
            <span className="font-medium text-foreground">{r.record}</span>
            <Badge tone={r.status === "verified" ? "success" : r.status === "failed" ? "danger" : "warning"}>
              {DOMAIN_STATUS_LABEL[r.status] ?? r.status}
            </Badge>
            {r.priority != null && <span className="text-muted-foreground">Prioridad {r.priority}</span>}
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-[88px_1fr]">
            <span className="text-muted-foreground">Nombre</span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-foreground">
              <span className="break-all">{dnsHostLabel(r.name, domain)}</span>
              <CopyValue value={dnsHostLabel(r.name, domain)} />
            </span>
            <span className="text-muted-foreground">Valor</span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-foreground">
              <span className="break-all">{r.value}</span>
              <CopyValue value={r.value} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TierRow({
  tier,
  onSaved,
}: {
  tier: InternalEmailAddonTier | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [label, setLabel] = useState(tier?.label ?? "");
  const [quota, setQuota] = useState(tier ? String(tier.quota) : "");
  const [price, setPrice] = useState(tier ? String(tier.price) : "");
  const [active, setActive] = useState(tier?.is_active ?? true);
  const dirty =
    !tier ||
    label !== tier.label ||
    quota !== String(tier.quota) ||
    price !== String(tier.price) ||
    active !== tier.is_active;

  const save = useMutation({
    mutationFn: () =>
      saveEmailAddonTier({
        id: tier?.id ?? null,
        label: label.trim(),
        quota: Number(quota.replace(/\D/g, "")),
        price: Number(price.replace(",", ".")),
        sort: tier?.sort ?? 0,
        active,
      }),
    onSuccess: () => {
      toast({ title: tier ? "Escalón guardado" : "Escalón agregado", variant: "success" });
      if (!tier) {
        setLabel("");
        setQuota("");
        setPrice("");
      }
      onSaved();
    },
    onError: (e: Error) => toast({ title: errText(e.message), variant: "error" }),
  });
  const del = useMutation({
    mutationFn: () => deleteEmailAddonTier(tier!.id),
    onSuccess: () => {
      toast({ title: "Escalón eliminado", variant: "success" });
      onSaved();
    },
    onError: (e: Error) => toast({ title: errText(e.message), variant: "error" }),
  });

  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_120px_140px]">
        <Input label="Nombre" placeholder="Inicial" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input
          label="Emails por mes"
          inputMode="numeric"
          placeholder="1000"
          value={quota}
          onChange={(e) => setQuota(e.target.value.replace(/\D/g, ""))}
        />
        <Input
          label="Precio por mes"
          inputMode="decimal"
          placeholder="5000"
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ""))}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={active} onCheckedChange={setActive} label="A la venta" /> A la venta
          {tier && tier.tenants > 0 && <span>· {formatInt(tier.tenants)} negocios</span>}
        </label>
        <div className="flex gap-2">
          {tier && (
            <Button variant="ghost" size="sm" loading={del.isPending} onClick={() => del.mutate()} aria-label="Eliminar escalón">
              <Trash2 size={15} />
            </Button>
          )}
          <Button
            size="sm"
            variant={tier ? "secondary" : "primary"}
            disabled={!dirty || !label.trim() || !quota || !price}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {tier ? "Guardar" : (
              <>
                <Plus size={15} /> Agregar
              </>
            )}
          </Button>
        </div>
      </div>
      {tier && tier.tenants > 0 && dirty && (
        <p className="mt-2 text-xs text-muted-foreground">
          El precio y el cupo nuevos rigen para las altas nuevas. Los negocios que ya lo tienen siguen con lo que contrataron.
        </p>
      )}
    </div>
  );
}

export function EmailAddonConfigCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery({
    queryKey: QK,
    queryFn: () => emailAddonAdmin({ action: "status" }),
  });
  const state: InternalEmailAddonState | undefined = data?.state;
  const s = state?.settings;

  const [apiKey, setApiKey] = useState("");
  const [domain, setDomain] = useState("soft.ninja");
  const [senderMode, setSenderMode] = useState<"business" | "fixed">("business");
  const [fixedLocal, setFixedLocal] = useState("notificaciones");
  const [policy, setPolicy] = useState<"block" | "warn" | "charge">("block");
  const [blockSize, setBlockSize] = useState("1000");
  const [blockPrice, setBlockPrice] = useState("");
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    if (!s) return;
    setDomain(s.domain || "soft.ninja");
    setSenderMode(s.sender_mode);
    setFixedLocal(s.fixed_local);
    setPolicy(s.overage_policy);
    setBlockSize(String(s.overage_block_size));
    setBlockPrice(s.overage_block_price > 0 ? String(s.overage_block_price) : "");
  }, [s]);

  function apply(res: EmailAdminResponse, okMsg: string) {
    if (res.error) {
      toast({ title: errText(res.error, res.detail), variant: "error" });
      return false;
    }
    qc.setQueryData(QK, res);
    toast({ title: okMsg, variant: "success" });
    return true;
  }

  const saveKey = useMutation({
    mutationFn: (system: boolean) =>
      emailAddonAdmin(system ? { action: "use_system_key" } : { action: "save_key", api_key: apiKey.trim() }),
    onSuccess: (res) => {
      if (apply(res, "API key probada y guardada")) setApiKey("");
    },
  });
  const checkDomain = useMutation({
    mutationFn: (create: boolean) => emailAddonAdmin({ action: "check_domain", domain: domain.trim().toLowerCase(), create }),
    onSuccess: (res) => {
      if (res.found === false) {
        qc.setQueryData(QK, res);
        toast({ title: "El dominio no está cargado en Resend. Podés darlo de alta desde acá.", variant: "warning" });
        return;
      }
      apply(res, res.created ? "Dominio dado de alta en Resend" : "Estado del dominio actualizado");
    },
  });
  const saveSettings = useMutation({
    mutationFn: (p: Record<string, unknown>) => saveEmailAddonSettings(p),
    onSuccess: (fresh) => {
      qc.setQueryData(QK, { ...(data ?? {}), ok: true, state: fresh });
      toast({ title: "Configuración guardada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["internal", "addon-catalog"] });
    },
    onError: (e: Error) => toast({ title: errText(e.message), variant: "error" }),
  });
  const sendTest = useMutation({
    mutationFn: () => emailAddonAdmin({ action: "send_test", to: testTo.trim() }),
    onSuccess: (res) => {
      if (res.error) toast({ title: errText(res.error, res.detail), variant: "error" });
      else toast({ title: `Email de prueba enviado a ${testTo.trim()}`, variant: "success" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (data?.error || !state || !s) {
    return (
      <Callout tone="danger" icon={TriangleAlert}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{errText(data?.error ?? "network")}</span>
          <Button size="sm" variant="secondary" onClick={() => refetch()}>
            Reintentar
          </Button>
        </div>
      </Callout>
    );
  }

  const verified = s.domain_status === "verified";
  const hasKey = Boolean(s.key_source);
  const activeTiers = state.tiers.filter((t) => t.is_active);
  const canSell = verified && hasKey && activeTiers.length > 0;
  const policyDirty =
    policy !== s.overage_policy ||
    Number(blockSize) !== s.overage_block_size ||
    Number(blockPrice || 0) !== Number(s.overage_block_price);
  const senderDirty = senderMode !== s.sender_mode || fixedLocal !== s.fixed_local;
  const example = senderAddress({ mode: senderMode, fixedLocal, domain: s.domain, slug: "kiosco-don-pepe" });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <StatusBadge ok={hasKey} label={hasKey ? "API key lista" : "Sin API key"} />
        <StatusBadge ok={verified} label={verified ? `${s.domain} verificado` : "Dominio sin verificar"} />
        <StatusBadge ok={activeTiers.length > 0} label={`${formatInt(activeTiers.length)} escalones a la venta`} />
        <StatusBadge ok={state.is_active} label={state.is_active ? "Disponible para los negocios" : "No disponible"} />
      </div>

      <Section icon={KeyRound} title="API key de Resend de la plataforma">
        <p className="text-xs text-muted-foreground">
          Se prueba contra Resend antes de guardarla y queda en los secretos de la plataforma: nunca vuelve al navegador.
          Tiene que ser de acceso completo (Full access) para poder verificar el dominio.
        </p>
        <CredentialInput
          label="API key"
          secret
          mono
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          configured={hasKey}
          configuredLabel={s.key_source === "system" ? "La de los emails del sistema" : s.key_hint ? `Guardada ${s.key_hint}` : undefined}
          placeholder={hasKey ? "Dejala vacía para mantenerla" : "re_xxxxxxxxxxxxxxxxxxxxxxxx"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!apiKey.trim()} loading={saveKey.isPending && saveKey.variables === false} onClick={() => saveKey.mutate(false)}>
            Probar y guardar
          </Button>
          {data?.system_key_available && s.key_source !== "system" && (
            <Button size="sm" variant="secondary" loading={saveKey.isPending && saveKey.variables === true} onClick={() => saveKey.mutate(true)}>
              Usar la de los emails del sistema
            </Button>
          )}
        </div>
      </Section>

      <Section icon={Globe} title="Dominio remitente">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Input label="Dominio" placeholder="soft.ninja" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!hasKey} loading={checkDomain.isPending && checkDomain.variables === false} onClick={() => checkDomain.mutate(false)}>
              <RefreshCw size={15} /> Verificar
            </Button>
            {s.domain_status === "not_found" && (
              <Button size="sm" disabled={!hasKey} loading={checkDomain.isPending && checkDomain.variables === true} onClick={() => checkDomain.mutate(true)}>
                Dar de alta en Resend
              </Button>
            )}
          </div>
        </div>
        {s.domain_status && (
          <p className="text-xs text-muted-foreground">
            Estado:{" "}
            <span className="font-medium text-foreground">
              {s.domain_status === "not_found" ? "No está cargado en Resend" : DOMAIN_STATUS_LABEL[s.domain_status] ?? s.domain_status}
            </span>
            {s.domain_checked_at ? ` · revisado ${formatDay(s.domain_checked_at)}` : ""}
            {s.domain_region ? ` · región ${s.domain_region}` : ""}
          </p>
        )}
        {!verified && s.dns_records.length > 0 && (
          <Callout tone="info">
            <p className="text-sm">
              Cargá estos registros en el DNS de <b>{s.domain}</b> (donde administrás el dominio: Cloudflare, Nic.ar,
              DonWeb u otro). El nombre va tal cual en el campo “Nombre” o “Host”; si tu proveedor agrega el dominio solo,
              no lo repitas. Puede tardar desde minutos hasta 48 horas: después tocá Verificar.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>SPF (TXT y MX en el subdominio send): autoriza a Resend a enviar por el dominio.</li>
              <li>DKIM (TXT resend._domainkey): firma los emails para que no caigan en spam.</li>
              <li>DMARC (opcional, TXT _dmarc): por ejemplo v=DMARC1; p=none; para empezar a medir.</li>
            </ul>
          </Callout>
        )}
        <DnsTable records={s.dns_records} domain={s.domain} />
      </Section>

      <Section icon={Mail} title="Remitente">
        <Segmented
          aria-label="Formato del remitente"
          value={senderMode}
          onChange={setSenderMode}
          className="w-full sm:w-auto"
          options={[
            { value: "business", label: "Uno por negocio" },
            { value: "fixed", label: "Una casilla fija" },
          ]}
        />
        {senderMode === "fixed" && (
          <Input
            label="Casilla"
            value={fixedLocal}
            onChange={(e) => setFixedLocal(e.target.value.trim().toLowerCase())}
            hint="Sólo minúsculas, números, punto, guion o guion bajo."
          />
        )}
        <p className="text-xs text-muted-foreground">
          Así sale: <span className="font-mono text-foreground">Kiosco Don Pepe &lt;{example}&gt;</span>, con respuesta al
          email del negocio.
        </p>
        {senderDirty && (
          <Button size="sm" loading={saveSettings.isPending} onClick={() => saveSettings.mutate({ sender_mode: senderMode, fixed_local: fixedLocal })}>
            Guardar remitente
          </Button>
        )}
      </Section>

      <Section icon={Layers} title="Escalones">
        <p className="text-xs text-muted-foreground">
          Cada escalón es una cantidad de emails por mes y un precio mensual que se suma a la suscripción del negocio.
        </p>
        <div className="space-y-2">
          {state.tiers.map((t) => (
            <TierRow key={t.id} tier={t} onSaved={() => refetch()} />
          ))}
          <TierRow tier={null} onSaved={() => refetch()} />
        </div>
      </Section>

      <Section icon={TriangleAlert} title="Al pasar el cupo del mes">
        <Segmented
          aria-label="Política al pasar el cupo"
          value={policy}
          onChange={setPolicy}
          className="w-full sm:w-auto"
          options={(["block", "warn", "charge"] as const).map((k) => ({ value: k, label: OVERAGE_POLICY_LABEL[k]!.title }))}
        />
        <p className="text-xs text-muted-foreground">{OVERAGE_POLICY_LABEL[policy]?.desc} Siempre se avisa al dueño al 80 % y al 100 %.</p>
        {policy === "charge" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Bloque de emails" inputMode="numeric" value={blockSize} onChange={(e) => setBlockSize(e.target.value.replace(/\D/g, ""))} />
            <Input
              label="Precio por bloque"
              inputMode="decimal"
              value={blockPrice}
              onChange={(e) => setBlockPrice(e.target.value.replace(/[^\d.,]/g, ""))}
            />
          </div>
        )}
        {policyDirty && (
          <Button
            size="sm"
            loading={saveSettings.isPending}
            onClick={() =>
              saveSettings.mutate({
                overage_policy: policy,
                overage_block_size: Number(blockSize) || 1000,
                overage_block_price: blockPrice ? Number(blockPrice.replace(",", ".")) : 0,
              })
            }
          >
            Guardar política
          </Button>
        )}
      </Section>

      <Section icon={Send} title="Venta y prueba">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
          <div className="text-sm">
            <div className="font-medium text-foreground">Disponible para los negocios</div>
            <div className="text-xs text-muted-foreground">
              {canSell
                ? "Aparece en Configuración › Email del negocio con el botón para sumarlo a la suscripción."
                : "Hace falta la API key, el dominio verificado y al menos un escalón a la venta."}
            </div>
          </div>
          <Switch
            checked={state.is_active}
            disabled={!canSell && !state.is_active}
            onCheckedChange={(v) => saveSettings.mutate({ is_active: v })}
            label="Disponible para los negocios"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Input label="Mandar una prueba a" type="email" placeholder="vos@ejemplo.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <Button size="sm" variant="secondary" disabled={!verified || !testTo.trim()} loading={sendTest.isPending} onClick={() => sendTest.mutate()}>
            <Send size={15} /> Enviar prueba
          </Button>
        </div>
      </Section>

      {state.usage.length > 0 && (
        <Section icon={Layers} title={`Uso de ${state.period.slice(5)}/${state.period.slice(0, 4)}`}>
          <div className="space-y-1.5">
            {state.usage.map((u) => {
              const lv = usageLevel(u.sent, u.quota);
              return (
                <div key={u.tenant_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-foreground">{u.tenant_name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {formatInt(u.sent)} / {formatInt(u.quota)}
                    <Badge tone={lv.level === "full" ? "danger" : lv.level === "warn" ? "warning" : "neutral"}>{lv.pct} %</Badge>
                    {u.overage > 0 && <span>+{formatInt(u.overage)} excedente</span>}
                    {u.blocked > 0 && <span>{formatInt(u.blocked)} bloqueados</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {s.overage_policy === "charge" && s.overage_block_price > 0 && (
            <p className="text-xs text-muted-foreground">
              El excedente se carga el día 1 en la cuenta corriente: {formatCurrency(s.overage_block_price)} cada{" "}
              {formatInt(s.overage_block_size)} emails.
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
