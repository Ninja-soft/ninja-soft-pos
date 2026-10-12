import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { Paged } from "@/lib/utils/pagination";
import { sanitizeIlike } from "@/lib/utils/search";
import type { CustomerOutput, CustomerRequired } from "./schemas";
import type { ParsedCustomer } from "./import";

export type Customer = Tables<"customers">;

function payload(input: CustomerOutput) {
  return {
    name: input.name,
    document_type: input.document_type ?? null,
    document_number: input.document_number,
    iva_condition: input.iva_condition ?? null,
    email: input.email,
    phone: input.phone,
    address: input.address,
    birth_date: input.birth_date,
    notes: input.notes,
    // preferences (H40): texto libre de gustos del cliente. Aún no está en los
    // tipos generados (no se regeneran); el payload se castea al insertar/actualizar.
    preferences: input.preferences,
    is_active: input.is_active,
    credit_limit: input.credit_limit ?? 0,
    group_id: input.group_id ?? null,
  };
}

const DAY_MS = 86_400_000;

// Movimiento de cuenta corriente para el cálculo FIFO.
export type AccountMovement = {
  delta: number | string | null;
  created_at: string;
  due_date?: string | null;
};

// Cargo impago que sobrevive al cálculo FIFO.
export type RemainingCharge = { amount: number; date: number; due: number };

// FIFO: los pagos (delta < 0) cancelan los cargos (delta > 0) más viejos
// primero. Devuelve los cargos que siguen impagos (parcial o totalmente), cada
// uno con su monto remanente, su fecha y su vencimiento. Si el cargo no tiene
// `due_date` (datos viejos), se asume vencimiento = fecha + 30 días.
export function remainingCharges(
  movements: AccountMovement[],
): RemainingCharge[] {
  const ordered = [...movements].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const charges: RemainingCharge[] = [];
  for (const m of ordered) {
    const delta = Number(m.delta) || 0;
    if (delta > 0) {
      const date = new Date(m.created_at).getTime();
      const due = m.due_date
        ? new Date(m.due_date + "T00:00:00").getTime()
        : date + 30 * DAY_MS;
      charges.push({ amount: delta, date, due });
    } else if (delta < 0) {
      let pay = -delta;
      while (pay > 0 && charges.length > 0) {
        const head = charges[0]!;
        if (head.amount <= pay) {
          pay -= head.amount;
          charges.shift();
        } else {
          head.amount -= pay;
          pay = 0;
        }
      }
    }
  }
  return charges;
}

export type CustomerGroup = Tables<"customer_groups">;

export const customerGroupsApi = {
  list: async (activeOnly = true): Promise<CustomerGroup[]> => {
    const supabase = createClient();
    let q = supabase.from("customer_groups").select("*").order("sort").order("name");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as CustomerGroup[];
  },
  create: async (name: string): Promise<CustomerGroup> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("customer_groups")
      .insert({ name })
      .select("*")
      .single();
    if (error) throw error;
    return data as CustomerGroup;
  },
};

export const customersApi = {
  // Config del tenant: qué campos del cliente son obligatorios (H31) + si el
  // documento (tipo + número) es obligatorio (require_customer_doc, default true).
  requiredFields: async (): Promise<{
    fields: CustomerRequired;
    requireDoc: boolean;
  }> => {
    const supabase = createClient();
    // require_customer_doc aún no está en los tipos generados (no se regeneran):
    // leemos con select("*") y casteamos vía unknown.
    const { data } = await supabase
      .from("pos_settings")
      .select("*")
      .maybeSingle();
    const row = (data as unknown as {
      customer_required?: CustomerRequired;
      require_customer_doc?: boolean;
    } | null) ?? null;
    return {
      fields: (row?.customer_required ?? {}) as CustomerRequired,
      // Default true: si no hay fila o la columna viene nula, se pide el documento.
      requireDoc: row?.require_customer_doc ?? true,
    };
  },

  // Cumpleaños del mes (H40 base): clientes con fecha de nacimiento cuyo mes
  // coincide con `month` (0-11). Ordenados por día. Solo lectura.
  birthdays: async (
    month: number,
  ): Promise<{ id: string; name: string; phone: string | null; email: string | null; birth_date: string; day: number }[]> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("customers")
      .select("id, name, phone, email, birth_date")
      .is("deleted_at", null)
      .not("birth_date", "is", null);
    return (data ?? [])
      .filter((c) => c.birth_date && new Date(c.birth_date + "T00:00:00").getMonth() === month)
      .map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        birth_date: c.birth_date as string,
        day: new Date((c.birth_date as string) + "T00:00:00").getDate(),
      }))
      .sort((a, b) => a.day - b.day);
  },

  // Saldo a favor (vale) del cliente = suma de movimientos de store credit.
  storeCreditBalance: async (customerId: string): Promise<number> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("store_credit_movements")
      .select("delta")
      .eq("customer_id", customerId);
    return (data ?? []).reduce((acc, r) => acc + Number(r.delta || 0), 0);
  },

  // Historial del cliente: saldo a favor + ventas + devoluciones.
  // (Cuenta corriente v2: el aging y el cobro de deuda viven en accountApi, por
  // RPC server-side; acá sólo el saldo y el próximo vencimiento para la ficha.)
  history: async (
    customerId: string,
  ): Promise<{
    creditBalance: number;
    accountDebt: number;
    nextDue: number | null;
    sales: { id: string; number: number; total: number; status: string; created_at: string }[];
    returns: { id: string; number: number; total: number; refund_method: string; created_at: string }[];
  }> => {
    const supabase = createClient();
    const [creditRes, debtRes, salesRes, returnsRes] = await Promise.all([
      supabase.from("store_credit_movements").select("delta").eq("customer_id", customerId),
      supabase
        .from("customer_account_movements")
        .select("delta, created_at, due_date")
        .eq("customer_id", customerId)
        .is("voided_at", null),
      supabase
        .from("sales")
        .select("id, number, total, status, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("sale_returns")
        .select("id, number, total, refund_method, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    const charges = remainingCharges((debtRes.data ?? []) as AccountMovement[]);
    const nextDue =
      charges.length > 0 ? Math.min(...charges.map((c) => c.due)) : null;
    return {
      creditBalance: (creditRes.data ?? []).reduce((a, r) => a + Number(r.delta || 0), 0),
      accountDebt: (debtRes.data ?? []).reduce((a, r) => a + Number(r.delta || 0), 0),
      nextDue,
      sales: (salesRes.data ?? []) as never,
      returns: (returnsRes.data ?? []) as never,
    };
  },

  // Ítems de la ÚLTIMA venta completada del cliente (H40 — recompra rápida
  // "Repetir última venta"). Devuelve las líneas crudas (sin resolver precios):
  // el POS las mapea al carrito resolviendo el precio ACTUAL del producto y
  // omitiendo los productos dados de baja. Sólo ventas 'completed' (no anuladas).
  lastSaleItems: async (
    customerId: string,
  ): Promise<{
    saleId: string;
    saleNumber: number;
    createdAt: string;
    customerName: string | null;
    items: {
      product_id: string | null;
      product_name: string;
      quantity: number;
      unit_price: number;
      variant_id: string | null;
    }[];
  } | null> => {
    const supabase = createClient();
    // Trae el nombre del cliente en el mismo query (join) para que el POS lo
    // seleccione sin un fetch extra (no depende de listar clientes).
    const { data: lastSale } = await supabase
      .from("sales")
      .select("id, number, created_at, customers(name)")
      .eq("customer_id", customerId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lastSale) return null;
    const { data: items } = await supabase
      .from("sale_items")
      .select("product_id, product_name, quantity, unit_price, variant_id")
      .eq("sale_id", lastSale.id);
    return {
      saleId: lastSale.id,
      saleNumber: lastSale.number,
      createdAt: lastSale.created_at,
      customerName:
        (lastSale as unknown as { customers: { name: string } | null }).customers
          ?.name ?? null,
      items: (items ?? []) as {
        product_id: string | null;
        product_name: string;
        quantity: number;
        unit_price: number;
        variant_id: string | null;
      }[],
    };
  },

  // Próximos turnos del cliente (H40, reusa H38 · appointments). Turnos FUTUROS
  // (starts_at >= ahora) no cancelados ni ya realizados, ordenados por fecha.
  // appointments aún no está en los tipos generados (no se regeneran): cast.
  upcomingAppointments: async (
    customerId: string,
  ): Promise<
    {
      id: string;
      service_name: string;
      starts_at: string;
      duration_min: number;
      status: string;
      professionals: { name: string } | null;
    }[]
  > => {
    const supabase = createClient();
    const { data } = await supabase
      .from("appointments" as never)
      .select(
        "id, service_name, starts_at, duration_min, status, professionals(name)",
      )
      .eq("customer_id", customerId)
      .gte("starts_at", new Date().toISOString())
      .not("status", "in", "(cancelado,realizado,no_show)")
      .order("starts_at")
      .limit(20);
    return (data ?? []) as unknown as {
      id: string;
      service_name: string;
      starts_at: string;
      duration_min: number;
      status: string;
      professionals: { name: string } | null;
    }[];
  },

  list: async (search?: string): Promise<Customer[]> => {
    const supabase = createClient();
    let q = supabase
      .from("customers")
      .select("*")
      .is("deleted_at", null)
      .order("name")
      .limit(200);
    const s = sanitizeIlike(search);
    if (s) q = q.or(`name.ilike.%${s}%,document_number.ilike.%${s}%`);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Customer[];
  },

  // Selector de cliente del POS — BAJO CONSUMO DE DATOS.
  //
  // Sin búsqueda: trae sólo los N clientes más recientes (created_at desc), no el
  // padrón entero. Con búsqueda: filtra server-side por nombre / documento /
  // teléfono (ilike saneado) con un límite chico. Reemplaza el list() de hasta
  // 200 filas en cada apertura del modal.
  forPicker: async (search?: string, limit = 10): Promise<Customer[]> => {
    const supabase = createClient();
    const s = sanitizeIlike(search);
    if (!s) {
      // Recientes: los últimos cargados (proxy de "últimos usados" sin join).
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as Customer[];
    }
    // Búsqueda server-side por nombre / documento / teléfono, limitada.
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .is("deleted_at", null)
      .or(`name.ilike.%${s}%,document_number.ilike.%${s}%,phone.ilike.%${s}%`)
      .order("name")
      .limit(20);
    if (error) throw error;
    return (data ?? []) as Customer[];
  },

  // Listado paginado server-side (.range + count exact). Búsqueda server-side por
  // nombre o documento (ilike, saneada). Carga solo la página pedida.
  listPaged: async (params: {
    page: number; // 1-based
    pageSize: number;
    search?: string;
  }): Promise<Paged<Customer>> => {
    const supabase = createClient();
    const { page, pageSize, search } = params;
    const start = Math.max(0, (page - 1) * pageSize);
    const end = start + pageSize - 1;

    let q = supabase
      .from("customers")
      .select("*", { count: "exact" })
      .is("deleted_at", null)
      .order("name");
    const s = sanitizeIlike(search);
    if (s) q = q.or(`name.ilike.%${s}%,document_number.ilike.%${s}%`);

    const { data, error, count } = await q.range(start, end);
    if (error) throw error;
    return { rows: (data ?? []) as Customer[], total: count ?? 0 };
  },

  create: async (input: CustomerOutput): Promise<void> => {
    const supabase = createClient();
    // payload incluye `preferences` (H40), aún no tipado: cast a never.
    const { error } = await supabase.from("customers").insert(payload(input) as never);
    if (error) throw error;
  },

  // Alta rápida desde un flujo (p.ej. emitir un vale sin cliente en la venta) que
  // necesita el id del cliente recién creado. Crea un cliente mínimo (nombre +
  // opcionales) y devuelve su id. Cuando el tenant exige documento
  // (require_customer_doc), el llamador valida y pasa tipo + número acá: el alta
  // los persiste igual que el alta completa. El enforcement vive en la UI.
  createQuick: async (input: {
    name: string;
    phone?: string | null;
    email?: string | null;
    document_type?: string | null;
    document_number?: string | null;
    // Fecha de nacimiento (ISO yyyy-mm-dd). El alta rápida desde el DNI escaneado
    // la trae parseada del PDF417 (H31); se persiste igual que el alta completa.
    birth_date?: string | null;
  }): Promise<{ id: string; name: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        document_type: input.document_type?.trim() || null,
        document_number: input.document_number?.trim() || null,
        birth_date: input.birth_date?.trim() || null,
        is_active: true,
      })
      .select("id, name")
      .single();
    if (error) throw error;
    return data as { id: string; name: string };
  },

  update: async (id: string, input: CustomerOutput): Promise<void> => {
    const supabase = createClient();
    // payload incluye `preferences` (H40), aún no tipado: cast a never.
    const { error } = await supabase
      .from("customers")
      .update(payload(input) as never)
      .eq("id", id);
    if (error) throw error;
  },

  bulkImport: async (rows: ParsedCustomer[]): Promise<number> => {
    if (rows.length === 0) return 0;
    const supabase = createClient();
    const payload = rows.map((r) => ({ ...r, is_active: true }));

    // Inserción en lotes para archivos grandes (request acotado por chunk).
    let created = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await supabase
        .from("customers")
        .insert(payload.slice(i, i + 500));
      if (error) throw error;
      created += Math.min(500, payload.length - i);
    }

    // H34: auditoría del import (cantidad creada/errores) — best effort, no bloquea.
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase.from("audit_logs").insert({
        actor_user_id: user?.id ?? null,
        entity_type: "customers",
        entity_id: null,
        action: "imported",
        after_data: { total: created, created },
      });
    } catch (e) {
      console.warn("H34 audit (customers import) falló:", e);
    }

    return created;
  },

  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("customers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
};
