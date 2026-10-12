-- =============================================================================
-- 20261011220000_ai_acceso_total_historial  (Asistente IA: acceso total de
-- lectura + historial de conversaciones por usuario, 15 días)  ADR-039
--
-- A) ai_query(p_spec jsonb): consulta genérica de SOLO LECTURA para el
--    Asistente IA. El modelo no escribe SQL: manda un pedido JSON (entidad,
--    columnas, filtros, agrupación, agregados, orden, límite) que acá se valida
--    contra una WHITELIST (ai__query_catalog) y se arma con identificadores
--    quote_ident y valores quote_literal.
--      • SECURITY INVOKER: corre con el JWT del usuario → RLS de cada tabla
--        aplica igual que en PostgREST. Nunca service_role para leer datos.
--      • Fuerza t.tenant_id = current_tenant_id() (aunque el usuario sea staff
--        interno con policies "or is_internal()": jamás cruza tenants) y
--        excluye filas con deleted_at.
--      • Límite 1..200 filas (default 50), máximo 12 filtros, 2 agrupaciones,
--        6 agregados, 3 órdenes, 50 valores por IN. El statement_timeout del
--        rol authenticated (8 s en Supabase) corta consultas pesadas.
--      • El catálogo es copia de supabase/functions/_shared/aiQuery.ts
--        (catalogForSql); tests/unit/aiQuery.test.ts verifica que coincidan.
--      • No expone: payment_secrets, platform_secrets, SMTP, email_providers,
--        mp_oauth_states, audit_logs, users, invite_codes, pin_hash, config de
--        medios de pago, metadata/card_voucher de pagos, código de vales.
--    No otorga nada nuevo: un usuario autenticado ya puede leer esas mismas
--    filas por PostgREST bajo RLS; esto sólo suma agregados y joins acotados.
--
-- B) ai_conversations / ai_messages: historial del chat POR USUARIO.
--    RLS: cada usuario ve sólo lo suyo (tenant_id = current_tenant_id() y
--    user_id = auth.uid()). Sin policies de escritura: escribe sólo la Edge
--    ai_assistant (service_role server-side) con tenant y usuario resueltos del
--    JWT. Borrado del usuario = lógico (deleted_at). Retención: pg_cron diario
--    borra FÍSICAMENTE las conversaciones sin actividad hace más de 15 días
--    (excepción documentada a la baja lógica: es dato transitorio de chat, no
--    dato de negocio; ver ADR-039).
--
-- NO aplicada en ningún entorno todavía.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- A.1) Catálogo (whitelist). GENERADO desde catalogForSql(): no editar a mano
--      sin actualizar aiQuery.ts (el test de Vitest compara ambos).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ai__query_catalog()
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select $catalog${
 "entities": {
  "appointments": {
   "cols": {
    "cancel_reason": "text",
    "commission_pct": "numeric",
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "duration_min": "int",
    "id": "uuid",
    "is_walk_in": "bool",
    "notes": "text",
    "professional_id": "uuid",
    "sale_id": "uuid",
    "service_name": "text",
    "service_price": "numeric",
    "starts_at": "timestamptz",
    "status": "text"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    },
    "professional": {
     "col": "professional_id",
     "to": "professionals",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "brands": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "name": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "cash_movements": {
   "cols": {
    "amount": "numeric",
    "cash_shift_id": "uuid",
    "created_at": "timestamptz",
    "created_by": "uuid",
    "id": "uuid",
    "payment_method": "text",
    "reason": "text",
    "type": "text"
   },
   "refs": {
    "shift": {
     "col": "cash_shift_id",
     "to": "cash_shifts",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "cash_registers": {
   "cols": {
    "id": "uuid",
    "is_active": "bool",
    "name": "text",
    "store_id": "uuid"
   },
   "refs": {
    "store": {
     "col": "store_id",
     "to": "stores",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "cash_shifts": {
   "cols": {
    "cash_register_id": "uuid",
    "closed_at": "timestamptz",
    "closed_by": "uuid",
    "closing_amount": "numeric",
    "difference": "numeric",
    "expected_amount": "numeric",
    "id": "uuid",
    "notes": "text",
    "opened_at": "timestamptz",
    "opened_by": "uuid",
    "opening_amount": "numeric",
    "status": "text"
   },
   "refs": {
    "opener": {
     "col": "opened_by",
     "to": "tenant_users",
     "target": "user_id",
     "via": null
    },
    "register": {
     "col": "cash_register_id",
     "to": "cash_registers",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "cash_z_closures": {
   "cols": {
    "cash_in": "numeric",
    "cash_out": "numeric",
    "cash_shift_id": "uuid",
    "closed_at": "timestamptz",
    "closing_amount": "numeric",
    "difference": "numeric",
    "discounts_total": "numeric",
    "expected_amount": "numeric",
    "id": "uuid",
    "opened_at": "timestamptz",
    "opening_amount": "numeric",
    "sales_count": "int",
    "sales_total": "numeric",
    "store_id": "uuid",
    "voids_count": "int",
    "voids_total": "numeric",
    "z_number": "int"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "cashier_profiles": {
   "cols": {
    "created_at": "timestamptz",
    "display_name": "text",
    "id": "uuid",
    "status": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "categories": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "is_active": "bool",
    "name": "text",
    "parent_id": "uuid",
    "sort_order": "int"
   },
   "refs": {
    "parent": {
     "col": "parent_id",
     "to": "categories",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "coupon_redemptions": {
   "cols": {
    "coupon_id": "uuid",
    "customer_id": "uuid",
    "discount": "numeric",
    "id": "uuid",
    "redeemed_at": "timestamptz",
    "sale_id": "uuid"
   },
   "refs": {
    "coupon": {
     "col": "coupon_id",
     "to": "coupons",
     "target": "id",
     "via": null
    },
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "coupons": {
   "cols": {
    "code": "text",
    "created_at": "timestamptz",
    "discount_type": "text",
    "discount_value": "numeric",
    "id": "uuid",
    "is_active": "bool",
    "max_per_customer": "int",
    "max_uses": "int",
    "min_amount": "numeric",
    "used_count": "int",
    "valid_from": "date",
    "valid_to": "date"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "customer_account_movements": {
   "cols": {
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "delta": "numeric",
    "due_date": "date",
    "id": "uuid",
    "reason": "text",
    "sale_id": "uuid"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    },
    "sale": {
     "col": "sale_id",
     "to": "sales",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "customer_groups": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "is_active": "bool",
    "name": "text",
    "sort": "int"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "customer_pack_credits": {
   "cols": {
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "expires_at": "timestamptz",
    "id": "uuid",
    "pack_id": "uuid",
    "pack_name": "text",
    "sessions_total": "int",
    "sessions_used": "int"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "customers": {
   "cols": {
    "address": "text",
    "birth_date": "date",
    "created_at": "timestamptz",
    "credit_limit": "numeric",
    "document_number": "text",
    "document_type": "text",
    "email": "text",
    "group_id": "uuid",
    "id": "uuid",
    "is_active": "bool",
    "iva_condition": "text",
    "name": "text",
    "notes": "text",
    "phone": "text"
   },
   "refs": {
    "group": {
     "col": "group_id",
     "to": "customer_groups",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": [
    "name",
    "document_number",
    "phone",
    "email",
    "group.name",
    "created_at"
   ]
  },
  "delivery_order_items": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "kds_status": "text",
    "name": "text",
    "order_id": "uuid",
    "product_id": "uuid",
    "qty": "numeric",
    "station": "text",
    "unit_price": "numeric"
   },
   "refs": {
    "order": {
     "col": "order_id",
     "to": "delivery_orders",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "delivery_orders": {
   "cols": {
    "address": "text",
    "channel": "text",
    "courier_name": "text",
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "customer_name": "text",
    "customer_phone": "text",
    "delivery_fee": "numeric",
    "id": "uuid",
    "notes": "text",
    "order_type": "text",
    "promised_at": "timestamptz",
    "sale_id": "uuid",
    "status": "text",
    "zone_id": "uuid"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    },
    "zone": {
     "col": "zone_id",
     "to": "delivery_zones",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "delivery_zones": {
   "cols": {
    "eta_minutes": "int",
    "fee": "numeric",
    "id": "uuid",
    "is_active": "bool",
    "name": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "dining_areas": {
   "cols": {
    "id": "uuid",
    "name": "text",
    "sort": "int"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "dining_reservations": {
   "cols": {
    "area_id": "uuid",
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "customer_name": "text",
    "customer_phone": "text",
    "deposit_amount": "numeric",
    "duration_minutes": "int",
    "id": "uuid",
    "notes": "text",
    "party_size": "int",
    "reserved_at": "timestamptz",
    "status": "text",
    "table_id": "uuid"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "dining_tables": {
   "cols": {
    "area_id": "uuid",
    "capacity": "int",
    "created_at": "timestamptz",
    "id": "uuid",
    "label": "text",
    "status": "text"
   },
   "refs": {
    "area": {
     "col": "area_id",
     "to": "dining_areas",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "menus": {
   "cols": {
    "id": "uuid",
    "is_active": "bool",
    "name": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "payment_plans": {
   "cols": {
    "base": "text",
    "brand": "text",
    "id": "uuid",
    "installments": "int",
    "is_active": "bool",
    "label": "text",
    "provider_key": "text",
    "surcharge_pct": "numeric"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "payments": {
   "cols": {
    "amount": "numeric",
    "created_at": "timestamptz",
    "id": "uuid",
    "method": "text",
    "reference": "text",
    "sale_id": "uuid"
   },
   "refs": {
    "sale": {
     "col": "sale_id",
     "to": "sales",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "plans": {
   "cols": {
    "id": "uuid",
    "key": "text",
    "monthly_price_ars": "numeric",
    "name": "text",
    "yearly_price_ars": "numeric"
   },
   "refs": {},
   "soft": false,
   "ref_only": true,
   "global": true,
   "def": null
  },
  "price_list_items": {
   "cols": {
    "id": "uuid",
    "price": "numeric",
    "price_list_id": "uuid",
    "product_id": "uuid",
    "updated_at": "timestamptz",
    "variant_id": "uuid"
   },
   "refs": {
    "price_list": {
     "col": "price_list_id",
     "to": "price_lists",
     "target": "id",
     "via": null
    },
    "product": {
     "col": "product_id",
     "to": "products",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "price_lists": {
   "cols": {
    "adjustment_pct": "numeric",
    "channel": "text",
    "created_at": "timestamptz",
    "id": "uuid",
    "is_active": "bool",
    "name": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "product_serials": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "product_id": "uuid",
    "sale_id": "uuid",
    "serial": "text",
    "status": "text"
   },
   "refs": {
    "product": {
     "col": "product_id",
     "to": "products",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "product_variants": {
   "cols": {
    "barcode": "text",
    "created_at": "timestamptz",
    "id": "uuid",
    "option1": "text",
    "option2": "text",
    "price_override": "numeric",
    "product_id": "uuid",
    "sku": "text",
    "stock": "numeric"
   },
   "refs": {
    "product": {
     "col": "product_id",
     "to": "products",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "products": {
   "cols": {
    "barcode": "text",
    "brand_id": "uuid",
    "category_id": "uuid",
    "commission_pct": "numeric",
    "cost": "numeric",
    "created_at": "timestamptz",
    "description": "text",
    "has_variants": "bool",
    "id": "uuid",
    "is_active": "bool",
    "is_favorite": "bool",
    "is_kit": "bool",
    "is_serialized": "bool",
    "name": "text",
    "plu": "text",
    "price": "numeric",
    "season": "text",
    "service_duration_min": "int",
    "sku": "text",
    "station": "text",
    "stock": "numeric",
    "stock_min": "numeric",
    "tax_rate": "numeric",
    "track_stock": "bool",
    "unit": "text",
    "updated_at": "timestamptz",
    "warranty_months": "int"
   },
   "refs": {
    "brand": {
     "col": "brand_id",
     "to": "brands",
     "target": "id",
     "via": null
    },
    "category": {
     "col": "category_id",
     "to": "categories",
     "target": "id",
     "via": null
    }
   },
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": [
    "name",
    "sku",
    "price",
    "cost",
    "stock",
    "stock_min",
    "is_active",
    "category.name"
   ]
  },
  "professionals": {
   "cols": {
    "commission_pct": "numeric",
    "created_at": "timestamptz",
    "id": "uuid",
    "is_active": "bool",
    "name": "text",
    "notes": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "promotions": {
   "cols": {
    "action_type": "text",
    "action_value": "numeric",
    "buy_qty": "int",
    "created_at": "timestamptz",
    "id": "uuid",
    "is_active": "bool",
    "min_amount": "numeric",
    "name": "text",
    "pay_qty": "int",
    "payment_method": "text",
    "priority": "int",
    "scope": "text",
    "valid_from": "date",
    "valid_to": "date"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "return_reasons": {
   "cols": {
    "id": "uuid",
    "is_active": "bool",
    "label": "text"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "sale_items": {
   "cols": {
    "created_at": "timestamptz",
    "discount": "numeric",
    "id": "uuid",
    "product_id": "uuid",
    "product_name": "text",
    "quantity": "numeric",
    "returned_qty": "numeric",
    "sale_id": "uuid",
    "serial": "text",
    "sku": "text",
    "subtotal": "numeric",
    "unit_price": "numeric",
    "variant_id": "uuid"
   },
   "refs": {
    "product": {
     "col": "product_id",
     "to": "products",
     "target": "id",
     "via": null
    },
    "product_category": {
     "col": "category_id",
     "to": "categories",
     "target": "id",
     "via": "product"
    },
    "sale": {
     "col": "sale_id",
     "to": "sales",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "sale_returns": {
   "cols": {
    "created_at": "timestamptz",
    "created_by": "uuid",
    "customer_id": "uuid",
    "id": "uuid",
    "number": "int",
    "reason": "text",
    "refund_method": "text",
    "sale_id": "uuid",
    "total": "numeric"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    },
    "sale": {
     "col": "sale_id",
     "to": "sales",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "sales": {
   "cols": {
    "cash_shift_id": "uuid",
    "coupon_code": "text",
    "coupon_discount": "numeric",
    "created_at": "timestamptz",
    "created_by": "uuid",
    "customer_id": "uuid",
    "discount_total": "numeric",
    "id": "uuid",
    "notes": "text",
    "number": "int",
    "professional_id": "uuid",
    "promo_discount": "numeric",
    "promo_name": "text",
    "status": "text",
    "store_id": "uuid",
    "subtotal": "numeric",
    "tax_total": "numeric",
    "tip_amount": "numeric",
    "tip_method": "text",
    "total": "numeric",
    "void_reason": "text",
    "voided_at": "timestamptz"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    },
    "professional": {
     "col": "professional_id",
     "to": "professionals",
     "target": "id",
     "via": null
    },
    "seller": {
     "col": "created_by",
     "to": "tenant_users",
     "target": "user_id",
     "via": null
    },
    "store": {
     "col": "store_id",
     "to": "stores",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": [
    "number",
    "created_at",
    "status",
    "total",
    "discount_total",
    "customer.name",
    "seller.display_name"
   ]
  },
  "service_packs": {
   "cols": {
    "id": "uuid",
    "is_active": "bool",
    "name": "text",
    "price": "numeric",
    "product_id": "uuid",
    "sessions": "int",
    "validity_days": "int"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "stock_movements": {
   "cols": {
    "created_at": "timestamptz",
    "created_by": "uuid",
    "delta": "numeric",
    "id": "uuid",
    "loss_reason": "text",
    "notes": "text",
    "product_id": "uuid",
    "reason": "text",
    "store_id": "uuid",
    "variant_id": "uuid"
   },
   "refs": {
    "product": {
     "col": "product_id",
     "to": "products",
     "target": "id",
     "via": null
    },
    "store": {
     "col": "store_id",
     "to": "stores",
     "target": "id",
     "via": null
    },
    "user": {
     "col": "created_by",
     "to": "tenant_users",
     "target": "user_id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "store_credit_movements": {
   "cols": {
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "delta": "numeric",
    "id": "uuid",
    "reason": "text"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "store_credit_vouchers": {
   "cols": {
    "amount": "numeric",
    "created_at": "timestamptz",
    "customer_id": "uuid",
    "expires_at": "timestamptz",
    "id": "uuid",
    "redeemed_at": "timestamptz",
    "status": "text"
   },
   "refs": {
    "customer": {
     "col": "customer_id",
     "to": "customers",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "stores": {
   "cols": {
    "address": "text",
    "id": "uuid",
    "is_active": "bool",
    "is_default": "bool",
    "name": "text",
    "phone": "text"
   },
   "refs": {},
   "soft": true,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "subscription_addons": {
   "cols": {
    "addon_key": "text",
    "cancel_at_period_end": "bool",
    "current_period_end": "date",
    "id": "uuid",
    "monthly_price_ars": "numeric",
    "status": "text"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "subscriptions": {
   "cols": {
    "billing_cycle": "text",
    "cancel_at_period_end": "bool",
    "created_at": "timestamptz",
    "current_period_end": "timestamptz",
    "current_period_start": "timestamptz",
    "id": "uuid",
    "is_lifetime": "bool",
    "plan_id": "uuid",
    "status": "text"
   },
   "refs": {
    "plan": {
     "col": "plan_id",
     "to": "plans",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "table_order_items": {
   "cols": {
    "course": "int",
    "created_at": "timestamptz",
    "id": "uuid",
    "kds_status": "text",
    "name": "text",
    "order_id": "uuid",
    "product_id": "uuid",
    "qty": "numeric",
    "station": "text",
    "unit_price": "numeric"
   },
   "refs": {
    "order": {
     "col": "order_id",
     "to": "table_orders",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "table_orders": {
   "cols": {
    "created_at": "timestamptz",
    "id": "uuid",
    "notes": "text",
    "opened_at": "timestamptz",
    "sale_id": "uuid",
    "status": "text",
    "table_id": "uuid"
   },
   "refs": {
    "table": {
     "col": "table_id",
     "to": "dining_tables",
     "target": "id",
     "via": null
    }
   },
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "tenant_payment_methods": {
   "cols": {
    "enabled": "bool",
    "id": "uuid",
    "provider_key": "text",
    "sandbox": "bool",
    "sort": "int",
    "surcharge_pct": "numeric"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "tenant_users": {
   "cols": {
    "created_at": "timestamptz",
    "display_name": "text",
    "id": "uuid",
    "joined_at": "timestamptz",
    "role": "text",
    "status": "text",
    "user_id": "uuid"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  },
  "warranty_plans": {
   "cols": {
    "commission_pct": "numeric",
    "description": "text",
    "id": "uuid",
    "is_active": "bool",
    "label": "text",
    "months": "int",
    "price": "numeric",
    "price_pct": "numeric"
   },
   "refs": {},
   "soft": false,
   "ref_only": false,
   "global": false,
   "def": null
  }
 }
}$catalog$::jsonb;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A.2) Resolución de columna: `col` o `ref.col` contra el catálogo. Devuelve la
--      expresión SQL ya citada (t."col" / "r_ref"."col") y su tipo.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ai__query_col(
  p_cat jsonb,
  p_entity text,
  p_token text,
  out token text,
  out expr text,
  out typ text,
  out ref text
)
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_ent jsonb := p_cat->'entities'->p_entity;
  v_ref jsonb;
  v_a   text;
  v_b   text;
begin
  if p_token is null
     or p_token !~ '^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$' then
    raise exception 'Columna no permitida en %: %', p_entity, left(coalesce(p_token, 'null'), 60)
      using errcode = '22023';
  end if;
  token := p_token;
  if strpos(p_token, '.') = 0 then
    typ := v_ent->'cols'->>p_token;
    if typ is null then
      raise exception 'Columna no permitida en %: %', p_entity, p_token using errcode = '22023';
    end if;
    expr := 't.' || quote_ident(p_token);
    ref := null;
  else
    v_a := split_part(p_token, '.', 1);
    v_b := split_part(p_token, '.', 2);
    v_ref := v_ent->'refs'->v_a;
    if v_ref is null then
      raise exception 'Relación no permitida en %: %', p_entity, v_a using errcode = '22023';
    end if;
    typ := p_cat->'entities'->(v_ref->>'to')->'cols'->>v_b;
    if typ is null then
      raise exception 'Columna no permitida: %', p_token using errcode = '22023';
    end if;
    expr := quote_ident('r_' || v_a) || '.' || quote_ident(v_b);
    ref := v_a;
  end if;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A.3) Literal tipado y citado. Fechas sin hora en columnas timestamptz se
--      interpretan como día civil ARGENTINO (p_next_day → inicio del día
--      siguiente, para rangos inclusivos).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ai__query_lit(
  p_val jsonb,
  p_typ text,
  p_next_day boolean default false
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_tz constant text := 'America/Argentina/Buenos_Aires';
  v text;
begin
  if p_val is null or jsonb_typeof(p_val) not in ('string', 'number', 'boolean') then
    raise exception 'Valor inválido (se espera texto, número o booleano).' using errcode = '22023';
  end if;
  v := btrim(p_val #>> '{}');
  if length(v) > 200 then
    raise exception 'Valor demasiado largo.' using errcode = '22023';
  end if;
  begin
    if p_typ in ('numeric', 'int') then
      perform v::numeric;
      return quote_literal(v) || '::numeric';
    elsif p_typ = 'bool' then
      perform v::boolean;
      return quote_literal(v) || '::boolean';
    elsif p_typ = 'uuid' then
      perform v::uuid;
      return quote_literal(v) || '::uuid';
    elsif p_typ = 'date' then
      perform v::date;
      return quote_literal(v) || '::date';
    elsif p_typ = 'timestamptz' then
      if v ~ '^\d{4}-\d{2}-\d{2}$' then
        perform v::date;
        return format('((%L::date + %s)::timestamp at time zone %L)',
                      v, case when p_next_day then 1 else 0 end, c_tz);
      elsif v ~ '(Z|z|[+-]\d{2}(:?\d{2})?)$' then
        perform v::timestamptz;
        return quote_literal(v) || '::timestamptz';
      else
        perform v::timestamp;
        return format('(%L::timestamp at time zone %L)', v, c_tz);
      end if;
    else
      return quote_literal(v) || '::text';
    end if;
  exception
    when invalid_text_representation or invalid_datetime_format
      or datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'Valor inválido para %: %', p_typ, left(v, 60) using errcode = '22023';
  end;
end;
$fn$;

-- A.4) Suma una ref (y su `via`, si la tiene) a la lista ordenada de joins.
create or replace function public.ai__query_add_ref(p_ent jsonb, p_refs text[], p_ref text)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_via text;
begin
  if p_ref is null or p_ref = any(p_refs) then
    return p_refs;
  end if;
  v_via := p_ent->'refs'->p_ref->>'via';
  if v_via is not null and not (v_via = any(p_refs)) then
    p_refs := p_refs || v_via;
  end if;
  return p_refs || p_ref;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A.5) ai_query: arma y ejecuta la consulta. Devuelve
--      { entity, rows, row_count, truncated, limit } o { error }.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ai_query(p_spec jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  c_tz       constant text := 'America/Argentina/Buenos_Aires';
  v_cat      jsonb := public.ai__query_catalog();
  v_tenant   uuid := public.current_tenant_id();
  v_entity   text;
  v_ent      jsonb;
  v_limit    int := 50;
  v_refs     text[] := '{}';
  v_sel      text[] := '{}';
  v_where    text[] := '{}';
  v_aliases  text[] := '{}';
  v_order    text[] := '{}';
  v_tokens   text[];
  v_joins    text := '';
  v_ngroup   int := 0;
  v_nagg     int := 0;
  v_agg_mode boolean;
  v_first_trunc text;
  v_first_agg   text;
  v_item     jsonb;
  v_arr      jsonb;
  v_col      record;
  v_op       text;
  v_dir      text;
  v_alias    text;
  v_expr     text;
  v_trunc    text;
  v_tok      text;
  v_lits     text[];
  v_v0       jsonb;
  v_v1       jsonb;
  v_day0     boolean;
  v_day1     boolean;
  v_ref      text;
  v_refdef   jsonb;
  v_sql      text;
  v_rows     jsonb;
  v_n        int;
begin
  if v_tenant is null then
    return jsonb_build_object('error', 'No hay un negocio activo en la sesión.');
  end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    return jsonb_build_object('error', 'El pedido debe ser un objeto.');
  end if;

  begin
    v_entity := p_spec->>'entity';
    if v_entity is null or v_entity !~ '^[a-z_][a-z0-9_]{0,62}$' then
      raise exception 'Falta entity o no es válida.' using errcode = '22023';
    end if;
    v_ent := v_cat->'entities'->v_entity;
    if v_ent is null or coalesce((v_ent->>'ref_only')::boolean, false) then
      raise exception 'La entidad % no existe o no está disponible.', v_entity using errcode = '22023';
    end if;

    -- Límite.
    if p_spec ? 'limit' and jsonb_typeof(p_spec->'limit') <> 'null' then
      begin
        v_limit := floor((p_spec->>'limit')::numeric)::int;
      exception when others then
        raise exception 'limit debe ser un número.' using errcode = '22023';
      end;
      v_limit := least(greatest(v_limit, 1), 200);
    end if;

    -- Aislamiento: tenant de la sesión SIEMPRE, más baja lógica.
    v_where := v_where || format('t.tenant_id = %L::uuid', v_tenant);
    if coalesce((v_ent->>'soft')::boolean, false) then
      v_where := v_where || 't.deleted_at is null'::text;
    end if;

    -- ── Filtros ──
    v_arr := coalesce(p_spec->'filters', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'filters debe ser una lista.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_arr) > 12 then
      raise exception 'Máximo 12 filtros.' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(v_arr) loop
      select * into v_col from public.ai__query_col(v_cat, v_entity, v_item->>'col');
      v_refs := public.ai__query_add_ref(v_ent, v_refs, v_col.ref);
      v_op := v_item->>'op';
      v_day0 := v_col.typ = 'timestamptz'
                and coalesce(v_item->>'value', '') ~ '^\d{4}-\d{2}-\d{2}$';

      if v_op = 'is_null' then
        v_where := v_where || (v_col.expr || ' is null');
      elsif v_op = 'not_null' then
        v_where := v_where || (v_col.expr || ' is not null');
      elsif v_op = 'in' then
        if jsonb_typeof(v_item->'values') is distinct from 'array'
           or jsonb_array_length(v_item->'values') not between 1 and 50 then
          raise exception 'in acepta entre 1 y 50 valores.' using errcode = '22023';
        end if;
        select array_agg(public.ai__query_lit(x.value, v_col.typ))
          into v_lits
          from jsonb_array_elements(v_item->'values') x;
        v_where := v_where || format('%s in (%s)', v_col.expr, array_to_string(v_lits, ', '));
      elsif v_op = 'between' then
        if jsonb_typeof(v_item->'values') is distinct from 'array'
           or jsonb_array_length(v_item->'values') <> 2 then
          raise exception 'between requiere exactamente 2 valores.' using errcode = '22023';
        end if;
        if v_col.typ not in ('numeric', 'int', 'date', 'timestamptz', 'text') then
          raise exception 'between no aplica a %.', v_col.token using errcode = '22023';
        end if;
        v_v0 := v_item->'values'->0;
        v_v1 := v_item->'values'->1;
        v_day1 := v_col.typ = 'timestamptz' and coalesce(v_v1 #>> '{}', '') ~ '^\d{4}-\d{2}-\d{2}$';
        v_where := v_where || format('%s >= %s and %s %s %s',
          v_col.expr, public.ai__query_lit(v_v0, v_col.typ),
          v_col.expr, case when v_day1 then '<' else '<=' end,
          public.ai__query_lit(v_v1, v_col.typ, v_day1));
      elsif v_op = 'ilike' then
        if v_col.typ <> 'text' then
          raise exception 'ilike sólo aplica a columnas de texto.' using errcode = '22023';
        end if;
        v_tok := btrim(coalesce(v_item->>'value', ''));
        if v_tok = '' or length(v_tok) > 200 then
          raise exception 'Valor inválido para ilike.' using errcode = '22023';
        end if;
        if strpos(v_tok, '%') = 0 then
          v_tok := '%' || v_tok || '%';
        end if;
        v_where := v_where || format('%s ilike %L', v_col.expr, v_tok);
      elsif v_op in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte') then
        if v_op in ('gt', 'gte', 'lt', 'lte')
           and v_col.typ not in ('numeric', 'int', 'date', 'timestamptz', 'text') then
          raise exception '% no aplica a %.', v_op, v_col.token using errcode = '22023';
        end if;
        if v_day0 then
          -- Día civil AR completo: [d 00:00, d+1 00:00).
          v_where := v_where || (case v_op
            when 'eq'  then format('(%1$s >= %2$s and %1$s < %3$s)', v_col.expr,
                                   public.ai__query_lit(v_item->'value', 'timestamptz'),
                                   public.ai__query_lit(v_item->'value', 'timestamptz', true))
            when 'neq' then format('(%1$s < %2$s or %1$s >= %3$s)', v_col.expr,
                                   public.ai__query_lit(v_item->'value', 'timestamptz'),
                                   public.ai__query_lit(v_item->'value', 'timestamptz', true))
            when 'gt'  then format('%s >= %s', v_col.expr, public.ai__query_lit(v_item->'value', 'timestamptz', true))
            when 'gte' then format('%s >= %s', v_col.expr, public.ai__query_lit(v_item->'value', 'timestamptz'))
            when 'lt'  then format('%s < %s',  v_col.expr, public.ai__query_lit(v_item->'value', 'timestamptz'))
            else            format('%s < %s',  v_col.expr, public.ai__query_lit(v_item->'value', 'timestamptz', true))
          end);
        else
          v_where := v_where || format('%s %s %s', v_col.expr,
            case v_op when 'eq' then '=' when 'neq' then 'is distinct from'
                      when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,
            public.ai__query_lit(v_item->'value', v_col.typ));
        end if;
      else
        raise exception 'Operador no permitido: %', left(coalesce(v_op, 'null'), 30) using errcode = '22023';
      end if;
    end loop;

    -- ── Agrupación ──
    v_arr := coalesce(p_spec->'group_by', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'group_by debe ser una lista.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_arr) > 2 then
      raise exception 'Máximo 2 agrupaciones.' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(v_arr) loop
      if jsonb_typeof(v_item) = 'string' then
        v_item := jsonb_build_object('col', v_item #>> '{}');
      end if;
      select * into v_col from public.ai__query_col(v_cat, v_entity, v_item->>'col');
      v_refs := public.ai__query_add_ref(v_ent, v_refs, v_col.ref);
      v_trunc := nullif(v_item->>'trunc', '');
      if v_trunc is not null then
        if v_trunc not in ('day', 'week', 'month', 'year') then
          raise exception 'trunc debe ser day, week, month o year.' using errcode = '22023';
        end if;
        if v_col.typ = 'timestamptz' then
          v_expr := format('date_trunc(%L, %s at time zone %L)::date', v_trunc, v_col.expr, c_tz);
        elsif v_col.typ = 'date' then
          v_expr := format('date_trunc(%L, %s)::date', v_trunc, v_col.expr);
        else
          raise exception 'trunc sólo aplica a fechas.' using errcode = '22023';
        end if;
        v_alias := replace(v_col.token, '.', '_') || '_' || v_trunc;
        v_first_trunc := coalesce(v_first_trunc, v_alias);
      else
        v_expr := case when v_col.typ = 'timestamptz'
                       then format('(%s at time zone %L)', v_col.expr, c_tz)
                       else v_col.expr end;
        v_alias := replace(v_col.token, '.', '_');
      end if;
      if v_alias = any(v_aliases) then
        raise exception 'Hay columnas o agregados repetidos.' using errcode = '22023';
      end if;
      v_sel := v_sel || format('%s as %I', v_expr, v_alias);
      v_aliases := v_aliases || v_alias;
      v_ngroup := v_ngroup + 1;
    end loop;

    -- ── Agregados ──
    v_arr := coalesce(p_spec->'aggregates', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'aggregates debe ser una lista.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_arr) > 6 then
      raise exception 'Máximo 6 agregados.' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(v_arr) loop
      v_op := v_item->>'op';
      if v_op is null or v_op not in ('count', 'count_distinct', 'sum', 'avg', 'min', 'max') then
        raise exception 'Agregado no permitido: %', left(coalesce(v_op, 'null'), 30) using errcode = '22023';
      end if;
      if coalesce(v_item->>'col', '') = '' then
        if v_op <> 'count' then
          raise exception '% requiere col.', v_op using errcode = '22023';
        end if;
        v_expr := 'count(*)';
        v_alias := 'count';
      else
        select * into v_col from public.ai__query_col(v_cat, v_entity, v_item->>'col');
        v_refs := public.ai__query_add_ref(v_ent, v_refs, v_col.ref);
        if v_op in ('sum', 'avg') and v_col.typ not in ('numeric', 'int') then
          raise exception '% requiere una columna numérica.', v_op using errcode = '22023';
        end if;
        if v_op in ('min', 'max') and v_col.typ not in ('numeric', 'int', 'date', 'timestamptz', 'text') then
          raise exception '% no aplica a %.', v_op, v_col.token using errcode = '22023';
        end if;
        v_expr := case v_op
          when 'count'          then format('count(%s)', v_col.expr)
          when 'count_distinct' then format('count(distinct %s)', v_col.expr)
          when 'sum'            then format('sum(%s)', v_col.expr)
          when 'avg'            then format('round(avg(%s)::numeric, 2)', v_col.expr)
          when 'min'            then case when v_col.typ = 'timestamptz'
                                          then format('(min(%s) at time zone %L)', v_col.expr, c_tz)
                                          else format('min(%s)', v_col.expr) end
          else                       case when v_col.typ = 'timestamptz'
                                          then format('(max(%s) at time zone %L)', v_col.expr, c_tz)
                                          else format('max(%s)', v_col.expr) end
        end;
        v_alias := v_op || '_' || replace(v_col.token, '.', '_');
      end if;
      if v_alias = any(v_aliases) then
        raise exception 'Hay columnas o agregados repetidos.' using errcode = '22023';
      end if;
      v_sel := v_sel || format('%s as %I', v_expr, v_alias);
      v_aliases := v_aliases || v_alias;
      v_first_agg := coalesce(v_first_agg, v_alias);
      v_nagg := v_nagg + 1;
    end loop;

    v_agg_mode := v_ngroup > 0 or v_nagg > 0;
    if v_ngroup > 0 and v_nagg = 0 then
      if 'count' = any(v_aliases) then
        raise exception 'Hay columnas o agregados repetidos.' using errcode = '22023';
      end if;
      v_sel := v_sel || 'count(*) as count'::text;
      v_aliases := v_aliases || 'count'::text;
      v_first_agg := 'count';
    end if;

    -- ── Columnas (sólo listados) ──
    if not v_agg_mode then
      if jsonb_typeof(p_spec->'select') = 'array' and jsonb_array_length(p_spec->'select') > 0 then
        if jsonb_array_length(p_spec->'select') > 25 then
          raise exception 'Máximo 25 columnas.' using errcode = '22023';
        end if;
        select array_agg(x.value #>> '{}') into v_tokens from jsonb_array_elements(p_spec->'select') x;
      elsif jsonb_typeof(v_ent->'def') = 'array' then
        select array_agg(x.value #>> '{}') into v_tokens from jsonb_array_elements(v_ent->'def') x;
      else
        select array_agg(k order by k) into v_tokens from jsonb_object_keys(v_ent->'cols') k;
      end if;
      foreach v_tok in array v_tokens loop
        select * into v_col from public.ai__query_col(v_cat, v_entity, v_tok);
        v_refs := public.ai__query_add_ref(v_ent, v_refs, v_col.ref);
        v_alias := replace(v_col.token, '.', '_');
        continue when v_alias = any(v_aliases);
        v_sel := v_sel || format('%s as %I',
          case when v_col.typ = 'timestamptz'
               then format('(%s at time zone %L)', v_col.expr, c_tz)
               else v_col.expr end,
          v_alias);
        v_aliases := v_aliases || v_alias;
      end loop;
    end if;

    -- ── Orden ──
    v_arr := coalesce(p_spec->'order_by', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'order_by debe ser una lista.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_arr) > 3 then
      raise exception 'Máximo 3 criterios de orden.' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(v_arr) loop
      if jsonb_typeof(v_item) = 'string' then
        v_item := jsonb_build_object('col', v_item #>> '{}');
      end if;
      v_dir := lower(coalesce(v_item->>'dir', 'asc'));
      if v_dir not in ('asc', 'desc') then
        raise exception 'dir debe ser asc o desc.' using errcode = '22023';
      end if;
      if v_agg_mode then
        v_tok := replace(coalesce(v_item->>'col', ''), '.', '_');
        if not (v_tok = any(v_aliases)) then
          raise exception 'En consultas agrupadas sólo podés ordenar por: %', array_to_string(v_aliases, ', ')
            using errcode = '22023';
        end if;
        v_order := v_order || format('%I %s nulls last', v_tok, v_dir);
      else
        select * into v_col from public.ai__query_col(v_cat, v_entity, v_item->>'col');
        v_refs := public.ai__query_add_ref(v_ent, v_refs, v_col.ref);
        v_order := v_order || format('%s %s nulls last', v_col.expr, v_dir);
      end if;
    end loop;
    if cardinality(v_order) = 0 then
      if v_agg_mode and v_first_trunc is not null then
        v_order := array[format('%I asc', v_first_trunc)];
      elsif v_agg_mode and v_ngroup > 0 then
        v_order := array[format('%I desc nulls last', v_first_agg)];
      elsif not v_agg_mode and (v_ent->'cols') ? 'created_at' then
        v_order := array['t.created_at desc'];
      end if;
    end if;

    -- ── Joins (refs whitelisteadas; mismo tenant salvo catálogos globales) ──
    foreach v_ref in array v_refs loop
      v_refdef := v_ent->'refs'->v_ref;
      v_joins := v_joins || format(' left join public.%I %I on %I.%I = %s.%I',
        v_refdef->>'to', 'r_' || v_ref, 'r_' || v_ref, v_refdef->>'target',
        case when v_refdef->>'via' is null then 't' else quote_ident('r_' || (v_refdef->>'via')) end,
        v_refdef->>'col');
      if not coalesce((v_cat->'entities'->(v_refdef->>'to')->>'global')::boolean, false) then
        v_joins := v_joins || format(' and %I.tenant_id = t.tenant_id', 'r_' || v_ref);
      end if;
    end loop;

    v_sql := format(
      'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select %s from public.%I t%s where %s%s%s limit %s) q',
      array_to_string(v_sel, ', '),
      v_entity,
      v_joins,
      array_to_string(v_where, ' and '),
      case when v_ngroup > 0
           then ' group by ' || (select string_agg(i::text, ', ') from generate_series(1, v_ngroup) i)
           else '' end,
      case when cardinality(v_order) > 0 then ' order by ' || array_to_string(v_order, ', ') else '' end,
      v_limit + 1
    );
    execute v_sql into v_rows;
  exception
    when others then
      -- Errores de validación (22023) y de datos/permisos vuelven como texto
      -- para que el modelo corrija el pedido. (query_canceled por timeout no
      -- entra en OTHERS y se propaga.)
      return jsonb_build_object('error', left(sqlerrm, 300));
  end;

  v_n := jsonb_array_length(v_rows);
  if v_n > v_limit then
    v_rows := v_rows - v_limit;
  end if;
  return jsonb_build_object(
    'entity', v_entity,
    'rows', v_rows,
    'row_count', least(v_n, v_limit),
    'truncated', v_n > v_limit,
    'limit', v_limit
  );
end;
$fn$;

revoke all on function public.ai__query_catalog() from public, anon;
revoke all on function public.ai__query_col(jsonb, text, text) from public, anon;
revoke all on function public.ai__query_lit(jsonb, text, boolean) from public, anon;
revoke all on function public.ai__query_add_ref(jsonb, text[], text) from public, anon;
revoke all on function public.ai_query(jsonb) from public, anon;
grant execute on function public.ai__query_catalog() to authenticated;
grant execute on function public.ai__query_col(jsonb, text, text) to authenticated;
grant execute on function public.ai__query_lit(jsonb, text, boolean) to authenticated;
grant execute on function public.ai__query_add_ref(jsonb, text[], text) to authenticated;
grant execute on function public.ai_query(jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- B.1) Historial: conversaciones y mensajes por usuario.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null default 'Nueva conversación'
             check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists ai_conversations_owner_idx
  on public.ai_conversations (tenant_id, user_id, updated_at desc)
  where deleted_at is null;
create index if not exists ai_conversations_updated_idx
  on public.ai_conversations (updated_at);

create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) <= 20000),
  tool_summary    jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

-- Lectura: sólo el propio usuario, dentro del negocio activo. Sin excepción
-- para staff interno: el chat es personal.
create policy ai_conversations_select_own on public.ai_conversations
  for select using (
    tenant_id = (select current_tenant_id())
    and user_id = (select auth.uid())
  );

create policy ai_messages_select_own on public.ai_messages
  for select using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1
        from public.ai_conversations c
       where c.id = ai_messages.conversation_id
         and c.tenant_id = ai_messages.tenant_id
         and c.user_id = (select auth.uid())
    )
  );

-- Sin policies de insert/update/delete: escribe sólo la Edge ai_assistant.
revoke insert, update, delete, truncate on public.ai_conversations from anon, authenticated;
revoke insert, update, delete, truncate on public.ai_messages from anon, authenticated;
revoke all on public.ai_conversations from anon;
revoke all on public.ai_messages from anon;
grant select on public.ai_conversations to authenticated;
grant select on public.ai_messages to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- B.2) Retención 15 días (pg_cron diario 04:41 UTC). Borrado FÍSICO de
--      conversaciones sin actividad (y las dadas de baja por el usuario) hace
--      más de 15 días; los mensajes caen por cascade.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;

create or replace function public.purge_ai_conversations()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n int;
begin
  delete from public.ai_conversations
   where updated_at < now() - interval '15 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
revoke all on function public.purge_ai_conversations() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-ai-conversations') then
    perform cron.unschedule('purge-ai-conversations');
  end if;
  perform cron.schedule('purge-ai-conversations', '41 4 * * *', 'select public.purge_ai_conversations();');
end;
$$;
