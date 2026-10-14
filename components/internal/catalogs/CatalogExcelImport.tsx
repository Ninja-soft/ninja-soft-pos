"use client";

// Plan B si el feed está caído: subir el Excel al bucket privado
// catalog-imports y correr el import por script server-side
// (scripts/import_catalog.cjs, que escribe por las RPC del catálogo maestro).
import { useRef, useState } from "react";
import { Check, FileSpreadsheet, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";

const CATALOG_IMPORTS_BUCKET = "catalog-imports";

export function CatalogExcelImport() {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safe}`;
      const up = await supabase.storage.from(CATALOG_IMPORTS_BUCKET).upload(path, file, { upsert: false });
      if (up.error) throw up.error;
      setLastUpload(file.name);
      toast({ title: "Excel subido", description: "Corré el import por script para cargarlo.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo subir el Excel", description: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Disclosure icon={<FileSpreadsheet size={15} />} title="Importar Excel manualmente (plan B)">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Sólo si la sincronización no anda (por ejemplo, el scraper está caído). Lo normal es no usarlo.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()}>
            {!uploading && <UploadCloud size={16} />} Subir Excel
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          {lastUpload ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check size={13} /> Subido: {lastUpload}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Una hoja por tienda. Se guarda en el almacenamiento privado.</span>
          )}
        </div>
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            La carga a la base la corre un <strong className="text-foreground">script server-side</strong> con la service
            key (el archivo es enorme y no entra en una función web):
          </p>
          <pre className="overflow-x-auto rounded-md bg-background p-3 text-xs leading-relaxed text-foreground">
{`SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  \\
  node scripts/import_catalog.cjs <archivo.xlsx>`}
          </pre>
          <p className="text-xs text-muted-foreground">
            Escribe el catálogo maestro por tienda y EAN con las mismas RPC que la sincronización, actualiza los conteos y
            avisa a los negocios que compraron cada catálogo.
          </p>
        </div>
      </div>
    </Disclosure>
  );
}
