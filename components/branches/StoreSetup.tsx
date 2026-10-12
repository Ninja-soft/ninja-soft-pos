"use client";

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { ChoiceDot } from "@/components/ui/ChoiceCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  copyResultMessage,
  defaultParts,
  normalizeParts,
  partsFor,
  templateSummary,
  type SetupPart,
  type SetupSource,
} from "@/lib/branches/storeTemplate";
import type { Branch } from "@/modules/branches/logic";
import {
  templateErrorMessage,
  useStoreTemplateMutations,
  useStoreTemplates,
  type StoreTemplate,
} from "@/modules/branches/templates";

// =============================================================================
// Sucursal nueva "Copiar de" otra sucursal o de una plantilla (F17 · ADR-057).
// Nunca se copian terminales ni credenciales: son de cada local.
// =============================================================================

export interface SetupChoice {
  source: SetupSource;
  fromStore: string | null;
  template: string | null;
  parts: SetupPart[];
}

export const INHERIT_ALL: SetupChoice = { source: "inherit", fromStore: null, template: null, parts: [] };

const fieldCls = "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm";

/** Lo que hay que mandar a store_copy_setup (null = no copiar nada). */
export function setupRequest(c: SetupChoice, templates: StoreTemplate[]) {
  if (c.source === "inherit") return null;
  if (c.source === "store" && !c.fromStore) return null;
  if (c.source === "template" && !c.template) return null;
  const tpl = c.source === "template" ? templates.find((t) => t.id === c.template) : null;
  const parts = normalizeParts(c.parts, c.source, tpl?.parts ?? null);
  if (parts.length === 0) return null;
  return {
    fromStore: c.source === "store" ? c.fromStore : null,
    template: c.source === "template" ? c.template : null,
    parts,
  };
}

export function StoreSetupPicker({
  value,
  onChange,
  branches,
  excludeId,
  allowInherit = true,
}: {
  value: SetupChoice;
  onChange: (v: SetupChoice) => void;
  /** Sucursales vivas a las que el usuario tiene acceso. */
  branches: Branch[];
  excludeId?: string | null;
  allowInherit?: boolean;
}) {
  const { data: templates = [] } = useStoreTemplates();
  const sources = branches.filter((b) => b.id !== excludeId && !b.deleted_at);
  const tpl = value.source === "template" ? templates.find((t) => t.id === value.template) : null;
  const parts = partsFor(value.source, tpl?.parts ?? null);

  const pick = (source: SetupSource) => {
    if (source === "inherit") return onChange(INHERIT_ALL);
    if (source === "store") {
      const from = value.fromStore ?? sources[0]?.id ?? null;
      return onChange({ source, fromStore: from, template: null, parts: defaultParts("store") });
    }
    const t = value.template ? templates.find((x) => x.id === value.template) : templates[0];
    onChange({ source, fromStore: null, template: t?.id ?? null, parts: defaultParts("template", t?.parts ?? null) });
  };

  const options: { key: SetupSource; title: string; desc: string; disabled?: boolean }[] = [
    ...(allowInherit
      ? [{ key: "inherit" as const, title: "Heredar todo del negocio", desc: "Recomendado. Después pisás sólo lo que cambia en esta sucursal." }]
      : []),
    {
      key: "store",
      title: "Copiar de otra sucursal",
      desc: sources.length ? "La deja igual a una que ya funciona." : "Todavía no hay otra sucursal.",
      disabled: sources.length === 0,
    },
    {
      key: "template",
      title: "Usar una plantilla",
      desc: templates.length ? "Una configuración guardada para locales parecidos." : "Guardá una desde el menú de una sucursal.",
      disabled: templates.length === 0,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Configuración inicial">
        {options.map((o) => {
          const on = value.source === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={o.disabled}
              onClick={() => pick(o.key)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                on ? "choice-on" : "border-border bg-card hover:bg-muted",
              )}
            >
              <ChoiceDot selected={on} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{o.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {value.source === "store" && (
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Sucursal de origen</span>
          <select
            value={value.fromStore ?? ""}
            onChange={(e) => onChange({ ...value, fromStore: e.target.value || null })}
            className={fieldCls}
          >
            {sources.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {value.source === "template" && (
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">Plantilla</span>
          <select
            value={value.template ?? ""}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              onChange({ ...value, template: t?.id ?? null, parts: defaultParts("template", t?.parts ?? null) });
            }}
            className={fieldCls}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {tpl && <TemplateLine template={tpl} />}
        </label>
      )}

      {parts.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm text-muted-foreground">Qué se copia</legend>
          {parts.map((p) => {
            const on = value.parts.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() =>
                  onChange({ ...value, parts: on ? value.parts.filter((x) => x !== p.key) : [...value.parts, p.key] })
                }
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
              >
                <ChoiceDot selected={on} multiple className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm">{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{p.desc}</span>
                </span>
              </button>
            );
          })}
          <p className="pt-1 text-xs text-muted-foreground">
            Terminales y credenciales de cobro no se copian: se cargan en cada sucursal.
          </p>
        </fieldset>
      )}
    </div>
  );
}

function TemplateLine({ template }: { template: StoreTemplate }) {
  const s = templateSummary(template.payload);
  const bits = [
    s.config ? `${s.config} ajustes` : null,
    s.paymentMethods ? `${s.paymentMethods} medios` : null,
    s.printers ? `${s.printers} impresoras` : null,
    s.plans ? `${s.plans} planes` : null,
  ].filter(Boolean);
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      {template.description ? `${template.description}. ` : ""}
      {bits.length ? `Trae ${bits.join(", ")}.` : "No trae ajustes propios."}
    </span>
  );
}

/** Aplica la configuración elegida a una sucursal ya creada. */
export function useApplySetup() {
  const { toast } = useToast();
  const { data: templates = [] } = useStoreTemplates();
  const m = useStoreTemplateMutations();
  return {
    pending: m.copySetup.isPending,
    apply: async (target: string, choice: SetupChoice): Promise<boolean> => {
      const req = setupRequest(choice, templates);
      if (!req) return true;
      try {
        const counts = await m.copySetup.mutateAsync({ target, ...req });
        toast({ title: "Configuración copiada", description: copyResultMessage(counts), variant: "success" });
        return true;
      } catch (e) {
        toast({ title: "La sucursal se creó, pero no se pudo copiar la configuración", description: templateErrorMessage(e), variant: "error" });
        return false;
      }
    },
  };
}

// ── Copiar configuración a una sucursal existente ───────────────────────────

export function CopySetupModal({
  open,
  onOpenChange,
  target,
  branches,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: Branch | null;
  branches: Branch[];
}) {
  const [choice, setChoice] = useState<SetupChoice>(INHERIT_ALL);
  const { apply, pending } = useApplySetup();
  const { data: templates = [] } = useStoreTemplates(open);
  const sources = branches.filter((b) => b.id !== target?.id && !b.deleted_at);

  useEffect(() => {
    if (!open) return;
    const first = sources[0]?.id ?? null;
    setChoice(
      first
        ? { source: "store", fromStore: first, template: null, parts: defaultParts("store") }
        : { source: "template", fromStore: null, template: templates[0]?.id ?? null, parts: defaultParts("template", templates[0]?.parts ?? null) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id]);

  const req = setupRequest(choice, templates);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={target ? `Copiar configuración a ${target.name}` : "Copiar configuración"}
      description="Suma o pisa lo que la sucursal personalizó. Lo que no se copia sigue como estaba."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={!req || !target}
            onClick={async () => {
              if (!target) return;
              if (await apply(target.id, choice)) onOpenChange(false);
            }}
          >
            Copiar
          </Button>
        </>
      }
    >
      <StoreSetupPicker value={choice} onChange={setChoice} branches={branches} excludeId={target?.id} allowInherit={false} />
    </Modal>
  );
}

// ── Guardar una sucursal como plantilla ─────────────────────────────────────

export function SaveTemplateModal({
  open,
  onOpenChange,
  from,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  from: Branch | null;
}) {
  const { toast } = useToast();
  const m = useStoreTemplateMutations();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [parts, setParts] = useState<SetupPart[]>(defaultParts("template"));
  const options = useMemo(() => partsFor("template"), []);

  useEffect(() => {
    if (!open) return;
    setName(from ? `Como ${from.name}` : "");
    setDesc("");
    setParts(defaultParts("template"));
  }, [open, from]);

  async function save() {
    if (!from) return;
    try {
      await m.save.mutateAsync({ name: name.trim(), fromStore: from.id, parts, description: desc.trim() || null });
      toast({ title: "Plantilla guardada", description: "La vas a ver al crear una sucursal.", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: templateErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Guardar como plantilla"
      description={from ? `Una foto de lo que ${from.name} personalizó hoy. Si después cambiás la sucursal, la plantilla no cambia.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={m.save.isPending} disabled={!name.trim() || parts.length === 0} onClick={save}>
            Guardar plantilla
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <Input label="Descripción (opcional)" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} placeholder="Ej.: local de shopping con dos cajas" />
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm text-muted-foreground">Qué guarda</legend>
          {options.map((p) => {
            const on = parts.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => setParts(on ? parts.filter((x) => x !== p.key) : [...parts, p.key])}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
              >
                <ChoiceDot selected={on} multiple className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm">{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{p.desc}</span>
                </span>
              </button>
            );
          })}
        </fieldset>
      </div>
    </Modal>
  );
}

// ── Plantillas guardadas ────────────────────────────────────────────────────

export function StoreTemplatesModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { data: templates = [], isLoading } = useStoreTemplates(open);
  const m = useStoreTemplateMutations();
  const [del, setDel] = useState<StoreTemplate | null>(null);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Plantillas de sucursal" className="sm:max-w-lg">
      <div className="space-y-3">
        {!isLoading && templates.length === 0 && (
          <Callout title="Todavía no hay plantillas">
            Desde el menú de una sucursal, &quot;Guardar como plantilla&quot; guarda lo que personalizó para usarlo al crear otras.
          </Callout>
        )}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <TemplateLine template={t} />
              </div>
              <button
                type="button"
                onClick={() => setDel(t)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Borrar la plantilla ${t.name}`}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={del !== null}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Borrar "${del?.name ?? ""}"`}
        description="Las sucursales creadas con esta plantilla no cambian."
        confirmLabel="Borrar"
        danger
        onConfirm={async () => {
          if (!del) return;
          try {
            await m.remove.mutateAsync(del.id);
            toast({ title: "Plantilla borrada", variant: "success" });
          } catch (e) {
            toast({ title: templateErrorMessage(e), variant: "error" });
          }
          setDel(null);
        }}
      />
    </Modal>
  );
}
