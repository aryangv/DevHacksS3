import type {
  CallRecord,
  Connection,
  Mode,
  OAuthState,
  PermissionRule,
  Risk,
  Server,
  Sql,
  ToolManifest,
  ToolStore,
} from './ports.ts';
import { hash } from './security.ts';

export class PostgresToolStore implements ToolStore {
  private db: Sql;
  constructor(db: Sql) {
    this.db = db;
  }
  async withConnectionLock<T>(
    userId: string,
    serverId: string,
    work: (store: ToolStore) => Promise<T>,
  ): Promise<T> {
    // Commit fail-closed status updates even when the external operation fails.
    const outcome = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `p4:connection:${userId}:${serverId}`,
      ]);
      try {
        return { value: await work(new PostgresToolStore(tx)) };
      } catch (error) {
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  private serverRow(r: Record<string, unknown>): Server {
    return {
      id: String(r.id),
      slug: String(r.slug),
      displayName: String(r.display_name),
      provider: r.provider as Server['provider'],
      transport: String(r.transport),
      baseUrl: r.base_url as string | undefined,
      authType: r.auth_type as Server['authType'],
      oauthConfig: r.oauth_config as Server['oauthConfig'],
      callbackPath: String(r.callback_path),
      status: String(r.status),
    };
  }
  async servers(): Promise<Server[]> {
    const { rows } = await this.db.query('SELECT * FROM mcp.servers ORDER BY slug');
    return rows.map((r) => this.serverRow(r));
  }
  async server(idOrSlug: string): Promise<Server | null> {
    const { rows } = await this.db.query('SELECT * FROM mcp.servers WHERE id::text=$1 OR slug=$1', [
      idOrSlug,
    ]);
    return rows[0] ? this.serverRow(rows[0]) : null;
  }
  async tools(
    serverId: string,
  ): Promise<{ manifests: ToolManifest[]; refreshedAt: number } | null> {
    const { rows } = await this.db.query('SELECT * FROM mcp.tools WHERE server_id=$1', [serverId]);
    if (!rows.length || rows.some((r) => !r.input_schema)) return null;
    return {
      refreshedAt: Math.min(...rows.map((r) => new Date(r.refreshed_at as string).getTime())),
      manifests: rows.map((r) => ({
        name: String(r.name),
        description: String(r.description ?? ''),
        inputSchema: r.input_schema as Record<string, unknown>,
        riskClass: r.risk_class as Risk,
        defaultMode: r.default_mode as Mode,
        requiredScopes: r.required_scopes as string[],
        sensitive: r.sensitive === true,
        trustedArgumentNames: (r.trusted_argument_names ?? []) as string[],
      })),
    };
  }
  async replaceTools(
    serverId: string,
    manifests: ToolManifest[],
    refreshedAt: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM mcp.servers WHERE id=$1 FOR UPDATE', [serverId]);
      await tx.query('DELETE FROM mcp.tools WHERE server_id=$1', [serverId]);
      for (const t of manifests)
        await tx.query(
          `INSERT INTO mcp.tools(server_id,name,description,input_schema_hash,risk_class,default_mode,refreshed_at,input_schema,required_scopes,sensitive,trusted_argument_names)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            serverId,
            t.name,
            t.description,
            hash(t.inputSchema),
            t.riskClass,
            t.defaultMode,
            new Date(refreshedAt),
            JSON.stringify(t.inputSchema),
            t.requiredScopes,
            t.sensitive ?? false,
            t.trustedArgumentNames ?? [],
          ],
        );
    });
  }
  async connection(userId: string, serverId: string): Promise<Connection | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM mcp.user_connections WHERE user_id=$1 AND server_id=$2',
      [userId, serverId],
    );
    const r = rows[0];
    return r
      ? {
          id: String(r.id),
          userId: String(r.user_id),
          serverId: String(r.server_id),
          status: r.status as Connection['status'],
          grantedScopes: r.granted_scopes as string[],
        }
      : null;
  }
  async saveConnection(c: Connection): Promise<void> {
    await this.db.query(
      `INSERT INTO mcp.user_connections(id,user_id,server_id,status,granted_scopes,connected_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='connected' THEN now() END)
      ON CONFLICT(user_id,server_id) DO UPDATE SET status=EXCLUDED.status,granted_scopes=EXCLUDED.granted_scopes,connected_at=CASE WHEN EXCLUDED.status='connected' THEN now() ELSE mcp.user_connections.connected_at END`,
      [c.id, c.userId, c.serverId, c.status, c.grantedScopes],
    );
  }
  async rules(userId: string, serverId: string): Promise<PermissionRule[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM mcp.tool_permissions WHERE user_id=$1 AND server_id=$2 AND revoked_at IS NULL',
      [userId, serverId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      serverId: String(r.server_id),
      toolName: r.tool_name as string | undefined,
      conversationId: r.conversation_id as string | undefined,
      mode: r.mode as Mode,
      constraints: r.constraints as Record<string, unknown>,
      source: r.source as PermissionRule['source'],
      expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : undefined,
      confirmed: !!r.confirmed_at,
    }));
  }
  async defaults(userId: string, serverId: string): Promise<{ riskClass?: Risk; mode: Mode }[]> {
    const { rows } = await this.db.query(
      'SELECT risk_class,mode FROM mcp.permission_defaults WHERE user_id=$1 AND server_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',
      [userId, serverId],
    );
    return rows.map((r) => ({
      riskClass: (r.risk_class ?? undefined) as Risk | undefined,
      mode: r.mode as Mode,
    }));
  }
  async saveRule(r: PermissionRule): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `p4:permission:${r.userId}:${r.serverId}`,
      ]);
      await tx.query(
        `UPDATE mcp.tool_permissions SET revoked_at=now() WHERE user_id=$1 AND server_id=$2 AND tool_name IS NOT DISTINCT FROM $3 AND conversation_id IS NOT DISTINCT FROM $4 AND revoked_at IS NULL`,
        [r.userId, r.serverId, r.toolName ?? null, r.conversationId ?? null],
      );
      await tx.query(
        `INSERT INTO mcp.tool_permissions(id,user_id,server_id,tool_name,conversation_id,mode,constraints,source,expires_at,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          r.id,
          r.userId,
          r.serverId,
          r.toolName ?? null,
          r.conversationId ?? null,
          r.mode,
          JSON.stringify(r.constraints ?? {}),
          r.source,
          r.expiresAt ?? null,
          r.confirmed ? new Date() : null,
        ],
      );
    });
  }
  async resetRules(userId: string, serverId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE mcp.tool_permissions SET revoked_at=now() WHERE user_id=$1 AND server_id=$2 AND revoked_at IS NULL',
        [userId, serverId],
      );
      await tx.query(
        'UPDATE mcp.permission_defaults SET revoked_at=now() WHERE user_id=$1 AND server_id=$2 AND revoked_at IS NULL',
        [userId, serverId],
      );
      // Reset means ask every time, including reads, rather than re-enabling read auto-allow.
      await tx.query(
        `INSERT INTO mcp.tool_permissions(user_id,server_id,mode,source,confirmed_at) VALUES($1,$2,'ask','user_dm',now())`,
        [userId, serverId],
      );
    });
  }
  async saveDefault(r: {
    userId: string;
    serverId: string;
    riskClass: Risk;
    mode: Mode;
    expiresAt?: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `p4:permission:${r.userId}:${r.serverId}`,
      ]);
      await tx.query(
        'UPDATE mcp.permission_defaults SET revoked_at=now() WHERE user_id=$1 AND server_id=$2 AND risk_class=$3 AND revoked_at IS NULL',
        [r.userId, r.serverId, r.riskClass],
      );
      await tx.query(
        `INSERT INTO mcp.permission_defaults(user_id,server_id,risk_class,mode,source,expires_at,confirmed_at) VALUES($1,$2,$3,$4,'user_dm',$5,now())`,
        [r.userId, r.serverId, r.riskClass, r.mode, r.expiresAt ?? null],
      );
    });
  }
  async oauthPut(s: OAuthState): Promise<void> {
    await this.db.query(
      'UPDATE mcp.oauth_states SET used_at=now() WHERE user_id=$1 AND server_id=$2 AND used_at IS NULL',
      [s.userId, s.serverId],
    );
    await this.db.query(
      `INSERT INTO mcp.oauth_states(state_hash,user_id,server_id,pkce_verifier_ciphertext,key_version,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [s.hash, s.userId, s.serverId, s.ciphertext, s.keyVersion, new Date(s.expiresAt)],
    );
  }
  async oauthTake(
    hash: string,
    userId: string,
    serverId: string,
    now: number,
  ): Promise<OAuthState | null> {
    const { rows } = await this.db.query(
      `UPDATE mcp.oauth_states SET used_at=now() WHERE state_hash=$1 AND user_id=$2 AND server_id=$3 AND used_at IS NULL AND expires_at>$4 RETURNING *`,
      [hash, userId, serverId, new Date(now)],
    );
    const r = rows[0];
    return r
      ? {
          hash,
          userId,
          serverId,
          ciphertext: r.pkce_verifier_ciphertext as Buffer,
          keyVersion: Number(r.key_version),
          expiresAt: new Date(r.expires_at as string).getTime(),
        }
      : null;
  }
  async callStart(c: CallRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (c.limits) {
        // Global order for locks avoids cross-user/group deadlocks.
        for (const key of [
          `p4:budget:user:${c.userId}`,
          `p4:budget:conversation:${c.conversationId}`,
        ].sort())
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
        const { rows } = await tx.query(
          `SELECT count(*) FILTER(WHERE user_id=$1 AND turn_id=$3) AS turn_count,
          count(*) FILTER(WHERE user_id=$1 AND created_at>now()-interval '1 minute') AS user_count,
          count(*) FILTER(WHERE conversation_id=$2 AND created_at>now()-interval '1 minute') AS conversation_count
          FROM mcp.tool_calls WHERE decision='execute' AND (user_id=$1 OR conversation_id=$2)`,
          [c.userId, c.conversationId, c.turnId],
        );
        const r = rows[0];
        if (
          Number(r.turn_count) >= c.limits.perTurn ||
          Number(r.user_count) >= c.limits.perUserMinute ||
          Number(r.conversation_count) >= c.limits.perConversationMinute
        )
          return false;
      }
      const { rowCount } = await tx.query(
        `INSERT INTO mcp.tool_calls(user_id,conversation_id,server_id,tool_name,args_hash,decision,mode_used,approval_id,idempotency_key,result_status,turn_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          c.userId,
          c.conversationId,
          c.serverId,
          c.toolName,
          c.argsHash,
          c.decision,
          c.modeUsed,
          c.approvalId ?? null,
          c.key,
          c.decision === 'execute' ? 'executing' : c.decision,
          c.turnId ?? null,
        ],
      );
      return rowCount === 1;
    });
  }
  async callFinish(key: string, status: string, latencyMs: number): Promise<void> {
    await this.db.query(
      'UPDATE mcp.tool_calls SET result_status=$2,latency_ms=$3 WHERE idempotency_key=$1',
      [key, status, latencyMs],
    );
  }
}
