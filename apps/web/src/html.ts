import { randomBytes } from "node:crypto";

// Tiny server-side rendering helpers. Every interpolated value goes through `esc` (or `raw` for
// markup we built ourselves). Pages run under a strict CSP with a per-response script nonce.

export type Html = { __html: string };
export const raw = (s: string): Html => ({ __html: s });

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template: strings are escaped, Html values are inserted as-is, arrays are joined. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return raw(out);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && "__html" in (v as object)) return (v as Html).__html;
  return esc(v);
}

export const newNonce = () => randomBytes(16).toString("base64");

export function csp(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5b6170; --line:#e3e6ec; --accent:#0a66ff; --ok:#137a3d; --warn:#9a5b00; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#e8eaef; --muted:#9aa1b1; --line:#2a2f3a; --accent:#5b9dff; --ok:#4cc27a; --warn:#e3a23b; --bad:#ff6b5e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.5rem; margin: 8px 0 4px; } h2 { font-size: 1.1rem; margin: 24px 0 8px; }
p { margin: 8px 0; } .muted { color: var(--muted); } .small { font-size: .875rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 12px 0; }
label { display:block; font-weight:600; margin: 12px 0 4px; }
input[type=text], input[type=tel], input[type=number] { width:100%; padding:10px 12px; font-size:1rem; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); }
button, .button { display:inline-block; margin-top:12px; padding:10px 16px; font-size:1rem; font-weight:600; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; }
button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
button.danger { background: var(--bad); }
.code { font: 700 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2em; padding: 8px 0; }
.status-ok { color: var(--ok); } .status-warn { color: var(--warn); } .status-bad { color: var(--bad); }
nav { display:flex; gap:16px; flex-wrap:wrap; padding: 8px 0 0; } nav a { color: var(--accent); text-decoration:none; font-weight:600; }
ul { padding-left: 20px; } li { margin: 4px 0; } code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }
table { width:100%; border-collapse: collapse; font-size:.875rem; } td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--line); vertical-align: top; }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.75rem; font-weight:600; border:1px solid var(--line); }
`;

export function page(opts: {
  title: string;
  nonce: string;
  body: Html;
  script?: string;
  nav?: boolean;
}): string {
  const navHtml = opts.nav
    ? html`<nav>
        <a href="/me">Account</a><a href="/me/memory">Memory</a><a href="/me/connections">Connections</a
        ><a href="/me/settings">Settings</a>
      </nav>`
    : raw("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(opts.title)}</title><style>${STYLE}</style></head>
<body><main>${navHtml.__html}${opts.body.__html}</main>
${opts.script ? `<script nonce="${opts.nonce}">${opts.script}</script>` : ""}
</body></html>`;
}
