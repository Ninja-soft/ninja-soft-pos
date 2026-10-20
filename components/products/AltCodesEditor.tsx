"use client";

// F24 · H163 (ADR-177): códigos alternativos del artículo (EAN viejo, código
// del fabricante o del proveedor). El scanner y el buscador los encuentran
// igual que al principal. Se guardan con el artículo; la base rechaza un
// código que ya use otro artículo.

import { useState } from "react";
import { Plus, ScanBarcode, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { codeError, duplicateCodes, normalizeCode, type AltCode } from "@/lib/products/catalogCodes";

const field =
  "h-10 w-full min-w-0 rounded-lg border-0 bg-muted px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary";

export type AltCodeDraft = AltCode & { supplierName?: string | null };

export function AltCodesEditor({
  value,
  onChange,
  mainBarcode,
  suppliers,
}: {
  value: AltCodeDraft[];
  onChange: (next: AltCodeDraft[]) => void;
  mainBarcode?: string | null;
  suppliers: { id: string; name: string }[];
}) {
  const [code, setCode] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dups = duplicateCodes(mainBarcode, value);

  function add() {
    const err = codeError(code);
    if (err) {
      setError(err);
      return;
    }
    const n = normalizeCode(code);
    if (duplicateCodes(mainBarcode, [...value, { code: n }]).has(n)) {
      setError(n === normalizeCode(mainBarcode ?? "") ? "Es el código principal" : "Ya está en la lista");
      return;
    }
    const sup = suppliers.find((s) => s.id === supplierId) ?? null;
    onChange([...value, { id: null, code: n, supplierId: sup?.id ?? null, variantId: null, supplierName: sup?.name ?? null }]);
    setCode("");
    setError(null);
  }

  return (
    <div className="space-y-3">
      {value.length > 0 && (
        <ul className="divide-y divide-border rounded-lg bg-muted">
          {value.map((c, i) => {
            const n = normalizeCode(c.code);
            return (
              <li key={c.id ?? `new-${i}-${n}`} className="flex items-center gap-3 px-3 py-2.5">
                <ScanBarcode size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{n}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.supplierName ? `Del proveedor ${c.supplierName}` : "Alternativo"}
                    {dups.has(n) ? " · repetido" : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  aria-label={`Quitar ${n}`}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-danger"
                >
                  <X size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
        <input
          className={field}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Escaneá o escribí otro código"
          aria-label="Código alternativo"
          inputMode="text"
          maxLength={60}
        />
        <select
          className={field}
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          aria-label="Proveedor del código (opcional)"
        >
          <option value="" className="bg-popover text-popover-foreground">
            Sin proveedor
          </option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
              {s.name}
            </option>
          ))}
        </select>
        <Button type="button" variant="secondary" onClick={add} disabled={!code.trim()}>
          <Plus size={15} /> Agregar
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
