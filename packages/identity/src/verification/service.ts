import {
  type AuditLog,
  type Clock,
  HarnessError,
  type InboundMessage,
  type Logger,
  type MessagingAdapter,
  type SqlClient,
} from "@campus/contracts";
import type { PgIdentityService } from "../identity-service";
import type { WebSessionService } from "../sessions";
import { UUID_RE, constantTimeEqual, hashToken, newHumanCode, newToken, normalizeAddress } from "../util";

// Sign-up / sign-in verification (spec 4.3 steps 3–6), self-built "inverted OTP" (spec 16 open
// decision 3; the transport is BlueBubbles, so Sendblue Verify is not available):
//
//   start()      — the web page asks for the person's iMessage address (phone or Apple ID email) and
//                  shows a short code plus the bot's address.
//   tryCode()    — the person texts the code to the bot FROM that address; the inbound webhook calls
//                  this before the turn pipeline. Address + code must both match a pending attempt.
//                  (Possession is proven by the message arriving from that handle over iMessage.)
//   poll()       — the page polls; only the browser that started the attempt (browser token) may
//                  exchange an approved attempt for a web session, exactly once.
//
// Marking verified happens once per attempt, in one transaction; replays are no-ops.

export const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_STARTS_PER_HOUR = 5;
const MAX_NAME = 40;

export type StartResult = {
  verificationId: string;
  /** Opaque token the browser keeps (cookie) to claim the session once approved. */
  browserToken: string;
  code: string;
  /** The address the person must text the code TO (the bot). */
  sendTo: string;
  /** The address it must come FROM. */
  address: string;
  smsLink: string;
  expiresAt: string;
};

export type PollResult =
  | { status: "pending"; expiresAt: string }
  | { status: "expired" | "failed" }
  | { status: "approved"; session: { token: string; expiresAt: Date } | null; userId: string };

type SessionRow = {
  id: string;
  external_identity_id: string;
  challenge_id: string | null;
  origin_conversation_id: string | null;
  address: string;
  display_name: string | null;
  status: "pending" | "approved" | "expired" | "failed";
  expires_at: Date | string;
  browser_token_hash: string;
};

const SELECT_SESSION = `SELECT id, external_identity_id, challenge_id, origin_conversation_id, address, display_name,
  status, expires_at, browser_token_hash FROM core.verification_sessions`;

export type VerificationDeps = {
  sql: SqlClient;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  identity: PgIdentityService;
  sessions: WebSessionService;
  messaging: MessagingAdapter;
  /** The bot's iMessage address people text the code to. */
  botAddress: string;
  agentName: string;
};

export class VerificationService {
  constructor(private readonly deps: VerificationDeps) {}

  async start(input: {
    address: string;
    displayName?: string | null;
    challengeToken?: string | null;
  }): Promise<StartResult> {
    const d = this.deps;
    const address = normalizeAddress(input.address);
    if (!address)
      throw new HarnessError(
        "invalid_phone",
        "Enter the phone number or Apple ID email you use for iMessage.",
      );
    const now = d.clock.now();
    const identity = await d.identity.ensureIdentity("imessage", address);

    const recent = await d.sql.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM core.verification_sessions WHERE external_identity_id = $1 AND created_at > $2`,
      [identity.externalIdentityId, new Date(now.getTime() - 3_600_000)],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= MAX_STARTS_PER_HOUR)
      throw new HarnessError("verification_rate_limited", "Too many attempts. Try again in an hour.");

    // A nudge link pre-binds the conversation the confirmation goes back to. The token only counts
    // when it belongs to THIS address; the page never reveals which address a token is for.
    let challengeId: string | null = null;
    let originConversationId: string | null = null;
    if (input.challengeToken) {
      const { rows } = await d.sql.query<{ id: string; origin_conversation_id: string | null }>(
        `SELECT id, origin_conversation_id FROM core.auth_challenges
         WHERE token_hash = $1 AND external_identity_id = $2 AND used_at IS NULL AND expires_at > $3`,
        [hashToken(input.challengeToken), identity.externalIdentityId, now],
      );
      if (rows[0]) {
        challengeId = rows[0].id;
        originConversationId = rows[0].origin_conversation_id;
      }
    }

    // Older pending attempts for this address stop counting: only the newest code works.
    await d.sql.query(
      `UPDATE core.verification_sessions SET status = 'expired' WHERE external_identity_id = $1 AND status = 'pending'`,
      [identity.externalIdentityId],
    );

    const code = newHumanCode();
    const browserToken = newToken();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const { rows } = await d.sql.query<{ id: string }>(
      `INSERT INTO core.verification_sessions
         (external_identity_id, challenge_id, origin_conversation_id, code_hash, address, display_name,
          browser_token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        identity.externalIdentityId,
        challengeId,
        originConversationId,
        hashToken(code),
        address,
        cleanName(input.displayName),
        hashToken(browserToken),
        expiresAt,
        now,
      ],
    );
    await d.audit.record({
      action: "verification.started",
      resource: `external_identity:${identity.externalIdentityId}`,
      ...(originConversationId ? { conversationId: originConversationId } : {}),
      detail: { fromNudge: challengeId !== null },
    });
    return {
      verificationId: rows[0]!.id,
      browserToken,
      code,
      sendTo: d.botAddress,
      address,
      smsLink: `sms:${d.botAddress}?&body=${encodeURIComponent(code)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The page's poll. Issues the web session exactly once, to the browser that started the attempt. */
  async poll(verificationId: string, browserToken: string): Promise<PollResult> {
    const d = this.deps;
    if (!UUID_RE.test(verificationId) || !browserToken) throw notFound();
    let s = await this.load(verificationId);
    if (!s || !constantTimeEqual(hashToken(browserToken), s.browser_token_hash)) throw notFound();
    const now = d.clock.now();
    if (s.status === "pending" && now.getTime() > new Date(s.expires_at).getTime()) {
      await this.expire(s);
      s = (await this.load(s.id))!;
    }
    if (s.status === "pending") return { status: "pending", expiresAt: new Date(s.expires_at).toISOString() };
    if (s.status === "expired" || s.status === "failed") return { status: s.status };

    const identity = await d.identity.byId(s.external_identity_id);
    if (!identity?.userId) return { status: "failed" };
    // Exactly one claim: the conditional UPDATE is the lock.
    const claimed = await d.sql.query(
      `UPDATE core.verification_sessions SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [s.id, now],
    );
    const session = claimed.rows.length ? await d.sessions.create(identity.userId, "imessage_code") : null;
    return { status: "approved", session, userId: identity.userId };
  }

  /**
   * Called by the inbound webhook for every 1:1 message BEFORE the turn pipeline. Returns true when
   * the message was a sign-up code (matched or not for this sender): codes are never passed to the
   * model or stored as memory.
   */
  async tryCode(message: InboundMessage): Promise<boolean> {
    if (message.isGroup || message.platform !== "imessage") return false;
    const code = message.text
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "");
    if (!/^[A-Z0-9]{6}$/.test(code)) return false;
    const d = this.deps;
    const now = d.clock.now();
    // A code that was just used still counts as "a code" (a redelivered webhook must not reach the model).
    const { rows } = await d.sql.query<SessionRow & { approved_at: Date | string | null }>(
      `SELECT id, external_identity_id, challenge_id, origin_conversation_id, address, display_name, status,
              expires_at, browser_token_hash, approved_at
       FROM core.verification_sessions
       WHERE code_hash = $1 AND ((status = 'pending' AND expires_at > $2) OR (status = 'approved' AND approved_at > $3))
       ORDER BY created_at DESC LIMIT 1`,
      [hashToken(code), now, new Date(now.getTime() - CODE_TTL_MS)],
    );
    const s = rows[0];
    if (!s) return false; // not a live code: an ordinary message, the pipeline handles it
    if (s.status === "approved") return true;
    const sender = normalizeAddress(message.senderExternalId) ?? message.senderExternalId;
    if (sender !== s.address) {
      // Typical cause: iMessage sends from the person's email instead of their number (or vice versa).
      // Say which address we saw so they can start again with it; never reveal the typed address.
      await d.audit.record({
        action: "verification.rejected",
        policyResult: "deny",
        resource: `external_identity:${s.external_identity_id}`,
        detail: { reason: "address_mismatch" },
      });
      await d.messaging
        .sendDM(
          message.senderExternalId,
          `That code was made for a different number or email. Your message came from ${sender}. Start again on the sign-up page with that, then text the new code.`,
        )
        .catch((err) => d.logger.warn("mismatch notice failed", { err }));
      return true;
    }
    await this.approve(s, now);
    return true;
  }

  // ---- internals -------------------------------------------------------------------------------

  private async approve(s: SessionRow, now: Date): Promise<void> {
    const d = this.deps;
    const outcome = await d.sql.transaction(async (tx) => {
      const locked = await tx.query<SessionRow>(`${SELECT_SESSION} WHERE id = $1 FOR UPDATE`, [s.id]);
      const cur = locked.rows[0];
      if (!cur || cur.status !== "pending") return null; // already handled (webhook retry)
      const ident = await tx.query<{ user_id: string | null; status: string; user_status: string | null }>(
        `SELECT ei.user_id, ei.status, u.status AS user_status FROM core.external_identities ei
         LEFT JOIN core.users u ON u.id = ei.user_id WHERE ei.id = $1 FOR UPDATE OF ei`,
        [cur.external_identity_id],
      );
      const row = ident.rows[0]!;
      let userId = row.user_id;
      let created = false;
      if (!userId || row.user_status === "deleted") {
        const u = await tx.query<{ id: string }>(
          `INSERT INTO core.users (display_name, created_at) VALUES ($1, $2) RETURNING id`,
          [cur.display_name, now],
        );
        userId = u.rows[0]!.id;
        created = true;
      } else if (cur.display_name) {
        await tx.query(`UPDATE core.users SET display_name = $2 WHERE id = $1 AND display_name IS NULL`, [
          userId,
          cur.display_name,
        ]);
      }
      // A revoked identity can be re-verified: it is a fresh sign-up with fresh consent.
      await tx.query(
        `UPDATE core.external_identities SET user_id = $2, status = 'verified', verified_at = $3, verify_sid = $4
         WHERE id = $1`,
        [cur.external_identity_id, userId, now, `imessage_code:${cur.id}`],
      );
      if (cur.challenge_id)
        await tx.query(`UPDATE core.auth_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL`, [
          cur.challenge_id,
          now,
        ]);
      await tx.query(
        `UPDATE core.verification_sessions SET status = 'approved', approved_at = $2 WHERE id = $1`,
        [cur.id, now],
      );
      return { userId, created, wasStatus: row.status, session: cur };
    });
    if (!outcome) return;
    await d.audit.record({
      action: "identity.verified",
      actorUserId: outcome.userId,
      resource: `external_identity:${s.external_identity_id}`,
      ...(s.origin_conversation_id ? { conversationId: s.origin_conversation_id } : {}),
      detail: { via: "imessage_code", newUser: outcome.created, previous: outcome.wasStatus },
    });
    await this.confirm(outcome.session);
  }

  /** "You're set" (spec 4.3 step 6) in the 1:1 chat, plus a note in the group the nudge came from. */
  private async confirm(s: SessionRow): Promise<void> {
    const d = this.deps;
    const name = s.display_name ? `, ${s.display_name}` : "";
    try {
      await d.messaging.sendDM(
        s.address,
        `You're set${name}! I'm ${d.agentName}. Text me here anytime, or mention me in a group chat I'm in.`,
      );
      if (s.origin_conversation_id) {
        const { rows } = await d.sql.query<{ provider_id: string; type: string }>(
          `SELECT provider_id, type FROM core.conversations WHERE id = $1`,
          [s.origin_conversation_id],
        );
        if (rows[0]?.type === "group")
          await d.messaging.sendGroup(
            rows[0].provider_id,
            `Thanks${name}, you're verified. You can ask me things here now.`,
          );
      }
    } catch (err) {
      // Verification already succeeded; the message is a courtesy.
      d.logger.warn("verification confirmation send failed", { verificationId: s.id, err });
    }
  }

  private async expire(s: SessionRow): Promise<void> {
    const r = await this.deps.sql.query(
      `UPDATE core.verification_sessions SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [s.id],
    );
    if (r.rows.length)
      await this.deps.audit.record({
        action: "verification.expired",
        resource: `external_identity:${s.external_identity_id}`,
        detail: {},
      });
  }

  private async load(id: string): Promise<SessionRow | null> {
    const { rows } = await this.deps.sql.query<SessionRow>(`${SELECT_SESSION} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
}

const notFound = () => new HarnessError("verification_not_found", "verification not found");

function cleanName(name: string | null | undefined): string | null {
  if (!name) return null;
  // Plain text only, one line, bounded: it is shown back in chats.
  const n = name
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return n || null;
}
