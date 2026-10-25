// Worker process: claims inbound events and runs the turn pipeline (spec 10: apps/worker).
import { buildContainer } from "./container";

const c = await buildContainer();
if (c.config.RUNTIME_STORE === "memory") {
  c.logger.warn(
    "RUNTIME_STORE=memory: this worker only sees events enqueued in this process. Use RUNTIME_STORE=postgres for a separate worker, or RUN_WORKER_IN_PROCESS=true in the API.",
  );
}
c.worker.start();
c.logger.info("worker started", { concurrency: c.config.WORKER_CONCURRENCY });

const shutdown = async (signal: string) => {
  c.logger.info("worker stopping", { signal });
  await c.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
