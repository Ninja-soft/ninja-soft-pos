"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, KeyRound, PlugZap, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CredentialInput } from "@/components/ui/CredentialInput";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import { EYEBROW } from "@/components/security/styles";
import { useStores } from "@/modules/stock/hooks";
import { nubceoErrorMessage, type NubceoConfig, type NubceoEnv } from "@/modules/integrations/nubceo/api";
import { useNubceoMutations } from "@/modules/integrations/nubceo/hooks";
import {
  CATEGORY_SOURCES,
  EVERY_OPTIONS,
  NUBCEO_PAYMENT_TYPES,
  NUBCEO_PLATFORMS,
  PAYMENT_FIELDS,
  PLATFORM_SOURCES,
  POS_METHODS,
  TAX_RATES,
  buildNubceoSale,
  classifySnapshot,
  mappingWarnings,
  normalizeMapping,
  sanitizePrefix,
  ventaIdFor,
  type CategorySource,
  type NubceoMapping,
  type PosMethod,
  type SaleSnapshot,
} from "@/supabase/functions/_shared/nubceo";
import { cn } from "@/lib/utils/cn";
import { ENV_LABEL, JsonBlock, fmtDateTime } from "./shared";

const DAYS = [
  { v: 1, label: "Lun" },
  { v: 2, label: "Mar" },
  { v: 3, label: "Mié" },
  { v: 4, label: "Jue" },
  { v: 5, label: "Vie" },
  { v: 6, label: "Sáb" },
  { v: 0, label: "Dom" },
];

interface Draft {
  enabled: boolean;
  environment: NubceoEnv;
  simulate: boolean;
  startDate: string;
  every: number;
  allDay: boolean;
  windowStart: string;
  windowEnd: string;
  days: number[];
  allStores: boolean;
  storeIds: string[];
  mapping: NubceoMapping;
  ledgerAuto: boolean;
  ledgerSince: string;
}

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "00:00");

function draftFrom(cfg: NubceoConfig): Draft {
  const s = cfg.settings;
  const ws = hhmm(s?.window_start);
  const we = hhmm(s?.window_end);
  return {
    enabled: s?.enabled ?? false,
    environment: s?.environment ?? "test",
    simulate: s?.simulate ?? true,
    startDate: s?.start_at ? new Date(new Date(s.start_at).getTime() - 3 * 3600_000).toISOString().slice(0, 16) : "",
    every: s?.every_minutes ?? 60,
    allDay: ws === we,
    windowStart: ws === we ? "08:00" : ws,
    windowEnd: ws === we ? "21:00" : we,
    days: s?.window_days ?? [0, 1, 2, 3, 4, 5, 6],
    allStores: !s?.store_ids,
    storeIds: s?.store_ids ?? [],
    mapping: normalizeMapping(s?.mapping),
    ledgerAuto: s?.ledger_auto ?? false,
    ledgerSince: s?.ledger_since ?? "",
  };
}

function patchFrom(d: Draft): Record<string, unknown> {
  return {
    enabled: d.enabled,
    environment: d.environment,
    simulate: d.simulate,
    // datetime-local en hora de Argentina → ISO con -03:00.
    start_at: d.startDate ? `${d.startDate}:00-03:00` : null,
    every_minutes: d.every,
    window_start: d.allDay ? "00:00" : d.windowStart,
    window_end: d.allDay ? "00:00" : d.windowEnd,
    window_days: d.days,
    store_ids: d.allStores ? null : d.storeIds,
    mapping: d.mapping,
    ledger_auto: d.ledgerAuto,
    ledger_since: d.ledgerSince || null,
  };
}

/** Venta de ejemplo para la vista previa del mapeo. */
function sampleSnapshot(storeId: string, storeName: string, prefix: NubceoMapping): SaleSnapshot {
  const now = new Date();
  const iso = now.toISOString();
  return {
    sync_id: "preview",
    kind: "sale",
    venta_id: ventaIdFor(prefix, { id: "3f1c2a90-0000-4000-8000-000000000000", number: 1520 }),
    status: "pending",
    sale: {
      id: "3f1c2a90-0000-4000-8000-000000000000",
      number: 1520,
      created_at: iso,
      status: "completed",
      total: 36300,
      tax_total: 0,
      store_id: storeId,
      store_name: storeName,
      register_name: "Caja 1",
      cashier_name: "Ana",
      customer_name: "Juan Pérez",
      customer_doc: "20123456",
    },
    payments: [
      {
        id: "p1",
        method: "credit",
        amount: 24200,
        reference: null,
        card_voucher: { marca: "Visa", lote: "12", cupon: "345", autorizacion: "AB12CD", ultimos4: "4242", comercio: "99887766", cuotas: 3, adquirente: "payway" },
        created_at: iso,
        provider_key: null,
        provider_payment_id: null,
      },
      {
        id: "p2",
        method: "qr",
        amount: 12100,
        reference: "0f0f0f0f-0000-4000-8000-000000000000",
        card_voucher: {},
        created_at: iso,
        provider_key: "mercadopago",
        provider_payment_id: "179321806741",
      },
    ],
    ret: null,
  };
}

export function NubceoSetup({ config, canWrite }: { config: NubceoConfig; canWrite: boolean }) {
  return (
    <div className="space-y-5">
      <ConnectionCard config={config} canWrite={canWrite} />
      <SendingSettings config={config} canWrite={canWrite} />
    </div>
  );
}
NubceoSetup.displayName = "NubceoSetup";

// -----------------------------------------------------------------------------
// Conexión (credenciales por ambiente)
// -----------------------------------------------------------------------------
function ConnectionCard({ config, canWrite }: { config: NubceoConfig; canWrite: boolean }) {
  const { toast } = useToast();
  const m = useNubceoMutations();
  const [env, setEnv] = useState<NubceoEnv>(config.settings?.environment ?? "prod");
  const cred = config.credentials[env];
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [tenant, setTenant] = useState(cred?.nubceo_tenant ?? "");
  const [taxCode, setTaxCode] = useState(cred?.tax_code ?? "");
  const [apiUrl, setApiUrl] = useState(cred?.api_url ?? "");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const c = config.credentials[env];
    setApiKey("");
    setApiSecret("");
    setTenant(c?.nubceo_tenant ?? "");
    setTaxCode(c?.tax_code ?? "");
    setApiUrl(c?.api_url ?? "");
  }, [env, config.credentials]);

  const save = async () => {
    try {
      await m.setCredentials.mutateAsync({
        environment: env,
        apiKey: apiKey.trim() || "",
        apiSecret: apiSecret.trim(),
        nubceoTenant: tenant.trim(),
        taxCode: taxCode.trim() || null,
        apiUrl: apiUrl.trim() || null,
      });
      toast({ title: "Credenciales guardadas.", variant: "success" });
      setApiSecret("");
    } catch (e) {
      toast({ title: "No se guardaron", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const test = async () => {
    try {
      const r = await m.test.mutateAsync(env);
      if (r.ok) {
        toast({
          title: "Conexión correcta.",
          description: r.company
            ? `Compañía: ${r.company.name} (${r.company.id}).`
            : `NubCeo respondió. ${r.companies?.length ?? 0} compañías; cargá el CUIT para elegir una.`,
          variant: "success",
        });
      } else {
        toast({ title: "No se pudo conectar", description: r.message ?? nubceoErrorMessage(r.error), variant: "error" });
      }
    } catch (e) {
      toast({ title: "No se pudo conectar", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  // La API key se vuelve a escribir al cambiar algo (sólo se guarda la terminación).
  const canSave = canWrite && tenant.trim() !== "" && apiKey.trim() !== "" && (Boolean(cred) || apiSecret.trim() !== "");

  return (
    <SettingsCard
      title="Conexión"
      icon={KeyRound}
      description="Las credenciales de la API de NubCeo (Conciliaciones). Se guardan sólo en el servidor (nadie las puede leer desde la app) y nunca vuelven a la pantalla."
      actions={
        <Segmented
          size="sm"
          value={env}
          onChange={setEnv}
          aria-label="Ambiente de las credenciales"
          options={[
            { value: "test", label: "Prueba" },
            { value: "prod", label: "Producción" },
          ]}
        />
      }
    >
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid gap-4 sm:grid-cols-2">
          <CredentialInput
            label="API key"
            mono
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cred ? `Termina en ${cred.api_key_hint}` : "API_KEY"}
            configured={Boolean(cred)}
            disabled={!canWrite}
            hint={cred ? "Escribila de nuevo para cambiar algo de la conexión." : undefined}
          />
          <CredentialInput
            label="API secret"
            secret
            mono
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder={cred ? "Sin cambios" : "API_SECRET"}
            configured={Boolean(cred)}
            disabled={!canWrite}
          />
          <CredentialInput
            label="Tenant de NubCeo"
            mono
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            placeholder="1616"
            disabled={!canWrite}
            hint="El número de cliente que te da NubCeo."
          />
          <CredentialInput
            label="CUIT de la empresa"
            optional
            mono
            inputMode="numeric"
            value={taxCode}
            onChange={(e) => setTaxCode(e.target.value)}
            placeholder="30-12345678-9"
            disabled={!canWrite}
            hint="Viaja como taxCode. Obligatorio si tu cuenta de NubCeo tiene varias empresas."
          />
          <div className="sm:col-span-2">
            <Disclosure title="Opciones avanzadas">
              <CredentialInput
                label="URL de la API"
                optional
                mono
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://connectapi.nubceo.com"
                disabled={!canWrite}
                hint="Sólo si NubCeo te dio otra dirección (por ejemplo, para pruebas). Tiene que ser https de nubceo.com."
              />
            </Disclosure>
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
          <p className={EYEBROW}>Estado en {ENV_LABEL[env]}</p>
          {cred ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">API key</dt>
              <dd className="font-mono">···{cred.api_key_hint}</dd>
              <dt className="text-muted-foreground">Tenant</dt>
              <dd className="font-mono">{cred.nubceo_tenant}</dd>
              <dt className="text-muted-foreground">Compañía</dt>
              <dd className="truncate">{cred.company_name ? `${cred.company_name} (${cred.company_id})` : "Sin verificar"}</dd>
              <dt className="text-muted-foreground">Verificada</dt>
              <dd>
                {cred.verified_at ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <Check size={14} /> {fmtDateTime(cred.verified_at)}
                  </span>
                ) : (
                  "Todavía no"
                )}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Sin credenciales. Pedíselas a tu ejecutivo de NubCeo (API key, API secret y número de tenant).</p>
          )}
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={save} disabled={!canSave} loading={m.setCredentials.isPending}>
              <Save size={15} /> Guardar
            </Button>
            <Button size="sm" variant="secondary" onClick={test} disabled={!cred || !canWrite} loading={m.test.isPending}>
              <PlugZap size={15} /> Probar conexión
            </Button>
            {cred && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={!canWrite}>
                <Trash2 size={15} /> Borrar
              </Button>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Borrar las credenciales de ${ENV_LABEL[env]}`}
        description="Si el envío real usa este ambiente, pasa a modo simulación hasta que cargues otras."
        confirmLabel="Borrar"
        danger
        loading={m.clearCredentials.isPending}
        onConfirm={async () => {
          try {
            await m.clearCredentials.mutateAsync(env);
            setConfirmClear(false);
            toast({ title: "Credenciales borradas.", variant: "success" });
          } catch (e) {
            toast({ title: "No se borraron", description: nubceoErrorMessage(e), variant: "error" });
          }
        }}
      />
    </SettingsCard>
  );
}

// -----------------------------------------------------------------------------
// Envío, sucursales, medios y mapeo (un solo guardado)
// -----------------------------------------------------------------------------
function SendingSettings({ config, canWrite }: { config: NubceoConfig; canWrite: boolean }) {
  const { toast } = useToast();
  const m = useNubceoMutations();
  const { data: stores = [] } = useStores();
  const initial = useMemo(() => draftFrom(config), [config]);
  const [d, setD] = useState<Draft>(initial);
  // Si llegan datos nuevos del servidor (otra pestaña, otro guardado), se
  // toman sólo si no hay cambios sin guardar.
  const lastInitial = useRef(initial);
  const acceptNext = useRef(false);
  useEffect(() => {
    const prev = lastInitial.current;
    lastInitial.current = initial;
    const accept = acceptNext.current;
    acceptNext.current = false;
    setD((cur) => (accept || JSON.stringify(cur) === JSON.stringify(prev) ? initial : cur));
  }, [initial]);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setMap = (fn: (mp: NubceoMapping) => NubceoMapping) => setD((x) => ({ ...x, mapping: fn(structuredClone(x.mapping)) }));

  const includedStores = d.allStores ? stores.map((s) => s.id) : d.storeIds;
  const warnings = mappingWarnings(d.mapping, includedStores);
  const credsForEnv = Boolean(config.credentials[d.environment]);

  const save = async () => {
    try {
      acceptNext.current = true;
      const r = await m.save.mutateAsync(patchFrom(d));
      // Lo guardado (con lo que completa el servidor, p. ej. la fecha de inicio).
      setD(lastInitial.current);
      toast({
        title: "Guardado.",
        description: r.requeued > 0 ? `${r.requeued} ventas vuelven a la cola para clasificarse con la configuración nueva.` : undefined,
        variant: "success",
      });
    } catch (e) {
      acceptNext.current = false;
      toast({ title: "No se guardó", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const platformOptions: SelectOption<string>[] = [
    { value: "", label: "Sin plataforma" },
    ...NUBCEO_PLATFORMS.map((p) => ({ value: p.code, label: p.label, description: p.code })),
  ];
  const methodPlatformOptions: SelectOption<string>[] = [
    { value: "", label: "Automática", description: "La del proveedor o la terminal del cupón" },
    ...NUBCEO_PLATFORMS.map((p) => ({ value: p.code, label: p.label, description: p.code })),
  ];
  const typeOptions: SelectOption<string>[] = [{ value: "", label: "No mandar" }, ...NUBCEO_PAYMENT_TYPES];

  const preview = useMemo(() => {
    const first = stores.find((s) => includedStores.includes(s.id)) ?? stores[0];
    if (!first) return null;
    const snap = sampleSnapshot(first.id, first.name, d.mapping);
    const c = classifySnapshot(snap, { mapping: d.mapping, storeIds: null });
    if (c.action !== "send") return { error: c.reason };
    return {
      sale: buildNubceoSale(c.envelope, {
        index: 0,
        taxCode: config.credentials[d.environment]?.tax_code ?? "",
        paymentDate: d.mapping.paymentDate,
        fields: d.mapping.paymentFields,
      }),
    };
  }, [stores, includedStores, d.mapping, d.environment, config.credentials]);

  const disabled = !canWrite;

  return (
    <div className="space-y-5">
      <SettingsCard title="Envío" description="Cuándo y cómo salen las ventas hacia NubCeo.">
        <SettingRow
          label="Mandar ventas a NubCeo"
          description="Cada venta completada se encola sola. Anularla la saca (o la borra de NubCeo si ya se mandó)."
        >
          <Switch checked={d.enabled} onCheckedChange={(v) => set("enabled", v)} label="Mandar ventas" disabled={disabled} />
        </SettingRow>
        <SettingRow label="Ambiente" description="Prueba usa las credenciales de prueba; Producción, las reales.">
          <Segmented
            size="sm"
            value={d.environment}
            onChange={(v) => set("environment", v)}
            aria-label="Ambiente"
            options={[
              { value: "test", label: "Prueba" },
              { value: "prod", label: "Producción" },
            ]}
          />
          {!credsForEnv && (
            <p className="mt-2 text-[13px] text-warning">Sin credenciales de {ENV_LABEL[d.environment]}: sólo se puede simular.</p>
          )}
        </SettingRow>
        <SettingRow
          label="Solo simular"
          description="Arma cada venta como la recibiría NubCeo y la guarda para que la revises, sin mandarla. Al apagarlo, lo simulado no sale solo: usá Mandar las simuladas en Envíos."
        >
          <Switch
            checked={d.simulate}
            onCheckedChange={(v) => set("simulate", v)}
            label="Solo simular"
            disabled={disabled || (!credsForEnv && d.simulate)}
          />
        </SettingRow>
        <SettingRow
          label="Desde"
          htmlFor="nubceo-start"
          description="Sólo se mandan las ventas desde este momento. Vacío: desde que se activa."
        >
          <Input
            id="nubceo-start"
            type="datetime-local"
            value={d.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            disabled={disabled}
            className="max-w-[260px]"
          />
        </SettingRow>
        <SettingRow label="Ritmo" description="Cada cuánto se juntan las ventas pendientes y se mandan en una tanda.">
          <Select
            value={String(d.every)}
            onChange={(v) => set("every", Number(v))}
            options={EVERY_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label }))}
            aria-label="Ritmo"
            disabled={disabled}
            className="max-w-[260px]"
          />
        </SettingRow>
        <SettingRow label="Ventana horaria" description="En hora de Argentina. Fuera de la ventana las ventas esperan a la próxima vuelta.">
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={d.allDay} onCheckedChange={(v) => set("allDay", v)} label="Todo el día" disabled={disabled} />
              Todo el día
            </label>
            {!d.allDay && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">De</span>
                <Input
                  type="time"
                  aria-label="Desde"
                  value={d.windowStart}
                  onChange={(e) => set("windowStart", e.target.value)}
                  disabled={disabled}
                  className="w-[124px]"
                />
                <span className="text-muted-foreground">a</span>
                <Input
                  type="time"
                  aria-label="Hasta"
                  value={d.windowEnd}
                  onChange={(e) => set("windowEnd", e.target.value)}
                  disabled={disabled}
                  className="w-[124px]"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Días">
              {DAYS.map((day) => {
                const on = d.days.includes(day.v);
                return (
                  <button
                    key={day.v}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() =>
                      set("days", on ? d.days.filter((x) => x !== day.v) : [...d.days, day.v].sort((a, b) => a - b))
                    }
                    className={cn(
                      "h-9 min-w-[48px] rounded-md border px-2.5 text-[13px] font-semibold transition-colors disabled:opacity-50",
                      on ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Sucursales"
        description="Qué sucursales mandan y con qué código de sucursal cabecera las conoce NubCeo (customerBranchReference)."
      >
        <SettingRow label="Todas las sucursales" description="Las que abras después entran solas (con su código).">
          <Switch checked={d.allStores} onCheckedChange={(v) => set("allStores", v)} label="Todas las sucursales" disabled={disabled} />
        </SettingRow>
        <div className="px-5 py-4">
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="w-12 px-3 py-2.5" aria-label="Incluida" />
                  <th className="px-3 py-2.5">Sucursal de NinjaPOS</th>
                  <th className="px-3 py-2.5">Código en NubCeo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stores.map((s) => {
                  const included = d.allStores || d.storeIds.includes(s.id);
                  const code = d.mapping.branchCodes[s.id] ?? "";
                  return (
                    <tr key={s.id} className={cn(!included && "text-muted-foreground")}>
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={included}
                          disabled={disabled || d.allStores}
                          aria-label={`Incluir ${s.name}`}
                          onCheckedChange={(v) =>
                            set("storeIds", v ? [...d.storeIds, s.id] : d.storeIds.filter((x) => x !== s.id))
                          }
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{s.name}</td>
                      <td className="px-3 py-2">
                        <input
                          value={code}
                          disabled={disabled}
                          onChange={(e) =>
                            setMap((mp) => {
                              const v = e.target.value.slice(0, 60);
                              if (v) mp.branchCodes[s.id] = v;
                              else delete mp.branchCodes[s.id];
                              return mp;
                            })
                          }
                          placeholder="Ej.: 12"
                          aria-label={`Código de ${s.name} en NubCeo`}
                          className={cn(
                            "h-9 w-full max-w-[220px] rounded-md border bg-background px-3 font-mono text-[13px] outline-none focus:border-foreground/40",
                            included && !code ? "border-warning/60" : "border-input",
                          )}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">
            El código es el id de la sucursal cabecera que diste de alta en NubCeo. Sin código, las ventas de esa sucursal quedan en
            error de configuración hasta que lo cargues.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Medios de pago"
        description="Qué medios viajan como pago (relatedPayments), con qué tipo y por qué plataforma. Un medio apagado no viaja; si la venta queda sin medios, no se manda."
      >
        <div className="px-5 py-4">
          <div className="slim-scrollbar overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5">Medio en NinjaPOS</th>
                  <th className="w-24 px-3 py-2.5">Va</th>
                  <th className="px-3 py-2.5">paymentType</th>
                  <th className="px-3 py-2.5">Plataforma</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {POS_METHODS.map((pm) => {
                  const rule = d.mapping.methods[pm.key];
                  return (
                    <tr key={pm.key} className={cn(!rule.include && "text-muted-foreground")}>
                      <td className="px-3 py-2">
                        <p className="font-medium text-foreground">{pm.label}</p>
                        <p className="text-xs text-muted-foreground">{pm.hint}</p>
                      </td>
                      <td className="px-3 py-2">
                        <Switch
                          checked={rule.include}
                          label={`Mandar ${pm.label}`}
                          disabled={disabled}
                          onCheckedChange={(v) =>
                            setMap((mp) => {
                              mp.methods[pm.key as PosMethod].include = v;
                              return mp;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          value={rule.paymentType}
                          options={typeOptions}
                          aria-label={`paymentType de ${pm.label}`}
                          disabled={disabled || !rule.include}
                          onChange={(v) =>
                            setMap((mp) => {
                              mp.methods[pm.key as PosMethod].paymentType = v as NubceoMapping["methods"][PosMethod]["paymentType"];
                              return mp;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          value={rule.platform}
                          options={methodPlatformOptions}
                          aria-label={`Plataforma de ${pm.label}`}
                          disabled={disabled || !rule.include}
                          onChange={(v) =>
                            setMap((mp) => {
                              mp.methods[pm.key as PosMethod].platform = v;
                              return mp;
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <SettingRow
          stacked
          label="Plataforma por proveedor o terminal"
          description="Con plataforma Automática, el pago toma la del proveedor que lo cobró (QR, link o Point) o la de la terminal elegida en el cupón del posnet."
        >
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {PLATFORM_SOURCES.map((src) => (
              <div key={src.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3">
                <span className="text-sm">{src.label}</span>
                <Select
                  value={d.mapping.platforms[src.key] ?? ""}
                  options={platformOptions}
                  aria-label={`Plataforma de ${src.label}`}
                  disabled={disabled}
                  onChange={(v) =>
                    setMap((mp) => {
                      mp.platforms[src.key] = v;
                      return mp;
                    })
                  }
                />
              </div>
            ))}
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Mapeo de campos"
        description="De dónde sale cada dato que recibe NubCeo. Los vacíos no se mandan."
      >
        <div className="px-5 py-4">
          <div className="slim-scrollbar overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="w-[34%] px-3 py-2.5">Campo de NubCeo</th>
                  <th className="px-3 py-2.5">Dato de NinjaPOS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                <FieldRow name="id" note="Llave de idempotencia: mandar dos veces la misma venta no la duplica.">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={d.mapping.saleIdPrefix}
                      disabled={disabled}
                      onChange={(e) => setMap((mp) => ({ ...mp, saleIdPrefix: sanitizePrefix(e.target.value) }))}
                      aria-label="Prefijo del id"
                      placeholder="Prefijo"
                      className="h-9 w-[110px] rounded-md border border-input bg-background px-3 font-mono text-[13px] outline-none focus:border-foreground/40"
                    />
                    <span className="text-muted-foreground">+</span>
                    <Segmented
                      size="sm"
                      value={d.mapping.saleIdSource}
                      onChange={(v) => setMap((mp) => ({ ...mp, saleIdSource: v }))}
                      aria-label="Origen del id"
                      options={[
                        { value: "number", label: "N° de venta" },
                        { value: "uuid", label: "Id interno" },
                      ]}
                    />
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {ventaIdFor(d.mapping, { id: "3f1c2a90-…", number: 1520 })}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">Cambiarlo afecta sólo a las ventas nuevas: las ya encoladas conservan su id.</p>
                </FieldRow>
                <FieldRow name="customerBranchReference">Código de la sucursal (tabla Sucursales)</FieldRow>
                <FieldRow name="taxCode">CUIT de la conexión</FieldRow>
                <FieldRow name="date · currencyCode · type">Fecha de la venta (hora de Argentina) · ARS · invoice (devoluciones: creditNote)</FieldRow>
                <FieldRow name="grossAmount">Suma de los pagos incluidos (sin el vuelto)</FieldRow>
                <FieldRow name="netAmount · taxAmount">
                  <Select
                    value={String(d.mapping.taxRate)}
                    options={TAX_RATES.map((t) => ({ value: String(t.value), label: t.label }))}
                    aria-label="IVA"
                    disabled={disabled}
                    onChange={(v) => setMap((mp) => ({ ...mp, taxRate: Number(v) }))}
                    className="max-w-[300px]"
                  />
                </FieldRow>
                {(["categoryOne", "categoryTwo", "categoryThree"] as const).map((k, i) => (
                  <FieldRow key={k} name={k}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={d.mapping.categories[i]!.source}
                        options={CATEGORY_SOURCES.map((c) => ({ value: c.value, label: c.label }))}
                        aria-label={k}
                        disabled={disabled}
                        onChange={(v) =>
                          setMap((mp) => {
                            mp.categories[i] = { source: v as CategorySource, value: mp.categories[i]!.value };
                            return mp;
                          })
                        }
                        className="max-w-[240px]"
                      />
                      {d.mapping.categories[i]!.source === "fixed" && (
                        <input
                          value={d.mapping.categories[i]!.value}
                          disabled={disabled}
                          onChange={(e) =>
                            setMap((mp) => {
                              mp.categories[i] = { source: "fixed", value: e.target.value.slice(0, 60) };
                              return mp;
                            })
                          }
                          aria-label={`Texto de ${k}`}
                          placeholder="Texto"
                          className="h-11 w-[180px] rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-foreground/40"
                        />
                      )}
                    </div>
                  </FieldRow>
                ))}
                <FieldRow name="internalReference">
                  <Segmented
                    size="sm"
                    value={d.mapping.internalReference}
                    onChange={(v) => setMap((mp) => ({ ...mp, internalReference: v }))}
                    aria-label="internalReference"
                    options={[
                      { value: "sale_number", label: "N° de venta" },
                      { value: "none", label: "No mandar" },
                    ]}
                  />
                </FieldRow>
                <FieldRow name="relatedPayments[].date">
                  <Segmented
                    size="sm"
                    value={d.mapping.paymentDate}
                    onChange={(v) => setMap((mp) => ({ ...mp, paymentDate: v }))}
                    aria-label="Fecha del pago"
                    options={[
                      { value: "payment", label: "La del cobro" },
                      { value: "sale", label: "La de la venta" },
                    ]}
                  />
                </FieldRow>
                {PAYMENT_FIELDS.map((f) => (
                  <FieldRow key={f.key} name={`relatedPayments[].${f.label}`}>
                    <label className="flex items-center gap-2.5">
                      <Checkbox
                        checked={d.mapping.paymentFields[f.key]}
                        disabled={disabled}
                        aria-label={`Mandar ${f.label}`}
                        onCheckedChange={(v) =>
                          setMap((mp) => {
                            mp.paymentFields[f.key] = v;
                            return mp;
                          })
                        }
                      />
                      <span className={cn(!d.mapping.paymentFields[f.key] && "text-muted-foreground line-through")}>{f.source}</span>
                    </label>
                  </FieldRow>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <SettingRow label="Devoluciones" description="Una devolución con reintegro en efectivo viaja como nota de crédito (creditNote, montos negativos).">
          <Switch
            checked={d.mapping.sendReturns}
            onCheckedChange={(v) => setMap((mp) => ({ ...mp, sendReturns: v }))}
            label="Mandar devoluciones"
            disabled={disabled}
          />
        </SettingRow>
        <SettingRow
          label="Anulaciones"
          description="Anular una venta ya mandada la borra de NubCeo. NubCeo no deja borrar una venta que ya concilió: queda avisado en Envíos."
        >
          <Switch
            checked={d.mapping.sendVoids}
            onCheckedChange={(v) => setMap((mp) => ({ ...mp, sendVoids: v }))}
            label="Borrar las anuladas"
            disabled={disabled}
          />
        </SettingRow>
        <div className="px-5 py-4">
          <Disclosure title="Vista previa con una venta de ejemplo">
            {preview && "sale" in preview ? (
              <JsonBlock value={[preview.sale]} />
            ) : (
              <p className="text-sm text-muted-foreground">{preview?.error ?? "Cargá una sucursal para ver el ejemplo."}</p>
            )}
          </Disclosure>
        </div>
      </SettingsCard>

      <SettingsCard title="Asientos contables" description="NubCeo arma los asientos de las liquidaciones y los expone por su API.">
        <SettingRow label="Traerlos solos" description="Cada 6 horas se importan los asientos nuevos o actualizados.">
          <Switch checked={d.ledgerAuto} onCheckedChange={(v) => set("ledgerAuto", v)} label="Traer asientos solos" disabled={disabled} />
        </SettingRow>
        <SettingRow label="Desde" htmlFor="nubceo-ledger-since" description="La primera importación trae lo actualizado desde esta fecha.">
          <Input
            id="nubceo-ledger-since"
            type="date"
            value={d.ledgerSince}
            onChange={(e) => set("ledgerSince", e.target.value)}
            disabled={disabled}
            className="max-w-[200px]"
          />
        </SettingRow>
      </SettingsCard>

      {warnings.length > 0 && d.enabled && (
        <Callout tone="warning" icon={AlertTriangle} title="Falta configurar">
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}

      {canWrite && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background/95 px-1 py-3">
          {dirty && <Badge tone="warning">Cambios sin guardar</Badge>}
          <Button variant="ghost" onClick={() => setD(initial)} disabled={!dirty}>
            Descartar
          </Button>
          <Button onClick={save} disabled={!dirty} loading={m.save.isPending}>
            <Save size={16} /> Guardar cambios
          </Button>
        </div>
      )}
    </div>
  );
}

function FieldRow({ name, note, children }: { name: string; note?: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="px-3 py-3">
        <code className="font-mono text-[12.5px] text-foreground">{name}</code>
        {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      </td>
      <td className="px-3 py-3 text-sm">{children}</td>
    </tr>
  );
}
