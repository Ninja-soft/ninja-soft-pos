"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Inbox, Info, Mail, Plus, RefreshCw, Send, Server, Zap, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
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
import { EmailPreviewFrame } from "@/components/email/EmailPreviewFrame";
import { ACCOUNT_EMAIL_PREVIEWS } from "@/lib/email/accountTemplates";
import { cn } from "@/lib/utils/cn";
import { NoData } from "@/components/ui/NoData";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { SearchField } from "@/components/ui/SearchField";
import { Skeleton } from "@/components/ui/Skeleton";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { IntegrationLogo, isIntegrationKey } from "@/components/ui/IntegrationLogo";

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

  // Emails de cuenta corriente: sólo vista previa (los envía cada negocio).
  const accountPreview = ACCOUNT_EMAIL_PREVIEWS.find((t) => t.key === selectedKey) ?? null;
  const def = EMAIL_TEMPLATES.find((t) => t.key === selectedKey) ?? EMAIL_TEMPLATES[0]!;
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
      <PageHeader
        eyebrow="Operaciones"
        title="Emails del sistema"
        icon={Mail}
        description={
          <>
            Editá los emails que NinjaPos envía a los usuarios y configurá los proveedores de envío.
          </>
        }
      />

      {/* Proveedores de email (Resend + failover SMTP). Camino de envío principal. */}
      <EmailProvidersCard />

      {/* Plantillas */}
      <section className="mt-10">
        <SectionHeader
          title="Plantillas"
          icon={FileText}
          description="Elegí un email para editar el asunto y el contenido. La vista previa usa datos de ejemplo."
        />
        <div className="mt-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
          {/* Riel horizontal en mobile; columna fija en desktop. */}
          <nav
            aria-label="Plantillas de email"
            className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] lg:flex-col lg:overflow-visible lg:rounded-lg lg:border lg:border-border lg:bg-card lg:p-2 [&::-webkit-scrollbar]:hidden"
          >
            <TemplateGroupLabel>Sistema</TemplateGroupLabel>
            {EMAIL_TEMPLATES.map((t) => (
              <TemplateTab
                key={t.key}
                label={t.label}
                active={selectedKey === t.key}
                edited={Boolean(saved[t.key])}
                onClick={() => setSelectedKey(t.key)}
              />
            ))}
            <TemplateGroupLabel className="lg:mt-2">Cuenta corriente</TemplateGroupLabel>
            {ACCOUNT_EMAIL_PREVIEWS.map((t) => (
              <TemplateTab
                key={t.key}
                label={t.label}
                active={selectedKey === t.key}
                onClick={() => setSelectedKey(t.key)}
              />
            ))}
          </nav>
          <Card className="min-w-0">
            <CardContent className="space-y-5 p-4 sm:p-5">
          {accountPreview ? (
            <AccountEmailPreviewPanel preview={accountPreview} />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{def.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{def.description}</p>
                </div>
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
                <label htmlFor="email-html" className="mb-2 block text-sm font-medium text-muted-foreground">
                  Contenido (HTML)
                </label>
                <textarea
                  id="email-html"
                  ref={htmlRef}
                  value={html}
                  spellCheck={false}
                  onFocus={() => setActiveField("html")}
                  onChange={(e) => setHtml(e.target.value)}
                  rows={7}
                  className="slim-scrollbar w-full rounded-lg border border-input bg-background p-3 font-mono text-xs text-foreground outline-none transition focus:border-foreground/30"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Tocá un campo (asunto o contenido) y después “Insertar variable”.
                </p>
              </div>
              <EmailPreview subject={renderTemplate(subject, vars)} html={renderTemplate(html, vars)} />
              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTestEmail("");
                    setTestOpen(true);
                  }}
                >
                  <Send size={16} /> Enviar prueba
                </Button>
                <Button onClick={() => saveTpl.mutate()} loading={saveTpl.isPending}>
                  Guardar plantilla
                </Button>
              </div>
            </>
          )}
            </CardContent>
          </Card>
        </div>
      </section>

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

// ── Vista previa de emails de cuenta corriente (no editables) ───────────────

function AccountEmailPreviewPanel({ preview }: { preview: (typeof ACCOUNT_EMAIL_PREVIEWS)[number] }) {
  const mail = preview.render();
  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <p className="font-semibold text-foreground">{preview.label}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{preview.description}</p>
      </div>
      <Callout tone="info" icon={Info}>
        Sólo vista previa con datos de ejemplo: cada negocio lo envía con su propio email, su logo y su color.
      </Callout>
      <EmailPreview subject={mail.subject} html={mail.html} />
    </div>
  );
}

// Vista previa del email: el sobre siempre es blanco (así lo ve el cliente de
// correo), con el asunto arriba.
function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-muted-foreground">Vista previa</div>
      <div className="overflow-hidden rounded-lg border border-border bg-white text-sm text-neutral-900">
        <div className="truncate border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500">
          <span className="font-semibold text-neutral-700">Asunto:</span> {subject}
        </div>
        <EmailPreviewFrame html={html} minHeight={640} />
      </div>
    </div>
  );
}

function TemplateGroupLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 self-center px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground lg:self-auto lg:pb-1 lg:pt-1.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

function TemplateTab({
  label,
  active,
  edited = false,
  onClick,
}: {
  label: string;
  active: boolean;
  edited?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition lg:w-full",
        active
          ? "choice-on font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {edited && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ninja-flameSoft"
          title="Editada por el staff"
          aria-label="Editada"
        />
      )}
    </button>
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
    <section className="mt-8">
      <SectionHeader
        title="Proveedores de envío"
        icon={Zap}
        description={
          <>
            El principal se usa siempre; el de respaldo entra solo si el principal falla.
            Cada uno puede ser Resend (recomendado) o un SMTP propio.
          </>
        }
      />
      {providers === undefined ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Cargando proveedores">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
      )}
    </section>
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
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm font-semibold">{title}</div>
        <label className="flex shrink-0 items-center gap-2">
          <Badge tone={state.is_active ? "success" : "neutral"}>
            {state.is_active ? "Activo" : "Inactivo"}
          </Badge>
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
                ? "choice-on"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {opt.key === "resend" ? (
              <IntegrationLogo name="resend" size={18} />
            ) : (
              <opt.icon size={14} />
            )}{" "}
            {opt.label}
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
                      "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition",
                      smtpPreset === p.key
                        ? "choice-on"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {isIntegrationKey(p.key) ? (
                      <IntegrationLogo name={p.key} size={16} />
                    ) : (
                      <Server size={13} />
                    )}
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
            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2.5 text-sm text-foreground">
              <span>Conexión segura (SSL/TLS, puerto 465)</span>
              <Switch
                checked={state.smtp_secure}
                onCheckedChange={(v) => set({ smtp_secure: v })}
                label="Conexión segura"
              />
            </div>
          </>
        )}

        <div className="flex justify-end border-t border-border pt-3">
          <Button size="sm" onClick={onSave} loading={saving}>
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
  const tone = email.status === "sent" ? "success" : email.status === "failed" ? "danger" : "warning";
  return (
    <Badge
      tone={tone}
      title={email.status === "failed" ? email.error_message ?? undefined : undefined}
    >
      {label}
    </Badge>
  );
}

// Origen del envío: "negocios" = originado por un tenant (comprobante o prueba
// SMTP del negocio); "sistema" = emails del sistema NinjaPos.
type OriginFilter = "todos" | "negocios" | "sistema";
const ORIGIN_FILTERS: { value: OriginFilter; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "negocios", label: "Negocios" },
  { value: "sistema", label: "Sistema" },
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

  // Despacha los emails del sistema en cola (pending + failed reintentables).
  // El auto-envío real lo hace un cron (pg_cron + pg_net) cada 5 min vía
  // process_pending_emails (por Resend/failover); este botón es un disparo
  // MANUAL para no esperar al próximo tick.
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
          negocio: e.tenantName ?? "",
          tipo: KIND_LABELS[e.kind] ?? e.kind,
          estado: STATUS_LABELS[e.status] ?? e.status,
          error: e.error_message ?? "",
        })),
      },
    ]);
  }

  return (
    <section className="mt-10">
      <SectionHeader
        title="Bitácora de envíos"
        icon={Inbox}
        description="Lo último que salió por los proveedores. Los pendientes se procesan solos cada 5 minutos."
        actions={
          <>
            <Button
              size="sm"
              onClick={() => processPending.mutate()}
              loading={processPending.isPending}
            >
              <Send size={15} /> Procesar pendientes
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="Actualizar"
            >
              <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
              <span className="hidden sm:inline">Actualizar</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onExport}
              disabled={filtered.length === 0}
            >
              <Download size={15} /> Exportar
            </Button>
          </>
        }
      />

      {/* Filtros: origen (segmentado) + búsqueda por negocio. */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented
          value={origin}
          options={ORIGIN_FILTERS}
          onChange={setOrigin}
          aria-label="Origen del envío"
          size="sm"
        />
        <SearchField
          value={tenantQuery}
          onValueChange={setTenantQuery}
          placeholder="Filtrar por negocio"
          aria-label="Filtrar por negocio"
          className="sm:max-w-xs"
        />
        {!isLoading && emails.length > 0 && (
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {filtered.length} de {emails.length}
          </span>
        )}
      </div>

      <TableWrap className="mt-3">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-semibold">Email</th>
              <th className="hidden px-4 py-3 font-semibold md:table-cell">Negocio</th>
              <th className="hidden px-4 py-3 font-semibold lg:table-cell">Tipo</th>
              <th className="px-4 py-3 font-semibold">Estado</th>
              <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Fecha</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && <TableStateRow colSpan={5} loading />}
            {!isLoading && filtered.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState
                  compact
                  icon={emails.length === 0 ? Mail : Search}
                  title={
                    emails.length === 0
                      ? "Acá vas a ver cada email que se envíe"
                      : "Ningún envío coincide con los filtros"
                  }
                />
              </TableStateRow>
            )}
            {!isLoading &&
              filtered.map((e) => (
                <tr key={e.id} className="align-top transition hover:bg-muted/40">
                  <td className="max-w-[18rem] px-4 py-3">
                    <div className="truncate font-medium text-foreground">{e.subject}</div>
                    <div className="truncate text-xs text-muted-foreground">{e.recipient}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                      {fmtDate(e.created_at)}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">{e.tenantName ?? <NoData />}</td>
                  <td className="hidden px-4 py-3 lg:table-cell">
                    <Badge>{KIND_LABELS[e.kind] ?? e.kind}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip email={e} />
                    {e.status === "failed" && e.error_message && (
                      <p className="mt-1 max-w-[16rem] truncate text-xs text-danger" title={e.error_message}>
                        {e.error_message}
                      </p>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {fmtDate(e.created_at)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}
