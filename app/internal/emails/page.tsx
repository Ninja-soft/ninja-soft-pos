"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Mail, Plus, RefreshCw, Send, Server, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useSystemEmails } from "@/modules/internal/hooks";
import type {
  SystemEmail,
  SystemEmailKind,
  SystemEmailStatus,
} from "@/modules/internal/api";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { EMAIL_TEMPLATES, renderTemplate, sampleVars } from "@/lib/email/templates";
import { cn } from "@/lib/utils/cn";

type Saved = Record<string, { subject: string; html: string }>;

// Presets de proveedor para el SMTP del sistema (mismo patrón que TenantEmailCard).
// "otro" deja host/puerto/secure editables.
type ProviderKey = "gmail" | "outlook" | "otro";
const SMTP_PROVIDERS: { key: ProviderKey; label: string; host: string; port: string; secure: boolean }[] = [
  { key: "gmail", label: "Gmail", host: "smtp.gmail.com", port: "465", secure: true },
  { key: "outlook", label: "Outlook", host: "smtp.office365.com", port: "587", secure: false },
  { key: "otro", label: "Otro", host: "", port: "587", secure: false },
];

function inferSmtpProvider(host: string): ProviderKey {
  const h = host.trim().toLowerCase();
  if (h === "smtp.gmail.com") return "gmail";
  if (h === "smtp.office365.com") return "outlook";
  return "otro";
}

export default function InternalEmailsPage() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedKey, setSelectedKey] = useState(EMAIL_TEMPLATES[0]!.key);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");

  const { data: saved = {} } = useQuery<Saved>({
    queryKey: ["system-email-templates"],
    queryFn: async (): Promise<Saved> => {
      const { data } = await supabase
        .from("system_email_templates")
        .select("key, subject, html");
      const map: Saved = {};
      (data ?? []).forEach((t) => (map[t.key] = { subject: t.subject, html: t.html }));
      return map;
    },
  });

  const def = EMAIL_TEMPLATES.find((t) => t.key === selectedKey)!;
  useEffect(() => {
    const ov = saved[selectedKey];
    setSubject(ov?.subject ?? def.defaultSubject);
    setHtml(ov?.html ?? def.defaultHtml);
  }, [selectedKey, saved, def.defaultSubject, def.defaultHtml]);

  // Insertar variables en el cursor (asunto o HTML).
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const [activeField, setActiveField] = useState<"subject" | "html">("html");

  function insertVar(name: string) {
    const token = `{{${name}}}`;
    const isSubject = activeField === "subject";
    const el = isSubject ? subjectRef.current : htmlRef.current;
    const cur = isSubject ? subject : html;
    const setter = isSubject ? setSubject : setHtml;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    setter(next);
    requestAnimationFrame(() => {
      if (el) {
        const pos = start + token.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }

  const saveTpl = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("system_email_templates")
        .upsert({ key: selectedKey, subject, html }, { onConflict: "key" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Plantilla guardada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["system-email-templates"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // Envío de prueba al destinatario que ingresa staff (no a un email fijo).
  const [testOpen, setTestOpen] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const sendTest = useMutation({
    mutationFn: async (to: string) => {
      const vars = sampleVars("NinjaPos");
      const { data, error } = await supabase.functions.invoke("send_email", {
        body: {
          to,
          subject: renderTemplate(subject, vars),
          html: renderTemplate(html, vars),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      setTestOpen(false);
      toast({ title: "Email de prueba enviado correctamente", variant: "success" });
    },
    onError: () =>
      toast({ title: "No se pudo enviar el email de prueba", variant: "error" }),
  });

  function submitTest() {
    const to = testEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast({ title: "Ingresá un email válido", variant: "error" });
      return;
    }
    sendTest.mutate(to);
  }

  const vars = sampleVars("NinjaPos");

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Emails del sistema</Display>
      <p className="mt-2 text-muted-foreground">
        Editá los emails que NinjaPos envía a los usuarios y configurá los proveedores de envío.
      </p>

      {/* Proveedores de email (Resend + failover SMTP). Camino de envío principal. */}
      <EmailProvidersCard />

      {/* Plantillas */}
      <Card className="mt-6">
        <CardContent className="space-y-5 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Mail size={16} /> Plantillas
          </div>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {EMAIL_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setSelectedKey(t.key)}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-1.5 text-sm transition",
                  selectedKey === t.key
                    ? "bg-ninja-flame/12 font-medium text-ninja-flameSoft"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{def.description}</p>
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="secondary" size="sm">
                  <Plus size={15} /> Insertar variable
                </Button>
              </DropdownTrigger>
              <DropdownContent align="end" className="w-56">
                <DropdownLabel>
                  Insertar en {activeField === "subject" ? "el asunto" : "el contenido"}
                </DropdownLabel>
                {def.variables.map((v) => (
                  <DropdownItem key={v} onSelect={() => insertVar(v)}>
                    <code className="text-xs">{`{{${v}}}`}</code>
                  </DropdownItem>
                ))}
              </DropdownContent>
            </Dropdown>
          </div>
          <Input
            ref={subjectRef}
            label="Asunto"
            value={subject}
            onFocus={() => setActiveField("subject")}
            onChange={(e) => setSubject(e.target.value)}
          />
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Contenido (HTML)
            </label>
            <textarea
              ref={htmlRef}
              value={html}
              onFocus={() => setActiveField("html")}
              onChange={(e) => setHtml(e.target.value)}
              rows={7}
              className="w-full rounded-lg border border-input bg-background p-3 font-mono text-xs text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Tocá un campo (asunto o contenido) y luego “Insertar variable”.
            </p>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">Vista previa</div>
            <div className="rounded-lg border border-border bg-white p-4 text-sm text-neutral-900">
              <div className="mb-2 border-b border-neutral-200 pb-2 text-xs text-neutral-500">
                Asunto: {renderTemplate(subject, vars)}
              </div>
              <div dangerouslySetInnerHTML={{ __html: renderTemplate(html, vars) }} />
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setTestEmail("");
                setTestOpen(true);
              }}
            >
              <Send size={16} /> Enviar prueba
            </Button>
            <Button onClick={() => saveTpl.mutate()} disabled={saveTpl.isPending}>
              Guardar plantilla
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bitácora de envíos (paridad Food) */}
      <SystemEmailsLog />

      {/* Prueba de envío: pregunta el destinatario (#14) en vez de un email fijo. */}
      <Modal
        open={testOpen}
        onOpenChange={(o) => {
          if (!sendTest.isPending) setTestOpen(o);
        }}
        title="¿A qué email enviar la prueba?"
        description="Te enviamos esta plantilla con datos de ejemplo a la dirección que indiques."
      >
        <div className="space-y-4">
          <Input
            label="Email de destino"
            type="email"
            placeholder="prueba@tuemail.com"
            value={testEmail}
            autoFocus
            onChange={(e) => setTestEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTest();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setTestOpen(false)}
              disabled={sendTest.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={submitTest} disabled={sendTest.isPending}>
              <Send size={16} /> Enviar prueba
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ── Proveedores de email (Resend + failover SMTP) ────────────────────────────

type ProviderKind = "resend" | "smtp";

// Estado editable de un slot. has_key/has_smtp_pass reflejan si ya hay secreto
// guardado (el RPC no devuelve los secretos): los campos van vacíos y solo se
// envían si el usuario escribe uno nuevo.
interface SlotState {
  kind: ProviderKind;
  is_active: boolean;
  from_name: string;
  from_email: string;
  api_key: string;
  has_key: boolean;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  has_smtp_pass: boolean;
}

const EMPTY_SLOT: SlotState = {
  kind: "resend",
  is_active: false,
  from_name: "NinjaPos",
  from_email: "",
  api_key: "",
  has_key: false,
  smtp_host: "",
  smtp_port: "587",
  smtp_secure: false,
  smtp_user: "",
  smtp_pass: "",
  has_smtp_pass: false,
};

function slotFromRpc(raw: Record<string, unknown> | undefined): SlotState {
  if (!raw) return { ...EMPTY_SLOT };
  const kind = raw.kind === "smtp" ? "smtp" : "resend";
  return {
    kind,
    is_active: !!raw.is_active,
    from_name: String(raw.from_name ?? "NinjaPos"),
    from_email: String(raw.from_email ?? ""),
    api_key: "",
    has_key: !!raw.has_key,
    smtp_host: String(raw.smtp_host ?? ""),
    smtp_port: String(raw.smtp_port ?? "587"),
    smtp_secure: !!raw.smtp_secure,
    smtp_user: String(raw.smtp_user ?? ""),
    smtp_pass: "",
    has_smtp_pass: !!raw.has_smtp_pass,
  };
}

function EmailProvidersCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: providers } = useQuery({
    queryKey: ["email-providers"],
    queryFn: async () => {
      const { data } = await supabase.rpc("get_email_providers");
      return (data as Record<string, Record<string, unknown>> | null) ?? {};
    },
  });

  const [slot1, setSlot1] = useState<SlotState>({ ...EMPTY_SLOT });
  const [slot2, setSlot2] = useState<SlotState>({ ...EMPTY_SLOT });
  useEffect(() => {
    if (providers) {
      setSlot1(slotFromRpc(providers["1"]));
      setSlot2(slotFromRpc(providers["2"]));
    }
  }, [providers]);

  const save = useMutation({
    mutationFn: async ({ slot, state }: { slot: number; state: SlotState }) => {
      const body: Record<string, unknown> = {
        slot,
        kind: state.kind,
        is_active: state.is_active,
        from_name: state.from_name,
        from_email: state.from_email,
      };
      if (state.kind === "resend") {
        // Solo enviamos api_key si el usuario escribió una nueva (vacío = conservar).
        if (state.api_key.trim()) body.api_key = state.api_key.trim();
      } else {
        body.smtp_host = state.smtp_host;
        body.smtp_port = Number(state.smtp_port) || 587;
        body.smtp_secure = state.smtp_secure;
        body.smtp_user = state.smtp_user;
        if (state.smtp_pass) body.smtp_pass = state.smtp_pass;
      }
      const { error } = await supabase.functions.invoke("set_email_providers", { body });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Proveedor guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["email-providers"] });
    },
    onError: () => toast({ title: "No se pudo guardar el proveedor", variant: "error" }),
  });

  return (
    <Card className="mt-6">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <Zap size={16} /> Proveedores de email
        </div>
        <p className="text-xs text-muted-foreground">
          El <b>proveedor principal</b> se usa siempre; el de <b>respaldo</b> entra
          automáticamente solo si el principal falla (failover). Cada uno puede ser
          Resend (recomendado) o un SMTP propio.
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          <SlotEditor
            title="Proveedor principal"
            state={slot1}
            onChange={setSlot1}
            onSave={() => save.mutate({ slot: 1, state: slot1 })}
            saving={save.isPending}
          />
          <SlotEditor
            title="Proveedor de respaldo (failover)"
            state={slot2}
            onChange={setSlot2}
            onSave={() => save.mutate({ slot: 2, state: slot2 })}
            saving={save.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Presets de SMTP para los slots de proveedor (mismo patrón que el SMTP legacy).
const SLOT_SMTP_PRESETS: { key: ProviderKey; label: string; host: string; port: string; secure: boolean }[] = SMTP_PROVIDERS;

function SlotEditor({
  title,
  state,
  onChange,
  onSave,
  saving,
}: {
  title: string;
  state: SlotState;
  onChange: (s: SlotState) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const set = (patch: Partial<SlotState>) => onChange({ ...state, ...patch });
  const smtpPreset = inferSmtpProvider(state.smtp_host);

  function pickPreset(key: ProviderKey) {
    if (key === "otro") {
      set({ smtp_host: "" });
      return;
    }
    const p = SLOT_SMTP_PRESETS.find((x) => x.key === key)!;
    set({ smtp_host: p.host, smtp_port: p.port, smtp_secure: p.secure });
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{title}</div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {state.is_active ? "Activo" : "Inactivo"}
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => set({ is_active: v })}
            label="Activar proveedor"
          />
        </label>
      </div>

      {/* Selector de tipo (Resend / SMTP). */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(
          [
            { key: "resend", label: "Resend", icon: Zap },
            { key: "smtp", label: "SMTP", icon: Server },
          ] as const
        ).map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => set({ kind: opt.key })}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition",
              state.kind === opt.key
                ? "border-ninja-flame text-foreground ring-2 ring-ninja-flame/30"
                : "border-border text-muted-foreground hover:border-ninja-flameSoft/40",
            )}
          >
            <opt.icon size={14} /> {opt.label}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Nombre del remitente"
            value={state.from_name}
            onChange={(e) => set({ from_name: e.target.value })}
          />
          <Input
            label="Email del remitente"
            type="email"
            placeholder="hola@tudominio.com"
            value={state.from_email}
            onChange={(e) => set({ from_email: e.target.value })}
          />
        </div>

        {state.kind === "resend" ? (
          <Input
            label={
              state.has_key ? "API key (dejar vacío para no cambiar)" : "API key de Resend"
            }
            type="password"
            placeholder={state.has_key ? "••••••••" : "re_..."}
            value={state.api_key}
            onChange={(e) => set({ api_key: e.target.value })}
          />
        ) : (
          <>
            {/* Presets de SMTP. */}
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Proveedor SMTP</div>
              <div className="grid grid-cols-3 gap-2">
                {SLOT_SMTP_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => pickPreset(p.key)}
                    className={cn(
                      "rounded-lg border px-2 py-2 text-xs font-medium transition",
                      smtpPreset === p.key
                        ? "border-ninja-flame text-foreground ring-2 ring-ninja-flame/30"
                        : "border-border text-muted-foreground hover:border-ninja-flameSoft/40",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Servidor SMTP"
                placeholder="smtp.gmail.com"
                value={state.smtp_host}
                onChange={(e) => set({ smtp_host: e.target.value })}
              />
              <Input
                label="Puerto"
                inputMode="numeric"
                placeholder="587"
                value={state.smtp_port}
                onChange={(e) => set({ smtp_port: e.target.value.replace(/\D/g, "") })}
              />
              <Input
                label="Usuario"
                placeholder="tu@email.com"
                value={state.smtp_user}
                onChange={(e) => set({ smtp_user: e.target.value })}
              />
              <Input
                label={
                  state.has_smtp_pass ? "Contraseña (dejar vacío para no cambiar)" : "Contraseña"
                }
                type="password"
                placeholder={state.has_smtp_pass ? "••••••••" : ""}
                value={state.smtp_pass}
                onChange={(e) => set({ smtp_pass: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="accent-ninja-flame"
                checked={state.smtp_secure}
                onChange={(e) => set({ smtp_secure: e.target.checked })}
              />
              Conexión segura (SSL/TLS, puerto 465)
            </label>
          </>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={onSave} disabled={saving}>
            Guardar proveedor
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Bitácora de envíos ───────────────────────────────────────────────────────

const KIND_LABELS: Record<SystemEmailKind, string> = {
  system: "Sistema",
  receipt: "Comprobante",
  smtp_test: "Prueba SMTP",
};

const STATUS_LABELS: Record<SystemEmailStatus, string> = {
  sent: "Enviado",
  failed: "Fallido",
  pending: "Pendiente",
};

function fmtDate(s: string): string {
  return new Date(s).toLocaleString("es-AR");
}

function StatusChip({ email }: { email: SystemEmail }) {
  const label = STATUS_LABELS[email.status] ?? email.status;
  const cls =
    email.status === "sent"
      ? "bg-emerald-500/12 text-emerald-400"
      : email.status === "failed"
        ? "bg-red-500/12 text-red-400"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
        cls,
      )}
      title={email.status === "failed" ? email.error_message ?? undefined : undefined}
    >
      {label}
    </span>
  );
}

// Origen del envío: "negocios" = originado por un tenant (comprobante o prueba
// SMTP del negocio); "sistema" = emails del sistema NinjaPos.
type OriginFilter = "todos" | "negocios" | "sistema";
const ORIGIN_FILTERS: { key: OriginFilter; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "negocios", label: "Negocios" },
  { key: "sistema", label: "Sistema" },
];

function matchesOrigin(email: SystemEmail, origin: OriginFilter): boolean {
  if (origin === "todos") return true;
  if (origin === "sistema") return email.kind === "system";
  // negocios: comprobantes y pruebas SMTP (originados por el tenant).
  return email.kind === "receipt" || email.kind === "smtp_test";
}

function SystemEmailsLog() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: emails = [], isLoading, isFetching, refetch } = useSystemEmails();
  const [origin, setOrigin] = useState<OriginFilter>("todos");
  const [tenantQuery, setTenantQuery] = useState("");

  // Despacha los emails del sistema en cola (estado 'pending'). El motor de
  // dunning solo encola; el envío real ocurre acá (o por automatización futura).
  const processPending = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("process_pending_emails", {
        body: {},
      });
      if (error) throw error;
      return data as { processed: number; sent: number; failed: number };
    },
    onSuccess: (d) => {
      toast({
        title:
          d.processed === 0
            ? "No hay envíos pendientes"
            : `Procesados ${d.processed}: ${d.sent} enviados, ${d.failed} con error`,
        variant: d.failed > 0 ? "error" : "success",
      });
      qc.invalidateQueries({ queryKey: ["internal", "system-emails"] });
    },
    onError: (e) =>
      toast({
        title: "No se pudieron procesar",
        description: e instanceof Error ? e.message : "Revisá la configuración SMTP.",
        variant: "error",
      }),
  });

  const filtered = emails.filter((e) => {
    if (!matchesOrigin(e, origin)) return false;
    const q = tenantQuery.trim().toLowerCase();
    if (q && !(e.tenantName ?? "").toLowerCase().includes(q)) return false;
    return true;
  });

  async function onExport() {
    await exportXlsx("bitacora-envios", [
      {
        name: "Envíos",
        title: "Bitácora de envíos",
        columns: [
          { header: "Fecha", key: "fecha", width: 22 },
          { header: "Asunto", key: "asunto", width: 36 },
          { header: "Destinatario", key: "destinatario", width: 28 },
          { header: "Negocio", key: "negocio", width: 24 },
          { header: "Tipo", key: "tipo", width: 16 },
          { header: "Estado", key: "estado", width: 14 },
          { header: "Error", key: "error", width: 40 },
        ],
        // El export respeta los filtros activos (origen + negocio).
        rows: filtered.map((e) => ({
          fecha: fmtDate(e.created_at),
          asunto: e.subject,
          destinatario: e.recipient,
          negocio: e.tenantName ?? "—",
          tipo: KIND_LABELS[e.kind] ?? e.kind,
          estado: STATUS_LABELS[e.status] ?? e.status,
          error: e.error_message ?? "",
        })),
      },
    ]);
  }

  return (
    <Card className="mt-6">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <Mail size={16} /> Bitácora de envíos
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => processPending.mutate()}
              disabled={processPending.isPending}
            >
              <Send size={15} /> Procesar pendientes
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />{" "}
              Actualizar
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onExport}
              disabled={filtered.length === 0}
            >
              <Download size={15} /> Exportar XLSX
            </Button>
          </div>
        </div>

        {/* Filtros: origen (segmented) + búsqueda por negocio. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {ORIGIN_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setOrigin(f.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  origin === f.key
                    ? "bg-ninja-flame/12 text-ninja-flameSoft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="w-full max-w-[220px]">
            <Input
              placeholder="Filtrar por negocio…"
              value={tenantQuery}
              onChange={(e) => setTenantQuery(e.target.value)}
            />
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {emails.length === 0
              ? "Todavía no hay envíos registrados."
              : "No hay envíos que coincidan con los filtros."}
          </p>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Fecha</th>
                  <th className="py-2 pr-3 font-medium">Asunto</th>
                  <th className="py-2 pr-3 font-medium">Destinatario</th>
                  <th className="py-2 pr-3 font-medium">Negocio</th>
                  <th className="py-2 pr-3 font-medium">Tipo</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className="border-b border-border/60">
                    <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                      {fmtDate(e.created_at)}
                    </td>
                    <td className="py-2 pr-3">{e.subject}</td>
                    <td className="py-2 pr-3">{e.recipient}</td>
                    <td className="py-2 pr-3">{e.tenantName ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {KIND_LABELS[e.kind] ?? e.kind}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusChip email={e} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
