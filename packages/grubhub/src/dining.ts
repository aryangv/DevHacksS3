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
  /** Hard cap per order (minor units), checked again at submit. */
  maxOrderMinor: number;
  logger?: Logger;
  now?: () => number;
};

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

/** Pull the charged total (minor units) out of a Grubhub cart/bill payload, if present. */
export function cartTotal(json: unknown): {
  totalMinor: number | null;
  subtotalMinor: number | null;
  feesMinor: number | null;
  taxMinor: number | null;
} {
  const o = obj(json);
  const charges = obj(o.charges);
  const pick = (...vals: unknown[]) => {
    for (const v of vals) {
      const a = amount(v);
      if (a !== null) return a;
    }
    return null;
  };
  const total = pick(charges.total, charges.diner_total, o.total, obj(o.bill).total, obj(charges.bill).total);
  const subtotal = pick(charges.diner_subtotal, charges.subtotal, o.subtotal);
  const tax = pick(charges.taxes, obj(charges.taxes).total, charges.tax, o.tax);
  const fees = pick(charges.fees, obj(charges.fees).total, charges.service_fee, o.fees);
  return { totalMinor: total, subtotalMinor: subtotal, feesMinor: fees, taxMinor: tax };
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

  /** Default choices for an item's required option groups (min ≥ 1): the first N options. */
  async function requiredOptions(
    restaurantId: string,
    itemId: string,
  ): Promise<Array<{ id: string; quantity: number }>> {
    const json = await call("get_menu_item", { restaurant_id: restaurantId, item_id: itemId, ...where });
    const item = obj(obj(json).menu_item ?? json);
    const out: Array<{ id: string; quantity: number }> = [];
    for (const c of arr(item.choice_category_list)) {
      const cat = obj(c);
      const min = typeof cat.min_choice_options === "number" ? cat.min_choice_options : 0;
      if (min < 1) continue;
      for (const o of arr(cat.choice_option_list).slice(0, min)) {
        const id = str(obj(o).id);
        if (id) out.push({ id, quantity: 1 });
      }
    }
    return out;
  }

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
      let cartId: string | null = null;
      for (const it of items) {
        const options = await requiredOptions(restaurantId, it.itemId);
        if (!cartId) {
          const created = obj(
            await call("create_cart", {
              restaurant_id: restaurantId,
              menu_item_id: it.itemId,
              quantity: it.quantity,
              ...(options.length ? { options } : {}),
              ...where,
              is_delivery: true,
            }),
          );
          cartId = str(created.id);
          if (!cartId) throw new HarnessError("provider_error", "Grubhub did not return a cart");
        } else {
          await call("add_to_cart", {
            cart_id: cartId,
            menu_item_id: it.itemId,
            quantity: it.quantity,
            ...(options.length ? { options } : {}),
          });
        }
      }
      const tipMinor = typeof args.tipMinor === "number" ? args.tipMinor : 0;
      if (tipMinor > 0) await call("set_tip", { cart_id: cartId!, tip_amount: tipMinor / 100 });
      const cart = await call("get_cart", { cart_id: cartId! });
      const t = cartTotal(cart);
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
        tipMinor,
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
      const current = cartTotal(await call("get_cart", { cart_id: cartId })).totalMinor;
      if (current === null || Math.abs(current - approved) > TOTAL_TOLERANCE_MINOR)
        return { provider: "grubhub", placed: false, reason: "total_changed", currentTotalMinor: current };
      const placed = obj(
        await call("place_order", {
          cart_id: cartId,
          ...(typeof args.tipMinor === "number" && args.tipMinor > 0
            ? { tip_amount: args.tipMinor / 100 }
            : {}),
        }),
      );
      const orderId =
        str(placed.order_id) ?? str(placed.id) ?? str(obj(placed.order).id) ?? str(placed.group_id);
      if (!orderId)
        return { provider: "grubhub", placed: false, reason: "no_order_id", outcomeUnknown: true };
      return { provider: "grubhub", placed: true, orderId, totalMinor: approved };
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
