// =============================================================================
// Edge Function: ml_api: acciones síncronas de Mercado Libre desde el POS
// (H87 · ADR-104). Deploy: verify_jwt = true.
//
// Gating server-side en cada acción: ml_edge_guard (miembro activo, rol y
// feature `mercadolibre`) y la cuenta tiene que ser del negocio del usuario.
//
//   predict_category {title}                       predictor de categoría
//   category {category_id}                         límites, atributos y tipos
//   validate {account_id, input}                   chequeos + POST /items/validate
//   publish {account_id, product_id, input}        crea el/los ítems (+ descripción)
//                                                  y los vincula al producto
//   import_items {account_id}                      trae las publicaciones de la
//                                                  cuenta y sugiere vínculos por
//                                                  SKU y GTIN
//   labels {account_id, shipment_ids[], format}    etiquetas ME2 (PDF o ZPL, de a 50)
//   sync_account {account_id}                      órdenes recientes ya
//   refresh_order {account_id, ml_order_id}        relee una orden y la ingresa
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { readJsonLimited } from "../_shared/requestGuard.ts";
import { MlApiError } from "../_shared/mercadolibre/client.ts";
import {
  attributeForm,
  buildItemBodies,
  itemIdentifiers,
  suggestLinks,
  validatePublish,
  type PublishInput,
} from "../_shared/mercadolibre/items.ts";
import { labelBatches, labelBlocker } from "../_shared/mercadolibre/orders.ts";
import { bytesToBase64, extractZpl, isPdf, labelPath, type LabelFormat } from "../_shared/mercadolibre/labels.ts";
import { ingestOrder, itemPayload, refreshItem } from "../_shared/mercadolibre/worker.ts";
import { syntheticOrderNotification } from "../_shared/mercadolibre/notifications.ts";
import type { MlCategoryAttribute, MlDomainSuggestion, MlItem, MlItemSearch, MlOrderSearch } from "../_shared/mercadolibre/types.ts";
import { ML_SITE } from "../_shared/mercadolibre/config.ts";
import { accountClient, adminClient, cors, json, mlConfig, rpcOf } from "../_shared/mercadolibre/runtime.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = new Set(["validate", "publish", "import_items", "sync_account", "refresh_order"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await readJsonLimited(req, 256 * 1024);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");
  const admin = adminClient();
  const { data: guard, error: gErr } = await admin.rpc("ml_edge_guard", {
    p_tenant: tenantId,
    p_user: user.id,
    p_manage: MANAGE.has(action),
  });
  if (gErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);
  const cfg = await mlConfig(admin);
  if (!cfg.ok) return json({ error: cfg.error, message: cfg.message }, 503);
  const rpc = rpcOf(admin);

  // Cuenta del negocio (activa).
  let account: { id: string; ml_user_id: number; user_product_seller: boolean; status: string } | null = null;
  const accountId = String(b.account_id ?? "");
  if (UUID_RE.test(accountId)) {
    const { data } = await admin
      .from("ml_accounts")
      .select("id, ml_user_id, user_product_seller, status")
      .eq("id", accountId)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    account = data;
  } else {
    // Sin cuenta explícita (predictor, categoría): la primera activa del negocio.
    const { data } = await admin
      .from("ml_accounts")
      .select("id, ml_user_id, user_product_seller, status")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("connected_at")
      .limit(1)
      .maybeSingle();
    account = data;
  }
  if (!account) return json({ error: "no_account" }, 404);
  if (account.status !== "active") return json({ error: "reauth_required" }, 409);
  const client = accountClient(admin, cfg.config, account.id);
  const deps = { rpc, client: () => client };

  try {
    switch (action) {
      case "predict_category": {
        const title = String(b.title ?? "").trim().slice(0, 120);
        if (title.length < 3) return json({ error: "invalid_title" }, 400);
        const suggestions = await client.get<MlDomainSuggestion[]>(`/sites/${ML_SITE}/domain_discovery/search`, { q: title, limit: 3 });
        return json({ suggestions });
      }
      case "category": {
        const id = String(b.category_id ?? "");
        if (!/^[A-Z]{3}\d{1,12}$/.test(id)) return json({ error: "invalid_category" }, 400);
        const [cat, attrs, types] = await Promise.all([
          client.get<{ id: string; name: string; settings?: Record<string, unknown> }>(`/categories/${id}`),
          client.get<MlCategoryAttribute[]>(`/categories/${id}/attributes`),
          client.get<Array<{ id: string; name: string }>>(`/sites/${ML_SITE}/listing_types`),
        ]);
        const s = cat.settings ?? {};
        return json({
          category: {
            id: cat.id,
            name: cat.name,
            max_title_length: Number(s.max_title_length ?? 60),
            max_pictures: Number(s.max_pictures_per_item ?? 12),
            listing_allowed: s.listing_allowed !== false,
          },
          attributes: attributeForm(attrs),
          listing_types: (types ?? []).filter((t) => ["gold_special", "gold_pro", "free"].includes(t.id)),
        });
      }
      case "validate":
      case "publish": {
        const input = b.input as PublishInput;
        if (!input || typeof input !== "object") return json({ error: "invalid_input" }, 400);
        input.model = account.user_product_seller ? "user_products" : "classic";
        const attrs = attributeForm(await client.get<MlCategoryAttribute[]>(`/categories/${encodeURIComponent(input.categoryId)}/attributes`));
        const local = validatePublish(input, attrs);
        if (local.length > 0) return json({ ok: false, errors: local });
        const bodies = buildItemBodies(input);
        const errors: string[] = [];
        for (const it of bodies) {
          try {
            await client.request("POST", "/items/validate", { body: it.body });
          } catch (e) {
            if (e instanceof MlApiError && (e.code === "validation_error" || e.code === "bad_request")) {
              errors.push(...(e.causes.length ? e.causes : [e.message]));
            } else throw e;
          }
        }
        if (errors.length > 0) return json({ ok: false, errors: [...new Set(errors)].slice(0, 30) });
        if (action === "validate") return json({ ok: true });

        const productId = String(b.product_id ?? "");
        if (!UUID_RE.test(productId)) return json({ error: "invalid_product" }, 400);
        const { data: prod } = await admin.from("products").select("id").eq("id", productId).eq("tenant_id", tenantId).maybeSingle();
        if (!prod) return json({ error: "product_not_found" }, 404);
        const created: Array<{ ml_item_id: string; permalink: string | null }> = [];
        for (const it of bodies) {
          const item = await client.post<MlItem>("/items", it.body);
          if (input.description && input.description.trim()) {
            await client.post(`/items/${item.id}/description`, { plain_text: input.description.trim().slice(0, 50_000) }).catch(() => undefined);
          }
          // Vínculos: UP = uno por ítem (variante); clásico = uno por variación.
          let links: Array<{ variant_id: string | null; ml_variation_id: string | null }>;
          if (it.variantKey || !(input.variants ?? []).length) {
            links = [{ variant_id: it.variantKey, ml_variation_id: null }];
          } else {
            const vars = item.variations ?? [];
            links = (input.variants ?? []).map((v, i) => ({ variant_id: v.key, ml_variation_id: vars[i] ? String(vars[i]!.id) : null }));
          }
          await rpc("ml_publish_register", {
            p_account: account.id,
            p_user: user.id,
            p_item: itemPayload(item),
            p_product: productId,
            p_links: links,
          });
          created.push({ ml_item_id: item.id, permalink: item.permalink ?? null });
        }
        return json({ ok: true, items: created });
      }
      case "import_items": {
        // Hasta 500 publicaciones por corrida (scan); multiget de a 20.
        const ids: string[] = [];
        let scroll: string | null = null;
        for (let page = 0; page < 10; page++) {
          const res: MlItemSearch = await client.get<MlItemSearch>(`/users/${account.ml_user_id}/items/search`, {
            search_type: "scan",
            limit: 50,
            scroll_id: scroll,
          });
          ids.push(...(res.results ?? []));
          scroll = res.scroll_id ?? null;
          if (!scroll || (res.results ?? []).length === 0) break;
        }
        const { data: prods } = await admin
          .from("products")
          .select("id, sku, barcode, product_variants(id, sku, barcode, deleted_at)")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .limit(20_000);
        const candidates: Array<{ product_id: string; variant_id: string | null; sku: string | null; barcode: string | null }> = (prods ?? []).flatMap((p: { id: string; sku: string | null; barcode: string | null; product_variants?: Array<{ id: string; sku: string | null; barcode: string | null; deleted_at: string | null }> }) => {
          const vs = (p.product_variants ?? []).filter((v) => !v.deleted_at);
          if (vs.length === 0) return [{ product_id: p.id, variant_id: null as string | null, sku: p.sku, barcode: p.barcode }];
          return vs.map((v) => ({ product_id: p.id, variant_id: v.id as string | null, sku: v.sku ?? p.sku, barcode: v.barcode }));
        });
        const { data: existing } = await admin.from("ml_item_links").select("item_id, ml_variation_id").eq("account_id", account.id);
        const linked = new Set((existing ?? []).map((l: { item_id: string; ml_variation_id: number | null }) => `${l.item_id}:${l.ml_variation_id ?? ""}`));
        const suggestions: unknown[] = [];
        let imported = 0;
        for (let i = 0; i < ids.length; i += 20) {
          const chunk = ids.slice(i, i + 20);
          const multi = await client.get<Array<{ code: number; body: MlItem }>>("/items", { ids: chunk.join(",") });
          for (const m of multi ?? []) {
            if (m.code !== 200 || !m.body) continue;
            const rowId = (await rpc("ml_item_upsert", { p_account: account.id, p: itemPayload(m.body) })) as string;
            imported++;
            for (const s of suggestLinks(itemIdentifiers(m.body), candidates)) {
              if (linked.has(`${rowId}:${s.variationId ?? ""}`)) continue;
              suggestions.push({
                item_row_id: rowId,
                ml_item_id: m.body.id,
                title: m.body.title,
                variation_id: s.variationId,
                label: itemIdentifiers(m.body).find((x) => x.variationId === s.variationId)?.label ?? m.body.title,
                product_id: s.product_id,
                variant_id: s.variant_id,
                by: s.by,
              });
            }
          }
        }
        return json({ imported, found: ids.length, suggestions: suggestions.slice(0, 500) });
      }
      case "labels": {
        const format: LabelFormat = b.format === "zpl2" ? "zpl2" : "pdf";
        const ids = (Array.isArray(b.shipment_ids) ? b.shipment_ids : []).map(String).filter((s) => /^\d{5,22}$/.test(s)).slice(0, 50);
        if (ids.length === 0) return json({ error: "no_shipments" }, 400);
        const { data: ships } = await admin
          .from("ml_shipments")
          .select("shipment_id, mode, logistic_type, status, substatus, pack_key")
          .eq("account_id", account.id)
          .in("shipment_id", ids);
        const { data: frauds } = await admin
          .from("ml_orders")
          .select("shipment_id")
          .eq("account_id", account.id)
          .eq("fraud_risk", true)
          .in("shipment_id", ids);
        const fraudSet = new Set((frauds ?? []).map((f: { shipment_id: number }) => String(f.shipment_id)));
        const blocked: Array<{ shipment_id: string; reason: string }> = [];
        const okIds: string[] = [];
        for (const id of ids) {
          const s = (ships ?? []).find((x: { shipment_id: number }) => String(x.shipment_id) === id);
          const reason = s ? labelBlocker(s, fraudSet.has(id)) : "not_ready";
          if (reason) blocked.push({ shipment_id: id, reason });
          else okIds.push(id);
        }
        if (okIds.length === 0) return json({ format, blocked });
        const [batch] = labelBatches(okIds, 50);
        const res = await client.request<Uint8Array>("GET", labelPath(batch!, format), { raw: true, headers: { Accept: "*/*" } });
        await admin
          .from("ml_shipments")
          .update({ label_printed_at: new Date().toISOString() })
          .eq("account_id", account.id)
          .in("shipment_id", batch!);
        await admin.from("audit_logs").insert({
          tenant_id: tenantId, actor_user_id: user.id, entity_type: "ml_shipments", entity_id: null,
          action: "ml_labels_printed", after_data: { count: batch!.length, format },
        });
        if (format === "pdf") {
          if (!isPdf(res.data)) return json({ error: "label_not_pdf" }, 502);
          return json({ format, pdf_base64: bytesToBase64(res.data), blocked });
        }
        return json({ format, zpl: await extractZpl(res.data), blocked });
      }
      case "sync_account": {
        const res = await client.get<MlOrderSearch>("/orders/search", {
          seller: account.ml_user_id,
          "order.date_last_updated.from": new Date(Date.now() - 2 * 86400_000).toISOString(),
          sort: "date_desc",
          limit: 50,
        });
        for (const o of res.results ?? []) {
          const s = syntheticOrderNotification(o.id, account.ml_user_id, o.last_updated ?? o.date_created);
          await rpc("ml_notification_ingest", { p: { ...s, source: "manual", handled: true } });
        }
        return json({ ok: true, orders: (res.results ?? []).length });
      }
      case "refresh_order": {
        const id = String(b.ml_order_id ?? "");
        if (!/^\d{5,22}$/.test(id)) return json({ error: "invalid_order" }, 400);
        const r = await ingestOrder(deps, account.id, id);
        return json({ ok: true, ...r });
      }
      case "refresh_item": {
        const id = String(b.ml_item_id ?? "");
        if (!/^[A-Z]{3}\d{4,16}$/.test(id)) return json({ error: "invalid_item" }, 400);
        await refreshItem(deps, account.id, id);
        return json({ ok: true });
      }
      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    if (e instanceof MlApiError) {
      return json({ error: e.code, message: e.message, causes: e.causes.slice(0, 10) }, e.code === "rate_limited" ? 429 : 502);
    }
    console.error(JSON.stringify({ fn: "ml_api", action, error: String(e instanceof Error ? e.message : e) }));
    return json({ error: "server_error" }, 500);
  }
});
