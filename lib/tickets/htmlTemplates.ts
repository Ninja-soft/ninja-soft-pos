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
  {
    // A4 con la estructura de una factura legal argentina (A/B/C). La app aún no
    // integra facturación electrónica (AFIP/ARCA): la letra rinde "X" (no fiscal)
    // y CAE / vto CAE / IIBB / inicio de actividades / doc. del receptor llegan
    // como "—" desde htmlVars hasta que exista la integración. La maqueta queda
    // lista para poblarse sin inventar datos.
    key: "a4-factura-legal",
    name: "Factura (legal AR)",
    paper: "a4",
    kind: "sale",
    html: `<div style="font-family:'Times New Roman',Georgia,serif;font-size:12px;color:#111;line-height:1.4;border:1px solid #111">
  <!-- Encabezado: emisor | letra | comprobante -->
  <table style="width:100%;border-collapse:collapse;table-layout:fixed">
    <tr>
      <td style="width:43%;vertical-align:top;padding:14px 16px;border-right:1px solid #111">
        <img src="{{logo_url}}" alt="" style="max-height:46px;object-fit:contain;margin-bottom:6px" />
        <div style="font-size:18px;font-weight:bold;letter-spacing:.3px">{{negocio}}</div>
        <div style="color:#333;margin-top:4px">{{direccion}}</div>
        <div style="color:#333">Tel.: {{telefono}}</div>
        <div style="color:#333;margin-top:6px;font-style:italic">{{condicion_iva}}</div>
      </td>
      <td style="width:14%;vertical-align:top;text-align:center;border-right:1px solid #111;position:relative;padding:0">
        <div style="border:2px solid #111;width:52px;height:52px;margin:8px auto 2px;line-height:50px;font-size:34px;font-weight:bold">{{comprobante_letra}}</div>
        <div style="font-size:9px;color:#333;letter-spacing:.5px">COD. {{comprobante_cod}}</div>
      </td>
      <td style="width:43%;vertical-align:top;padding:14px 16px">
        <div style="font-size:17px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px">{{comprobante_tipo}}</div>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:12px">
          <tr><td style="padding:1px 0;color:#333">Pto. Venta:</td><td style="text-align:right;font-weight:bold">{{punto_venta}}</td></tr>
          <tr><td style="padding:1px 0;color:#333">Comp. Nro:</td><td style="text-align:right;font-weight:bold">{{comprobante_nro}}</td></tr>
          <tr><td style="padding:1px 0;color:#333">Fecha:</td><td style="text-align:right">{{fecha}}</td></tr>
        </table>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;color:#333">
          <tr><td style="padding:1px 0">CUIT:</td><td style="text-align:right">{{cuit}}</td></tr>
          <tr><td style="padding:1px 0">Ingresos Brutos:</td><td style="text-align:right">{{ingresos_brutos}}</td></tr>
          <tr><td style="padding:1px 0">Inicio de actividades:</td><td style="text-align:right">{{inicio_actividades}}</td></tr>
        </table>
      </td>
    </tr>
  </table>
  <div style="border-top:1px solid #111;background:#f3f3f3;text-align:center;font-size:10px;letter-spacing:3px;color:#444;padding:2px 0">ORIGINAL</div>

  <!-- Receptor -->
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #111;table-layout:fixed">
    <tr>
      <td style="padding:8px 16px;vertical-align:top">
        <div><span style="color:#333">Cliente:</span> <strong>{{cliente}}</strong></div>
        <div style="margin-top:2px"><span style="color:#333">CUIT / DNI:</span> {{cliente_doc}}</div>
      </td>
      <td style="padding:8px 16px;vertical-align:top">
        <div><span style="color:#333">Condición frente al IVA:</span> {{cliente_iva}}</div>
        <div style="margin-top:2px"><span style="color:#333">Domicilio:</span> —</div>
      </td>
    </tr>
  </table>

  <!-- Detalle -->
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #111">
    <thead>
      <tr style="background:#f3f3f3;font-size:11px;text-transform:uppercase;letter-spacing:.3px">
        <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #111;width:9%">Código</th>
        <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #111">Descripción</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #111;width:9%">Cant.</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #111;width:15%">P. Unit.</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #111;width:9%">% IVA</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #111;width:16%">Subtotal</th>
      </tr>
    </thead>
    <tbody>{{items_fiscal_html}}</tbody>
  </table>

  <!-- Totales -->
  <table style="width:100%;border-collapse:collapse;margin-top:10px">
    <tr>
      <td style="width:55%"></td>
      <td style="width:45%;padding:0 16px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <tr><td style="padding:2px 0;color:#333">Importe neto gravado:</td><td style="text-align:right">{{neto_gravado}}</td></tr>
          <tr><td style="padding:2px 0;color:#333">IVA:</td><td style="text-align:right">{{iva_total}}</td></tr>
          <tr><td style="padding:2px 0;color:#333">Descuento:</td><td style="text-align:right">{{descuento}}</td></tr>
          <tr style="border-top:2px solid #111;font-size:16px;font-weight:bold">
            <td style="padding:6px 0">TOTAL:</td><td style="text-align:right">{{total}}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Medios de pago -->
  <div style="padding:0 16px;margin-top:8px">
    <div style="font-size:11px;color:#333;text-transform:uppercase;letter-spacing:.3px">Medios de pago</div>
    <table style="width:100%;max-width:300px;border-collapse:collapse;font-size:12px">{{pagos_html}}</table>
  </div>

  <div style="text-align:center;color:#c00;font-weight:bold;margin-top:8px">{{anulada}}</div>

  <!-- Pie fiscal: CAE + vto + código de barras AFIP -->
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #111;margin-top:12px">
    <tr>
      <td style="width:62%;vertical-align:top;padding:10px 16px">
        <!-- Código de barras AFIP (Interleaved 2of5). Placeholder visual hasta
             integrar AFIP/ARCA: sin CAE no se puede generar el dígito real. -->
        <div style="height:44px;background:repeating-linear-gradient(90deg,#111 0,#111 1px,#fff 1px,#fff 2px,#111 2px,#111 4px,#fff 4px,#fff 5px,#111 5px,#111 6px,#fff 6px,#fff 9px)"></div>
        <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;margin-top:3px">{{cuit}} {{comprobante_cod}} {{punto_venta}} {{cae}}</div>
      </td>
      <td style="width:38%;vertical-align:top;text-align:right;padding:10px 16px">
        <div style="font-size:13px;font-weight:bold">CAE N°: {{cae}}</div>
        <div style="font-size:13px;font-weight:bold;margin-top:2px">Vto. de CAE: {{cae_vto}}</div>
      </td>
    </tr>
  </table>

  <div style="border-top:1px solid #111;padding:8px 16px;font-size:9px;color:#666;line-height:1.45">${FISCAL_LINE}</div>
  <div style="text-align:center;font-size:11px;color:#444;padding:0 16px 10px">{{pie}} · {{leyenda}}</div>
</div>`,
  },
];
