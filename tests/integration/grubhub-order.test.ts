// P2 contribution (owner of this folder: P1 — please review). A real-provider group order end to end
// through P1's pipeline, with Grubhub replaced by a fake shaped like real grubhub-mcp responses:
// group asks → proposal → confirm → each agent picks items → real quote (tax/fees) → payer approves
// the exact total → order placed through the gateway → delivery updates posted to the same group.
import type { GroupMealState } from "@campus/contracts";
import type { Simulator } from "@campus/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MEMBERS, AVERY, CASEY, GROUP, makeSim } from "./helpers";

const MENU = {
  restaurant: {
    id: "926742",
    name: "Taco Bell",
    menu_category_list: [
      {
        name: "Burritos",
        menu_item_list: [
          { id: "11", name: "Bean Burrito", price: { amount: 199, currency: "USD" } },
          { id: "12", name: "Steak Burrito", price: { amount: 731, currency: "USD" } },
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
    ],
  },
};
const FEES_AND_TAX = 412;

let sim: Simulator;
let calls: Array<{ tool: string; args: Record<string, unknown> }>;
let cartSubtotal: number;
let totalOverride: number | null;
let tracking: string[];

function fakeGrubhub() {
  const prices = new Map<string, number>([
    ["11", 199],
    ["12", 731],
    ["21", 599],
    ["31", 299],
  ]);
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ tool, args });
    switch (tool) {
      case "search_restaurants":
        return {
          results: [
            {
              restaurant_id: "926742",
              name: "Taco Bell",
              open: true,
              delivery: true,
              cuisines: ["Fast Food"],
            },
          ],
        };
      case "get_restaurant":
        return MENU;
      case "get_menu_item":
        return { menu_item: { choice_category_list: [] } };
      case "create_cart":
      case "add_to_cart":
        cartSubtotal += (prices.get(String(args.menu_item_id)) ?? 0) * Number(args.quantity ?? 1);
        return { id: "cart-1" };
      case "get_cart":
        return {
          id: "cart-1",
          charges: {
            total: { amount: totalOverride ?? cartSubtotal + FEES_AND_TAX },
            diner_subtotal: { amount: cartSubtotal },
          },
        };
      case "place_order":
        return { order_id: "GH-ORDER-1" };
      case "track_order":
        return { status: tracking.shift() ?? "DELIVERED", estimated_delivery_minutes: 9 };
      default:
        throw new Error(`unexpected grubhub tool ${tool}`);
    }
  };
}

beforeEach(async () => {
  calls = [];
  cartSubtotal = 0;
  totalOverride = null;
  tracking = ["CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"];
  sim = await makeSim({
    env: { DINING_PROVIDER: "grubhub", DELIVERY_LATITUDE: "33.4242", DELIVERY_LONGITUDE: "-111.9281" },
    overrides: { diningCaller: fakeGrubhub() },
  });
});

afterEach(async () => {
  await sim.c.close();
});

let conversationId = "";
const order = () => sim.c.tasks.findActive<GroupMealState>(conversationId, "group_meal");

async function planAndConfirm() {
  const ask = await sim.group(
    GROUP,
    AVERY.externalId,
    ALL_MEMBERS,
    "@agent order taco bell for dinner? under $20 each",
  );
  conversationId = ask.outcomes[0]!.conversationId!;
  expect(ask.sent.filter((m) => m.kind === "group").at(-1)!.text).toMatch(/^Proposal: Taco Bell/);
  return sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");
}

describe("real-provider group order (Grubhub, faked at the process boundary)", () => {
  it("wires Grubhub as the dining provider", () => {
    expect(sim.c.wiring.dining).toBe("real");
  });

  it("quotes the exact cart, asks only the payer to approve, places it once approved, then tracks delivery", async () => {
    const confirm = await planAndConfirm();
    const groupText = confirm.sent.filter((m) => m.kind === "group").at(-1)!.text;
    const task = (await order())!;
    const o = task.state.order!;
    expect(task.status).toBe("awaiting_payment");
    expect(o.quote).toMatchObject({
      provider: "grubhub",
      cartId: "cart-1",
      totalMinor: cartSubtotal + FEES_AND_TAX,
    });
    expect(groupText).toContain(
      `Total $${((cartSubtotal + FEES_AND_TAX) / 100).toFixed(2)} with tax and fees.`,
    );
    expect(groupText).toContain("Casey, I sent you a private link to approve");
    // Split = each person's items plus a proportional share of tax/fees.
    expect(o.splits.reduce((n, s) => n + s.owesMinor, 0)).toBeLessThan(o.totalMinor);
    const dm = confirm.sent.find((m) => m.kind === "dm")!;
    expect(dm.to).toBe(CASEY.externalId);
    expect(dm.text).toContain(`/approve/${o.approvalId}`);
    expect(calls.some((c) => c.tool === "place_order")).toBe(false); // nothing ordered yet

    // Someone else can't approve; the payer can, exactly once.
    expect((await sim.c.orders.approveAndPlace(o.approvalId!, AVERY.userId)).status).toBe("forbidden");
    const placed = await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId);
    expect(placed).toMatchObject({ status: "placed", orderId: "GH-ORDER-1" });
    expect(calls.filter((c) => c.tool === "place_order")).toHaveLength(1);
    expect((await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId)).status).toBe("not_found");
    const groupMsgs = () => sim.c.fakes.messaging!.to(GROUP).map((m) => m.text);
    expect(groupMsgs().at(-1)).toMatch(
      /^Order placed with Taco Bell on Grubhub: \$\d+\.\d\d, paid by Casey\./,
    );

    // Delivery updates land in the same group; the split is repeated on delivery.
    await sim.c.orders.trackOrders();
    expect(groupMsgs().at(-1)).toBe("Taco Bell is preparing the order.");
    await sim.c.orders.trackOrders();
    expect(groupMsgs().at(-1)).toBe("The food is on the way (about 9 min).");
    await sim.c.orders.trackOrders();
    expect(groupMsgs().at(-1)).toMatch(/^Delivered\. Enjoy! Split: .*owes Casey \$/);
    const done = await sim.c.tasks.get<GroupMealState>(task.id);
    expect(done!.status).toBe("completed");
    await sim.c.orders.trackOrders();
    expect(groupMsgs().filter((t) => t.startsWith("Delivered"))).toHaveLength(1);
  });

  it("refuses to place the order if the provider's total changed after approval was requested", async () => {
    await planAndConfirm();
    const o = (await order())!.state.order!;
    totalOverride = o.quote!.totalMinor + 150;
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/changed the total to \$/);
    expect(calls.some((c) => c.tool === "place_order")).toBe(false);
  });

  it("never asks anyone to pay when the provider gives no final total", async () => {
    totalOverride = null;
    const caller = fakeGrubhub();
    await sim.c.close();
    sim = await makeSim({
      env: { DINING_PROVIDER: "grubhub", DELIVERY_LATITUDE: "33.4242", DELIVERY_LONGITUDE: "-111.9281" },
      overrides: {
        diningCaller: async (tool, args) =>
          tool === "get_cart" ? { id: "cart-1", charges: null } : caller(tool, args),
      },
    });
    const confirm = await planAndConfirm();
    expect(confirm.sent.filter((m) => m.kind === "group").at(-1)!.text).toContain(
      "didn't give me the final total",
    );
    expect(confirm.sent.some((m) => m.kind === "dm")).toBe(false);
    expect(calls.some((c) => c.tool === "place_order")).toBe(false);
  });
});
