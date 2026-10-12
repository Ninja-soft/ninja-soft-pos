// Lógica pura de sucursales, cajas y personal por sucursal (F17 · H89-H91).
// Sin React ni Supabase: la usan los hooks, la UI y los tests. Las reglas de
// alcance espejan las de la base (staff_allowed_store_ids, ADR-045); la base es
// la autoridad, esto sirve para mostrar y anticipar.

export type StaffRole = "owner" | "manager" | "cashier" | "viewer";
export type AssignmentKind = "home" | "cover" | "extra";
export type RegisterKind = "fixed" | "mobile" | "self_service";

export interface BranchRegister {
  id: string;
  store_id: string;
  name: string;
  code: string | null;
  kind: RegisterKind;
  is_active: boolean;
  deleted_at: string | null;
  sort: number;
  device_notes: string | null;
  printer_notes: string | null;
  afip_pos_number: number | null;
  created_at: string;
}

export type WeekDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export interface TimeRange {
  from: string; // "09:00"
  to: string; // "13:00"
}
export type OpeningHours = Partial<Record<WeekDay, TimeRange[]>>;

export interface Branch {
  id: string;
  name: string;
  short_name: string | null;
  code: string | null;
  color: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  afip_pos_number: number | null;
  opening_hours: OpeningHours;
  notes: string | null;
  is_default: boolean;
  is_active: boolean;
  deleted_at: string | null;
  archived_reason: string | null;
  sort: number;
  created_at: string;
  registers: BranchRegister[];
}

export interface StaffAssignment {
  id: string;
  store_id: string;
  user_id: string | null;
  cashier_profile_id: string | null;
  kind: AssignmentKind;
  role: Exclude<StaffRole, "owner"> | null;
  valid_from: string; // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD (inclusive)
  reason: string | null;
  transfer_id: string;
  superseded_by: string | null;
  deleted_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

export const KIND_LABEL: Record<AssignmentKind, string> = {
  home: "Sucursal base",
  cover: "Cobertura temporal",
  extra: "Acceso adicional",
};

export const REGISTER_KIND_LABEL: Record<RegisterKind, string> = {
  fixed: "Fija",
  mobile: "Móvil",
  self_service: "Autoservicio",
};

export const WEEK_DAYS: { key: WeekDay; label: string; short: string }[] = [
  { key: "mon", label: "Lunes", short: "Lu" },
  { key: "tue", label: "Martes", short: "Ma" },
  { key: "wed", label: "Miércoles", short: "Mi" },
  { key: "thu", label: "Jueves", short: "Ju" },
  { key: "fri", label: "Viernes", short: "Vi" },
  { key: "sat", label: "Sábado", short: "Sá" },
  { key: "sun", label: "Domingo", short: "Do" },
];

// ── Fechas ──────────────────────────────────────────────────────────────────

// "Hoy" operativo en Argentina (YYYY-MM-DD), igual que branch_today() en SQL.
export function todayAR(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

// Suma días a una fecha YYYY-MM-DD (sin zona: aritmética de calendario).
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// "2026-10-20" → "20/10/2026".
export function formatDay(date: string | null): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

// Período legible de una asignación: "Desde 20/10/2026", "20/10 al 25/10/2026".
export function periodLabel(from: string, until: string | null): string {
  if (!until) return `Desde ${formatDay(from)}`;
  if (from === until) return `El ${formatDay(from)}`;
  return `Del ${formatDay(from)} al ${formatDay(until)}`;
}

// ── Vigencia de asignaciones ────────────────────────────────────────────────

export type AssignmentStatus = "scheduled" | "active" | "ended" | "cancelled";

export const STATUS_LABEL: Record<AssignmentStatus, string> = {
  scheduled: "Programada",
  active: "Vigente",
  ended: "Finalizada",
  cancelled: "Cancelada",
};

// Estado de una asignación en una fecha (evaluación perezosa, sin cron).
export function assignmentStatus(
  a: Pick<StaffAssignment, "valid_from" | "valid_until" | "deleted_at">,
  today: string,
): AssignmentStatus {
  if (a.deleted_at) return "cancelled";
  if (a.valid_from > today) return "scheduled";
  if (a.valid_until !== null && a.valid_until < today) return "ended";
  return "active";
}

export function isActiveOn(
  a: Pick<StaffAssignment, "valid_from" | "valid_until" | "deleted_at">,
  day: string,
): boolean {
  return assignmentStatus(a, day) === "active";
}

// ── Alcance por sucursal (espejo de staff_allowed_store_ids) ─────────────────

export interface ScopeInput {
  role: StaffRole | null;
  // Sucursales del negocio (incluidas las archivadas: con deleted_at).
  stores: Pick<Branch, "id" | "is_default" | "deleted_at" | "created_at">[];
  // Asignaciones de ESTA persona.
  assignments: Pick<StaffAssignment, "store_id" | "kind" | "valid_from" | "valid_until" | "deleted_at">[];
  today: string;
}

function byCreated<T extends { created_at: string }>(a: T, b: T): number {
  return a.created_at.localeCompare(b.created_at);
}

export function allowedStoreIds({ role, stores, assignments, today }: ScopeInput): string[] {
  const live = stores.filter((s) => !s.deleted_at);
  const all = [...stores].sort(byCreated).map((s) => s.id);
  if (role === "owner" || live.length <= 1) return all;

  const liveIds = new Set(live.map((s) => s.id));
  const active = assignments.filter((a) => liveIds.has(a.store_id) && isActiveOn(a, today));
  const cover = unique(active.filter((a) => a.kind === "cover").map((a) => a.store_id));
  if (cover.length > 0) return cover;
  const any = unique(active.map((a) => a.store_id));
  if (any.length > 0) return any;

  if (role === "manager") return all;
  return live.filter((s) => s.is_default).map((s) => s.id);
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

// Asignaciones de una persona (usuario con login o perfil sin cuenta), las más
// nuevas primero.
export function assignmentsOf(
  all: StaffAssignment[],
  person: { userId: string | null; profileId: string | null },
): StaffAssignment[] {
  return all
    .filter((a) =>
      person.userId ? a.user_id === person.userId : a.cashier_profile_id === person.profileId,
    )
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from) || b.created_at.localeCompare(a.created_at));
}

// Tiene alcance de "todas las sucursales" (puede ver el consolidado).
export function hasFullScope(input: ScopeInput): boolean {
  const ids = new Set(allowedStoreIds(input));
  return input.stores.every((s) => ids.has(s.id));
}

// ── Contexto "dónde estoy" ──────────────────────────────────────────────────

export const ALL_BRANCHES = "all" as const;
export type BranchSelection = string | typeof ALL_BRANCHES;

export interface BranchContextInput {
  // Sucursales vivas permitidas, ya ordenadas (principal primero).
  allowed: Pick<Branch, "id" | "is_default" | "is_active">[];
  saved: BranchSelection | null; // filtro del panel guardado
  savedPos: string | null; // sucursal del POS guardada en este dispositivo
}

export interface BranchContext {
  // null = todas las sucursales (sólo si el usuario puede ver más de una).
  filterStoreId: string | null;
  // Sucursal donde vende este dispositivo (siempre concreta si hay alguna).
  posStoreId: string | null;
  isMulti: boolean;
}

export function resolveBranchContext({ allowed, saved, savedPos }: BranchContextInput): BranchContext {
  if (allowed.length === 0) return { filterStoreId: null, posStoreId: null, isMulti: false };
  const ids = new Set(allowed.map((s) => s.id));
  const fallback = (allowed.find((s) => s.is_default && s.is_active) ??
    allowed.find((s) => s.is_active) ??
    allowed[0])!.id;
  if (allowed.length === 1) {
    return { filterStoreId: allowed[0]!.id, posStoreId: allowed[0]!.id, isMulti: false };
  }
  const filterStoreId =
    saved === ALL_BRANCHES || saved === null ? null : ids.has(saved) ? saved : null;
  const posOk = (id: string | null) =>
    id !== null && ids.has(id) && allowed.find((s) => s.id === id)!.is_active;
  const posStoreId = posOk(savedPos)
    ? savedPos!
    : posOk(filterStoreId)
      ? filterStoreId!
      : fallback;
  return { filterStoreId, posStoreId, isMulti: true };
}

// ── Caja del dispositivo ────────────────────────────────────────────────────

export interface OpenShiftLite {
  id: string;
  cash_register_id: string;
  opened_by: string;
  opened_at: string;
}

// Cajas operables de una sucursal (activas y no archivadas), por orden.
export function liveRegisters(registers: BranchRegister[]): BranchRegister[] {
  return registers
    .filter((r) => !r.deleted_at && r.is_active)
    .sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
}

// Qué caja usa este dispositivo: la recordada; si no, en la que el usuario
// tiene un turno abierto; si no, la primera libre; si no, la primera.
export function resolveRegister(
  registers: BranchRegister[],
  savedRegisterId: string | null,
  openShifts: OpenShiftLite[],
  userId: string | null,
): BranchRegister | null {
  const live = liveRegisters(registers);
  if (live.length === 0) return null;
  const saved = live.find((r) => r.id === savedRegisterId);
  if (saved) return saved;
  const mine = [...openShifts]
    .filter((s) => s.opened_by === userId)
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    .map((s) => live.find((r) => r.id === s.cash_register_id))
    .find(Boolean);
  if (mine) return mine;
  const busy = new Set(openShifts.map((s) => s.cash_register_id));
  return live.find((r) => !busy.has(r.id)) ?? live[0]!;
}

// ── Etiquetas ───────────────────────────────────────────────────────────────

export function branchLabel(b: Pick<Branch, "name" | "short_name">): string {
  return b.short_name?.trim() || b.name;
}

// "Caja 1" → "C1"; "Caja rápida" → "CR"; con código, el código.
export function registerShort(r: Pick<BranchRegister, "name" | "code">): string {
  if (r.code) return r.code;
  const num = r.name.match(/(\d+)\s*$/);
  if (/^caja\b/i.test(r.name) && num) return `C${num[1]}`;
  const initials = r.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials.slice(0, 3) || r.name;
}

// "Centro · Caja 1" (mobile: "Centro · C1").
export function locationLabel(
  branch: Pick<Branch, "name" | "short_name"> | null,
  register: Pick<BranchRegister, "name" | "code"> | null,
  compact = false,
): string {
  const parts: string[] = [];
  if (branch) parts.push(branchLabel(branch));
  if (register) parts.push(compact ? registerShort(register) : register.name);
  return parts.join(" · ");
}

// ── Horario ─────────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Normaliza y valida un horario semanal. Devuelve null si hay un rango inválido
// (formato, desde >= hasta o rangos superpuestos en el mismo día).
export function normalizeOpeningHours(input: OpeningHours): OpeningHours | null {
  const out: OpeningHours = {};
  for (const { key } of WEEK_DAYS) {
    const ranges = input[key] ?? [];
    const clean = ranges
      .filter((r) => r.from || r.to)
      .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
      .sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 0; i < clean.length; i++) {
      const r = clean[i]!;
      if (!HHMM.test(r.from) || !HHMM.test(r.to) || r.from >= r.to) return null;
      if (i > 0 && clean[i - 1]!.to > r.from) return null;
    }
    if (clean.length) out[key] = clean;
  }
  return out;
}

// Resumen corto: "Lu a Vi 09:00-18:00 · Sá 09:00-13:00".
export function summarizeOpeningHours(h: OpeningHours): string {
  const fmt = (rs: TimeRange[] | undefined) =>
    (rs ?? []).map((r) => `${r.from}-${r.to}`).join(", ");
  const groups: { from: string; to: string; text: string }[] = [];
  for (const d of WEEK_DAYS) {
    const text = fmt(h[d.key]);
    if (!text) continue;
    const last = groups[groups.length - 1];
    const prevIdx = WEEK_DAYS.findIndex((w) => w.short === last?.to);
    const idx = WEEK_DAYS.findIndex((w) => w.key === d.key);
    if (last && last.text === text && prevIdx === idx - 1) last.to = d.short;
    else groups.push({ from: d.short, to: d.short, text });
  }
  if (groups.length === 0) return "Sin horario cargado";
  return groups
    .map((g) => `${g.from === g.to ? g.from : `${g.from} a ${g.to}`} ${g.text}`)
    .join(" · ");
}

// ── Errores del servidor → mensajes ─────────────────────────────────────────

const ERRORS: [string, string][] = [
  ["feature_not_in_plan: multi_sucursal", "Tu plan no incluye más de una sucursal"],
  ["feature_not_in_plan: multi_caja", "Tu plan no incluye más de una caja por sucursal"],
  ["plan_limit: max_stores", "Llegaste al máximo de sucursales de tu plan"],
  ["plan_limit: max_registers_per_store", "Llegaste al máximo de cajas por sucursal de tu plan"],
  ["store_is_default", "Es la sucursal principal: elegí otra como principal antes de archivarla"],
  ["store_has_open_shift", "La sucursal tiene una caja abierta: cerrala antes"],
  ["last_active_store", "Tiene que quedar al menos una sucursal activa"],
  ["register_has_open_shift", "La caja tiene un turno abierto: cerralo antes"],
  ["last_register", "La sucursal necesita al menos una caja"],
  ["store_archived", "La sucursal está archivada"],
  ["store_paused", "La sucursal está pausada"],
  ["register_inactive", "La caja está pausada"],
  ["register_not_found", "La caja no existe o está archivada"],
  ["store_not_allowed", "No tenés acceso a esa sucursal"],
  ["shift_ambiguous", "Hay cajas abiertas en varias sucursales: elegí dónde estás vendiendo"],
  ["shift_not_open", "El turno de esta caja ya se cerró: actualizá la pantalla"],
  ["shift_already_open", "Esa caja ya tiene un turno abierto"],
  ["stores_tenant_code_uidx", "Ya hay una sucursal con ese código"],
  ["cash_registers_store_code_uidx", "Ya hay una caja con ese código en la sucursal"],
  ["already_home", "Esa ya es su sucursal base en esa fecha"],
  ["cover_overlap", "Ya tiene una cobertura en esas fechas"],
  ["already_assigned", "Ya tiene acceso a esa sucursal en esas fechas"],
  ["cover_needs_until", "La cobertura temporal necesita fecha de fin"],
  ["date_in_past", "La fecha no puede ser anterior a hoy"],
  ["invalid_dates", "La fecha de fin es anterior a la de inicio"],
  ["owner_all_branches", "El dueño ya ve todas las sucursales"],
  ["assignment_already_ended", "Esa asignación ya terminó"],
  ["forbidden", "No tenés permiso para esta acción"],
];

export function branchErrorMessage(err: unknown, fallback = "No se pudo guardar"): string {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err ?? "");
  for (const [code, text] of ERRORS) if (msg.includes(code)) return text;
  return fallback;
}
