// H9b PR2 — Plantillas HTML precargadas para el modo "html" del ticket.
// Cada `html` es autónomo (solo estilos inline, sin CSS externo ni <script>),
// se renderiza dentro de la app y se exporta a PNG. Usa {{variables}} de
// HTML_TEMPLATE_VARS (ver lib/tickets/htmlVars.ts).

export interface HtmlStarterTemplate {
  key: string;
  name: string;
  paper: "58" | "80" | "a4";
  kind: "sale" | "promo" | "gift";
  html: string;
}

export const HTML_STARTER_TEMPLATES: HtmlStarterTemplate[] = [
  {
    key: "clasico-80",
    name: "Clásico 80mm",
    paper: "80",
    kind: "sale",
    html: `<div style="font-family:monospace;font-size:12px;color:#000;line-height:1.4">
  <img src="{{logo_url}}" alt="" style="display:block;max-height:48px;margin:0 auto 6px;object-fit:contain" />
  <div style="text-align:center;font-weight:bold;font-size:15px">{{negocio}}</div>
  <div style="text-align:center;font-size:11px;color:#444">
    CUIT {{cuit}}<br />
    {{direccion}}<br />
    {{telefono}}
  </div>
  <div style="text-align:center;margin:4px 0;color:#444">{{titulo}}</div>
  <div style="border-top:1px dashed #999;margin:6px 0"></div>
  <div style="display:flex;justify-content:space-between">
    <span>Comprobante {{numero}}</span>
    <span>{{fecha}}</span>
  </div>
  <div style="border-top:1px dashed #999;margin:6px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{items_html}}</table>
  <div style="border-top:1px dashed #999;margin:6px 0"></div>
  <table style="width:100%;border-collapse:collapse">
    <tr><td>Subtotal</td><td style="text-align:right">{{subtotal}}</td></tr>
    <tr><td>Descuento</td><td style="text-align:right">{{descuento}}</td></tr>
    <tr style="font-weight:bold;font-size:15px"><td>TOTAL</td><td style="text-align:right">{{total}}</td></tr>
  </table>
  <div style="border-top:1px dashed #999;margin:6px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{pagos_html}}</table>
  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:6px">{{anulada}}</div>
  <div style="border-top:1px dashed #999;margin:6px 0"></div>
  <div style="text-align:center">{{pie}}</div>
  <div style="text-align:center;font-size:10px;color:#666;margin-top:2px">{{leyenda}}</div>
</div>`,
  },
  {
    key: "compacto-58",
    name: "Compacto 58mm",
    paper: "58",
    kind: "sale",
    html: `<div style="font-family:monospace;font-size:10px;color:#000;line-height:1.35">
  <div style="text-align:center;font-weight:bold;font-size:12px">{{negocio}}</div>
  <div style="display:flex;justify-content:space-between;font-size:9px;color:#444">
    <span>{{numero}}</span>
    <span>{{fecha}}</span>
  </div>
  <div style="border-top:1px dashed #999;margin:4px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{items_html}}</table>
  <div style="border-top:1px dashed #999;margin:4px 0"></div>
  <div style="text-align:center;font-weight:bold;font-size:16px;margin:4px 0">{{total}}</div>
  <div style="text-align:center;color:#c00;font-weight:bold">{{anulada}}</div>
  <div style="text-align:center;font-size:9px;margin-top:4px">{{pie}}</div>
</div>`,
  },
  {
    key: "a4-factura",
    name: "A4 estilo factura",
    paper: "a4",
    kind: "sale",
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.5">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #e2e2e2;padding-bottom:12px">
    <div>
      <div style="font-size:20px;font-weight:bold">{{negocio}}</div>
      <div style="color:#555;font-size:12px">CUIT {{cuit}}</div>
      <div style="color:#555;font-size:12px">{{direccion}}</div>
      <div style="color:#555;font-size:12px">{{telefono}}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:14px;font-weight:bold;letter-spacing:1px">COMPROBANTE NO FISCAL</div>
      <div style="color:#555">N° {{numero}}</div>
      <div style="color:#555">{{fecha}}</div>
      <div style="color:#555">Cliente: {{cliente}}</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <thead>
      <tr style="border-bottom:1px solid #ccc;text-align:left">
        <th style="padding:6px 0">Detalle</th>
        <th style="padding:6px 0;text-align:right">Subtotal</th>
      </tr>
    </thead>
    <tbody>{{items_html}}</tbody>
  </table>
  <div style="display:flex;justify-content:flex-end;margin-top:16px">
    <table style="border-collapse:collapse;min-width:240px">
      <tr><td style="padding:2px 0">Subtotal</td><td style="text-align:right">{{subtotal}}</td></tr>
      <tr><td style="padding:2px 0">Descuento</td><td style="text-align:right">{{descuento}}</td></tr>
      <tr style="border-top:1px solid #ccc;font-weight:bold;font-size:16px">
        <td style="padding:6px 0">TOTAL</td><td style="text-align:right">{{total}}</td>
      </tr>
    </table>
  </div>
  <div style="margin-top:16px">
    <div style="font-weight:bold;margin-bottom:4px">Medios de pago</div>
    <table style="width:100%;max-width:320px;border-collapse:collapse">{{pagos_html}}</table>
  </div>
  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:12px">{{anulada}}</div>
  <div style="border-top:1px solid #e2e2e2;margin-top:24px;padding-top:12px;text-align:center;color:#555">
    {{pie}}<br /><span style="font-size:11px">{{leyenda}}</span>
  </div>
</div>`,
  },
  {
    key: "volante-promo",
    name: "Volante promo",
    paper: "80",
    kind: "promo",
    html: `<div style="font-family:Arial,Helvetica,sans-serif;background:#fff7e6;color:#1a1a1a;padding:16px;text-align:center;line-height:1.4">
  <div style="font-size:30px;font-weight:bold;color:#e85d00;letter-spacing:1px">¡PROMO!</div>
  <div style="font-size:16px;font-weight:bold;margin:8px 0">2x1 todos los miércoles</div>
  <div style="font-size:13px;margin-bottom:8px">Aprovechá nuestras ofertas de la semana. ¡Te esperamos!</div>
  <!-- pegá la URL de tu imagen -->
  <img src="" alt="" style="width:100%;border-radius:8px;margin:8px 0" />
  <div style="border-top:2px dashed #e85d00;margin:12px 0"></div>
  <div style="font-size:15px;font-weight:bold">{{negocio}}</div>
  <div style="font-size:12px;color:#555">{{telefono}}</div>
</div>`,
  },
  {
    key: "gift-card",
    name: "Gift card",
    paper: "80",
    kind: "gift",
    html: `<div style="font-family:Georgia,'Times New Roman',serif;border:4px double #b08d57;padding:18px;text-align:center;color:#3a2f1c;background:#fffdf7">
  <div style="font-size:13px;letter-spacing:3px;color:#b08d57">★ ★ ★</div>
  <div style="font-size:24px;font-weight:bold;letter-spacing:2px;margin:8px 0">VALE DE REGALO</div>
  <div style="font-size:14px;margin:12px 0">
    Monto: <span style="display:inline-block;min-width:120px;border-bottom:1px solid #b08d57">&nbsp;</span>
  </div>
  <div style="font-size:13px;text-align:left;margin:0 12px;line-height:2.2">
    Para: <span style="display:inline-block;min-width:140px;border-bottom:1px solid #b08d57">&nbsp;</span><br />
    De: <span style="display:inline-block;min-width:150px;border-bottom:1px solid #b08d57">&nbsp;</span>
  </div>
  <div style="border-top:1px solid #b08d57;margin:14px 0"></div>
  <div style="font-size:15px;font-weight:bold">{{negocio}}</div>
  <div style="font-size:11px;color:#7a6a4a">{{fecha}}</div>
  <div style="font-size:13px;letter-spacing:3px;color:#b08d57;margin-top:6px">★ ★ ★</div>
</div>`,
  },
];
