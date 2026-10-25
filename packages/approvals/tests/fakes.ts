import type { Approval, ApprovalStore } from '../src/ports.ts';
export class MemoryApprovalStore implements ApprovalStore {
  rows = new Map<string, Approval>();
  private locks = new Map<string, Promise<unknown>>();
  async insert(a: Approval): Promise<void> {
    this.rows.set(a.id, structuredClone(a));
  }
  async mutate<T>(id: string, fn: (a: Approval | null) => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const a = structuredClone(this.rows.get(id) ?? null);
        const result = await fn(a);
        if (a) this.rows.set(id, a);
        return result;
      });
    this.locks.set(id, next);
    return next;
  }
  async list(userId: string): Promise<Approval[]> {
    return structuredClone([...this.rows.values()].filter((a) => a.userId === userId));
  }
}
