// Import-boundary rule (harness-spec 18.1 / 18.3 item 2).
//
// Inside packages/<name>/ a file may import:
//   - npm dependencies and node builtins,
//   - files inside its own package (relative imports that stay inside packages/<name>/),
//   - @campus/contracts (and its subpaths).
// packages/contracts itself may import no other workspace package.
// apps/* and tests/ are composition roots and are not restricted.
import path from "node:path";

const WORKSPACE_SCOPE = "@campus/";
const CONTRACTS = "@campus/contracts";

function packageRootOf(filename) {
  const norm = filename.split(path.sep).join("/");
  const m = norm.match(/^(.*\/packages\/[^/]+)\//);
  return m ? { root: m[1], name: m[1].split("/").pop() } : null;
}

/** @type {import("eslint").Rule.RuleModule} */
const onlyContracts = {
  meta: {
    type: "problem",
    docs: { description: "packages may import only @campus/contracts and their own files" },
    schema: [],
    messages: {
      crossPackage:
        "'{{source}}' crosses a package boundary. Packages may import only @campus/contracts and their own files (harness-spec 18.1).",
      contractsPure: "packages/contracts must not import other workspace packages ('{{source}}').",
      relativeEscape:
        "Relative import '{{source}}' leaves packages/{{pkg}}. Depend on @campus/contracts interfaces instead.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const pkg = packageRootOf(filename);
    if (!pkg) return {};

    function check(node, source) {
      if (typeof source !== "string") return;
      if (source.startsWith(WORKSPACE_SCOPE)) {
        const isContracts = source === CONTRACTS || source.startsWith(`${CONTRACTS}/`);
        if (pkg.name === "contracts") {
          context.report({ node, messageId: "contractsPure", data: { source } });
        } else if (!isContracts) {
          context.report({ node, messageId: "crossPackage", data: { source } });
        }
        return;
      }
      if (source.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), source).split(path.sep).join("/");
        if (!resolved.startsWith(`${pkg.root}/`) && resolved !== pkg.root) {
          context.report({ node, messageId: "relativeEscape", data: { source, pkg: pkg.name } });
        }
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === "Literal" && check(node, node.source.value),
    };
  },
};

export default { rules: { "only-contracts": onlyContracts } };
