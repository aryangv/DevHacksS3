import { createMemoryLogger } from "@campus/contracts";
import { describe, expect, it } from "vitest";
import { MaintenanceScheduler } from "../src/maintenance";

describe("MaintenanceScheduler", () => {
  it("runs memory jobs on their intervals and stops cleanly", async () => {
    const calls: string[] = [];
    const { logger } = createMemoryLogger("debug");
    const s = MaintenanceScheduler.forMemory(
      {
        processPendingCleanup: async () => (calls.push("cleanup"), { removed: 0, stillPending: 0 }),
        purgeExpired: async () => (calls.push("purge"), { removed: 0, pending: 0 }),
      },
      { cleanupEveryMs: 10, purgeEveryMs: 25, logger },
    );
    s.start();
    await new Promise((r) => setTimeout(r, 80));
    await s.stop();
    const after = calls.length;
    expect(calls.filter((c) => c === "cleanup").length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("purge");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(after); // nothing runs after stop()
  });

  it("never overlaps a job with itself, and a failing job is logged, not thrown", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { logger, lines } = createMemoryLogger("debug");
    const job = {
      name: "slow",
      everyMs: 1000,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        throw new Error("boom");
      },
    };
    const s = new MaintenanceScheduler([job], logger);
    await Promise.all([s.tick(job), s.tick(job), s.tick(job)]);
    expect(maxConcurrent).toBe(1);
    expect(lines.join("\n")).toContain("maintenance job failed");
  });
});
