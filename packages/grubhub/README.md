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
2. `.env`: `DINING_PROVIDER=grubhub`, `DELIVERY_LATITUDE/LONGITUDE`, `DELIVERY_STREET/CITY/STATE/POSTAL_CODE`, `DELIVERY_PHONE`, `DELIVERY_EMAIL`
   (optional `GRUBHUB_MAX_ORDER_MINOR`, `GRUBHUB_SESSION_DIR`). Needs `uv` installed.
3. Sign in once: `pnpm --filter @campus/grubhub login` (one-time code by email). The session is saved
   in `.data/grubhub` — it contains credentials; never commit or share it.

## How it runs

`py/campus_grubhub.py` starts the unmodified grubhub-mcp server (login, search, menus, tracking) and
adds cart tools that call the cart endpoints Grubhub actually serves. grubhub-mcp's own cart tools
call endpoints that don't exist (`/carts/{id}/line_items`, `/carts/{id}/submit`), so its carts stay empty.
Started with `uv run --no-project --with grubhub-mcp==1.1.7 python py/campus_grubhub.py`.

## Verified / not verified (2026-10-25, live, Taco Bell near ASU)

- Verified: search, menus, item option trees; building a priced cart. Steps, in order: empty cart →
  `PUT delivery_info` (address + phone + email; required before items, or items are refused as
  "not open") → `POST lines` (required nested choices in `child_options`) → `POST tip` → read
  `charges.diner_grand_total`. Example: 2 burritos = $14.62 + $2.49 fees + $1.38 tax + $2.00 tip = $20.49.
- **Not done: placing the order.** The checkout call hasn't been verified, so `dining__submit_order`
  fails closed (`checkout_not_available`): nothing is charged and the group is told the order
  wasn't placed. It also needs a card saved on the Grubhub account.
