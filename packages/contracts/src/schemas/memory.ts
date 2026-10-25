// harness-spec Section 5. Implemented by P3 (context/). The harness never names a namespace:
// it passes a principal and the implementation derives `user_{uuid}` / `group_{uuid}`.

export type MemoryPrincipal = { kind: "user"; userId: string } | { kind: "group"; conversationId: string };

export type MemoryKind = "preference" | "fact" | "conversation" | "feedback" | "decision";

/** Flat metadata only (spec 5.2; v5 flat-value constraint still to be verified by P3). */
export type MemoryMetadata = Record<string, string | number | boolean | string[]>;

export type MemoryWrite = {
  content: string;
  kind: MemoryKind;
  metadata: MemoryMetadata;
  /** Stable document id so new information appends instead of duplicating (spec 5.2). */
  customId?: string;
};

export type MemoryItem = {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  score?: number;
};

export type MemoryProfile = {
  static: string[];
  dynamic: string[];
  buckets: Record<string, string[]>;
};

/** A turn's proposal to remember something; the MemoryPolicy (consent) decides. */
export type MemoryCandidate = {
  principal: MemoryPrincipal;
  /** The verified user whose message/decision this is (author_user_id). */
  authorUserId: string;
  write: MemoryWrite;
};

export type MemoryPolicyDecision = { ingest: true; write: MemoryWrite } | { ingest: false; reason: string };

export type MemorySettings = {
  userId: string;
  rememberEnabled: boolean;
  allowedKinds: MemoryKind[];
  sensitiveBucketsEnabled: boolean;
  retentionDays: number | null;
};
