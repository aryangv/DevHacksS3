import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeSupermemory } from "./fake-supermemory";

/**
 * Serves a FakeSupermemory over real HTTP on localhost so a composition root (worker/api container)
 * can load the real @campus/context module with SUPERMEMORY_BASE_URL pointing here.
 */
export async function serveFakeSupermemory(
  fake: FakeSupermemory,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const out = await fake.fetch(`http://fake${req.url}`, {
      method: req.method ?? "GET",
      headers: { Authorization: String(req.headers.authorization ?? "") },
      ...(body ? { body } : {}),
    });
    res.writeHead(out.status, { "Content-Type": "application/json" });
    res.end(await out.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
