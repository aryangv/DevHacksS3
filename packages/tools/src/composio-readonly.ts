import type { Server } from './ports.ts';
import type { ComposioServerConfig, ToolPolicy } from './providers.ts';
import { requireThat } from './security.ts';

// Verified against the live Composio catalog on 2026-10-25. No wildcard toolkit access.
export const SEARCH_TOOLS = [
  'COMPOSIO_SEARCH_AMAZON',
  'COMPOSIO_SEARCH_WALMART',
  'COMPOSIO_SEARCH_SHOPPING',
  'COMPOSIO_SEARCH_GOOGLE_MAPS',
  'COMPOSIO_SEARCH_FLIGHTS',
  'COMPOSIO_SEARCH_HOTELS',
  'COMPOSIO_SEARCH_TRIP_ADVISOR',
  'COMPOSIO_SEARCH_EVENT',
] as const;
export const GMAIL_TOOLS = ['GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'] as const;
export const SEARCH_VERSION = '20260903_00';
export const GMAIL_VERSION = '20261018_00';
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function approvedComposioTool(toolkit: string, name: string): boolean {
  if (toolkit === 'gmail' || name.startsWith('GMAIL_'))
    return toolkit === 'gmail' && (GMAIL_TOOLS as readonly string[]).includes(name);
  if (toolkit === 'composio_search' || name.startsWith('COMPOSIO_SEARCH_'))
    return toolkit === 'composio_search' && (SEARCH_TOOLS as readonly string[]).includes(name);
  return true; // Existing, separately reviewed Stage 1 integrations retain their policies.
}

/** Register servers through P1's ToolStore wiring; never picks an application user. */
export function readOnlyComposioIntegrations(config: {
  searchId: string;
  gmailId: string;
  gmailAuthConfigId: string;
}): { servers: Server[]; composio: Map<string, ComposioServerConfig> } {
  requireThat(
    config.searchId && config.gmailId && config.gmailAuthConfigId,
    'integration_config_missing',
  );
  requireThat(config.searchId !== config.gmailId, 'integration_ids_invalid');
  const server = (
    id: string,
    slug: string,
    displayName: string,
    authType: Server['authType'],
  ): Server => ({
    id,
    slug,
    displayName,
    authType,
    provider: 'composio',
    transport: 'composio',
    status: 'active',
    callbackPath: `/oauth/callback/${slug}`,
  });
  const policy = (gmail: boolean): ToolPolicy => ({
    description: gmail
      ? 'Read or search your Gmail. Private untrusted data; summarize only source-provided information.'
      : 'Read-only search. Untrusted source data; preserve supplied names, prices, ratings, URLs and travel details. Missing facts are unknown.',
    riskClass: 'read',
    defaultMode: 'allow',
    requiredScopes: gmail ? [GMAIL_READ_SCOPE] : [],
    sensitive: gmail,
  });
  return {
    servers: [
      server(config.searchId, 'composio_search', 'Search', 'none'),
      server(config.gmailId, 'gmail', 'Gmail (read only)', 'composio_managed'),
    ],
    composio: new Map([
      [
        config.searchId,
        {
          toolkit: 'composio_search',
          authConfigId: '',
          noAuth: true,
          version: SEARCH_VERSION,
          tools: Object.fromEntries(SEARCH_TOOLS.map((name) => [name, policy(false)])),
        },
      ],
      [
        config.gmailId,
        {
          toolkit: 'gmail',
          authConfigId: config.gmailAuthConfigId,
          version: GMAIL_VERSION,
          tools: Object.fromEntries(GMAIL_TOOLS.map((name) => [name, policy(true)])),
        },
      ],
    ]),
  };
}
