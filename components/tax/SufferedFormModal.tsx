"use client";

// Alta o cambio de una retención, percepción o pago a cuenta SUFRIDO
// (F18 · H106, ADR-095). El servidor valida todo (tax_suffered_register /
// tax_suffered_update). En el alta se puede vincular el documento donde está
// la plata que falta (recibo de cuenta corriente, débito del banco) o
// registrar el débito en una cuenta de tesorería: con eso la contabilidad
// reclasifica sola.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { JURISDICTIONS } from "@/lib/tax/catalog";
import {
  SUFFERED_KIND_LABEL,
  SUFFERED_REGIME_LABEL,
  SUFFERED_TAX_LABEL,
  type SufferedKind,
  type SufferedRegime,
  type SufferedRow,
  type SufferedTax,
} from "@/lib/tax/suffered";
import { parseArAmount } from "@/lib/tax/suffered";
import { taxErrorMessage } from "@/modules/tax/api";
import { taxSubjectApi, type LinkCandidate } from "@/modules/tax/subjectApi";
import { useSufferedMutations } from "@/modules/tax/subjectHooks";
import { useCustomersForPicker } from "@/modules/customers/hooks";
import { useTreasuryAccounts } from "@/modules/treasury/hooks";
import { useFeature } from "@/modules/saas/gating";
import { formatCurrency } from "@/lib/utils/format";

type Origin = "manual" | "banco" | "cliente";

const TAXES: SufferedTax[] = ["iibb", "iva", "ganancias", "suss", "debitos_creditos", "otro"];
const KINDS: SufferedKind[] = ["retencion", "percepcion"];
const REGIMES: SufferedRegime[] = ["general", "sircreb", "sirtac", "procesador", "otro"];

const opt = <T extends string>(v: T, label: string): SelectOption<T> => ({ value: v, label });

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function SufferedFormModal({
  open,
  onOpenChange,
  row,
  defaultJurisdiction,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Con fila: edición (clasificación, período, agente, notas). */
  row?: SufferedRow | null;
  defaultJurisdiction: string | null;
}) {
  const editing = Boolean(row);
  const m = useSufferedMutations();
  const tesoreria = useFeature("tesoreria");
  const [origin, setOrigin] = useState<Origin>("manual");
  const [tax, setTax] = useState<SufferedTax>("iibb");
  const [kind, setKind] = useState<SufferedKind>("retencion");
  const [regime, setRegime] = useState<SufferedRegime>("general");
  const [jur, setJur] = useState<string>(defaultJurisdiction ?? "");
  const [date, setDate] = useState(today());
  const [period, setPeriod] = useState("");
  const [amount, setAmount] = useState("");
  const [base, setBase] = useState("");
  const [rate, setRate] = useState("");
  const [cuit, setCuit] = useState("");
  const [agent, setAgent] = useState("");
  const [cert, setCert] = useState("");
  const [notes, setNotes] = useState("");
  const [bankMode, setBankMode] = useState<"none" | "new" | "link">("none");
  const [account, setAccount] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [customerQ, setCustomerQ] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<LinkCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (row) {
      setTax(row.tax);
      setKind(row.kind === "pago_a_cuenta" ? "retencion" : row.kind);
      setRegime(row.regime);
      setJur(row.jurisdiction ?? defaultJurisdiction ?? "");
      setPeriod(row.period.slice(0, 7));
      setCuit(row.agent_cuit ?? "");
      setAgent(row.agent_name ?? "");
      setCert(row.certificate ?? "");
      setNotes(row.notes ?? "");
    } else {
      setOrigin("manual");
      setTax("iibb");
      setKind("retencion");
      setRegime("general");
      setJur(defaultJurisdiction ?? "");
      setDate(today());
      setPeriod("");
      setAmount("");
      setBase("");
      setRate("");
      setCuit("");
      setAgent("");
      setCert("");
      setNotes("");
      setBankMode("none");
      setAccount(null);
      setLinkId(null);
      setCustomerId(null);
      setCustomerQ("");
    }
  }, [open, row, defaultJurisdiction]);

  const { data: accounts = [] } = useTreasuryAccounts({}, open && origin === "banco" && tesoreria === true);
  const { data: customers = [] } = useCustomersForPicker(open && origin === "cliente" ? customerQ : "");

  useEffect(() => {
    let alive = true;
    setCandidates([]);
    setLinkId(null);
    if (!open || editing) return;
    if (origin === "banco" && bankMode === "link") {
      void taxSubjectApi.bankDebits(daysAgo(120)).then((c) => alive && setCandidates(c));
    } else if (origin === "cliente" && customerId) {
      void taxSubjectApi.customerReceipts(customerId, daysAgo(120)).then((c) => alive && setCandidates(c));
    }
    return () => {
      alive = false;
    };
  }, [open, editing, origin, bankMode, customerId]);

  const busy = m.register.isPending || m.update.isPending;
  const isIibb = tax === "iibb";
  const isDyc = tax === "debitos_creditos";

  const taxOptions = useMemo(() => TAXES.map((t) => opt(t, SUFFERED_TAX_LABEL[t])), []);
  const jurOptions = useMemo(() => JURISDICTIONS.map((j) => opt(j.code, `${j.name} (${j.code})`)), []);

  async function save() {
    setError(null);
    try {
      if (editing && row) {
        await m.update.mutateAsync({
          id: row.id,
          p: {
            tax,
            kind: isDyc ? "pago_a_cuenta" : kind,
            regime,
            jurisdiction: isIibb ? jur || null : null,
            period: period ? `${period}-01` : row.period,
            agent_cuit: cuit || null,
            agent_name: agent || null,
            certificate: cert || null,
            notes: notes || null,
          },
        });
      } else {
        const amt = parseArAmount(amount);
        if (amt === null || amt <= 0) {
          setError("Cargá el importe.");
          return;
        }
        await m.register.mutateAsync({
          tax,
          kind: isDyc ? "pago_a_cuenta" : kind,
          regime,
          jurisdiction: isIibb ? jur || null : null,
          origin,
          operation_date: date,
          period: period ? `${period}-01` : null,
          amount: amt,
          base_amount: parseArAmount(base),
          rate: parseArAmount(rate),
          agent_cuit: cuit || null,
          agent_name: agent || null,
          certificate: cert || null,
          notes: notes || null,
          customer_id: origin === "cliente" ? customerId : null,
          cc_movement_id: origin === "cliente" ? linkId : null,
          treasury_movement_id: origin === "banco" && bankMode === "link" ? linkId : null,
          treasury_account_id: origin === "banco" && bankMode === "new" ? account : null,
        });
      }
      onOpenChange(false);
    } catch (e) {
      setError(taxErrorMessage(e));
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Editar retención sufrida" : "Registrar retención o percepción sufrida"}
      description={
        editing
          ? "El importe, la fecha y el origen no cambian: si están mal, anulala y cargala de nuevo."
          : "Lo que te retuvieron o percibieron: queda como saldo a favor del impuesto en el mes que elijas."
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner size={15} /> : null} Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!editing && (
          <Select<Origin>
            label="¿De dónde viene?"
            value={origin}
            onChange={setOrigin}
            options={[
              opt("manual", "Otro (certificado, constancia)"),
              opt("banco", "Débito del banco (SIRCREB, débitos y créditos)"),
              opt("cliente", "Cobro de un cliente (retención en el recibo)"),
            ]}
          />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select<SufferedTax> label="Impuesto" value={tax} onChange={setTax} options={taxOptions} />
          {!isDyc && (
            <Select<SufferedKind>
              label="Tipo"
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => opt(k, SUFFERED_KIND_LABEL[k]))}
            />
          )}
          <Select<SufferedRegime>
            label="Régimen"
            value={regime}
            onChange={setRegime}
            options={REGIMES.map((r) => opt(r, SUFFERED_REGIME_LABEL[r]))}
          />
          {isIibb && (
            <Select<string> label="Jurisdicción" value={jur || null} onChange={setJur} options={jurOptions} placeholder="Elegí la jurisdicción" />
          )}
        </div>

        {!editing && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input label="Importe" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
            <Input label="Base (opcional)" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} />
            <Input label="Alícuota % (opcional)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        )}
        <Input
          label="Mes de la declaración jurada (opcional)"
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          hint="Por defecto, el mes de la fecha. Cambialo si la tomás como saldo a favor en otro mes."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="CUIT del agente" inputMode="numeric" value={cuit} onChange={(e) => setCuit(e.target.value)} />
          <Input label="Agente" value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={120} />
          <Input label="N° de certificado" value={cert} onChange={(e) => setCert(e.target.value)} maxLength={40} />
          <Input label="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </div>

        {!editing && origin === "banco" && (
          <div className="space-y-3 rounded-md bg-muted/50 p-3">
            {tesoreria !== true ? (
              <p className="text-sm text-muted-foreground">
                Con Tesorería podés registrar el débito en la cuenta del banco y la contabilidad lo reclasifica sola.
              </p>
            ) : (
              <>
                <Select<"none" | "new" | "link">
                  label="Débito en el banco"
                  value={bankMode}
                  onChange={setBankMode}
                  options={[
                    opt("none", "No registrar el débito"),
                    opt("new", "Registrar el débito en una cuenta"),
                    opt("link", "Ya está cargado: vincularlo"),
                  ]}
                />
                {bankMode === "new" && (
                  <Select<string>
                    label="Cuenta"
                    value={account}
                    onChange={setAccount}
                    options={accounts.filter((a) => a.kind === "bank").map((a) => opt(a.id, a.name))}
                    placeholder="Elegí la cuenta bancaria"
                  />
                )}
                {bankMode === "link" && (
                  <Select<string>
                    label="Débito"
                    value={linkId}
                    onChange={setLinkId}
                    options={candidates.map((c) => opt(c.id, `${c.date} · ${c.label} · ${formatCurrency(c.amount)}`))}
                    placeholder={candidates.length ? "Elegí el débito" : "No hay débitos de los últimos 120 días"}
                  />
                )}
              </>
            )}
          </div>
        )}

        {!editing && origin === "cliente" && (
          <div className="space-y-3 rounded-md bg-muted/50 p-3">
            <Input label="Buscar cliente" value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} placeholder="Nombre o documento" />
            <Select<string>
              label="Cliente"
              value={customerId}
              onChange={setCustomerId}
              options={customers.map((c) => opt(c.id, c.name))}
              placeholder="Elegí el cliente"
            />
            {customerId && (
              <Select<string>
                label="Recibo de cuenta corriente (opcional)"
                value={linkId}
                onChange={setLinkId}
                options={candidates.map((c) => opt(c.id, `${c.date} · ${c.label} · ${formatCurrency(c.amount)}`))}
                placeholder={candidates.length ? "Elegí el recibo" : "Sin recibos en los últimos 120 días"}
                hint="Cargá el cobro con el medio Otro por el importe retenido y vinculalo: así baja la deuda del cliente y el asiento queda bien."
              />
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
