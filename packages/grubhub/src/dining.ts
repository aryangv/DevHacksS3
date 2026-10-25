import {
  HarnessError,
  type Logger,
  type MealOption,
  type MenuItem,
  type ToolManifest,
} from "@campus/contracts";
import { z } from "zod";
import type { GrubhubCaller } from "./client";

// The "dining" tools the agents already use, backed by Grubhub (real restaurants, real menus, real
// orders). Same tool names as the test provider, so the group/personal agents don't change:
//
//   dining__search_options  read   restaurants near the delivery location, with a per-person estimate
//   dining__get_menu        read   menu items (price, category, dietary tags)
//   dining__quote_order     read   builds a Grubhub cart and returns the REAL total (tax, fees). No charge.
//   dining__submit_order    spend  places that exact cart; refuses if the total changed. Needs approval.
//   dining__order_status    read   delivery tracking
//
// Grubhub data has no dietary tags, so `vegetarian_friendly` is inferred from category/item names
// (e.g. Taco Bell's "Veggie Cravings") — a heuristic, labelled as such.

export type GrubhubDiningOptions = {
  call: GrubhubCaller;
  latitude: number;
  longitude: number;
  /** Where the order goes; Grubhub needs it on the cart before items can be added. */
  delivery: DeliveryInfo;
  /** Hard cap per order (minor units), checked again at submit. */
  maxOrderMinor: number;
  logger?: Logger;
  now?: () => number;
};

export type DeliveryInfo = {
  street: string;
  unit?: string;
  city: string;
  state: string;
  postalCode: string;
  instructions?: string;
  /** Courier contact. */
  phone: string;
  email: string;
};

/** A chosen option; nested required choices go in child_options (Grubhub's cart format). */
export type CartOption = { id: string; quantity: number; child_options: CartOption[] };

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const SERVER = "dining";
const OPTION_PREFIX = "gh_";
const MENU_TTL_MS = 10 * 60_000;
/** A submit may differ from the approved quote by at most this (rounding); otherwise it's refused. */
const TOTAL_TOLERANCE_MINOR = 0;

export const grubhubDiningManifests: ToolManifest[] = [
  {
    server: SERVER,
    name: "search_options",
    description:
      "Search nearby restaurants on Grubhub that deliver now. Returns options with a per-person price estimate.",
    inputSchema: {
      type: "object",
      properties: {
        maxPricePerPersonMinor: { type: "integer", minimum: 0 },
        cuisine: { type: "string" },
        query: { type: "string" },
        partySize: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    riskClass: "read",
    defaultMode: "allow",
  },
  {
    server: SERVER,
    name: "get_menu",
    description: "Get the Grubhub menu (items, prices, categories) for one restaurant option.",
    inputSchema: {
      type: "object",
      properties: { optionId: { type: "string" } },
      required: ["optionId"],
      additionalProperties: false,
    },
    riskClass: "read",
    defaultMode: "allow",
  },
  {
    server: SERVER,
    name: "quote_order",
    description:
      "Build a Grubhub cart for these items and return the real total including tax and fees. Does not charge.",
    inputSchema: {
      type: "object",
      properties: {
        optionId: { type: "string" },
        items: { type: "array" },
        tipMinor: { type: "integer", minimum: 0 },
      },
      required: ["optionId", "items"],
      additionalProperties: false,
    },
    riskClass: "read",
    defaultMode: "allow",
  },
  {
    server: SERVER,
    name: "submit_order",
    description: "Place a quoted Grubhub order. Moves real money with the account's saved card.",
    inputSchema: {
      type: "object",
      properties: {
        cartId: { type: "string" },
        approvedTotalMinor: { type: "integer", minimum: 1 },
        tipMinor: { type: "integer", minimum: 0 },
      },
      required: ["cartId", "approvedTotalMinor"],
      additionalProperties: false,
    },
    riskClass: "spend",
    defaultMode: "ask",
  },
  {
    server: SERVER,
    name: "order_status",
    description: "Delivery tracking for a placed Grubhub order.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    riskClass: "read",
    defaultMode: "allow",
  },
];

// ---- tolerant parsing of grubhub-mcp JSON (it returns Grubhub's own payloads) -----------------

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const amount = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const a = obj(v).amount;
  return typeof a === "number" && Number.isFinite(a) ? Math.round(a) : null;
};

const MEAT =
  /\b(chicken|beef|steak|pork|sausage|bacon|carnitas|chorizo|fish|shrimp|meat|ham|turkey|brisket|pepperoni|nugget)/i;
const VEG = /\b(veggie|vegetarian|vegan|bean|beans|potato|cheese|avocado|tofu|mushroom|falafel)/i;

export function categoryOf(name: string): MenuItem["category"] | null {
  const n = name.toLowerCase();
  if (/sauce|condiment|utensil|packet/.test(n)) return null;
  if (/breakfast/.test(n)) return null; // time-limited; often unavailable later in the day
  if (/drink|beverage|freeze|soda/.test(n)) return "drink";
  if (/sweet|dessert/.test(n)) return "dessert";
  if (/\bsides?\b|extras|add-?ons/.test(n)) return "side";
  return "main";
}

export function tagsFor(itemName: string, categoryName: string): string[] {
  const veg = /veggie|vegetarian/i.test(categoryName) || (VEG.test(itemName) && !MEAT.test(itemName));
  return veg ? ["vegetarian_friendly"] : [];
}

/** Menu names are shown in chats: drop control characters and broken-encoding marks. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return name.replace(/[\u0000-\u001f\u007f�]/g, "").trim();
}

export function menuItems(menuJson: unknown): MenuItem[] {
  const restaurant = obj(obj(menuJson).restaurant);
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const c of arr(restaurant.menu_category_list)) {
    const cat = obj(c);
    const catName = str(cat.name) ?? "";
    const category = categoryOf(catName);
    if (!category) continue;
    for (const i of arr(cat.menu_item_list)) {
      const it = obj(i);
      const id = str(it.id);
      const name = str(it.name);
      const price = amount(it.price);
      if (!id || !name || price === null || price <= 0 || seen.has(id)) continue;
      seen.add(id);
      const currency = str(obj(it.price).currency) ?? "USD";
      out.push({
        id,
        name: cleanName(name),
        priceMinor: price,
        currency,
        category,
        tags: tagsFor(name, catName),
      });
    }
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

const ItemsSchema = z
  .array(z.strictObject({ itemId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(5) }))
  .min(1)
  .max(20);

/** Map Grubhub tracking/status payloads to a small set the group agent understands. */
export function normalizeStatus(json: unknown): {
  status: "placed" | "preparing" | "on_the_way" | "delivered" | "cancelled" | "unknown";
  etaMinutes: number | null;
  detail: string | null;
} {
  const o = obj(json);
  const flat = JSON.stringify(o).toLowerCase();
  const raw =
    str(o.status) ??
    str(o.state) ??
    str(o.order_status) ??
    str(o.delivery_status) ??
    str(obj(o.tracking).status) ??
    "";
  const s = raw.toLowerCase();
  const status = /cancel|void|reject/.test(s)
    ? "cancelled"
    : /deliver(ed|y_complete)|complete|fulfilled/.test(s)
      ? "delivered"
      : /pick(ed)?_?up|out_for|en_route|on_the_way|in_transit|driver/.test(s)
        ? "on_the_way"
        : /prepar|confirm|accept|cooking|in_progress/.test(s)
          ? "preparing"
          : /placed|submitted|received|new/.test(s)
            ? "placed"
            : /cancel/.test(flat)
              ? "cancelled"
              : "unknown";
  const eta = o.estimated_delivery_minutes ?? o.eta_minutes ?? obj(o.tracking).eta_minutes;
  return { status, etaMinutes: typeof eta === "number" ? Math.round(eta) : null, detail: raw || null };
}

/**
 * Pull the charges (cents) out of a Grubhub cart. Live shape (2026-10-25):
 * charges { diner_subtotal: 414, fees: { total: 449 }, taxes: { total: 70 }, tip: { amount: 100 },
 *           diner_grand_total: 1033 }. Null total = no line items yet / not priced.
 */
export function cartTotal(json: unknown): {
  totalMinor: number | null;
  subtotalMinor: number | null;
  feesMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
} {
  const charges = obj(obj(json).charges);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const items = arr(obj(charges.lines).line_items);
  return {
    totalMinor: items.length ? num(charges.diner_grand_total) : null,
    subtotalMinor: num(charges.diner_subtotal),
    feesMinor: num(obj(charges.fees).total),
    taxMinor: num(obj(charges.taxes).total),
    tipMinor: amount(charges.tip),
  };
}

/**
 * Default choices for every REQUIRED option group of a menu item, recursively (a combo's "Item 1"
 * option has its own required protein/sauce groups). Picks the restaurant's defaulted options first,
 * then the first available ones; optional groups are left empty.
 */
export function requiredChoices(categories: unknown): CartOption[] {
  const out: CartOption[] = [];
  for (const c of arr(categories)) {
    const cat = obj(c);
    const qs = obj(cat.quantity_settings);
    const min = Math.max(
      typeof cat.min_choice_options === "number" ? cat.min_choice_options : 0,
      typeof qs.minimum_units === "number" ? qs.minimum_units : 0,
    );
    if (min < 1) continue;
    const opts = arr(cat.choice_option_list)
      .map(obj)
      .filter((o) => o.available !== false && str(o.id));
    const ordered = [
      ...opts.filter((o) => o.defaulted === true),
      ...opts.filter((o) => o.defaulted !== true),
    ];
    for (const o of ordered.slice(0, min))
      out.push({ id: str(o.id)!, quantity: 1, child_options: requiredChoices(o.choice_category_list) });
  }
  return out;
}

export function createGrubhubDining(opts: GrubhubDiningOptions): {
  manifests: ToolManifest[];
  handlers: Record<string, Handler>;
} {
  const { call } = opts;
  const now = opts.now ?? Date.now;
  const where = { latitude: opts.latitude, longitude: opts.longitude };
  const menus = new Map<string, { at: number; items: MenuItem[]; name: string }>();

  const restaurantIdOf = (optionId: unknown): string => {
    const v = typeof optionId === "string" ? optionId : "";
    if (!v.startsWith(OPTION_PREFIX) || !/^\d{1,15}$/.test(v.slice(OPTION_PREFIX.length)))
      throw new HarnessError("tool_args_invalid", "unknown restaurant option");
    return v.slice(OPTION_PREFIX.length);
  };

  // get_restaurant = the same menu without every item's option lists (~0.5 MB vs ~70 MB for Taco Bell
  // via get_menu, which times out). Options are fetched per item only when building a cart.
  async function menuFor(restaurantId: string): Promise<{ items: MenuItem[]; name: string }> {
    const hit = menus.get(restaurantId);
    if (hit && now() - hit.at < MENU_TTL_MS) return hit;
    const json = await call("get_restaurant", { restaurant_id: restaurantId, ...where });
    const name = str(obj(obj(json).restaurant).name) ?? "Restaurant";
    const entry = { at: now(), items: menuItems(json), name };
    menus.set(restaurantId, entry);
    return entry;
  }

  async function requiredOptions(restaurantId: string, itemId: string): Promise<CartOption[]> {
    const json = await call("get_menu_item", { restaurant_id: restaurantId, item_id: itemId, ...where });
    return requiredChoices(obj(obj(json).menu_item ?? json).choice_category_list);
  }

  const d = opts.delivery;

  const handlers: Record<string, Handler> = {
    search_options: async (args) => {
      const query = str(args.query) ?? str(args.cuisine) ?? "";
      const json = await call("search_restaurants", {
        ...where,
        query,
        page_size: 8,
        location_mode: "DELIVERY",
      });
      const results = arr(obj(json).results)
        .map(obj)
        .filter((r) => r.open !== false && r.delivery !== false && str(r.restaurant_id ?? r.id));
      const options: MealOption[] = [];
      await Promise.all(
        results.slice(0, 5).map(async (r) => {
          const id = str(r.restaurant_id ?? r.id)!;
          try {
            const menu = await menuFor(id);
            const mains = menu.items.filter((i) => i.category === "main");
            if (!mains.length) return;
            const cuisines = arr(r.cuisines)
              .map((c) => str(c))
              .filter(Boolean) as string[];
            options.push({
              id: `${OPTION_PREFIX}${id}`,
              name: str(r.name) ?? menu.name,
              cuisine: (cuisines[0] ?? "").toLowerCase(),
              pricePerPersonMinor: median(mains.map((i) => i.priceMinor)),
              currency: mains[0]!.currency,
              tags: mains.some((i) => i.tags.includes("vegetarian_friendly")) ? ["vegetarian_friendly"] : [],
            });
          } catch (err) {
            opts.logger?.warn("grubhub menu fetch failed; skipping restaurant", { err });
          }
        }),
      );
      const max = typeof args.maxPricePerPersonMinor === "number" ? args.maxPricePerPersonMinor : Infinity;
      // Keep the provider's relevance order.
      const order = results.map((r) => `${OPTION_PREFIX}${str(r.restaurant_id ?? r.id)}`);
      return {
        provider: "grubhub",
        options: options
          .filter((o) => o.pricePerPersonMinor <= max)
          .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
      };
    },

    get_menu: async (args) => {
      const menu = await menuFor(restaurantIdOf(args.optionId));
      return { provider: "grubhub", restaurant: menu.name, items: menu.items };
    },

    quote_order: async (args) => {
      const restaurantId = restaurantIdOf(args.optionId);
      const items = ItemsSchema.parse(args.items);
      const menu = await menuFor(restaurantId);
      const known = new Set(menu.items.map((i) => i.id));
      if (!items.every((i) => known.has(i.itemId)))
        throw new HarnessError("tool_args_invalid", "item not on the menu");
      // Order matters: Grubhub prices items for the cart's fulfillment, so the delivery address goes
      // first (without it an item is refused as "not open" when pickup is closed).
      const cartId = str(obj(await call("cart_new", {})).id);
      if (!cartId) throw new HarnessError("provider_error", "Grubhub did not return a cart");
      await call("cart_set_delivery", {
        cart_id: cartId,
        street: d.street,
        city: d.city,
        state: d.state,
        postal_code: d.postalCode,
        latitude: opts.latitude,
        longitude: opts.longitude,
        phone: d.phone,
        email: d.email,
        ...(d.unit ? { unit: d.unit } : {}),
        ...(d.instructions ? { instructions: d.instructions } : {}),
      });
      for (const it of items) {
        await call("cart_add_line", {
          cart_id: cartId,
          restaurant_id: restaurantId,
          menu_item_id: it.itemId,
          quantity: it.quantity,
          options: await requiredOptions(restaurantId, it.itemId),
        });
      }
      const tipMinor = typeof args.tipMinor === "number" ? args.tipMinor : 0;
      if (tipMinor > 0) await call("cart_set_tip", { cart_id: cartId, amount_cents: tipMinor });
      const t = cartTotal(await call("cart_read", { cart_id: cartId }));
      const menuSubtotal = items.reduce(
        (n, i) => n + menu.items.find((m) => m.id === i.itemId)!.priceMinor * i.quantity,
        0,
      );
      return {
        provider: "grubhub",
        cartId,
        restaurant: menu.name,
        // Null when Grubhub doesn't show the final total before checkout; the agent then refuses to
        // ask for approval of an amount it can't state exactly.
        totalMinor: t.totalMinor,
        subtotalMinor: t.subtotalMinor ?? menuSubtotal,
        taxMinor: t.taxMinor,
        feesMinor: t.feesMinor,
        tipMinor: t.tipMinor ?? tipMinor,
        currency: menu.items[0]?.currency ?? "USD",
      };
    },

    submit_order: async (args) => {
      const cartId = str(args.cartId);
      const approved = typeof args.approvedTotalMinor === "number" ? args.approvedTotalMinor : NaN;
      if (!cartId || !Number.isInteger(approved))
        throw new HarnessError("tool_args_invalid", "cartId and approvedTotalMinor are required");
      if (approved > opts.maxOrderMinor)
        throw new HarnessError("permission_denied", "order is over the spending cap");
      // Exact-quote binding: re-read the cart and refuse if what would be charged changed.
      const current = cartTotal(await call("cart_read", { cart_id: cartId })).totalMinor;
      if (current === null || Math.abs(current - approved) > TOTAL_TOLERANCE_MINOR)
        return { provider: "grubhub", placed: false, reason: "total_changed", currentTotalMinor: current };
      // Checkout isn't wired yet: grubhub-mcp's place_order calls an endpoint Grubhub doesn't serve,
      // and the real checkout call (attach saved card + check out) hasn't been verified. Fail closed:
      // nothing is charged and the group is told the order wasn't placed.
      return { provider: "grubhub", placed: false, reason: "checkout_not_available" };
    },

    order_status: async (args) => {
      const orderId = str(args.orderId);
      if (!orderId) throw new HarnessError("tool_args_invalid", "orderId is required");
      return {
        provider: "grubhub",
        orderId,
        ...normalizeStatus(await call("track_order", { order_id: orderId })),
      };
    },
  };

  return { manifests: grubhubDiningManifests, handlers };
}
