// H9b PR2 — Plantillas HTML precargadas para el modo "html" del ticket.
// Cada `html` es autónomo (solo estilos inline, sin CSS externo ni <script>),
// se renderiza dentro de la app y se exporta a PNG. Usa {{variables}} de
// HTML_TEMPLATE_VARS (ver lib/tickets/htmlVars.ts).

import { FISCAL_TRANSPARENCY_TEXT } from "@/lib/tickets/legal";

export interface HtmlStarterTemplate {
  key: string;
  name: string;
  paper: "58" | "80" | "a4";
  kind: "sale" | "promo" | "gift";
  html: string;
}

// Leyenda fiscal (Ley 27.743) lista para pegar dentro de un <div> de venta.
const FISCAL_LINE = FISCAL_TRANSPARENCY_TEXT;

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
  <div style="text-align:center;font-size:9px;color:#737373;margin-bottom:4px">${FISCAL_LINE}</div>
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
  <div style="text-align:center;font-weight:bold;font-size:13px;color:#2563eb;letter-spacing:1px">{{negocio}}</div>
  <div style="display:flex;justify-content:space-between;font-size:9px;color:#444">
    <span>{{numero}}</span>
    <span>{{fecha}}</span>
  </div>
  <div style="border-top:2px solid #2563eb;margin:4px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{items_html}}</table>
  <div style="border-top:1px dashed #93c5fd;margin:4px 0"></div>
  <div style="text-align:center;font-weight:bold;font-size:16px;margin:4px 0;color:#2563eb">{{total}}</div>
  <div style="text-align:center;color:#c00;font-weight:bold">{{anulada}}</div>
  <div style="text-align:center;font-size:8px;color:#737373;margin-top:4px">${FISCAL_LINE}</div>
  <div style="text-align:center;font-size:9px;margin-top:4px">{{pie}}</div>
</div>`,
  },
  {
    key: "a4-factura",
    name: "A4 estilo factura",
    paper: "a4",
    kind: "sale",
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.5">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #047857;padding-bottom:12px">
    <div>
      <div style="font-size:20px;font-weight:bold;color:#047857">{{negocio}}</div>
      <div style="color:#555;font-size:12px">CUIT {{cuit}}</div>
      <div style="color:#555;font-size:12px">{{direccion}}</div>
      <div style="color:#555;font-size:12px">{{telefono}}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:14px;font-weight:bold;letter-spacing:1px;color:#047857">COMPROBANTE NO FISCAL</div>
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
      <tr style="border-top:2px solid #047857;font-weight:bold;font-size:16px;color:#047857">
        <td style="padding:6px 0">TOTAL</td><td style="text-align:right">{{total}}</td>
      </tr>
    </table>
  </div>
  <div style="margin-top:16px">
    <div style="font-weight:bold;margin-bottom:4px">Medios de pago</div>
    <table style="width:100%;max-width:320px;border-collapse:collapse">{{pagos_html}}</table>
  </div>
  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:12px">{{anulada}}</div>
  <div style="font-size:11px;color:#737373;margin-top:16px;line-height:1.4">${FISCAL_LINE}</div>
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
  {
    key: "a4-ejecutivo",
    name: "A4 Ejecutivo",
    paper: "a4",
    kind: "sale",
    html: `<div style="font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.55">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div style="display:flex;align-items:center;gap:12px">
      <img src="{{logo_url}}" alt="" style="max-height:56px;object-fit:contain" />
      <div>
        <div style="font-size:20px;font-weight:700;letter-spacing:.3px">{{negocio}}</div>
        <div style="color:#737373;font-size:12px">CUIT {{cuit}} · {{direccion}}</div>
        <div style="color:#737373;font-size:12px">{{telefono}}</div>
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:15px;font-weight:700;letter-spacing:1px;color:#140D35">COMPROBANTE NO FISCAL</div>
      <div style="color:#737373">N° {{numero}}</div>
      <div style="color:#737373">{{fecha}}</div>
      <div style="color:#737373">Cliente: {{cliente}}</div>
    </div>
  </div>
  <div style="border-top:2px solid #140D35;margin:14px 0"></div>
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="border-bottom:1px solid #d4d4d4;text-align:left;color:#525252">
        <th style="padding:6px 0;font-weight:600">Detalle</th>
        <th style="padding:6px 0;text-align:right;font-weight:600">Subtotal</th>
      </tr>
    </thead>
    <tbody>{{items_html}}</tbody>
  </table>
  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:18px">
    <img src="{{qr_url}}" alt="" style="width:96px;height:96px" />
    <table style="border-collapse:collapse;min-width:260px">
      <tr><td style="padding:2px 0;color:#525252">Subtotal</td><td style="text-align:right">{{subtotal}}</td></tr>
      <tr><td style="padding:2px 0;color:#525252">Descuento</td><td style="text-align:right">{{descuento}}</td></tr>
      <tr style="border-top:2px solid #140D35;font-weight:700;font-size:18px">
        <td style="padding:8px 0">TOTAL</td><td style="text-align:right">{{total}}</td>
      </tr>
    </table>
  </div>
  <div style="margin-top:14px"><table style="width:100%;max-width:320px;border-collapse:collapse">{{pagos_html}}</table></div>
  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:10px">{{anulada}}</div>
  <div style="font-size:11px;color:#737373;margin-top:18px;line-height:1.4">${FISCAL_LINE}</div>
  <div style="border-top:1px solid #e5e5e5;margin-top:18px;padding-top:12px;text-align:center;color:#737373">
    {{pie}}<br /><span style="font-size:11px">{{leyenda}}</span>
  </div>
</div>`,
  },
  {
    key: "a4-elegante",
    name: "A4 Elegante",
    paper: "a4",
    kind: "sale",
    html: `<div style="font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#2b2b2b;line-height:1.6">
  <div style="text-align:center;border-bottom:3px double #8a6d3b;padding-bottom:14px">
    <img src="{{logo_url}}" alt="" style="max-height:56px;object-fit:contain;display:block;margin:0 auto 6px" />
    <div style="font-size:24px;font-weight:700;letter-spacing:1px">{{negocio}}</div>
    <div style="color:#6b6b6b;font-size:12px">CUIT {{cuit}} · {{direccion}} · {{telefono}}</div>
    <div style="margin-top:8px;font-size:14px;letter-spacing:2px;color:#8a6d3b">COMPROBANTE NO FISCAL</div>
  </div>
  <div style="display:flex;justify-content:space-between;color:#6b6b6b;margin-top:14px">
    <span>N° {{numero}} · {{cliente}}</span>
    <span>{{fecha}}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-top:12px">
    <thead>
      <tr style="border-bottom:1px solid #cdbf9f;text-align:left;color:#8a6d3b">
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
      <tr style="border-top:2px double #8a6d3b;font-weight:700;font-size:17px;color:#8a6d3b">
        <td style="padding:6px 0">TOTAL</td><td style="text-align:right">{{total}}</td>
      </tr>
    </table>
  </div>
  <div style="margin-top:14px"><table style="width:100%;max-width:320px;border-collapse:collapse">{{pagos_html}}</table></div>
  <div style="text-align:center;margin-top:14px"><img src="{{qr_url}}" alt="" style="width:100px;height:100px" /></div>
  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:8px">{{anulada}}</div>
  <div style="text-align:center;font-size:11px;color:#737373;margin-top:16px;line-height:1.4">${FISCAL_LINE}</div>
  <div style="border-top:1px solid #e0d8c4;margin-top:16px;padding-top:12px;text-align:center;color:#6b6b6b;font-style:italic">
    {{pie}}<br /><span style="font-size:11px;font-style:normal">{{leyenda}}</span>
  </div>
</div>`,
  },
  {
    key: "termico-moderno",
    name: "Térmico moderno",
    paper: "80",
    kind: "sale",
    html: `<div style="font-family:system-ui,'Segoe UI',Arial,sans-serif;font-size:12px;color:#111;line-height:1.45">
  <img src="{{logo_url}}" alt="" style="display:block;max-height:44px;margin:0 auto 6px;object-fit:contain" />
  <div style="text-align:center;font-weight:600;font-size:15px;letter-spacing:.3px">{{negocio}}</div>
  <div style="text-align:center;font-size:11px;color:#737373">CUIT {{cuit}} · {{telefono}}</div>
  <div style="border-top:1px solid #e5e5e5;margin:8px 0"></div>
  <div style="display:flex;justify-content:space-between;color:#525252">
    <span>{{numero}}</span><span>{{fecha}}</span>
  </div>
  <div style="border-top:1px solid #e5e5e5;margin:8px 0"></div>
  <table style="width:100%;border-collapse:collapse">{{items_html}}</table>
  <div style="border-top:1px solid #e5e5e5;margin:8px 0"></div>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="color:#525252">Subtotal</td><td style="text-align:right">{{subtotal}}</td></tr>
    <tr><td style="color:#525252">Descuento</td><td style="text-align:right">{{descuento}}</td></tr>
    <tr style="font-weight:700;font-size:16px"><td>TOTAL</td><td style="text-align:right">{{total}}</td></tr>
  </table>
  <table style="width:100%;border-collapse:collapse;margin-top:4px">{{pagos_html}}</table>
  <div style="text-align:center;margin-top:8px"><img src="{{qr_url}}" alt="" style="width:96px;height:96px" /></div>
  <div style="text-align:center;color:#c00;font-weight:bold">{{anulada}}</div>
  <div style="text-align:center;font-size:9px;color:#737373;margin-top:6px">${FISCAL_LINE}</div>
  <div style="text-align:center;margin-top:4px">{{pie}}</div>
</div>`,
  },
];
