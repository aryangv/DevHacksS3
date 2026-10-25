// @campus/tools — owner: P4 (hands).
//
// Implements: ToolGateway, PermissionResolver, ToolProvider (custom MCP + Composio), VaultClient,
// ConnectionService — see @campus/contracts interfaces/p4.ts and harness-spec Section 6.
// Tables (P4-owned): mcp.*, vault.*. New columns → db/migrations/p4/.
// The gateway receives TurnContext from the harness (ctx.userId is the verified principal; never use
// a user id from tool args) and returns approval prompts for the harness to send.
//
// To plug into the pipeline, export:
//   export const createToolsModule: ToolsModuleFactory = (deps) => ({ gateway, permissions, connections, vault })
// then flip USE_REAL_TOOLS=true at integration point I2.
//
// Import rule: only @campus/contracts and files inside this package.
export {};
