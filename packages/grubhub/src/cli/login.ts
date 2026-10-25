// Sign the demo Grubhub account in once (one-time code by email; no password is ever typed here).
//   pnpm --filter @campus/grubhub login
// The session is stored in GRUBHUB_SESSION_DIR (default ./.data/grubhub, gitignored). It contains
// credentials: never commit or share it. Use a dedicated demo account.
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { GrubhubProcess } from "../client";

const sessionDir = resolve(process.env.GRUBHUB_SESSION_DIR ?? "../../.data/grubhub");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const gh = new GrubhubProcess({ sessionDir });
const say = (line: string) =>
  process.stdout.write(`${line}
`);

try {
  const email = (await rl.question("Grubhub account email: ")).trim();
  await gh.call("send_login_otp", { email });
  const code = (await rl.question("Code from the email: ")).trim();
  await gh.call("verify_login_otp", { email, code });
  const addresses = (await gh.call("get_addresses", {})) as unknown;
  const payments = (await gh.call("get_payment_methods", {})) as unknown;
  const count = (v: unknown) =>
    Array.isArray(v)
      ? v.length
      : Array.isArray((v as { addresses?: unknown[] })?.addresses)
        ? (v as { addresses: unknown[] }).addresses.length
        : "?";
  say(`Signed in. Session saved in ${sessionDir}`);
  say(`Saved addresses: ${count(addresses)}. Saved payment methods: ${count(payments)}.`);
  say("Make sure the account has the delivery address and a card saved in the Grubhub app.");
} catch (err) {
  process.stderr.write(`Login failed: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
} finally {
  rl.close();
  await gh.close();
}
