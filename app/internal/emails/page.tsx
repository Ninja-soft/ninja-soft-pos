"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plus, Send } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
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

export default function InternalEmailsPage() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedKey, setSelectedKey] = useState(EMAIL_TEMPLATES[0]!.key);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [smtp, setSmtp] = useState({
    host: "",
    port: "587",
    secure: false,
    username: "",
    password: "",
    from_name: "NinjaPos",
    from_email: "",
  });
  const [hasPassword, setHasPassword] = useState(false);

  const { data: smtpCfg } = useQuery({
    queryKey: ["system-email-smtp"],
    queryFn: async () => {
      const { data } = await supabase.rpc("get_email_smtp");
      return (data as Record<string, unknown> | null) ?? null;
    },
  });
  useEffect(() => {
    if (smtpCfg) {
      setSmtp((s) => ({
        ...s,
        host: String(smtpCfg.host ?? ""),
        port: String(smtpCfg.port ?? "587"),
        secure: !!smtpCfg.secure,
        username: String(smtpCfg.username ?? ""),
        from_name: String(smtpCfg.from_name ?? "NinjaPos"),
        from_email: String(smtpCfg.from_email ?? ""),
        password: "",
      }));
      setHasPassword(!!smtpCfg.has_password);
    }
  }, [smtpCfg]);
  const setS = (k: keyof typeof smtp, v: string | boolean) =>
    setSmtp((s) => ({ ...s, [k]: v }));

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

  const saveCfg = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke("set_email_smtp", {
        body: { ...smtp, port: Number(smtp.port) || 587 },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "SMTP guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["system-email-smtp"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

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

  const sendTest = useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const vars = sampleVars("NinjaPos");
      const { data, error } = await supabase.functions.invoke("send_email", {
        body: {
          to: user?.email,
          subject: renderTemplate(subject, vars),
          html: renderTemplate(html, vars),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () =>
      toast({ title: "Email de prueba enviado", variant: "success" }),
    onError: (e) =>
      toast({
        title: "No se pudo enviar",
        description: e instanceof Error ? e.message : "Revisá la configuración SMTP.",
        variant: "error",
      }),
  });

  const vars = sampleVars("NinjaPos");

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Emails del sistema</Display>
      <p className="mt-2 text-muted-foreground">
        Editá los emails que NinjaPos envía a los usuarios y configurá el remitente.
      </p>

      {/* SMTP del remitente (config propia, sin secrets de backend) */}
      <Card className="mt-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <Send size={16} /> Servidor de envío (SMTP)
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Servidor SMTP"
              placeholder="smtp.gmail.com"
              value={smtp.host}
              onChange={(e) => setS("host", e.target.value)}
            />
            <Input
              label="Puerto"
              inputMode="numeric"
              placeholder="587"
              value={smtp.port}
              onChange={(e) => setS("port", e.target.value.replace(/\D/g, ""))}
            />
            <Input
              label="Usuario"
              placeholder="tu@email.com"
              value={smtp.username}
              onChange={(e) => setS("username", e.target.value)}
            />
            <Input
              label={hasPassword ? "Contraseña (dejar vacío para no cambiar)" : "Contraseña"}
              type="password"
              placeholder={hasPassword ? "••••••••" : ""}
              value={smtp.password}
              onChange={(e) => setS("password", e.target.value)}
            />
            <Input
              label="Nombre del remitente"
              value={smtp.from_name}
              onChange={(e) => setS("from_name", e.target.value)}
            />
            <Input
              label="Email del remitente"
              type="email"
              placeholder="hola@tudominio.com"
              value={smtp.from_email}
              onChange={(e) => setS("from_email", e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="accent-ninja-flame"
              checked={smtp.secure}
              onChange={(e) => setS("secure", e.target.checked)}
            />
            Conexión segura (SSL/TLS, puerto 465)
          </label>
          <div className="flex justify-end">
            <Button onClick={() => saveCfg.mutate()} disabled={saveCfg.isPending}>
              Guardar SMTP
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Usá tu propio email (ej. Gmail con contraseña de aplicación, o el SMTP de
            tu hosting). No requiere servicios pagos ni secrets externos.
          </p>
        </CardContent>
      </Card>

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
              onClick={() => sendTest.mutate()}
              disabled={sendTest.isPending}
            >
              <Send size={16} /> Enviar prueba
            </Button>
            <Button onClick={() => saveTpl.mutate()} disabled={saveTpl.isPending}>
              Guardar plantilla
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
