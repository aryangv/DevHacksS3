# @campus/grubhub — interim Grubhub dining connector

Backs the agents' `dining__*` tools with **real** Grubhub restaurants, menus and orders, so a group
order can actually be placed and tracked. Team decision (Oct 2026); P4 may fold it into `@campus/tools`.

**What it is, honestly:** it runs the unofficial [`grubhub-mcp`](https://github.com/aserper/grubhub-mcp)
server (pinned `1.1.7`, run unmodified as a separate process; the repo has no license, so none of its
code is copied here). That server calls **Grubhub's private app API** using the Android app's client
key. It is not an official integration, is likely against Grubhub's terms, can break without notice,
and the account can be blocked. Use a dedicated demo account, and say so if asked.

| Tool | Risk | What it does |
|---|---|---|
| `dining__search_options` | read | Restaurants near `DELIVERY_LATITUDE/LONGITUDE` that deliver now, with a per-person estimate |
| `dining__get_menu` | read | Menu items; `vegetarian_friendly` is **inferred** from names/categories (Grubhub has no tags) |
| `dining__quote_order` | read | Builds a Grubhub cart (required options default to the first choice) and returns the **real total** incl. tax/fees. No charge |
| `dining__submit_order` | **spend** | Places that exact cart. Refuses if Grubhub's total changed, or above `GRUBHUB_MAX_ORDER_MINOR` |
| `dining__order_status` | read | Delivery tracking (placed → preparing → on the way → delivered) |

Every call goes through the tool gateway: `submit_order` needs the payer's approval of the exact
total on the approval page, and the bot only says "ordered" once Grubhub returns an order id.

## Setup

1. A dedicated Grubhub account with the **delivery address and a card saved** (in the Grubhub app).
2. `.env`: `DINING_PROVIDER=grubhub`, `DELIVERY_LATITUDE=…`, `DELIVERY_LONGITUDE=…`
   (optional `GRUBHUB_MAX_ORDER_MINOR`, `GRUBHUB_SESSION_DIR`). Needs `uv` installed (for `uvx`).
3. Sign in once: `pnpm --filter @campus/grubhub login` (one-time code by email). The session is saved
   in `.data/grubhub` — it contains credentials; never commit or share it.

## Verified / not verified (2026-10-25)

- Verified live (anonymous): search near ASU finds Taco Bell (open, delivering); menu with item ids,
  prices and required option groups; creating a cart.
- **Not verified yet:** an anonymous cart has no price breakdown. Whether a signed-in cart reports
  the final total, and whether `place_order` works without a delivery-address step (grubhub-mcp has
  no tool for setting the cart's address), needs a signed-in test. If no exact total comes back, the
  bot says so and never asks anyone to pay.
