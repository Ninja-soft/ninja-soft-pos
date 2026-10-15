"use client";

// Vidriera del catálogo público (H10) con carrito y pedido (ADR-130).
// Siempre clara (es del cliente final, fuera del tema del POS), con la marca
// del negocio: logo, nombre de fantasía y color (con contraste AA para texto
// y botones). Mobile-first: barra fija abajo con el carrito y hoja inferior;
// en pantallas grandes, panel a la derecha. El carrito se guarda en el
// navegador por negocio y se concilia con el catálogo vigente al volver.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  addToCart,
  cartKey,
  cartTotals,
  isOrderable,
  priceRange,
  productOrderable,
  qtyCap,
  readStoredCart,
  reconcileCart,
  setCartQty,
  type CartItem,
  type Catalog,
  type CatalogProduct,
} from "@/lib/catalog/publicOrder";
import { ProductSheet } from "./ProductSheet";
import { CartSheet } from "./CartSheet";
import { QtyStepper } from "./QtyStepper";

const storageKey = (slug: string) => `ninja-carrito:${slug}`;

export function CatalogStorefront({
  catalog,
  title,
  palette,
}: {
  catalog: Catalog;
  title: string;
  palette: { accent: string; accentInk: string; accentText: string };
}) {
  const slug = catalog.tenant.slug;
  const ordering = catalog.ordering?.enabled ? catalog.ordering : null;
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [picking, setPicking] = useState<CatalogProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

  // Carrito guardado → conciliado con precios y stock de ahora.
  useEffect(() => {
    if (!ordering) return;
    try {
      const raw = localStorage.getItem(storageKey(slug));
      const saved = readStoredCart(raw ? JSON.parse(raw) : []);
      const { cart: next, changed } = reconcileCart(saved, catalog.products);
      setCart(next);
      if (changed && saved.length > 0) setNotice("Actualizamos tu carrito con los precios y el stock de hoy.");
    } catch {
      // Sin almacenamiento: el carrito arranca vacío.
    }
    setLoaded(true);
  }, [catalog.products, ordering, slug]);

  useEffect(() => {
    if (!loaded || !ordering) return;
    try {
      localStorage.setItem(storageKey(slug), JSON.stringify(cart));
    } catch {
      // Ignorado: modo privado o almacenamiento lleno.
    }
  }, [cart, loaded, ordering, slug]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of catalog.products) if (p.category) set.add(p.category);
    return [...set].sort((a, b) => a.localeCompare(b, "es"));
  }, [catalog.products]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("es");
    return catalog.products.filter(
      (p) => (!category || p.category === category) && (!q || p.name.toLocaleLowerCase("es").includes(q)),
    );
  }, [catalog.products, category, query]);

  const qtyInCart = useCallback(
    (productId: string, variantId: string | null) =>
      cart.find((c) => cartKey(c.productId, c.variantId) === cartKey(productId, variantId))?.qty ?? 0,
    [cart],
  );

  const add = (item: CartItem) => {
    setNotice(null);
    setCart((c) => addToCart(c, item));
  };
  const setQty = (key: string, qty: number) => setCart((c) => setCartQty(c, key, qty));

  function quickAdd(p: CatalogProduct) {
    if (p.has_variants || (p.unit ?? "un") === "kg") {
      setPicking(p);
      return;
    }
    add({
      productId: p.id,
      variantId: null,
      name: p.name,
      variantLabel: null,
      unitPrice: Number(p.price),
      qty: 1,
      imageUrl: p.image_url,
      max: p.available == null ? null : qtyCap(p.available),
      unit: p.unit ?? "un",
    });
  }

  const { units, total } = cartTotals(cart);
  const contact = [catalog.branding?.address, catalog.branding?.phone].filter(Boolean).join(" · ");

  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b-4 bg-[#15111f] px-4 py-8 text-white sm:px-6 sm:py-10" style={{ borderColor: palette.accent }}>
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          {catalog.branding?.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={catalog.branding.logo_url} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-white/10 object-contain p-1" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-2xl font-extrabold tracking-tight">{title}</h1>
            <p className="text-sm opacity-90">{contact || "Catálogo"}</p>
          </div>
          {ordering && (
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="relative hidden h-11 shrink-0 items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-semibold transition-colors hover:bg-white/15 sm:inline-flex"
              aria-label={`Ver carrito, ${units} productos`}
            >
              <ShoppingBag size={18} aria-hidden />
              Carrito
              {units > 0 && (
                <span className="rounded-md px-1.5 text-xs tabular-nums" style={{ backgroundColor: palette.accent, color: palette.accentInk }}>
                  {units}
                </span>
              )}
            </button>
          )}
        </div>
      </header>

      <section
        className={cn(
          "mx-auto w-full max-w-5xl px-4 pt-5 sm:px-6 sm:pt-8",
          ordering && units > 0 ? "pb-[calc(6.5rem+env(safe-area-inset-bottom))]" : "pb-[calc(2.5rem+env(safe-area-inset-bottom))]",
        )}
      >
        {ordering && (
          <p className="mb-4 text-sm text-neutral-600">
            Armá tu pedido y elegí {ordering.retiro.enabled && ordering.envio.enabled
              ? "retirarlo en la sucursal o recibirlo en tu casa"
              : ordering.envio.enabled
                ? "recibirlo en tu casa"
                : "retirarlo en la sucursal"}.
          </p>
        )}
        {notice && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {notice}
          </p>
        )}

        {catalog.products.length > 6 && (
          <div className="mb-4 space-y-3">
            <label className="relative block">
              <span className="sr-only">Buscar productos</span>
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar productos"
                className="h-11 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-[16px] outline-none focus:border-neutral-900 sm:text-sm"
              />
            </label>
            {categories.length > 1 && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
                {[null, ...categories].map((c) => {
                  const on = category === c;
                  return (
                    <button
                      key={c ?? "_all"}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCategory(c)}
                      className={cn(
                        "h-9 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors",
                        on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100",
                      )}
                    >
                      {c ?? "Todo"}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {catalog.products.length === 0 ? (
          <p className="py-16 text-center text-neutral-500">Todavía no hay productos publicados.</p>
        ) : visible.length === 0 ? (
          <p className="py-16 text-center text-neutral-500">No encontramos productos con esa búsqueda.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            {visible.map((p) => {
              const range = priceRange(p);
              const orderable = productOrderable(p);
              const simple = !p.has_variants && (p.unit ?? "un") !== "kg";
              const inCart = simple ? qtyInCart(p.id, null) : 0;
              return (
                <article key={p.id} className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white">
                  <button
                    type="button"
                    className="aspect-square w-full bg-neutral-100 text-left disabled:cursor-default"
                    onClick={() => ordering && orderable && setPicking(p)}
                    disabled={!ordering || !orderable}
                    aria-label={ordering && orderable ? `Ver ${p.name}` : p.name}
                  >
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt={p.name} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full place-items-center text-sm text-neutral-300">Sin foto</span>
                    )}
                  </button>
                  <div className="flex flex-1 flex-col p-3">
                    {p.category && <div className="text-[11px] uppercase tracking-wide text-neutral-400">{p.category}</div>}
                    <h2 className="line-clamp-2 text-sm font-medium">{p.name}</h2>
                    <div className="mt-1 font-bold tabular-nums" style={{ color: palette.accentText }}>
                      {range.min !== range.max ? `Desde ${formatCurrency(range.min)}` : formatCurrency(range.min)}
                    </div>
                    {!orderable && (
                      <span className="mt-1.5 inline-flex w-fit rounded-md bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-500">
                        Sin stock
                      </span>
                    )}
                    {ordering && orderable && (
                      <div className="mt-auto pt-3">
                        {simple && inCart > 0 ? (
                          <QtyStepper
                            value={inCart}
                            max={qtyCap(p.available)}
                            onChange={(n) => setQty(cartKey(p.id, null), n)}
                            label={`Cantidad de ${p.name}`}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => quickAdd(p)}
                            disabled={simple && !isOrderable(p.available)}
                            className="h-10 w-full rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                            style={{ backgroundColor: palette.accent, color: palette.accentInk }}
                          >
                            {simple ? "Agregar" : "Elegir"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {ordering && units > 0 && !cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex h-12 w-full items-center sm:mx-auto sm:max-w-md justify-between gap-3 rounded-lg px-4 text-sm font-semibold"
            style={{ backgroundColor: palette.accent, color: palette.accentInk }}
          >
            <span className="inline-flex items-center gap-2">
              <ShoppingBag size={18} aria-hidden /> Ver carrito ({units})
            </span>
            <span className="tabular-nums">{formatCurrency(total)}</span>
          </button>
        </div>
      )}

      <footer className="border-t border-neutral-200 py-6 text-center text-xs text-neutral-400">Hecho con NinjaPos</footer>

      {ordering && (
        <>
          <ProductSheet
            product={picking}
            inCart={qtyInCart}
            accent={palette.accent}
            accentInk={palette.accentInk}
            onClose={() => setPicking(null)}
            onAdd={add}
          />
          <CartSheet
            open={cartOpen}
            onClose={() => setCartOpen(false)}
            slug={slug}
            cart={cart}
            ordering={ordering}
            accent={palette.accent}
            accentInk={palette.accentInk}
            onQty={setQty}
            onOrdered={() => {
              setCart([]);
              try {
                localStorage.removeItem(storageKey(slug));
              } catch {
                // Ignorado.
              }
            }}
          />
        </>
      )}
    </main>
  );
}
