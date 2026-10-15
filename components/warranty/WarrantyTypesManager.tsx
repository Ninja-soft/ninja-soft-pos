"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Archive, Eye, Pencil, Plus, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatCategoryPath, pathToCategory } from "@/lib/products/categoryPath";
import { monthsLabel, pricingSummary, sortPlans, warrantyUnitPrice, type CategoryNodeLike } from "@/lib/warranty/pricing";
import { useCategories } from "@/modules/products/hooks";
import { warrantyErrorMessage, type WarrantyScope, type WarrantyType } from "@/modules/warranty/api";
import { useWarrantyCatalog, useWarrantyMutations } from "@/modules/warranty/hooks";
import { EXAMPLE_PRICE, WarrantyTypeEditor, type WarrantyTemplate } from "./WarrantyTypeEditor";
import { WarrantyPreview } from "./WarrantyPreview";

const TEMPLATES: WarrantyTemplate[] = [
  { label: "+12 meses", months: 12, price_pct: 10, description: "Extiende la garantía un año más" },
  { label: "+24 meses", months: 24, price_pct: 18, description: "Dos años más de cobertura" },
  { label: "Protección total", months: 12, price_pct: 15, description: "Fallas y rotura accidental" },
];

interface Chip {
  key: string;
  text: string;
  tone: "neutral" | "success";
}

function scopeChips(plan: WarrantyType, scopes: WarrantyScope[], categories: CategoryNodeLike[]): Chip[] {
  const cats = categories.map((c) => ({ id: c.id, name: c.name ?? "", parent_id: c.parent_id }));
  const mine = scopes.filter((s) => s.plan_id === plan.id);
  const live = new Set(categories.filter((c) => !c.deleted_at).map((c) => c.id));
  const chips: Chip[] = [
    { key: "base", text: plan.applies_to_all ? "Todos los productos" : "Sólo lo elegido", tone: plan.applies_to_all ? "success" : "neutral" },
  ];
  for (const s of mine) {
    if (!s.category_id || !live.has(s.category_id)) continue;
    const path = formatCategoryPath(pathToCategory(s.category_id, cats));
    chips.push({ key: s.category_id, text: s.effect === "include" ? path : `Sin ${path}`, tone: s.effect === "include" ? "success" : "neutral" });
  }
  const pin = mine.filter((s) => s.product_id && s.effect === "include").length;
  const pout = mine.filter((s) => s.product_id && s.effect === "exclude").length;
  if (pin) chips.push({ key: "pin", text: `+${pin} ${pin === 1 ? "producto" : "productos"}`, tone: "success" });
  if (pout) chips.push({ key: "pout", text: `Sin ${pout} ${pout === 1 ? "producto" : "productos"}`, tone: "neutral" });
  return chips;
}

// Configuración de garantías extendidas (ADR-139): una tarjeta por tipo con
// su precio, el ejemplo sobre un producto de $100.000 y a qué se asigna.
export function WarrantyTypesManager() {
  const { toast } = useToast();
  const { data, isLoading } = useWarrantyCatalog(true);
  const { data: categories } = useCategories();
  const { setActive, archive, reorder } = useWarrantyMutations();
  const [editing, setEditing] = useState<{ plan: WarrantyType | null; template: WarrantyTemplate | null } | null>(null);
  const [archiving, setArchiving] = useState<WarrantyType | null>(null);
  const [preview, setPreview] = useState(false);

  const plans = useMemo(() => sortPlans(data?.plans ?? []), [data?.plans]);
  const scopes = data?.scopes ?? [];
  const cats = (categories ?? []) as CategoryNodeLike[];

  function move(i: number, dir: -1 | 1) {
    const ids = plans.map((p) => p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids, { onError: (e) => toast({ title: warrantyErrorMessage(e), variant: "error" }) });
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        icon={ShieldCheck}
        title="Tipos de garantía"
        description="Armá las garantías que ofrecés al cobrar, con su % sobre el precio, y elegí en qué productos aparecen."
        actions={
          <>
            <Button size="sm" onClick={() => setEditing({ plan: null, template: null })}>
              <Plus size={15} /> Nueva garantía
            </Button>
            {plans.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setPreview((v) => !v)} aria-expanded={preview}>
                <Eye size={15} /> {preview ? "Ocultar vista previa" : "Vista previa"}
              </Button>
            )}
          </>
        }
      />

      {preview && plans.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-sm font-semibold text-foreground">¿Qué ofrece un producto?</p>
          <WarrantyPreview plans={plans} scopes={scopes} categories={cats} />
        </div>
      )}

      {isLoading ? (
        <SpinnerBlock />
      ) : plans.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            icon={ShieldCheck}
            title="Todavía no ofrecés garantías extendidas"
            description="Sumá un ingreso extra en cada venta de electro, celulares o herramientas. Empezá con una de estas y ajustala a tu negocio."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {TEMPLATES.map((t) => (
                  <Button key={t.label} size="sm" variant="secondary" onClick={() => setEditing({ plan: null, template: t })}>
                    <Plus size={14} /> {t.label} · {t.price_pct}%
                  </Button>
                ))}
              </div>
            }
          />
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((p, i) => {
            const chips = scopeChips(p, scopes, cats);
            const shown = chips.slice(0, 4);
            const more = chips.length - shown.length;
            const pct = Number(p.price_pct);
            return (
              <li key={p.id} className={cn("flex flex-col rounded-lg border border-border bg-card p-4", !p.is_active && "opacity-75")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-foreground">{p.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      +{monthsLabel(p.months)}
                      {Number(p.commission_pct) > 0 ? ` · comisión ${Number(p.commission_pct)}%` : ""}
                    </p>
                  </div>
                  <Badge tone={p.is_active ? "success" : "neutral"}>{p.is_active ? "Activa" : "Pausada"}</Badge>
                </div>

                <div className="mt-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="font-price text-3xl font-semibold leading-none tabular-nums text-foreground">
                      {pct > 0 ? `${String(pct).replace(".", ",")}%` : formatCurrency(Number(p.price))}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{pct > 0 ? "del precio del producto" : "por unidad"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">En {formatCurrency(EXAMPLE_PRICE)}</p>
                    <p className="font-price text-sm font-semibold tabular-nums text-foreground">
                      +{formatCurrency(warrantyUnitPrice(p, EXAMPLE_PRICE))}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{pricingSummary(p, formatCurrency)}</p>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {shown.map((c) => (
                    <Badge key={c.key} tone={c.tone} className="max-w-full truncate font-medium">
                      {c.text}
                    </Badge>
                  ))}
                  {more > 0 && <Badge tone="neutral">+{more}</Badge>}
                </div>
                {p.description && <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>}

                <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
                  <Switch
                    checked={p.is_active}
                    onCheckedChange={(v) =>
                      setActive.mutate(
                        { id: p.id, active: v },
                        { onError: (e) => toast({ title: warrantyErrorMessage(e), variant: "error" }) },
                      )
                    }
                    label="Activa"
                  />
                  <div className="flex items-center gap-0.5">
                    <IconBtn label={`Subir ${p.label}`} disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                      <ArrowUp size={15} />
                    </IconBtn>
                    <IconBtn
                      label={`Bajar ${p.label}`}
                      disabled={i === plans.length - 1 || reorder.isPending}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown size={15} />
                    </IconBtn>
                    <IconBtn label={`Archivar ${p.label}`} onClick={() => setArchiving(p)}>
                      <Archive size={15} />
                    </IconBtn>
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ plan: p, template: null })}>
                      <Pencil size={14} /> Editar
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <WarrantyTypeEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        plan={editing?.plan ?? null}
        template={editing?.template ?? null}
        scopes={scopes}
        categories={cats}
      />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`¿Archivar ${archiving?.label ?? "la garantía"}?`}
        description="Deja de ofrecerse en el POS. Las ventas que ya la tienen la siguen mostrando con su vencimiento."
        confirmLabel="Archivar"
        danger
        loading={archive.isPending}
        onConfirm={() =>
          archiving &&
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ title: "Garantía archivada", variant: "success" });
              setArchiving(null);
            },
            onError: (e) => toast({ title: warrantyErrorMessage(e), variant: "error" }),
          })
        }
      />
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
