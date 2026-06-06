# H9b PR1 — Infra de plantillas + editor de bloques + email de comprobante

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabla `ticket_templates` multi-modelo, editor de bloques con preview en vivo, integración en TicketModal/A4, y envío del comprobante por email (manual, reenvío y automático).

**Architecture:** Una tabla JSONB por tenant guarda plantillas (`mode: blocks` en este PR). Un componente puro `TicketRenderer(blocks, data)` renderiza en editor, ticket térmico, A4 (vía PNG→jsPDF) y email (PNG adjunto por Edge Function que reusa el SMTP del sistema). Fallback: sin plantilla se renderizan los bloques default que replican el ticket actual.

**Tech Stack:** Next.js App Router, Supabase (Postgres+RLS, Edge Functions), TanStack Query, html2canvas, jspdf, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-h9b-ticket-designer-design.md`

**Branch:** `feature/h9b-ticket-designer` (desde `main`).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `supabase/migrations/20260606120000_ticket_templates.sql` | Crear | tabla + RLS + columnas de email en `sales` y `pos_settings` |
| `lib/tickets/blocks.ts` | Crear | tipos de bloques, defaults, factoría de plantilla inicial |
| `lib/tickets/sample.ts` | Crear | venta de muestra para preview |
| `lib/tickets/exportPng.ts` | Crear | nodo DOM → PNG dataURL (html2canvas, imágenes inlineadas) |
| `modules/tickets/api.ts` | Crear | CRUD `ticket_templates` + resolución de default |
| `modules/tickets/hooks.ts` | Crear | hooks TanStack Query |
| `components/tickets/TicketRenderer.tsx` | Crear | render puro de bloques |
| `components/tickets/TicketTemplateEditor.tsx` | Crear | editor (lista de bloques + settings + preview) |
| `components/tickets/TicketTemplatesCard.tsx` | Crear | listado/CRUD de modelos en Configuración |
| `components/sales/TicketModal.tsx` | Modificar | usar renderer + botón email + auto-email |
| `components/sales/SendReceiptEmail.tsx` | Crear | botón/flujo de envío con input de email |
| `app/(app)/configuracion/page.tsx` | Modificar | sección "Tickets" |
| `app/(app)/ventas/page.tsx` | Modificar | acción "Enviar por email" por venta |
| `components/dashboard-team/OperationSettingsCard.tsx` | Modificar | toggle `auto_email_receipt` |
| `supabase/functions/send_receipt_email/index.ts` | Crear | Edge Function de envío |
| `tests/unit/ticket-blocks.test.ts` | Crear | unit de defaults/factoría |
| `tests/unit/ticket-renderer.test.tsx` | Crear | unit del renderer |
| `tests/integration/rls.test.ts` | Modificar | aislamiento de `ticket_templates` |

---

### Task 1: Rama + dependencia

- [ ] **Step 1.1:** `git checkout main && git pull && git checkout -b feature/h9b-ticket-designer`
- [ ] **Step 1.2:** `pnpm add html2canvas` (única dep nueva). Verificar lockfile actualizado.
- [ ] **Step 1.3:** Commit: `chore(h9b): rama + html2canvas`

### Task 2: Migración

**Files:** Create `supabase/migrations/20260606120000_ticket_templates.sql`

- [ ] **Step 2.1: Escribir migración**

```sql
-- H9b (F6) — Plantillas de ticket multi-modelo por tenant + email de comprobante.
-- Modos: blocks (PR1), canvas/html (PR2, mismo esquema).

create table if not exists ticket_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  kind        text not null default 'sale' check (kind in ('sale','promo','gift')),
  mode        text not null default 'blocks' check (mode in ('blocks','canvas','html')),
  paper       text not null default '80' check (paper in ('58','80','a4')),
  content     jsonb not null default '{"blocks":[]}'::jsonb,
  show_ninjasoft_logo boolean not null default false,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_ticket_templates_tenant on ticket_templates(tenant_id);
-- Un solo default activo por tipo de documento por tenant.
create unique index if not exists uq_ticket_templates_default
  on ticket_templates(tenant_id, kind) where is_default and deleted_at is null;

create trigger set_updated_at_ticket_templates
  before update on ticket_templates
  for each row execute function set_updated_at();

alter table ticket_templates enable row level security;

create policy ticket_templates_select on ticket_templates
  for select using (tenant_id = current_tenant_id() or is_internal());

create policy ticket_templates_write on ticket_templates
  for all
  using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  )
  with check (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner','manager')
    )
  );

-- Email del comprobante: registro del último envío + setting de envío automático.
alter table sales add column if not exists receipt_email_to text;
alter table sales add column if not exists receipt_emailed_at timestamptz;
alter table pos_settings add column if not exists auto_email_receipt boolean not null default false;
```

- [ ] **Step 2.2:** Aplicar en remoto vía MCP `apply_migration` (name: `ticket_templates`) — proyecto POS (`hrkditzrsavehnhngakb`, pinneado en `.mcp.json`).
- [ ] **Step 2.3:** Regenerar tipos: MCP `generate_typescript_types` → reemplazar `types/database.ts`. Verificar que aparece `ticket_templates` y las columnas nuevas.
- [ ] **Step 2.4:** Commit: `feat(h9b): tabla ticket_templates + RLS + email de comprobante (schema)`

### Task 3: Modelo de bloques + venta de muestra (TDD)

**Files:** Create `lib/tickets/blocks.ts`, `lib/tickets/sample.ts`, `tests/unit/ticket-blocks.test.ts`

- [ ] **Step 3.1: Test que falla**

```ts
// tests/unit/ticket-blocks.test.ts
import { describe, expect, it } from "vitest";
import { defaultSaleBlocks, newBlock, BLOCK_LABELS } from "@/lib/tickets/blocks";

describe("ticket blocks", () => {
  it("defaultSaleBlocks replica el ticket actual (orden y tipos)", () => {
    const types = defaultSaleBlocks().map((b) => b.type);
    expect(types).toEqual([
      "logo", "business", "title", "separator", "saleInfo", "separator",
      "items", "separator", "totals", "separator", "payments", "qr", "footer",
    ]);
  });
  it("cada bloque default tiene id único", () => {
    const ids = defaultSaleBlocks().map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("newBlock crea bloque con defaults por tipo", () => {
    const b = newBlock("text");
    expect(b.type).toBe("text");
    expect(b.id).toBeTruthy();
    if (b.type === "text") expect(b.text).toBe("Texto");
  });
  it("hay label para cada tipo", () => {
    for (const t of Object.keys(BLOCK_LABELS)) expect(BLOCK_LABELS[t as keyof typeof BLOCK_LABELS]).toBeTruthy();
  });
});
```

- [ ] **Step 3.2:** `pnpm vitest run tests/unit/ticket-blocks.test.ts` → FAIL (módulo no existe).
- [ ] **Step 3.3: Implementar `lib/tickets/blocks.ts`**

```ts
// H9b — Modelo de bloques del ticket. El content JSONB de ticket_templates
// (mode: blocks) es { blocks: TicketBlock[] }. Ver spec 2026-06-06-h9b.
export type Align = "left" | "center" | "right";
export type TextSize = "sm" | "md" | "lg";

interface Base {
  id: string;
  hidden?: boolean;
}
export type TicketBlock =
  | (Base & { type: "logo" })
  | (Base & { type: "business"; showLegalName?: boolean; showCuit?: boolean; showAddress?: boolean; showPhone?: boolean })
  | (Base & { type: "title"; text?: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "saleInfo"; showNumber?: boolean; showDate?: boolean })
  | (Base & { type: "customer" })
  | (Base & { type: "items"; showUnitPrice?: boolean })
  | (Base & { type: "totals" })
  | (Base & { type: "payments" })
  | (Base & { type: "qr" })
  | (Base & { type: "barcode" })
  | (Base & { type: "text"; text: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "image"; url: string; widthPct?: number; align?: Align })
  | (Base & { type: "separator" })
  | (Base & { type: "footer"; text?: string });

export type BlockType = TicketBlock["type"];

export interface BlocksContent {
  blocks: TicketBlock[];
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  logo: "Logo del negocio",
  business: "Datos del negocio",
  title: "Título",
  saleInfo: "Datos de la venta",
  customer: "Cliente",
  items: "Ítems",
  totals: "Totales",
  payments: "Medios de pago",
  qr: "QR del comprobante",
  barcode: "Código de barras",
  text: "Texto libre",
  image: "Imagen",
  separator: "Separador",
  footer: "Pie",
};

const uid = () => Math.random().toString(36).slice(2, 10);

export function newBlock(type: BlockType): TicketBlock {
  const id = uid();
  switch (type) {
    case "text":
      return { id, type, text: "Texto", align: "center", size: "md" };
    case "image":
      return { id, type, url: "", widthPct: 100, align: "center" };
    case "title":
      return { id, type, align: "center", size: "md" };
    case "items":
      return { id, type, showUnitPrice: false };
    case "saleInfo":
      return { id, type, showNumber: true, showDate: true };
    case "business":
      return { id, type, showLegalName: true, showCuit: true, showAddress: true, showPhone: true };
    default:
      return { id, type } as TicketBlock;
  }
}

// Replica del ticket hard-coded actual (TicketModal) como plantilla inicial.
export function defaultSaleBlocks(): TicketBlock[] {
  return [
    newBlock("logo"),
    newBlock("business"),
    newBlock("title"),
    newBlock("separator"),
    newBlock("saleInfo"),
    newBlock("separator"),
    newBlock("items"),
    newBlock("separator"),
    newBlock("totals"),
    newBlock("separator"),
    newBlock("payments"),
    newBlock("qr"),
    newBlock("footer"),
  ];
}
```

- [ ] **Step 3.4: Implementar `lib/tickets/sample.ts`**

```ts
// Venta ficticia para el preview del editor.
import type { TicketData } from "@/components/tickets/TicketRenderer";

export function sampleTicketData(brand: TicketData["brand"]): TicketData {
  return {
    sale: {
      number: 1042,
      numberLabel: "#0001042",
      created_at: new Date("2026-06-06T16:30:00").toISOString(),
      subtotal: 14500,
      discount_total: 500,
      total: 14000,
      status: "completed",
    },
    items: [
      { id: "s1", product_name: "Remera básica negra M", quantity: 2, unit_price: 4500, subtotal: 9000 },
      { id: "s2", product_name: "Gorra trucker", quantity: 1, unit_price: 3500, subtotal: 3500 },
      { id: "s3", product_name: "Medias pack x3", quantity: 1, unit_price: 2000, subtotal: 2000 },
    ],
    payments: [
      { id: "p1", method: "cash", amount: 10000 },
      { id: "p2", method: "transfer", amount: 4000 },
    ],
    customer: { name: "Juan Pérez", email: "juan@example.com" },
    brand,
  };
}
```

- [ ] **Step 3.5:** `pnpm vitest run tests/unit/ticket-blocks.test.ts` → PASS.
- [ ] **Step 3.6:** Commit: `feat(h9b): modelo de bloques + venta de muestra`

### Task 4: TicketRenderer (TDD)

**Files:** Create `components/tickets/TicketRenderer.tsx`, `tests/unit/ticket-renderer.test.tsx`

- [ ] **Step 4.1: Test que falla**

```tsx
// tests/unit/ticket-renderer.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketRenderer } from "@/components/tickets/TicketRenderer";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
import { sampleTicketData } from "@/lib/tickets/sample";

const brand = {
  logo_url: null, legal_name: "Mi Kiosco SRL", cuit: "30-11111111-1",
  phone: "11 5555-5555", address: "Av. Siempre Viva 123", ticket_footer: "¡Gracias!",
  ticket_width: "80", ticket_title: "Comprobante no fiscal", ticket_legend: null,
  ticket_show_qr: false, ticket_show_logo: true,
};

describe("TicketRenderer", () => {
  it("renderiza bloques default con datos de muestra", () => {
    render(<TicketRenderer blocks={defaultSaleBlocks()} data={sampleTicketData(brand)} paper="80" showNinjaLogo={false} />);
    expect(screen.getByText("Mi Kiosco SRL")).toBeDefined();
    expect(screen.getByText(/Remera básica/)).toBeDefined();
    expect(screen.getByText("TOTAL")).toBeDefined();
    expect(screen.getByText(/Comprobante #0001042/)).toBeDefined();
  });
  it("omite bloques hidden", () => {
    const blocks = defaultSaleBlocks().map((b) => (b.type === "totals" ? { ...b, hidden: true } : b));
    render(<TicketRenderer blocks={blocks} data={sampleTicketData(brand)} paper="80" showNinjaLogo={false} />);
    expect(screen.queryByText("TOTAL")).toBeNull();
  });
  it("muestra footer NinjaSoft cuando showNinjaLogo", () => {
    render(<TicketRenderer blocks={[]} data={sampleTicketData(brand)} paper="58" showNinjaLogo />);
    expect(screen.getByAltText("NinjaSoft")).toBeDefined();
  });
  it("bloque texto respeta contenido", () => {
    render(
      <TicketRenderer
        blocks={[{ id: "x", type: "text", text: "2x1 los miércoles" }]}
        data={sampleTicketData(brand)} paper="80" showNinjaLogo={false}
      />,
    );
    expect(screen.getByText("2x1 los miércoles")).toBeDefined();
  });
});
```

- [ ] **Step 4.2:** `pnpm vitest run tests/unit/ticket-renderer.test.tsx` → FAIL.
- [ ] **Step 4.3: Implementar `components/tickets/TicketRenderer.tsx`**

```tsx
"use client";

// H9b — Render puro de una plantilla de bloques. Lo usan: editor (preview),
// TicketModal (térmica), A4/PDF y el email (export a PNG). Sin fetches.
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { code39Segments } from "@/lib/barcode/code39";
import type { Align, TextSize, TicketBlock } from "@/lib/tickets/blocks";

export interface TicketData {
  sale: {
    number: number;
    numberLabel: string;
    created_at: string;
    subtotal: number;
    discount_total: number;
    total: number;
    status: string;
  };
  items: { id: string; product_name: string; quantity: number; unit_price: number; subtotal: number }[];
  payments: { id: string; method: string; amount: number }[];
  customer?: { name: string; email?: string | null } | null;
  brand: {
    logo_url: string | null;
    legal_name: string | null;
    cuit: string | null;
    phone: string | null;
    address: string | null;
    ticket_footer: string | null;
    ticket_width: string | null;
    ticket_title: string | null;
    ticket_legend: string | null;
    ticket_show_qr: boolean | null;
    ticket_show_logo: boolean | null;
  } | null;
}

const alignCls = (a?: Align) =>
  a === "left" ? "text-left" : a === "right" ? "text-right" : "text-center";
const sizeCls = (s?: TextSize) =>
  s === "sm" ? "text-[10px]" : s === "lg" ? "text-base" : "text-xs";

function Barcode({ value }: { value: string }) {
  let segs;
  try {
    segs = code39Segments(value, 3);
  } catch {
    return null;
  }
  const total = segs.reduce((a, s) => a + s.width, 0);
  let x = 0;
  return (
    <svg viewBox={`0 0 ${total} 40`} className="mx-auto h-10 w-full max-w-[60mm]" preserveAspectRatio="none">
      {segs.map((s, i) => {
        const r = s.on ? <rect key={i} x={x} y={0} width={s.width} height={40} fill="black" /> : null;
        x += s.width;
        return r;
      })}
    </svg>
  );
}

interface Props {
  blocks: TicketBlock[];
  data: TicketData;
  paper: "58" | "80" | "a4";
  showNinjaLogo: boolean;
  className?: string;
}

export function TicketRenderer({ blocks, data, paper, showNinjaLogo, className }: Props) {
  const { sale, items, payments, customer, brand } = data;
  const width = paper === "58" ? "58mm" : paper === "80" ? "80mm" : "210mm";

  const renderBlock = (b: TicketBlock) => {
    if (b.hidden) return null;
    switch (b.type) {
      case "logo":
        return brand?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={b.id} src={brand.logo_url} alt="" className="mx-auto mb-1 h-12 w-auto object-contain" />
        ) : null;
      case "business":
        return (
          <div key={b.id} className="text-center">
            {b.showLegalName !== false && (
              <div className="font-display text-base font-bold">{brand?.legal_name || "NinjaSoft POS"}</div>
            )}
            <div className="text-[10px] leading-tight text-muted-foreground">
              {b.showCuit !== false && brand?.cuit && <div>CUIT {brand.cuit}</div>}
              {b.showAddress !== false && brand?.address && <div>{brand.address}</div>}
              {b.showPhone !== false && brand?.phone && <div>{brand.phone}</div>}
            </div>
          </div>
        );
      case "title":
        return (
          <div key={b.id} className={`${alignCls(b.align)} ${sizeCls(b.size)} ${b.bold ? "font-bold" : ""} text-muted-foreground`}>
            {b.text || brand?.ticket_title || "Comprobante no fiscal"}
          </div>
        );
      case "saleInfo":
        return (
          <div key={b.id} className="flex justify-between text-xs text-muted-foreground">
            {b.showNumber !== false && <span>Comprobante {sale.numberLabel}</span>}
            {b.showDate !== false && <span>{new Date(sale.created_at).toLocaleString("es-AR")}</span>}
          </div>
        );
      case "customer":
        return customer?.name ? (
          <div key={b.id} className="text-xs text-muted-foreground">Cliente: {customer.name}</div>
        ) : null;
      case "items":
        return (
          <ul key={b.id} className="space-y-1">
            {items.map((it) => (
              <li key={it.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {formatQty(it.quantity)}× {it.product_name}
                  {b.showUnitPrice && ` (${formatCurrency(it.unit_price)})`}
                </span>
                <span>{formatCurrency(it.subtotal)}</span>
              </li>
            ))}
          </ul>
        );
      case "totals":
        return (
          <div key={b.id}>
            <div className="flex justify-between text-xs">
              <span>Subtotal</span>
              <span>{formatCurrency(sale.subtotal)}</span>
            </div>
            {sale.discount_total > 0 && (
              <div className="flex justify-between text-xs">
                <span>Descuento</span>
                <span>-{formatCurrency(sale.discount_total)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-base font-bold">
              <span>TOTAL</span>
              <span>{formatCurrency(sale.total)}</span>
            </div>
          </div>
        );
      case "payments":
        return (
          <div key={b.id}>
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between text-xs">
                <span>{METHOD_LABELS[p.method] ?? p.method}</span>
                <span>{formatCurrency(p.amount)}</span>
              </div>
            ))}
          </div>
        );
      case "qr":
        return (
          <div key={b.id} className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
                `${brand?.legal_name || "NinjaPos"} | ${sale.numberLabel} | ${formatCurrency(sale.total)} | ${new Date(sale.created_at).toLocaleString("es-AR")}`,
              )}`}
              alt="QR del comprobante"
              width={110}
              height={110}
              className="h-[110px] w-[110px]"
            />
          </div>
        );
      case "barcode":
        return <div key={b.id}><Barcode value={String(sale.number)} /></div>;
      case "text":
        return (
          <div key={b.id} className={`${alignCls(b.align)} ${sizeCls(b.size)} ${b.bold ? "font-bold" : ""} whitespace-pre-wrap`}>
            {b.text}
          </div>
        );
      case "image":
        return b.url ? (
          <div key={b.id} className={alignCls(b.align)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.url} alt="" style={{ width: `${b.widthPct ?? 100}%` }} className="inline-block" />
          </div>
        ) : null;
      case "separator":
        return <div key={b.id} className="my-3 border-t border-dashed border-border" />;
      case "footer":
        return (
          <div key={b.id} className="text-center">
            <div className="text-xs text-muted-foreground">{b.text || brand?.ticket_footer || "¡Gracias por su compra!"}</div>
            {brand?.ticket_legend && (
              <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{brand.ticket_legend}</div>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`mx-auto space-y-2 rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground ${className ?? ""}`}
      style={{ width, maxWidth: "100%" }}
    >
      {blocks.map(renderBlock)}
      {data.sale.status === "voided" && (
        <div className="mt-3 text-center text-xs font-bold text-red-500">** ANULADA **</div>
      )}
      {showNinjaLogo && (
        <div className="mt-3 flex justify-center opacity-70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/ninjasoft-wordmark.webp" alt="NinjaSoft" className="h-4 w-auto" />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4.4:** `pnpm vitest run tests/unit/ticket-renderer.test.tsx` → PASS. (Si jsdom no resuelve `formatCurrency` con Intl es-AR, los asserts usan regex/labels — ajustar assert, no la impl.)
- [ ] **Step 4.5:** Commit: `feat(h9b): TicketRenderer de bloques`

### Task 5: API + hooks de plantillas

**Files:** Create `modules/tickets/api.ts`, `modules/tickets/hooks.ts`

- [ ] **Step 5.1: `modules/tickets/api.ts`**

```ts
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { BlocksContent } from "@/lib/tickets/blocks";

export type TicketTemplate = Tables<"ticket_templates">;
export type TemplateKind = "sale" | "promo" | "gift";

export interface TemplateInput {
  name: string;
  kind: TemplateKind;
  mode: "blocks";
  paper: "58" | "80" | "a4";
  content: BlocksContent;
  show_ninjasoft_logo: boolean;
}

export const ticketTemplatesApi = {
  list: async (): Promise<TicketTemplate[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_templates")
      .select("*")
      .is("deleted_at", null)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as TicketTemplate[];
  },

  getDefault: async (kind: TemplateKind): Promise<TicketTemplate | null> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("ticket_templates")
      .select("*")
      .eq("kind", kind)
      .eq("is_default", true)
      .is("deleted_at", null)
      .maybeSingle();
    return (data as TicketTemplate | null) ?? null;
  },

  create: async (tenantId: string, input: TemplateInput): Promise<TicketTemplate> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_templates")
      .insert({ tenant_id: tenantId, ...input, content: input.content as never })
      .select("*")
      .single();
    if (error) throw error;
    return data as TicketTemplate;
  },

  update: async (id: string, input: Partial<TemplateInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("ticket_templates")
      .update({ ...input, content: input.content as never })
      .eq("id", id);
    if (error) throw error;
  },

  // Marca default: primero desmarca el actual del mismo kind (índice único parcial).
  setDefault: async (id: string, kind: TemplateKind): Promise<void> => {
    const supabase = createClient();
    const { error: e1 } = await supabase
      .from("ticket_templates")
      .update({ is_default: false })
      .eq("kind", kind)
      .eq("is_default", true);
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from("ticket_templates")
      .update({ is_default: true })
      .eq("id", id);
    if (e2) throw e2;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("ticket_templates")
      .update({ deleted_at: new Date().toISOString(), is_default: false })
      .eq("id", id);
    if (error) throw error;
  },
};
```

- [ ] **Step 5.2: `modules/tickets/hooks.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ticketTemplatesApi, type TemplateInput, type TemplateKind } from "./api";

const KEY = ["ticket-templates"];

export function useTicketTemplates() {
  return useQuery({ queryKey: KEY, queryFn: ticketTemplatesApi.list });
}

export function useDefaultTemplate(kind: TemplateKind, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "default", kind],
    enabled,
    queryFn: () => ticketTemplatesApi.getDefault(kind),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ tenantId, input }: { tenantId: string; input: TemplateInput }) =>
      ticketTemplatesApi.create(tenantId, input),
    onSuccess: inv,
  });
}

export function useUpdateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<TemplateInput> }) =>
      ticketTemplatesApi.update(id, input),
    onSuccess: inv,
  });
}

export function useSetDefaultTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: TemplateKind }) =>
      ticketTemplatesApi.setDefault(id, kind),
    onSuccess: inv,
  });
}

export function useRemoveTemplate() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: ticketTemplatesApi.remove, onSuccess: inv });
}
```

- [ ] **Step 5.3:** `pnpm typecheck` → PASS.
- [ ] **Step 5.4:** Commit: `feat(h9b): api + hooks de ticket_templates`

### Task 6: Editor + listado en Configuración

**Files:** Create `components/tickets/TicketTemplateEditor.tsx`, `components/tickets/TicketTemplatesCard.tsx`; Modify `app/(app)/configuracion/page.tsx`

- [ ] **Step 6.1: `components/tickets/TicketTemplatesCard.tsx`** — listado + alta + acciones. Patrón visual de `PaymentMethodsCard`/`WarrantyPlansManager` (Card + tabla + Modal). Funcionalidad: listar (nombre, tipo, modo, papel, default), botones Nuevo (abre editor con `defaultSaleBlocks()`), Editar, Duplicar (create con mismo content y nombre "… (copia)"), Default (useSetDefaultTemplate), Eliminar (confirm + useRemoveTemplate). El tenant activo sale del store de sesión igual que en `BrandingCard` (revisar import exacto ahí: hook/contexto del tenant actual; usar el mismo).

- [ ] **Step 6.2: `components/tickets/TicketTemplateEditor.tsx`** — modal a pantalla casi completa (`Modal` con `className="max-w-5xl"`), dos columnas:
  - **Izquierda:** inputs nombre / kind (`Segmented`: Venta·Promo·Gift) / papel (`Segmented`: 58·80·A4) / toggle "Logo NinjaSoft al pie"; lista de bloques: una fila por bloque con label (`BLOCK_LABELS`), botones ↑ ↓ (reordenar), ojo (toggle `hidden`), ✕ (quitar), y chevron que expande settings del bloque (según tipo: text → textarea + align + size + bold; image → url + ancho %; title → text + align + size; items → showUnitPrice; saleInfo → showNumber/showDate; business → 4 toggles). Select "Agregar bloque" con los 14 tipos (`newBlock`).
  - **Derecha:** preview en vivo: `<TicketRenderer blocks={blocks} data={sampleTicketData(brand)} paper={paper} showNinjaLogo={showNinja} />` (brand del hook `useBranding` — extraerlo de TicketModal a `modules/tickets/hooks.ts` como `useTicketBranding()` exportado, y que TicketModal lo importe de ahí).
  - Estado local con `useState<TicketBlock[]>`; helpers `move(i, dir)`, `patch(id, partial)`, `removeBlock(id)`, `add(type)`.
  - Guardar → `useCreateTemplate`/`useUpdateTemplate` con `content: { blocks }`. Botón "Imprimir" (para promos): `window.print()` sobre el preview con clase `ticket-print`.

- [ ] **Step 6.3: Sección en Configuración** — en `app/(app)/configuracion/page.tsx`: agregar `"tickets"` al type `Section` y a `SECTIONS` (label "Tickets", icon `ReceiptText` de lucide), y render `{section === "tickets" && <TicketTemplatesCard />}`. Visible solo owner/manager: mismo guard que usa la sección "operacion" (revisar cómo gatea `OperationSettingsCard` y replicar).

- [ ] **Step 6.4:** `pnpm lint && pnpm typecheck` → PASS. Prueba manual: crear plantilla, reordenar, guardar, marcar default.
- [ ] **Step 6.5:** Commit: `feat(h9b): editor de bloques + listado de modelos en Configuración`

### Task 7: Integración TicketModal + A4

**Files:** Modify `components/sales/TicketModal.tsx`

- [ ] **Step 7.1:** En `TicketModal`: cargar plantilla default con `useDefaultTemplate("sale", open)`. Armar `TicketData` desde `data` (SaleDetail) + `brand` + `numFmt` (`numberLabel: formatSaleNumber(...)`). Reemplazar el markup hard-coded por:

```tsx
const blocks = tpl?.mode === "blocks" && (tpl.content as { blocks?: TicketBlock[] })?.blocks?.length
  ? (tpl.content as { blocks: TicketBlock[] }).blocks
  : defaultSaleBlocks();
const paper = (tpl?.paper as "58" | "80" | "a4") ?? (brand?.ticket_width === "58" ? "58" : "80");
// dentro del JSX:
<div ref={ticketRef}>
  <TicketRenderer blocks={blocks} data={ticketData} paper={paper} showNinjaLogo={!!tpl?.show_ninjasoft_logo} className="ticket-print" />
</div>
```

Respetar compat: sin plantilla, `defaultSaleBlocks()` + flags de branding viejos (`ticket_show_qr === false` → filtrar bloque qr; `ticket_show_logo === false` → filtrar logo) para que el resultado sea idéntico al actual.

- [ ] **Step 7.2:** Botón A4: si hay plantilla → `exportNodePng(ticketRef.current)` (Task 8) y `jsPDF.addImage` centrado en A4; si no → `downloadTicketPdf` legacy intacto.
- [ ] **Step 7.3:** `pnpm vitest run` (suite completa) + prueba manual: ticket con y sin plantilla, impresión térmica, A4.
- [ ] **Step 7.4:** Commit: `feat(h9b): TicketModal renderiza la plantilla default`

### Task 8: Export a PNG

**Files:** Create `lib/tickets/exportPng.ts`

- [ ] **Step 8.1:**

```ts
// Nodo DOM → PNG dataURL. Inlinea <img> remotas a dataURL antes de html2canvas
// para evitar canvas tainted (QR de qrserver, logo de Storage).
import html2canvas from "html2canvas";

async function inlineImages(node: HTMLElement): Promise<() => void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  const restores: { img: HTMLImageElement; src: string }[] = [];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:") || src.startsWith("/")) return;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((ok, err) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result));
          r.onerror = err;
          r.readAsDataURL(blob);
        });
        restores.push({ img, src });
        img.src = dataUrl;
      } catch {
        // Imagen inaccesible: se oculta para no romper el export.
        restores.push({ img, src });
        img.style.display = "none";
      }
    }),
  );
  return () => restores.forEach(({ img, src }) => {
    img.src = src;
    img.style.display = "";
  });
}

export async function exportNodePng(node: HTMLElement): Promise<string> {
  const restore = await inlineImages(node);
  try {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
    return canvas.toDataURL("image/png");
  } finally {
    restore();
  }
}
```

- [ ] **Step 8.2:** `pnpm typecheck` → PASS.
- [ ] **Step 8.3:** Commit: `feat(h9b): export del ticket a PNG`

### Task 9: Edge Function `send_receipt_email`

**Files:** Create `supabase/functions/send_receipt_email/index.ts`

- [ ] **Step 9.1:** Basada en `send_email` (mismo CORS/json helpers/SMTP), con estas diferencias:
  - Guard: usuario autenticado **miembro activo del tenant de la venta** (no `is_internal`): body trae `sale_id`; con el client service_role buscar `sales.tenant_id` y validar `tenant_users` (user_id, tenant_id, status='active'). 404 si la venta no existe, 403 si no es miembro.
  - Body: `{ sale_id: string, to: string, png: string }` — `png` dataURL (`data:image/png;base64,...`), límite 2 MB (rechazar más con 413).
  - Envío: `attachments: [{ filename: "comprobante.png", content: <base64 sin prefijo>, encoding: "base64", contentType: "image/png" }]` con denomailer; html simple: `<p>Comprobante de ${legal_name}</p><img src="cid:..." />` — si denomailer no soporta cid inline, mandar solo adjunto + texto (decisión en implementación, adjunto es lo obligatorio).
  - Post-envío (service_role): `update sales set receipt_email_to = to, receipt_emailed_at = now() where id = sale_id` + insert en `audit_logs` `{ tenant_id, actor_user_id: user.id, entity_type: 'sale', entity_id: sale_id, action: 'receipt_emailed', after_data: { to } }`.

```ts
// Esqueleto completo (adaptar SMTP idéntico a send_email):
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  let b: { sale_id?: string; to?: string; png?: string };
  try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const saleId = String(b.sale_id ?? "");
  const to = String(b.to ?? "").trim().toLowerCase();
  const png = String(b.png ?? "");
  if (!saleId) return json({ error: "missing_sale_id" }, 400);
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
  if (!png.startsWith("data:image/png;base64,")) return json({ error: "invalid_png" }, 400);
  const base64 = png.slice("data:image/png;base64,".length);
  if (base64.length > 2_800_000) return json({ error: "png_too_large" }, 413);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: sale } = await admin.from("sales").select("id, tenant_id, number").eq("id", saleId).maybeSingle();
  if (!sale) return json({ error: "sale_not_found" }, 404);
  const { data: member } = await admin
    .from("tenant_users").select("user_id")
    .eq("tenant_id", sale.tenant_id).eq("user_id", user.id).eq("status", "active").maybeSingle();
  if (!member) return json({ error: "forbidden" }, 403);

  const { data: cfg } = await admin.from("system_email_smtp").select("*").eq("id", true).maybeSingle();
  if (!cfg?.host || !cfg?.from_email)
    return json({ error: "smtp_not_configured" }, 400);
  const { data: brand } = await admin
    .from("tenant_branding").select("legal_name").eq("tenant_id", sale.tenant_id).maybeSingle();
  const name = brand?.legal_name || "NinjaSoft POS";

  const client = new SMTPClient({
    connection: {
      hostname: cfg.host,
      port: cfg.port || 587,
      tls: !!cfg.secure,
      auth: cfg.username ? { username: cfg.username, password: cfg.password } : undefined,
    },
  });
  try {
    await client.send({
      from: `${name} <${cfg.from_email}>`,
      to,
      subject: `Tu comprobante de ${name}`,
      content: `Adjuntamos tu comprobante de compra. ¡Gracias!`,
      html: `<p>Adjuntamos tu comprobante de compra de <b>${name}</b>. ¡Gracias!</p>`,
      attachments: [{ filename: `comprobante-${sale.number}.png`, content: base64, encoding: "base64", contentType: "image/png" }],
    });
    await client.close();
  } catch (e) {
    try { await client.close(); } catch (_) { /* noop */ }
    return json({ error: "send_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
  await admin.from("sales").update({ receipt_email_to: to, receipt_emailed_at: new Date().toISOString() }).eq("id", saleId);
  await admin.from("audit_logs").insert({
    tenant_id: sale.tenant_id,
    actor_user_id: user.id,
    entity_type: "sale",
    entity_id: saleId,
    action: "receipt_emailed",
    after_data: { to },
  });
  return json({ ok: true });
});
```

- [ ] **Step 9.2:** Deploy vía MCP `deploy_edge_function` (name: `send_receipt_email`).
- [ ] **Step 9.3:** Commit: `feat(h9b): Edge Function send_receipt_email`

### Task 10: UI de envío (manual + reenvío + automático)

**Files:** Create `components/sales/SendReceiptEmail.tsx`; Modify `components/sales/TicketModal.tsx`, `app/(app)/ventas/page.tsx`, `components/dashboard-team/OperationSettingsCard.tsx`

- [ ] **Step 10.1: `SendReceiptEmail.tsx`** — componente botón + mini-form:
  - Props: `{ saleId: string; ticketNode: () => HTMLElement | null; defaultEmail?: string | null; sentTo?: string | null; sentAt?: string | null; onSent?: () => void }`.
  - UI: botón "Enviar por email" (icon `Mail`); si `sentAt`, texto secundario "Enviado a {sentTo} {fecha relativa}" y el botón dice "Reenviar".
  - Click → si no hay `defaultEmail`, input inline para cargar email (+ checkbox "Guardar en la ficha del cliente" si la venta tiene `customer_id` → update `customers.email`).
  - Envío: `exportNodePng(ticketNode())` → `supabase.functions.invoke("send_receipt_email", { body: { sale_id, to, png } })` → toast éxito/error (helper de toast existente en `components/ui/Toast`).
- [ ] **Step 10.2: TicketModal** — agregar `<SendReceiptEmail …/>` en la fila de botones; `defaultEmail` viene del cliente de la venta: extender `salesApi.get` para traer `customers(name, email)` junto a la venta (join como en `salesApi.list`). Pasar `ticketNode={() => ticketRef.current}`.
- [ ] **Step 10.3: Auto-envío** — en TicketModal, `useEffect` cuando `open && data`: si `pos_settings.auto_email_receipt` (leer con el hook de settings existente del POS — el mismo que usa OperationSettingsCard) **y** `data.sale.receipt_emailed_at == null` **y** hay email del cliente → disparar el mismo flujo de envío una sola vez (`ref` anti-doble), fire-and-forget con `catch` a toast silencioso (console.warn). No bloquea impresión.
- [ ] **Step 10.4: /ventas** — en la fila/detalle de venta agregar acción "Enviar por email": abre el TicketModal existente de esa venta (ya existe botón "ver ticket" en /ventas — verificar y reusar; el envío vive dentro del modal). Mostrar indicador "Email ✓" en la fila si `receipt_emailed_at` no es null.
- [ ] **Step 10.5: OperationSettingsCard** — agregar toggle "Enviar comprobante por email automáticamente (si el cliente tiene email)" → columna `pos_settings.auto_email_receipt`, mismo patrón que los toggles existentes de la card.
- [ ] **Step 10.6:** `pnpm lint && pnpm typecheck && pnpm vitest run` → PASS. Prueba manual de los 3 flujos.
- [ ] **Step 10.7:** Commit: `feat(h9b): envío de comprobante por email (manual, reenvío y automático)`

### Task 11: Tests RLS

**Files:** Modify `tests/integration/rls.test.ts`

- [ ] **Step 11.1:** Leer el patrón existente del archivo (tenants A/B, owner/cashier). Agregar describe `ticket_templates`:
  - Owner A crea plantilla → OK.
  - Cashier A intenta crear → error RLS (write solo owner/manager).
  - Owner B no ve la plantilla de A (select cross-tenant vacío).
  - Owner A no puede crear plantilla con `tenant_id` de B (with check).
  Usar los helpers/clients ya definidos en la suite (mismo estilo que los tests de `payment_plans`/`tenant_notes`).
- [ ] **Step 11.2:** Si hay Supabase local: `pnpm test:rls` → PASS. Si no, validar que CI (job `rls`) pase en el PR.
- [ ] **Step 11.3:** Commit: `test(h9b): RLS de ticket_templates`

### Task 12: Docs + PR

- [ ] **Step 12.1:** `CHANGELOG.md`: entrada H9b PR1 (qué entrega, qué queda para PR2: canvas + HTML + 5 plantillas precargadas).
- [ ] **Step 12.2:** `docs/02-roadmap.md`: marcar en H9b los sub-items entregados con `[x]` + evidencia (PR #), dejar canvas/HTML como pendientes.
- [ ] **Step 12.3:** Gates completos: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build` → todos PASS.
- [ ] **Step 12.4:** Push + `gh pr create` (título `feat(h9b): plantillas de ticket + editor de bloques + email de comprobante`). Esperar CI verde. Merge squash.

---

## Self-review (hecho al escribir)

- Cobertura spec PR1: tabla+RLS ✓, multi-modelo+default ✓, bloques (14) ✓, preview ✓, térmica/A4 ✓, email 3 vías ✓, footer NinjaSoft ✓, fallback compat ✓, auditoría ✓. Canvas/HTML/5 plantillas → PR2 (explícito en spec).
- Tipos consistentes entre tasks (TicketBlock/TicketData/TemplateInput) ✓.
- Pasos con código completo donde hay código nuevo; integraciones sobre archivos existentes referencian el patrón a seguir y el archivo exacto ✓.
