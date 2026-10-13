// Llamadas a las RPC import_<entidad> (TX-4, ADR-078). Las filas viajan en
// lotes de IMPORT_CHUNK_SIZE; cada lote es una transacción en el servidor.
//   • Revisión (apply = false): dry-run, no escribe nada.
//   • Confirmación (apply = true): aplica y deja una entrada de auditoría por
//     lote con el nombre del archivo.
import { createClient } from "@/lib/supabase/client";
import { importErrorMessage } from "./messages";
import { buildPayloads, chunk, mergeServerResults } from "./engine";
import type { ParsedRow } from "@/lib/utils/xlsxImport";
import type { ImportDefinition, ServerImportResult } from "./types";

export interface RunImportOptions {
  apply: boolean;
  fileName?: string | null;
  /** Avance: lotes terminados / total. */
  onProgress?: (done: number, total: number) => void;
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function runServerImport<R>(
  def: ImportDefinition<R>,
  rows: ParsedRow<R>[],
  opts: RunImportOptions,
): Promise<ServerImportResult> {
  const payloads = buildPayloads(def, rows);
  const batches = chunk(payloads);
  const client = createClient() as unknown as RpcClient;
  const parts: ServerImportResult[] = [];
  for (let i = 0; i < batches.length; i++) {
    const { data, error } = await client.rpc(def.rpc, {
      p_rows: batches[i],
      p_apply: opts.apply,
      p_file_name: opts.fileName ?? null,
    });
    if (error) throw new Error(importErrorMessage(error.message));
    parts.push(data as ServerImportResult);
    opts.onProgress?.(i + 1, batches.length);
  }
  return mergeServerResults(parts);
}
