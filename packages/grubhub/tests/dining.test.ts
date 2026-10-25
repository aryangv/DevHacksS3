import { describe, expect, it } from "vitest";
import {
  cartTotal,
  categoryOf,
  createGrubhubDining,
  menuItems,
  normalizeStatus,
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
    create_cart: () => ({ id: "cart-1" }),
    add_to_cart: () => ({ ok: true }),
    get_cart: () => ({ id: "cart-1", charges: { total: { amount: 1234 }, diner_subtotal: { amount: 930 } } }),
    set_tip: () => ({ ok: true }),
    place_order: () => ({ order_id: "GH-777" }),
    track_order: () => ({ status: "OUT_FOR_DELIVERY", estimated_delivery_minutes: 12 }),
  };
  const impl = { ...base, ...over };
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const f = impl[tool];
    if (!f) throw new Error(`unexpected tool ${tool}`);
    return f(args);
  };
  const dining = createGrubhubDining({ call, latitude: 33.4242, longitude: -111.9281, maxOrderMinor: 5000 });
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
    const { h, calls } = fakeGrubhub();
    const q = (await h.quote_order!({
      optionId: "gh_926742",
      items: [
        { itemId: "12", quantity: 1 },
        { itemId: "11", quantity: 2 },
      ],
      tipMinor: 300,
    })) as Record<string, unknown>;
    expect(q).toMatchObject({ cartId: "cart-1", totalMinor: 1234, subtotalMinor: 930, tipMinor: 300 });
    expect(calls.find((c) => c.tool === "create_cart")!.args).toMatchObject({
      menu_item_id: "12",
      options: [{ id: "c1", quantity: 1 }],
    });
    expect(calls.find((c) => c.tool === "add_to_cart")!.args).toMatchObject({
      cart_id: "cart-1",
      menu_item_id: "11",
      quantity: 2,
    });
    expect(calls.find((c) => c.tool === "set_tip")!.args).toEqual({ cart_id: "cart-1", tip_amount: 3 });
    expect(calls.some((c) => c.tool === "place_order")).toBe(false);
    await expect(
      h.quote_order!({ optionId: "gh_926742", items: [{ itemId: "nope", quantity: 1 }] }),
    ).rejects.toMatchObject({
      code: "tool_args_invalid",
    });
  });

  it("quote: no final total from Grubhub → totalMinor null (the agent then won't ask for approval)", async () => {
    const { h } = fakeGrubhub({ get_cart: () => ({ id: "cart-1", charges: null }) });
    const q = (await h.quote_order!({
      optionId: "gh_926742",
      items: [{ itemId: "11", quantity: 1 }],
    })) as Record<string, unknown>;
    expect(q.totalMinor).toBeNull();
    expect(q.subtotalMinor).toBe(199);
  });

  it("submit: places only the exact approved total, under the cap", async () => {
    const ok = fakeGrubhub();
    expect(await ok.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 1234 })).toEqual({
      provider: "grubhub",
      placed: true,
      orderId: "GH-777",
      totalMinor: 1234,
    });

    const changed = fakeGrubhub();
    expect(await changed.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 1200 })).toMatchObject({
      placed: false,
      reason: "total_changed",
      currentTotalMinor: 1234,
    });
    expect(changed.calls.some((c) => c.tool === "place_order")).toBe(false);

    const capped = fakeGrubhub({ get_cart: () => ({ charges: { total: { amount: 6000 } } }) });
    await expect(
      capped.h.submit_order!({ cartId: "cart-1", approvedTotalMinor: 6000 }),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(capped.calls.some((c) => c.tool === "place_order")).toBe(false);
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
    expect(cartTotal({ charges: { total: { amount: 1500 } } }).totalMinor).toBe(1500);
  });
});
