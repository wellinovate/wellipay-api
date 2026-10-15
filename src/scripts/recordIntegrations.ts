// Registers the partner systems patients can connect (WelliRecord and other
// health-record systems). Only Wellinovate runs this, from the Render shell.
//
//   npm run integration:list
//   KEY=wellirecord NAME='WelliRecord' KIND=WELLIRECORD BASE_URL=https://api.wellirecord.example npm run integration:register
//   KEY=acme-labs NAME='Acme Labs' KIND=EXTERNAL_SYSTEM BASE_URL=https://records.acme.example npm run integration:register
//   KEY=acme-labs npm run integration:disable
//
// The partner's API key is not stored in the database. Set it in Render as
// RECORD_INTEGRATION_<KEY>_API_KEY (for example RECORD_INTEGRATION_WELLIRECORD_API_KEY).
// A partner without that variable does not appear to patients.
import { prisma } from "../lib/prisma.js";
import { integrationEnvName, integrationKeyProblem } from "../lib/recordConnections.js";

async function list() {
  const rows = await prisma.recordIntegration.findMany({ orderBy: { key: "asc" } });
  if (!rows.length) return console.log("No integrations registered.");
  for (const r of rows) {
    const env = integrationEnvName(r.key);
    console.log(`${r.key}\t${r.kind}\t${r.status}\t${r.baseUrl}\t${process.env[env] ? "key set" : `${env} NOT set`}`);
  }
}

async function register() {
  const key = process.env.KEY ?? "";
  const name = process.env.NAME?.trim() ?? "";
  const kind = process.env.KIND ?? "";
  const baseUrl = process.env.BASE_URL?.trim() ?? "";
  const problem = integrationKeyProblem(key);
  if (problem) throw new Error(problem);
  if (!name) throw new Error("NAME is required.");
  if (kind !== "WELLIRECORD" && kind !== "EXTERNAL_SYSTEM") throw new Error("KIND must be WELLIRECORD or EXTERNAL_SYSTEM.");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("BASE_URL must be a full URL.");
  }
  if (url.protocol !== "https:") throw new Error("BASE_URL must use https.");
  await prisma.recordIntegration.upsert({
    where: { key },
    create: { key, name, kind, baseUrl: url.origin + url.pathname.replace(/\/+$/, "") },
    update: { name, kind, baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), status: "ACTIVE" },
  });
  console.log(`Registered ${key}. Set ${integrationEnvName(key)} in Render, then redeploy. Patients see it once the variable is set.`);
}

async function disable() {
  const key = process.env.KEY ?? "";
  const res = await prisma.recordIntegration.updateMany({ where: { key }, data: { status: "DISABLED" } });
  console.log(res.count ? `Disabled ${key}. Existing links stay; no new ones can start.` : `No integration with key ${key}.`);
}

const commands: Record<string, () => Promise<void>> = { list, register, disable };

async function main() {
  const run = commands[process.argv[2] ?? ""];
  if (!run) throw new Error("Use list, register or disable.");
  await run();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
