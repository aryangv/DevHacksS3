import type { Approval, ApprovalStore, Sql } from './ports.ts';

export class PostgresApprovalStore implements ApprovalStore {
  private db: Sql;
  constructor(db: Sql) {
    this.db = db;
  }
  async insert(a: Approval): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO core.pending_approvals(id,user_id,conversation_id,kind,proposal,proposal_hash,code_hash,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          a.id,
          a.userId,
          a.conversationId,
          a.kind,
          JSON.stringify(a.proposal),
          a.proposalHash,
          a.codeHash,
          a.status,
          new Date(a.expiresAt),
        ],
      );
      await tx.query('INSERT INTO mcp.approval_security(approval_id,channel) VALUES($1,$2)', [
        a.id,
        a.channel,
      ]);
    });
  }
  private from(r: Record<string, unknown>): Approval {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      conversationId: String(r.conversation_id),
      kind: r.kind as Approval['kind'],
      proposal: r.proposal,
      proposalHash: String(r.proposal_hash),
      codeHash: String(r.code_hash),
      channel: r.channel as Approval['channel'],
      status: r.status as Approval['status'],
      expiresAt: new Date(r.expires_at as string).getTime(),
      consumedAt: r.consumed_at ? new Date(r.consumed_at as string).getTime() : undefined,
      attempts: Number(r.attempts),
    };
  }
  async mutate<T>(id: string, fn: (a: Approval | null) => T | Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT a.*,s.channel,s.consumed_at,s.attempts FROM core.pending_approvals a
        JOIN mcp.approval_security s ON s.approval_id=a.id WHERE a.id=$1 FOR UPDATE OF a,s`,
        [id],
      );
      const a = rows[0] ? this.from(rows[0]) : null,
        result = await fn(a);
      if (a) {
        await tx.query(
          `UPDATE core.pending_approvals SET status=$2,decided_at=CASE WHEN $2 IN ('approved','declined') THEN COALESCE(decided_at,now()) ELSE decided_at END WHERE id=$1`,
          [id, a.status],
        );
        await tx.query(
          'UPDATE mcp.approval_security SET attempts=$2,consumed_at=$3 WHERE approval_id=$1',
          [id, a.attempts, a.consumedAt === undefined ? null : new Date(a.consumedAt)],
        );
      }
      return result;
    });
  }
  async list(userId: string): Promise<Approval[]> {
    const { rows } = await this.db.query(
      `SELECT a.*,s.channel,s.consumed_at,s.attempts FROM core.pending_approvals a
      JOIN mcp.approval_security s ON s.approval_id=a.id WHERE a.user_id=$1 AND a.status='pending'`,
      [userId],
    );
    return rows.map((r) => this.from(r));
  }
}
