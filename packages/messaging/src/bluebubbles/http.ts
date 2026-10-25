import { HarnessError, type Logger } from "@campus/contracts";
import { type Sleep, Throttle, realSleep } from "../throttle";

// Minimal BlueBubbles Server REST client (server v1 API, verified against the server source:
// packages/server/src/server/api/http/api/v1). Auth is the server password as the `password` query
// parameter. Responses are `{ status, message, data }`; errors add `error: { type, error }`.
//
// Retry policy (spec 4.7): sends are NOT retried here. A failed or timed-out send may still have
// gone out through Messages.app, so the outcome is unknown and re-sending could text someone twice.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type BlueBubblesHttpOptions = {
  baseUrl: string;
  password: string;
  fetch?: FetchLike;
  logger?: Logger;
  maxPerSecond?: number;
  /** AppleScript sends wait for Messages.app; give them time. */
  timeoutMs?: number;
  sleep?: Sleep;
  now?: () => number;
};

export class BlueBubblesHttp {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly throttle: Throttle;

  constructor(private readonly opts: BlueBubblesHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.throttle = new Throttle(opts.maxPerSecond ?? 2, opts.now ?? Date.now, opts.sleep ?? realSleep);
  }

  /** Throws HarnessError("send_failed"). `op` names the call in errors/logs (never the URL: it has the password). */
  async request(
    method: "GET" | "POST",
    path: string,
    op: string,
    body?: Record<string, unknown>,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    if (method === "POST") await this.throttle.wait();
    const params = new URLSearchParams({ ...query, password: this.opts.password });
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}?${params.toString()}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new HarnessError("send_failed", `bluebubbles ${op}: request failed; outcome unknown`, {
        details: { op, outcomeUnknown: true },
        cause: err instanceof Error ? new Error(err.name) : undefined,
      });
    }
    const json = await readJson(res);
    if (!res.ok) {
      const error =
        json.error && typeof json.error === "object" ? (json.error as Record<string, unknown>) : {};
      throw new HarnessError("send_failed", `bluebubbles ${op}: HTTP ${res.status}`, {
        details: {
          op,
          status: res.status,
          ...(typeof error.type === "string" ? { errorType: error.type } : {}),
          // 5xx on a send may still have gone out.
          outcomeUnknown: res.status >= 500,
        },
      });
    }
    return json;
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
