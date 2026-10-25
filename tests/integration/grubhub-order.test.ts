// P2 contribution (owner of this folder: P1 — please review). A real-provider group order end to end
// through P1's pipeline, with Grubhub replaced by a fake shaped like real grubhub-mcp responses:
// group asks → proposal → confirm → each agent picks items → real quote (tax/fees) → payer approves
// the exact total → (checkout not wired yet: fails closed, nothing charged).
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
const GRUBHUB_ENV = {
  DINING_PROVIDER: "grubhub",
  DELIVERY_LATITUDE: "33.4242",
  DELIVERY_LONGITUDE: "-111.9281",
  DELIVERY_STREET: "301 E Orange St",
  DELIVERY_CITY: "Tempe",
  DELIVERY_STATE: "AZ",
  DELIVERY_POSTAL_CODE: "85281",
  DELIVERY_PHONE: "4805550100",
  DELIVERY_EMAIL: "demo@example.com",
};

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
      case "cart_new":
        return { id: "cart-1" };
      case "cart_set_delivery":
      case "cart_set_tip":
        return { ok: true };
      case "cart_add_line":
        cartSubtotal += (prices.get(String(args.menu_item_id)) ?? 0) * Number(args.quantity ?? 1);
        return { id: "line-1" };
      case "cart_read":
        // Shape Grubhub returned live (2026-10-25).
        return {
          id: "cart-1",
          charges: {
            lines: { line_items: cartSubtotal ? [{ id: "line-1" }] : [] },
            diner_subtotal: cartSubtotal,
            fees: { total: FEES_AND_TAX - 100 },
            taxes: { total: 100 },
            tip: { amount: 0, type: "INCLUDE_IN_BILL" },
            diner_grand_total: totalOverride ?? cartSubtotal + FEES_AND_TAX,
          },
        };
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
    env: GRUBHUB_ENV,
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

  it("quotes the exact cart and asks only the payer to approve; checkout fails closed for now", async () => {
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
    expect(calls.find((c) => c.tool === "cart_set_delivery")!.args).toMatchObject({ postal_code: "85281" });

    // Someone else can't approve. The payer can, but checkout isn't wired yet: nothing is placed or
    // charged, and the group is told so (never "ordered").
    expect((await sim.c.orders.approveAndPlace(o.approvalId!, AVERY.userId)).status).toBe("forbidden");
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/wasn't placed.*Nothing was charged/);
    const groupMsgs = sim.c.fakes.messaging!.to(GROUP).map((m) => m.text);
    expect(groupMsgs.some((t) => t.startsWith("Order placed"))).toBe(false);
  });

  it("refuses to place the order if the provider's total changed after approval was requested", async () => {
    await planAndConfirm();
    const o = (await order())!.state.order!;
    totalOverride = o.quote!.totalMinor + 150;
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/changed the total to \$/);
  });

  it("never asks anyone to pay when the provider gives no final total", async () => {
    totalOverride = null;
    const caller = fakeGrubhub();
    await sim.c.close();
    sim = await makeSim({
      env: GRUBHUB_ENV,
      overrides: {
        diningCaller: async (tool, args) =>
          tool === "cart_read" ? { id: "cart-1", charges: null } : caller(tool, args),
      },
    });
    const confirm = await planAndConfirm();
    expect(confirm.sent.filter((m) => m.kind === "group").at(-1)!.text).toContain(
      "didn't give me the final total",
    );
    expect(confirm.sent.some((m) => m.kind === "dm")).toBe(false);
  });
});
