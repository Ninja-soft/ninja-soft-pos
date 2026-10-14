# Íconos de tiendas de origen del catálogo

Oficiales, provistos por el dueño (13/10/2026). Originales 800x800 en su
carpeta de Descargas; acá van redimensionados a 256x256 WebP con transparencia.
Nombre = id de tienda del feed en minúsculas. Mapa en `lib/catalog/storeLogos.ts`.

Variantes por tema (14/10/2026): `<tienda>-claro.webp` para temas oscuros y
`<tienda>-oscuro.webp` para temas claros. Es el mismo ícono con SOLO la tinta
que se pierde recoloreada (alfa intacto, sin placa blanca): Macro (azul marino
→ claro), Bancor y Provincia (blanco → oscuro). Registradas en
`STORE_ICON_VARIANTS` y resueltas con `storeIcon(key, { theme })`.
