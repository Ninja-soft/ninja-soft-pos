-- =============================================================================
-- 20260601120000_warranty_plans_full  (H28 — garantía extendida configurable)
-- Enriquece warranty_plans: prima como % del precio (alternativa a la fija) y
-- descripción. Configurable completo desde Configuración → Garantías.
-- =============================================================================
alter table warranty_plans add column if not exists price_pct   numeric not null default 0;
alter table warranty_plans add column if not exists description text;
