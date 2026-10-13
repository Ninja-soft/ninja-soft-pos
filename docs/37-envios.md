# 37 · Envíos y logística

> Fase 1 (ADR-103, F19 · H121). Qué hace el módulo, qué tiene que tramitar el dueño con cada logística y qué quedó verificado contra cada API.

## 1. Qué hace

- **Configuración > Envíos**: conectar cada logística con las credenciales del contrato del negocio, para todo el negocio o para una sucursal (la sucursal pisa al negocio, como los medios de pago). Botón **Probar** antes de guardar. Ambiente de prueba o producción.
- **Envíos** (menú Operación): crear un envío desde una venta del POS (por número de venta), un pedido o a mano; cotizar entre las logísticas conectadas de la sucursal; elegir servicio (a domicilio o a sucursal o punto de retiro); imprimir la etiqueta (PDF por el navegador o ZPL a la cola de impresión del equipo); seguimiento con línea de tiempo; cancelar; filtros por estado, logística y sucursal; impresión por lote.
- **Simulador de envíos**: disponible en cualquier negocio con Envíos, sin contrato. Sirve para probar todo el circuito y capacitar al personal. Las etiquetas dicen "Etiqueta de prueba". Escenarios por el nombre del destinatario: `[rechazo]`, `[caido]`, `[timeout]`, `[ausente]`.

Plan: Envíos está desde **Pro** (feature `envios`). Andreani, Correo Argentino y OCA desde Pro; Envíopack (agregador) desde Business.

## 2. Qué pedirle a cada logística

Regla general en Argentina: **sin contrato no hay API**. Las credenciales las da el ejecutivo de cuentas del carrier, por CUIT. NinjaSoft nunca usa credenciales propias: cada negocio usa su contrato.

### Andreani (integrado)

1. Contrato con Andreani (PyME, Middle Market o Corporativo). Hay reportes de que piden un mínimo de envíos mensuales para dar acceso a la API REST (entre 250 y 300, a confirmar con tu ejecutivo).
2. Pedile a tu ejecutivo el **alta de la API REST** para tu CUIT. Te tienen que dar:
   - **Usuario y contraseña de la API** (se guardan cifrados del lado del servidor; nunca vuelven al navegador).
   - **Número de cliente** (formato `CL...`).
   - **Un número de contrato por servicio**: envío a domicilio y envío a sucursal (si usás los dos).
   - **Código de tu sucursal de origen** para cotizar (por ejemplo `BAR`).
3. Cargalo en Configuración > Envíos > Andreani, dejá **Prueba (QA)** prendido, tocá **Probar** y creá un envío de prueba. Cuando funcione, pasá a **Producción** con las credenciales reales.
4. Opcional: dirección de despacho distinta a la de la sucursal (depósito) y remitente que figura en la etiqueta.

Limitaciones: Andreani **no permite cancelar por API**. Si cancelás un envío ya creado, NinjaSoft lo marca cancelado (queda auditado) y tenés que avisarle a tu ejecutivo para que no lo retire ni lo cobre. La etiqueta sale en **PDF** (térmica 10x15); ZPL no está disponible.

### Correo Argentino (próximamente)

- **MiCorreo** (pymes): creá la cuenta en MiCorreo con tu CUIT y pedí las credenciales de la API por el formulario de contacto de MiCorreo. Ojo: con MiCorreo el envío se **importa** a tu cuenta y la etiqueta se paga e imprime en la web de MiCorreo (la API no la devuelve).
- **PAQ.AR** (empresas): acuerdo comercial corporativo; el ejecutivo de cuentas te da un **Agreement** y una **API key**.

Podés dejar las credenciales cargadas desde ya; los envíos con Correo se habilitan cuando terminemos el adaptador.

### OCA (próximamente)

Pedí a OCA (0800-999-7700 o tu ejecutivo) una **cuenta e-Pak** con tu CUIT. Te dan usuario y contraseña de e-Pak y te habilitan una **operativa por servicio** (puerta a puerta, puerta a sucursal, etc.): anotá el número de cada una.

### Envíopack (agregador, próximamente)

Útil si no tenés contrato con cada logística: con una sola cuenta accedés a varios carriers con sus tarifas. Creá la cuenta con tu CUIT y generá la **API key** y la **secret key** en su panel.

### Pickit, HOP, Andesmar, Urbano, Bluemail, Cabify Logistics, Moova, Zipnova

No publican su API: la documentación la entrega un comercial después del alta. Se integran cuando un negocio con contrato la consiga (nos la pasa y armamos el adaptador) o a través de un agregador (Envíopack o Zipnova) en la fase 2. Si trabajás con alguna, avisanos: priorizamos por demanda.

## 3. Cómo funciona por dentro (para soporte)

- Crear un envío lo deja **Generando** y encola el alta en la logística; la pantalla lo procesa en el momento y, si la logística tarda, sigue un proceso cada 2 minutos.
- **Nunca se crea dos veces**: la misma operación repetida (doble clic, reintento, corte de red) devuelve el mismo envío. Si la logística no respondió a tiempo al crear, el envío queda **Con error** con el aviso "No sabemos si la logística creó el envío": hay que revisar el panel del carrier antes de **Reintentar** (pide confirmación).
- El seguimiento se consulta solo cada 2 horas (cada 30 minutos cuando está en reparto) durante 30 días; **Actualizar seguimiento** lo pide ya.
- La etiqueta se guarda en un almacenamiento privado y se entrega con un link que vence a los 2 minutos.
- Roles: dueño y encargado conectan logísticas, reintentan y cancelan envíos ya creados; el cajero crea envíos, imprime y cancela los que todavía no están en la logística; solo lectura mira.

## 4. Verificación contra las APIs (2026-10-13)

| Logística | Qué se verificó | Cómo |
|---|---|---|
| Andreani | Login, sucursales por CP, alta a domicilio y a sucursal (202), consulta de la orden, etiqueta PDF, trazas de un envío | QA público `apisqa.andreani.com` con las credenciales de prueba publicadas; respuestas guardadas como fixtures en `tests/fixtures/shipping/andreani.ts` |
| Andreani | Tarifa (`/v1/tarifas`) | **No verificada**: el contrato de prueba responde "No se pudo obtener la tarifa". Hay que probar con un contrato real |
| Andreani | Estados intermedios del seguimiento | Verificados "Ingreso al circuito operativo" y "Entregado"; el resto se mapea por texto, a confirmar con envíos reales |
| Correo Argentino, OCA, Envíopack | Nada | Esqueletos documentados, endpoints A CONFIRMAR con la documentación de cada carrier |

## 5. Próximas fases

Ver [`02-roadmap.md`](./02-roadmap.md) F19: Correo Argentino, OCA y un agregador con webhooks (fase 2); puntos de retiro y Mercado Libre ME1 y Flex (fase 3); impresión ZPL local sin diálogo, manifiesto diario y retiros programados (fase 4).
