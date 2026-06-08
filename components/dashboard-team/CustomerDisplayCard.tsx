"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MonitorSmartphone, Tags } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Configuración de la pantalla del cliente / doble pantalla (F10 · H25).
// Owner/manager: mostrar precios unitarios + mensajes de idle/agradecimiento.
// Lee/escribe pos_settings (RLS: owner/manager). Las columnas display_* aún no
// están en los tipos generados (no se regeneran): se castea el payload.
type DisplaySettings = {
  display_show_unit_prices: boolean;
  display_welcome_message: string | null;
  display_thanks_message: string | null;
};

const DEFAULT_WELCOME = "¡Bienvenido!";
const DEFAULT_THANKS = "¡Gracias por tu compra!";

export function CustomerDisplayCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: ctx } = useQuery({
    queryKey: ["customer-display-settings-ctx"],
    queryFn: async (): Promise<{ tenantId: string; canManage: boolean } | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      return {
        tenantId: mem.tenant_id,
        canManage: ["owner", "manager"].includes(mem.role),
      };
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: settings } = useQuery({
    queryKey: ["customer-display-settings", tenantId],
    enabled: !!tenantId && (ctx?.canManage ?? false),
    queryFn: async (): Promise<DisplaySettings> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("*")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const row = (data as unknown as Partial<DisplaySettings>) ?? {};
      return {
        display_show_unit_prices: row.display_show_unit_prices ?? true,
        display_welcome_message: row.display_welcome_message ?? null,
        display_thanks_message: row.display_thanks_message ?? null,
      };
    },
  });

  const [showUnit, setShowUnit] = useState(true);
  const [welcome, setWelcome] = useState("");
  const [thanks, setThanks] = useState("");

  useEffect(() => {
    if (!settings) return;
    setShowUnit(settings.display_show_unit_prices ?? true);
    setWelcome(settings.display_welcome_message ?? "");
    setThanks(settings.display_thanks_message ?? "");
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("pos_settings").upsert(
        {
          tenant_id: tenantId,
          display_show_unit_prices: showUnit,
          display_welcome_message: welcome.trim() || null,
          display_thanks_message: thanks.trim() || null,
        } as never,
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["customer-display-settings", tenantId] });
      // Refresca lo que lee el POS (usePosSettings) para que la pantalla del
      // cliente tome los nuevos textos/flag en la próxima publicación.
      qc.invalidateQueries({ queryKey: ["pos", "settings"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  function openPreview() {
    window.open("/customer-display", "ninja-customer-display", "noopener");
  }

  if (!ctx || !ctx.canManage) return null;

  return (
    <section className="space-y-4">
      <div>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <MonitorSmartphone size={18} /> Pantalla del cliente
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Una segunda pantalla (monitor o tablet de cara al cliente) que muestra
          el carrito, el total, el QR de pago y el vuelto en vivo mientras cobrás.
        </p>
      </div>

      {/* Cómo se abre + limitación técnica */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <ExternalLink size={16} className="text-ninja-flameSoft" /> Cómo se usa
          </div>
          <p className="text-sm text-muted-foreground">
            En el Punto de venta tocá <strong>“Pantalla cliente”</strong> (o el
            botón de acá abajo): se abre una ventana nueva. Arrastrala al segundo
            monitor o abrila en la tablet de la caja y ponela en pantalla completa
            (tecla F11). Se sincroniza sola con esta caja, sin recargar.
          </p>
          <p className="text-xs text-muted-foreground">
            Nota: por seguridad, el navegador no puede mover la ventana a otro
            monitor ni ponerla en pantalla completa por su cuenta — ese paso lo
            hacés vos una vez. La pantalla solo muestra la venta en curso (nunca
            datos internos ni de otros clientes).
          </p>
          <Button variant="secondary" size="sm" onClick={openPreview}>
            <MonitorSmartphone size={15} /> Abrir pantalla del cliente
          </Button>
        </CardContent>
      </Card>

      {/* Mostrar precios unitarios */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <Tags size={16} className="text-ninja-flameSoft" /> Mostrar precios unitarios
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Muestra el precio por unidad de cada ítem en la pantalla del cliente.
              Si lo apagás, solo se ven nombre, cantidad y subtotal de cada línea.
            </p>
          </div>
          <Switch
            checked={showUnit}
            onCheckedChange={setShowUnit}
            label="Mostrar precios unitarios en la pantalla del cliente"
          />
        </CardContent>
      </Card>

      {/* Mensajes */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2 font-semibold">
            <MonitorSmartphone size={16} className="text-ninja-flameSoft" /> Mensajes
          </div>
          <Input
            label="Mensaje de bienvenida"
            placeholder={DEFAULT_WELCOME}
            value={welcome}
            onChange={(e) => setWelcome(e.target.value)}
            maxLength={60}
          />
          <p className="-mt-2 text-xs text-muted-foreground">
            Se muestra en la pantalla idle (sin venta en curso). Vacío → “{DEFAULT_WELCOME}”.
          </p>
          <Input
            label="Mensaje de agradecimiento"
            placeholder={DEFAULT_THANKS}
            value={thanks}
            onChange={(e) => setThanks(e.target.value)}
            maxLength={80}
          />
          <p className="-mt-2 text-xs text-muted-foreground">
            Se muestra junto a “Pago recibido ✓” tras cobrar. Vacío → “{DEFAULT_THANKS}”.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </section>
  );
}
