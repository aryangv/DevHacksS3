import { describe, expect, it } from "vitest";
import {
  cartTotal,
  categoryOf,
  createGrubhubDining,
  menuItems,
  normalizeStatus,
  requiredChoices,
  tagsFor,
} from "../src/index";

// Shapes follow real grubhub-mcp 1.1.7 responses observed on 2026-10-25 (Taco Bell near ASU),
// trimmed. No network.

const MENU = {
  restaurant: {
    id: "926742",
    name: "Taco Bell",
    menu_category_list: [
      {
        name: "Breakfast",
        menu_item_list: [{ id: "1", name: "Breakfast Burrito", price: { amount: 182, currency: "USD" } }],
      },
      {
        name: "Burritos",
        menu_item_list: [
          { id: "11", name: "Bean Burrito", price: { amount: 199, currency: "USD" } },
          { id: "12", name: "Steak Double Dipping Burritos", price: { amount: 731, currency: "USD" } },
        ],
      },
      {
        name: "Veggie Cravings",
        menu_item_list: [{ id: "21", name: "Crunchwrap Supreme", price: { amount: 599, currency: "USD" } }],
      },
      {
        name: "Drinks",
        menu_item_list: [{ id: "31", name: "Baja Blast", price: { amount: 299, currency: "USD" } }],
      },
      {
        name: "Sauce Packets",
        menu_item_list: [{ id: "41", name: "Fire Sauce", price: { amount: 0, currency: "USD" } }],
      },
    ],
  },
};

type Call = { tool: string; args: Record<string, unknown> };

const DELIVERY = {
  street: "301 E Orange St",
  city: "Tempe",
  state: "AZ",
  postalCode: "85281",
  phone: "4805550100",
  email: "demo@example.com",
};

/** A priced cart, in the shape Grubhub returned live (2026-10-25). */
const cart = (grand: number, tip = 0) => ({
  id: "cart-1",
  charges: {
    lines: { diner_total: 930, line_items: [{ id: "line-1" }] },
    diner_subtotal: 930,
    fees: { total: 200, delivery: 0, service: 200 },
    taxes: { total: 104 },
    tip: { amount: tip, type: "INCLUDE_IN_BILL" },
    diner_grand_total: grand,
  },
});

function fakeGrubhub(over: Partial<Record<string, (a: Record<string, unknown>) => unknown>> = {}) {
  const calls: Call[] = [];
  const base: Record<string, (a: Record<string, unknown>) => unknown> = {
    search_restaurants: () => ({
      results: [
        { restaurant_id: "926742", name: "Taco Bell", open: true, delivery: true, cuisines: ["Mexican"] },
        { restaurant_id: "999", name: "Closed Place", open: false, delivery: true },
      ],
    }),
    get_restaurant: () => MENU,
    get_menu_item: (a) =>
      a.item_id === "12"
        ? {
            menu_item: {
              choice_category_list: [
                { name: "Item 1", min_choice_options: 1, choice_option_list: [{ id: "c1" }, { id: "c2" }] },
                { name: "Extras", min_choice_options: 0, choice_option_list: [{ id: "x1" }] },
              ],
            },
          }
        : { menu_item: { choice_category_list: [] } },
    cart_new: () => ({ id: "cart-1" }),
    cart_set_delivery: () => ({ ok: true }),
    cart_add_line: () => ({ id: "line-1" }),
    cart_read: () => cart(1234),
    cart_set_tip: () => ({ ok: true }),
    track_order: () => ({ status: "OUT_FOR_DELIVERY", estimated_delivery_minutes: 12 }),
  };
  const impl = { ...base, ...over };
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const f = impl[tool];
    if (!f) throw new Error(`unexpected tool ${tool}`);
    return f(args);
  };
  const dining = createGrubhubDining({
    call,
    latitude: 33.4242,
    longitude: -111.9281,
    delivery: DELIVERY,
    maxOrderMinor: 5000,
  });
  return { calls, h: dining.handlers, manifests: dining.manifests };
}

describe("menu mapping", () => {
  it("keeps orderable items, drops sauces and breakfast, infers vegetarian from names/categories", () => {
    const items = menuItems(MENU);
    expect(items.map((i) => [i.id, i.category, i.tags])).toEqual([
      ["11", "main", ["vegetarian_friendly"]],
      ["12", "main", []],
      ["21", "main", ["vegetarian_friendly"]],
      ["31", "drink", []],
    ]);
    expect(categoryOf("Sides")).toBe("side");
    expect(tagsFor("Chicken Quesadilla", "Quesadillas")).toEqual([]);
    expect(tagsFor("Cheese Quesadilla", "Quesadillas")).toEqual(["vegetarian_friendly"]);
  });
});

describe("dining tools backed by Grubhub", () => {
  it("search: open delivering restaurants with a per-person estimate and a grubhub option id", async () => {
    const { h, calls } = fakeGrubhub();
    const out = (await h.search_options!({ query: "taco bell" })) as {
      options: Array<Record<string, unknown>>;
    };
    expect(out.options).toEqual([
      {
        id: "gh_926742",
        name: "Taco Bell",
        cuisine: "mexican",
        pricePerPersonMinor: 599,
        currency: "USD",
        tags: ["vegetarian_friendly"],
      },
    ]);
    expect(calls[0]).toMatchObject({
      tool: "search_restaurants",
      args: { latitude: 33.4242, query: "taco bell" },
    });
    expect(
      ((await h.search_options!({ maxPricePerPersonMinor: 500 })) as { options: unknown[] }).options,
    ).toEqual([]);
  });

  it("menu: by option id only; unknown ids are refused", async () => {
    const { h } = fakeGrubhub();
    const menu = (await h.get_menu!({ optionId: "gh_926742" })) as { restaurant: string; items: unknown[] };
    expect(menu.restaurant).toBe("Taco Bell");
    expect(menu.items).toHaveLength(4);
    await expect(h.get_menu!({ optionId: "926742" })).rejects.toMatchObject({ code: "tool_args_invalid" });
    await expect(h.get_menu!({ optionId: "gh_../../etc" })).rejects.toMatchObject({
      code: "tool_args_invalid",
    });
  });

  it("quote: builds one cart with required option defaults and returns Grubhub's real total; no charge", async () => {
    const { h, calls } = fakeGrubhub({ cart_read: () => cart(1234, 300) });
    const q = (await h.quote_order!({
      optionId: "gh_926742",
      items: [
        { itemId: "12", quantity: 1 },
        { itemId: "11", quantity: 2 },
      ],
      tipMinor: 300,
    })) as Record<string, unknown>;
    expect(q).toMatchObject({
      cartId: "cart-1",
      totalMinor: 1234,
      subtotalMinor: 930,
      feesMinor: 200,
      taxMinor: 104,
      tipMinor: 300,
    });
    const tools = calls.map((c) => c.tool).filter((t) => t.startsWith("cart_"));
    // Address before items (Grubhub refuses items on a cart without delivery info).
    expect(tools).toEqual([
      "cart_new",
      "cart_set_delivery",
      "cart_add_line",
      "cart_add_line",
      "cart_set_tip",
      "cart_read",
    ]);
    expect(calls.find((c) => c.tool === "cart_set_delivery")!.args).toMatchObject({
      cart_id: "cart-1",
      street: "301 E Orange St",
      postal_code: "85281",
      latitude: 33.4242,
      phone: "4805550100",
    });
    const lines = calls.filter((c) => c.tool === "cart_add_line").map((c) => c.args);
    expect(lines[0]).toMatchObject({
      restaurant_id: "926742",
      menu_item_id: "12",
      quantity: 1,
      options: [{ id: "c1", quantity: 1, child_options: [] }],
    });
    expect(lines[1]).toMatchObject({ menu_item_id: "11", quantity: 2, options: [] });
    expect(calls.find((c) => c.tool === "cart_set_tip")!.args).toEqual({
      cart_id: "cart-1",
      amount_cents: 300,
    });
    await expect(
      h.quote_order!({ optionId: "gh_926742", items: [{ itemId: "nope", quantity: 1 }] }),
    ).rejects.toMatchObject({
      code: "tool_args_invalid",
    });
  });

  it("quote: no final total from Grubhub → totalMinor null (the agent then won't ask for approval)", async () => {
    const { h } = fakeGrubhub({ cart_read: () => ({ id: "cart-1", charges: null }) });
    const q = (await h.quote_order!({
      optionId: "gh_926742",
      items: [{ itemId: "11", quantity: 1 }],
    })) as Record<string, unknown>;
    expect(q.totalMinor).toBeNull();
    expect(q.subtotalMinor).toBe(199);
  });

  it("submit: refuses a changed total or one over the cap; checkout is not wired yet (fails closed)", async () => {
    const ok = fakeGrubhub();
    expect(await ok.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 1234 })).toEqual({
      provider: "grubhub",
      placed: false,
      reason: "checkout_not_available",
    });

    const changed = fakeGrubhub();
    expect(await changed.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 1200 })).toMatchObject({
      placed: false,
      reason: "total_changed",
      currentTotalMinor: 1234,
    });

    const capped = fakeGrubhub({ cart_read: () => cart(6000) });
    await expect(
      capped.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 6000 }),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("required choices: defaulted options first, nested required groups as child_options, optional groups skipped", () => {
    // Trimmed from Taco Bell's Cantina Chicken Soft Taco (live, 2026-10-25).
    const choices = requiredChoices([
      {
        name: "Item 1",
        min_choice_options: 1,
        quantity_settings: { minimum_units: 1 },
        choice_option_list: [
          { id: "other", defaulted: false },
          {
            id: "taco",
            defaulted: true,
            choice_category_list: [
              {
                name: "Protein",
                min_choice_options: 1,
                choice_option_list: [{ id: "chicken", defaulted: true }],
              },
              { name: "Add Ons", min_choice_options: 0, choice_option_list: [{ id: "extra" }] },
            ],
          },
        ],
      },
      {
        name: "Sauce",
        min_choice_options: 1,
        choice_option_list: [{ id: "gone", available: false }, { id: "salsa" }],
      },
    ]);
    expect(choices).toEqual([
      { id: "taco", quantity: 1, child_options: [{ id: "chicken", quantity: 1, child_options: [] }] },
      { id: "salsa", quantity: 1, child_options: [] },
    ]);
  });

  it("only submit_order is a spend tool", () => {
    const { manifests } = fakeGrubhub();
    expect(manifests.filter((m) => m.riskClass === "spend").map((m) => m.name)).toEqual(["submit_order"]);
  });

  it("tracking statuses map to placed / preparing / on_the_way / delivered / cancelled", async () => {
    const { h } = fakeGrubhub();
    expect(await h.order_status!({ orderId: "GH-777" })).toMatchObject({
      status: "on_the_way",
      etaMinutes: 12,
    });
    expect(normalizeStatus({ status: "CONFIRMED" }).status).toBe("preparing");
    expect(normalizeStatus({ state: "DELIVERED" }).status).toBe("delivered");
    expect(normalizeStatus({ status: "CANCELLED" }).status).toBe("cancelled");
    expect(normalizeStatus({}).status).toBe("unknown");
    expect(cartTotal(cart(1500)).totalMinor).toBe(1500);
    // An empty cart has no total to approve.
    expect(cartTotal({ charges: { lines: { line_items: [] }, diner_grand_total: 0 } }).totalMinor).toBeNull();
  });
});
