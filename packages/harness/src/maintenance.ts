import type { Logger, MemoryMaintenance } from "@campus/contracts";

// Periodic background jobs owned by other packages but scheduled by the worker process.
// Memory (P3): retry deletions Supermemory refused while documents were processing (spec 5.8),
// enforce memory_settings.retention_days (spec 5.4), and batch group chat into group memory (~60 s). A job never overlaps with itself and
// a failure is logged, never thrown into the worker.

type Job = { name: string; everyMs: number; run: () => Promise<unknown> };
export type MaintenanceJob = Job;

export class MaintenanceScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly jobs: Job[],
    private readonly logger: Logger,
  ) {}

  static forMemory(
    maintenance: MemoryMaintenance,
    opts: {
      cleanupEveryMs: number;
      purgeEveryMs: number;
      groupIngestEveryMs?: number;
      /** Other periodic jobs to run on the same scheduler (e.g. order tracking). */
      extraJobs?: Job[];
      logger: Logger;
    },
  ): MaintenanceScheduler {
    const ingest = maintenance.ingestGroupChat?.bind(maintenance);
    return new MaintenanceScheduler(
      [
        {
          name: "memory.cleanup",
          everyMs: opts.cleanupEveryMs,
          run: () => maintenance.processPendingCleanup(),
        },
        { name: "memory.purge_expired", everyMs: opts.purgeEveryMs, run: () => maintenance.purgeExpired() },
        ...(ingest
          ? [{ name: "memory.group_chat_ingest", everyMs: opts.groupIngestEveryMs ?? 60_000, run: ingest }]
          : []),
        ...(opts.extraJobs ?? []),
      ],
      opts.logger,
    );
  }

  start(): void {
    if (this.timers.length) return;
    for (const job of this.jobs) {
      if (job.everyMs <= 0) continue;
      const t = setInterval(() => void this.tick(job), job.everyMs);
      t.unref(); // never keeps the process alive on its own
      this.timers.push(t);
    }
  }

  /** Run one job now (also used by tests). Skips if that job is already running. */
  async tick(job: Job): Promise<void> {
    if (this.running.has(job.name)) return;
    this.running.add(job.name);
    const p = (async () => {
      try {
        const result = await job.run();
        this.logger.debug("maintenance job done", { job: job.name, result });
      } catch (err) {
        this.logger.warn("maintenance job failed", { job: job.name, err });
      } finally {
        this.running.delete(job.name);
      }
    })();
    this.inFlight.add(p);
    await p;
    this.inFlight.delete(p);
  }

  runAll(): Promise<void> {
    return Promise.all(this.jobs.map((j) => this.tick(j))).then(() => undefined);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.splice(0)) clearInterval(t);
    await Promise.all([...this.inFlight]);
  }
}
