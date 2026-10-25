/** Temporary P4-local interfaces; P1 will publish the canonical equivalents. */
export type ApprovalRequest = {
  userId: string;
  conversationId: string;
  kind: 'tool_ask' | 'permission_change' | 'spend_handoff';
  proposal: unknown;
  channel: 'text' | 'web';
  sensitive?: boolean;
};
export type Approval = {
  id: string;
  userId: string;
  conversationId: string;
  kind: ApprovalRequest['kind'];
  proposal: unknown;
  proposalHash: string;
  codeHash: string;
  channel: 'text' | 'web';
  status: 'pending' | 'approved' | 'declined' | 'expired';
  expiresAt: number;
  consumedAt?: number;
  attempts: number;
};
export interface AuditLog {
  record(event: {
    actorUserId?: string;
    action: string;
    resource?: string;
    policyResult?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}
export interface ApprovalStore {
  insert(approval: Approval): Promise<void>;
  // Implementations MUST serialize mutation across processes, not just per JS instance.
  mutate<T>(id: string, fn: (approval: Approval | null) => T | Promise<T>): Promise<T>;
  list(userId: string): Promise<Approval[]>;
}
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
export type DecisionContext = {
  userId: string;
  verified: boolean;
  conversationId: string;
  isGroup: boolean;
  instruction?: {
    source: string;
    senderUserId: string;
    text: string;
    messageId: string;
  };
};
export type WebSession = {
  userId: string;
  sessionId: string;
  authenticated: boolean;
};
