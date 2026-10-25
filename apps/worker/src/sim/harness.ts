import {
  type AuditEvent,
  type InboundMessage,
  type IngestResult,
  type Logger,
  type TurnOutcome,
  newId,
} from "@campus/contracts";
import { FakeMessagingAdapter, type SentMessage } from "@campus/contracts/fakes";
import { demoUsers } from "@campus/contracts/fixtures";
import { type Container, type ContainerOverrides, buildContainer } from "../container";

// Programmatic chat simulator: push fake DMs / group messages / Sendblue fixtures through the real
// pipeline and collect what was sent plus the audit trace. Used by the CLI and the acceptance tests.

export type SimTurn = {
  inbound: InboundMessage;
  ingest: IngestResult;
  outcomes: TurnOutcome[];
  sent: SentMessage[];
  trace: AuditEvent[];
};

export class Simulator {
  private seq = 0;
  readonly names = new Map<string, string>();

  constructor(readonly c: Container) {}

  /**
   * Builds a container whose messaging is always the fake adapter (the simulator never sends real
   * iMessages), with everything else selected by env flags as usual.
   */
  static async create(
    opts: {
      env?: Record<string, string | undefined>;
      overrides?: ContainerOverrides;
      seedDemo?: boolean;
      logger?: Logger;
    } = {},
  ): Promise<Simulator> {
    const messaging =
      (opts.overrides?.messaging as FakeMessagingAdapter | undefined) ?? new FakeMessagingAdapter();
    const env = { LOG_LEVEL: "warn", ...(opts.env ?? process.env) };
    const c = await buildContainer({
      env,
      overrides: { ...opts.overrides, messaging },
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    c.fakes.messaging = messaging;
    const sim = new Simulator(c);
    if (opts.seedDemo ?? true) sim.seedDemoCast();
    return sim;
  }

  get messaging(): FakeMessagingAdapter {
    return this.c.fakes.messaging!;
  }

  /** Demo cast (fictional, 555 numbers): three verified students and one unverified. */
  seedDemoCast(): void {
    const { identity, broker } = this.c.fakes;
    for (const u of demoUsers) {
      this.names.set(u.externalId, u.displayName);
      if (identity)
        identity.seedUser({
          userId: u.userId,
          externalId: u.externalId,
          displayName: u.displayName,
          verified: u.verified,
        });
      if (broker && u.verified) broker.setFacts(u.userId, u.private);
    }
  }

  verify(externalId: string, displayName?: string): void {
    if (!this.c.fakes.identity)
      throw new Error("verify() needs the fake identity service (USE_REAL_IDENTITY=false)");
    this.c.fakes.identity.verify(externalId, displayName ? { displayName } : {});
    if (displayName) this.names.set(externalId, displayName);
  }

  label(externalId: string): string {
    return this.names.get(externalId) ?? externalId;
  }

  dm(from: string, text: string, opts: { messageId?: string } = {}): Promise<SimTurn> {
    return this.push({
      platform: "imessage",
      providerMessageId: opts.messageId ?? this.nextId(),
      providerConversationId: from,
      senderExternalId: from,
      participantExternalIds: [from],
      isGroup: false,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  group(
    groupId: string,
    from: string,
    members: string[],
    text: string,
    opts: { messageId?: string } = {},
  ): Promise<SimTurn> {
    return this.push({
      platform: "imessage",
      providerMessageId: opts.messageId ?? this.nextId(),
      providerConversationId: groupId,
      senderExternalId: from,
      participantExternalIds: [...new Set([...members, from])],
      isGroup: true,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  /** Push a raw provider payload (e.g. a Sendblue fixture) through verify + normalize first. */
  async fixture(raw: unknown): Promise<SimTurn | null> {
    const body = JSON.stringify(raw);
    if (!this.c.messaging.verifyWebhook({}, body)) throw new Error("webhook verification failed");
    const msg = this.c.messaging.normalize(JSON.parse(body));
    return msg ? this.push(msg) : null;
  }

  async push(inbound: InboundMessage): Promise<SimTurn> {
    const before = this.messaging.sent.length;
    const ingest = await this.c.pipeline.ingest(inbound);
    const outcomes = await this.c.worker.drain();
    const sent = this.messaging.sent.slice(before);
    const trace = await this.c.audit.query({ turnId: ingest.eventId });
    return { inbound, ingest, outcomes, sent, trace };
  }

  format(turn: SimTurn, opts: { trace?: boolean } = {}): string {
    const where = turn.inbound.isGroup ? `group ${turn.inbound.providerConversationId}` : "dm";
    const lines = [`> [${where}] ${this.label(turn.inbound.senderExternalId)}: ${turn.inbound.text}`];
    if (turn.ingest.status === "duplicate")
      lines.push("  (duplicate delivery - deduped, not processed again)");
    for (const m of turn.sent) {
      const to = m.kind === "group" ? `group ${m.to}` : `dm -> ${this.label(m.to)}`;
      lines.push(`  < [${to}] agent: ${m.text}`);
    }
    for (const o of turn.outcomes)
      lines.push(`  = outcome: ${o.status}${o.detail ? ` ${JSON.stringify(o.detail)}` : ""}`);
    if (opts.trace) {
      lines.push(
        `  trace: ${turn.trace.map((e) => e.action + (e.policyResult ? `(${e.policyResult})` : "")).join(" -> ") || "(none)"}`,
      );
    }
    return lines.join("\n");
  }

  private nextId(): string {
    return `sim-${++this.seq}-${newId().slice(0, 8)}`;
  }
}
