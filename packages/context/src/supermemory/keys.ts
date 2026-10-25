import type { Clock } from "@campus/contracts";
import {
  type HttpOptions,
  type KeySource,
  NamespaceClient,
  SupermemoryAdmin,
  SupermemoryHttp,
} from "./client";
import type { Namespace } from "./namespaces";

const REFRESH_BEFORE_MS = 60 * 60 * 1000;

/**
 * Per-namespace scoped keys (harness-spec §5.9 defense in depth). Minted on first
 * use with a 1-day expiry, held in process memory only — never persisted, logged or
 * returned — refreshed an hour before expiry, revoked on `dispose()`.
 */
export class ScopedKeyCache implements KeySource {
  private readonly keys = new Map<Namespace, { key: string; id: string; expiresAt: Date | null }>();
  private readonly inflight = new Map<Namespace, Promise<string>>();

  constructor(
    private readonly admin: SupermemoryAdmin,
    private readonly clock: Clock,
  ) {}

  async keyFor(namespace: Namespace): Promise<string> {
    const cached = this.keys.get(namespace);
    if (
      cached &&
      (!cached.expiresAt || cached.expiresAt.getTime() - this.clock.now().getTime() > REFRESH_BEFORE_MS)
    ) {
      return cached.key;
    }
    const pending = this.inflight.get(namespace);
    if (pending) return pending;
    const minting = this.admin
      .mintScopedKey(namespace)
      .then(async (minted) => {
        const previous = this.keys.get(namespace);
        this.keys.set(namespace, minted);
        if (previous) await this.admin.revokeScopedKey(previous.id).catch(() => undefined);
        return minted.key;
      })
      .finally(() => this.inflight.delete(namespace));
    this.inflight.set(namespace, minting);
    return minting;
  }

  invalidate(namespace: Namespace): void {
    this.keys.delete(namespace);
  }

  /** Forget (and revoke) the key for a namespace that is being deleted. */
  async drop(namespace: Namespace): Promise<void> {
    const cached = this.keys.get(namespace);
    this.keys.delete(namespace);
    if (cached) await this.admin.revokeScopedKey(cached.id).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const all = [...this.keys.values()];
    this.keys.clear();
    await Promise.all(all.map((k) => this.admin.revokeScopedKey(k.id).catch(() => undefined)));
  }
}

/** Fallback when scoped keys are off: every namespace uses the org key. Isolation then rests on our code alone. */
class OrgKeySource implements KeySource {
  constructor(private readonly key: string) {}
  async keyFor() {
    return this.key;
  }
  invalidate() {}
}

export type SupermemoryOptions = HttpOptions & {
  apiKey: string;
  /** Default true. Turn off only if the plan cannot mint scoped keys. */
  scopedKeys?: boolean;
  clock?: Clock;
};

/** Entry point: `forNamespace()` for the data plane, `admin` for org-key operations. */
export class Supermemory {
  readonly admin: SupermemoryAdmin;
  private readonly http: SupermemoryHttp;
  private readonly keys: KeySource;
  private readonly scoped: ScopedKeyCache | null;

  constructor(options: SupermemoryOptions) {
    this.http = new SupermemoryHttp(options);
    this.admin = new SupermemoryAdmin(this.http, options.apiKey);
    this.scoped =
      options.scopedKeys === false
        ? null
        : new ScopedKeyCache(this.admin, options.clock ?? { now: () => new Date() });
    this.keys = this.scoped ?? new OrgKeySource(options.apiKey);
  }

  forNamespace(namespace: Namespace): NamespaceClient {
    return new NamespaceClient(namespace, this.http, this.keys);
  }

  async deleteNamespace(namespace: Namespace): Promise<{ existed: boolean }> {
    await this.scoped?.drop(namespace);
    return this.admin.deleteNamespace(namespace);
  }

  dispose(): Promise<void> {
    return this.scoped?.dispose() ?? Promise.resolve();
  }
}
