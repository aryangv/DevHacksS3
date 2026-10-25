/**
 * Supermemory v5 namespaces (harness-spec §5.1/§5.2): `user_{uuid}`, `group_{uuid}`, `task_{uuid}`.
 * Internal stable UUIDs only — never display names or phone numbers.
 *
 * v5 accepts `^[a-zA-Z0-9_:-]{1,100}$` (verified against the API, 2026-10-24); a
 * lowercase UUID can't contain `_`, so one principal can never spell another's
 * namespace. The brand means only this module can produce one: the engine will not
 * accept an arbitrary string (e.g. something the model wrote).
 */
export type Namespace = string & { readonly __brand: "SupermemoryNamespace" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function build(prefix: "user" | "group" | "task", id: string): Namespace {
  if (!UUID.test(id)) throw new Error(`invalid ${prefix} id for namespace`);
  return `${prefix}_${id}` as Namespace;
}

export const namespaces = {
  user: (userId: string) => build("user", userId),
  group: (groupId: string) => build("group", groupId),
  task: (taskId: string) => build("task", taskId),
};

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
