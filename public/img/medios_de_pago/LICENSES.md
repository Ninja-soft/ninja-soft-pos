# Íconos de medios de pago

## `iconos/*.svg` (medios genéricos de la hoja de cobro)

Fuente: **Phosphor Icons**, estilo *duotone* (grilla 256, trazo 16).
Repositorio: https://github.com/phosphor-icons/core (carpeta `assets/duotone`).
Sitio: https://phosphoricons.com

Licencia: **MIT** (Copyright (c) 2023 Phosphor Icons). Uso comercial libre,
sin atribución visible obligatoria; se conserva este aviso.

| Archivo | Ícono Phosphor | Medio |
|---|---|---|
| `efectivo.svg` | `money-duotone` | Efectivo |
| `transferencia.svg` | `arrows-left-right-duotone` | Transferencia |
| `tarjeta.svg` | `credit-card-duotone` | Tarjeta en posnet, débito, crédito |
| `posnet.svg` | `contactless-payment-duotone` | Terminal / posnet sin logo |
| `qr.svg` | `qr-code-duotone` | QR |
| `billetera.svg` | `wallet-duotone` | Billetera o link sin logo |
| `cuenta-corriente.svg` | `notebook-duotone` | Cuenta corriente (fiado) |
| `vale.svg` | `ticket-duotone` | Vale / saldo a favor |
| `sena.svg` | `calendar-check-duotone` | Seña del turno |
| `plataforma.svg` | `storefront-duotone` | Plataforma / tienda online |
| `mercado-libre.svg` | `package-duotone` | Venta de Mercado Libre |
| `otro.svg` | `dots-three-circle-duotone` | Otro |

Los SVG usan una sola tinta: la capa de fondo va con `opacity="0.2"`. La UI
(`components/pos/ui/TenderLogo.tsx`) los aplica como máscara CSS sobre
`currentColor`, así toman el color del tema (claro u oscuro) sin variantes.

Texto de la licencia MIT:

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Logos de marca (`*_cube.webp`, `public/images/payments`, `public/images/cards`)

Logos oficiales de cada marca (Mercado Pago, Payway, MODO, Mobbex, Pagos360,
redes de tarjeta, etc.), usados sólo para identificar el medio de pago. Son
marcas de sus titulares; no se redistribuyen bajo la licencia anterior.
