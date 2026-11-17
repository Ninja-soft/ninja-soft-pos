# Grants del Data API

- `grants.prod.json`: foto de producción (sólo lectura) de los privilegios de `anon` y `authenticated` sobre cada tabla, vista y función de `public`, más RLS, cantidad de policies, SECURITY DEFINER y `search_path`. Se regenera con `pnpm security:snapshot` (necesita `SUPABASE_ACCESS_TOKEN`) y se commitea.
- `grants.expected.json`: el **estado objetivo**. Arrancó igual a prod (SEC-06) y cada tarea de seguridad (SEC-07 a SEC-17) lo ajusta en su PR hacia lo correcto.
- `tests/integration/grants-parity.test.ts` compara la base local de CI contra el esperado y muestra el diff (tabla, rol, privilegio). Informativo hasta SEC-07; con `GRANTS_PARITY_STRICT=1` falla ante cualquier diferencia.

Codificación de privilegios de tablas: `s` SELECT, `i` INSERT, `u` UPDATE, `d` DELETE.
