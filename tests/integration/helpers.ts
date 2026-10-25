import type { Logger, ModelClient } from "@campus/contracts";
import { demoGroupProviderId, demoUsers } from "@campus/contracts/fixtures";
import { Simulator } from "@campus/worker";

export const TEST_ENV = { LOG_LEVEL: "error", APP_ORIGIN: "https://app.test", NODE_ENV: "test" };

export const [AVERY, BLAKE, CASEY, DEVON] = demoUsers as [
  (typeof demoUsers)[0],
  (typeof demoUsers)[0],
  (typeof demoUsers)[0],
  (typeof demoUsers)[0],
];
export const GROUP = demoGroupProviderId;
export const ALL_MEMBERS = demoUsers.map((u) => u.externalId);

export async function makeSim(
  opts: { model?: ModelClient; env?: Record<string, string>; logger?: Logger } = {},
): Promise<Simulator> {
  return Simulator.create({
    env: { ...TEST_ENV, ...opts.env },
    ...(opts.model ? { overrides: { model: opts.model } } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

export const actions = (trace: Array<{ action: string }>) => trace.map((e) => e.action);
