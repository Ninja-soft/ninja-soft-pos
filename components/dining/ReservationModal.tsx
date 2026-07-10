"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, Search, Users, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useCustomersForPicker } from "@/modules/customers/hooks";
import { useReservationMutations } from "@/modules/dining/reservationsHooks";
import { useDiningAreas, useDiningTables } from "@/modules/dining/hooks";

// Alta de una reserva gastronómica (F13 · H51). Elegí cliente (existente del
// catálogo o datos sueltos nombre+teléfono), comensales, fecha/hora, duración,
// mesa/sector (opcional) y seña (opcional). Al crear, devuelve el id (la agenda
// la muestra). No sienta: sentar se hace desde la agenda cuando el cliente llega.
export function ReservationModal({
  open,
  onOpenChange,
  onCreated,
  defaultReservedAt,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  // Prefill de fecha/hora (datetime-local) cuando se abre desde un día concreto.
  defaultReservedAt?: string;
}) {
  const { toast } = useToast();
  const { create } = useReservationMutations();
  const { data: areas } = useDiningAreas();
  const { data: tables } = useDiningTables();

  // Cliente: existente (del catálogo) o datos sueltos. customerId set = elegido.
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [partySize, setPartySize] = useState("2");
  const [reservedAt, setReservedAt] = useState(defaultReservedAt ?? "");
  const [duration, setDuration] = useState("90");
  const [areaId, setAreaId] = useState<string>(""); // "" = sin sector
  const [tableId, setTableId] = useState<string>(""); // "" = sin mesa
  const [deposit, setDeposit] = useState("");
  const [notes, setNotes] = useState("");

  // Picker optimizado: sin búsqueda trae recientes; con búsqueda filtra
  // server-side con límite (bajo consumo de datos).
  const { data: customers } = useCustomersForPicker(customerSearch);
  const showCustomerList = customerSearch.trim().length > 0 && customerId === null;
  const list = useMemo(() => (customers ?? []).slice(0, 8), [customers]);

  // Mesas elegibles para asignar a la reserva: filtradas por sector si hay uno.
  const tableOptions = useMemo(() => {
    const all = tables ?? [];
    return areaId ? all.filter((t) => t.area_id === areaId) : all;
  }, [tables, areaId]);

  function reset() {
    setCustomerSearch("");
    setCustomerId(null);
    setCustomerName("");
    setCustomerPhone("");
    setPartySize("2");
    setReservedAt(defaultReservedAt ?? "");
    setDuration("90");
    setAreaId("");
    setTableId("");
    setDeposit("");
    setNotes("");
  }

  function pickCustomer(c: {
    id: string;
    name: string;
    phone: string | null;
  }) {
    setCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerPhone(c.phone ?? "");
    setCustomerSearch(c.name);
  }

  function clearCustomer() {
    setCustomerId(null);
    setCustomerSearch("");
    setCustomerName("");
    setCustomerPhone("");
  }

  // Al cambiar de sector, si la mesa elegida ya no pertenece al sector, limpiala.
  function pickArea(id: string) {
    setAreaId(id);
    if (id && tableId) {
      const t = (tables ?? []).find((x) => x.id === tableId);
      if (t && t.area_id !== id) setTableId("");
    }
  }

  async function submit() {
    const name = customerName.trim();
    if (!name) {
      toast({ title: "Poné el nombre del cliente", variant: "error" });
      return;
    }
    if (!reservedAt) {
      toast({ title: "Elegí fecha y hora de la reserva", variant: "error" });
      return;
    }
    const size = Number(partySize || 0);
    if (!Number.isFinite(size) || size <= 0) {
      toast({ title: "La cantidad de comensales no es válida", variant: "error" });
      return;
    }
    const depositNum = Number(deposit || 0);
    if (!Number.isFinite(depositNum) || depositNum < 0) {
      toast({ title: "La seña no es válida", variant: "error" });
      return;
    }
    try {
      await create.mutateAsync({
        customer_id: customerId,
        customer_name: name,
        customer_phone: customerPhone.trim() || null,
        party_size: size,
        // datetime-local → ISO (local).
        reserved_at: new Date(reservedAt).toISOString(),
        duration_minutes: Number(duration || 90) || 90,
        area_id: areaId || null,
        table_id: tableId || null,
        deposit_amount: depositNum,
        notes: notes.trim() || null,
      });
      toast({ title: "Reserva creada", variant: "success" });
      reset();
      onOpenChange(false);
      onCreated();
    } catch (e) {
      toast({
        title: "No se pudo crear la reserva",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Nueva reserva"
    >
      <div className="space-y-4">
        {/* Cliente: buscar existente o cargar suelto */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Cliente
          </span>
          {customerId ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-ninja-flame/40 bg-ninja-flame/[0.06] px-3 py-2">
              <span className="min-w-0 text-sm">
                <span className="block truncate font-medium text-foreground">
                  {customerName}
                </span>
                {customerPhone && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {customerPhone}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={clearCustomer}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Quitar cliente"
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="Buscar cliente por nombre o teléfono…"
                className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
              />
              {showCustomerList && list.length > 0 && (
                <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card p-1">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        pickCustomer({ id: c.id, name: c.name, phone: c.phone })
                      }
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-muted"
                    >
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {c.name}
                      </span>
                      {c.phone && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Datos sueltos (nombre + teléfono) cuando NO se eligió un cliente del
            catálogo. El nombre es obligatorio (queda como snapshot de la reserva). */}
        {!customerId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Nombre del cliente"
            />
            <Input
              label="Teléfono"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="Ej. 11 3000 1111"
            />
          </div>
        )}

        {/* Fecha/hora + comensales */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Fecha y hora
            </span>
            <input
              type="datetime-local"
              value={reservedAt}
              onChange={(e) => setReservedAt(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            />
          </label>
          <Input
            label="Comensales"
            type="number"
            min="1"
            step="1"
            value={partySize}
            onChange={(e) => setPartySize(e.target.value)}
            placeholder="2"
          />
        </div>

        {/* Duración + seña */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Duración (min)"
            type="number"
            min="15"
            step="15"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="90"
          />
          <Input
            label="Seña (opcional)"
            type="number"
            min="0"
            step="1"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            placeholder="0"
          />
        </div>

        {/* Sector + mesa (opcionales) */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Sector (opcional)
            </span>
            <select
              value={areaId}
              onChange={(e) => pickArea(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            >
              <option value="">Cualquiera</option>
              {(areas ?? []).map((a) => (
                <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Mesa (opcional)
            </span>
            <select
              value={tableId}
              onChange={(e) => setTableId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            >
              <option value="">Sin asignar</option>
              {tableOptions.map((t) => (
                <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Cumpleaños, alergias, ubicación preferida…"
        />

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            <CalendarPlus size={16} /> Crear reserva
          </Button>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users size={12} /> Cuando llegue el cliente, sentá la reserva desde la
          agenda: se abre la mesa y se carga el pedido.
        </p>
      </div>
    </Modal>
  );
}
