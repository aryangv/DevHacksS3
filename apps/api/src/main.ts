// API process: webhooks, OAuth callbacks, approvals, trace API.
import { buildContainer } from "@campus/worker";
import { buildServer } from "./server";

const c = await buildContainer();
const app = await buildServer(c);

// With the in-memory queue the worker must live in this process; with Postgres it can run separately.
if (c.config.RUN_WORKER_IN_PROCESS || c.config.RUNTIME_STORE === "memory") {
  c.worker.start();
  c.logger.info("worker running in-process");
}

await app.listen({ port: c.config.API_PORT, host: "0.0.0.0" });
c.logger.info("api listening", { port: c.config.API_PORT });

const shutdown = async () => {
  await app.close();
  await c.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
