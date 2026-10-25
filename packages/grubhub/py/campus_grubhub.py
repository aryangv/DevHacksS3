"""grubhub-mcp plus working cart tools.

Runs the unmodified grubhub-mcp server (its login/session, search, menu and tracking tools) and adds
cart tools that use the cart endpoints Grubhub's API actually serves. grubhub-mcp 1.1.7's own cart
tools call endpoints that don't exist (POST /carts/{id}/line_items, /submit) or drop the items, so
carts stay empty. The calls below were checked live on 2026-10-25 (Taco Bell near ASU):

  POST /carts                          -> {id}            empty cart
  PUT  /carts/{id}/delivery_info       -> 204             address + contact (required before items)
  POST /carts/{id}/lines               -> 201 {id}        item; nested choices go in child_options
  POST /carts/{id}/tip                 -> 204             {amount (cents), type: INCLUDE_IN_BILL}
  GET  /carts/{id}                     -> charges.diner_grand_total etc.

Placing the order (checkout) is NOT implemented here yet: it hasn't been verified.

Start: uv run --no-project --with grubhub-mcp==1.1.7 python campus_grubhub.py
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from grubhub_mcp.client import get_client
from grubhub_mcp.server import mcp

EXPERIMENTS = ["IGNORE_MINIMUM_TIP_REQUIREMENT"]


async def _call(method: str, path: str, data: dict[str, Any] | None = None) -> str:
    """Grubhub errors come back as {"error", "status"} (the TS client treats that shape as a failure)."""
    try:
        out = await get_client()._request(method, path, data=data)
    except httpx.HTTPStatusError as exc:
        detail = ""
        try:
            body = exc.response.json()
            if isinstance(body, list):
                detail = ", ".join(
                    f"{e.get('property')}:{e.get('message_key')}" for e in body if isinstance(e, dict)
                )
        except ValueError:
            pass
        return json.dumps({"error": f"HTTP {exc.response.status_code} {detail}".strip(),
                           "status": exc.response.status_code})
    return json.dumps(out if out else {"ok": True})


def _id(value: str) -> str:
    v = str(value)
    if not v.replace("-", "").replace("_", "").isalnum() or len(v) > 64:
        raise ValueError("bad id")
    return v


@mcp.tool()
async def cart_new() -> str:
    """Create an empty Grubhub cart. Returns {id}."""
    return await _call("POST", "/carts", {"brand": "GRUBHUB", "experiments": EXPERIMENTS, "cart_attributes": []})


@mcp.tool()
async def cart_set_delivery(
    cart_id: str, street: str, city: str, state: str, postal_code: str,
    latitude: float, longitude: float, phone: str, email: str, unit: str = "",
    instructions: str = "",
) -> str:
    """Set the cart's delivery address and contact. Required before adding items."""
    payload: dict[str, Any] = {
        "street_address1": street,
        "address_locality": city,
        "address_region": state,
        "postal_code": postal_code,
        "address_country": "USA",
        "latitude": str(latitude),
        "longitude": str(longitude),
        "phone": phone,
        "email": email,
        "green_indicated": False,
    }
    if unit:
        payload["street_address2"] = unit
    if instructions:
        payload["delivery_instructions"] = instructions
    return await _call("PUT", f"/carts/{_id(cart_id)}/delivery_info", payload)


@mcp.tool()
async def cart_add_line(
    cart_id: str, restaurant_id: str, menu_item_id: str, quantity: int = 1,
    options: list[dict[str, Any]] | None = None,
) -> str:
    """Add an item. options: [{id, quantity, child_options: [...]}] (nested choices)."""
    return await _call("POST", f"/carts/{_id(cart_id)}/lines", {
        "menu_item_id": _id(menu_item_id),
        "restaurant_id": _id(restaurant_id),
        "brand": "GRUBHUB",
        "experiments": EXPERIMENTS,
        "quantity": int(quantity),
        "special_instructions": "",
        "options": options or [],
    })


@mcp.tool()
async def cart_set_tip(cart_id: str, amount_cents: int) -> str:
    """Set the tip, in cents."""
    return await _call("POST", f"/carts/{_id(cart_id)}/tip",
                       {"amount": int(amount_cents), "type": "INCLUDE_IN_BILL"})


@mcp.tool()
async def cart_read(cart_id: str) -> str:
    """The cart with Grubhub's charges (diner_grand_total, fees, taxes, tip)."""
    return await _call("GET", f"/carts/{_id(cart_id)}")


if __name__ == "__main__":
    mcp.run()
