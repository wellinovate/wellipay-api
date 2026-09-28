import { buildApp } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { startWebhookWorker } from "./worker.js";

async function main() {
  const app = buildApp();

  const stopWorker = startWebhookWorker(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    stopWorker();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
