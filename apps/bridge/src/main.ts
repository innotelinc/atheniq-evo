/**
 * Process entry point.
 *
 * Boot order matters: configuration is validated (a weak signing key stops the
 * process), the ledger is loaded and parsed (a corrupt ledger stops the process
 * rather than silently starting empty and re-awarding everything), and only
 * then does the port open.
 */

import { readFile } from "node:fs/promises";
import { ConfigError, describeConfig, loadConfig, type Config } from "./config.ts";
import { LedgerStore } from "./ledger.ts";
import { createBridgeServer } from "./app.ts";

async function readUserMap(path: string | undefined): Promise<Record<string, number>> {
  if (!path) return {};
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("must be a JSON object of id → numeric LMS user id");
    }
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
}

async function start(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[bridge] configuration: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const ledger = new LedgerStore(`${config.dataDir}/atheniq-ledger.json`);
  await ledger.load();

  const [lmsUserMap, lmsUsernameMap] = await Promise.all([
    readUserMap(process.env.LMS_USER_MAP_PATH),
    readUserMap(process.env.LMS_USERNAME_MAP_PATH),
  ]);

  const server = createBridgeServer({
    config,
    ledger,
    lmsUserMap,
    lmsUsernameMap,
    startedAt: new Date(),
    log: (line) => console.log(`[bridge] ${line}`),
  });

  server.listen(config.port, () => {
    const snapshot = ledger.snapshot();
    console.log(`[bridge] listening on :${config.port}`, JSON.stringify(describeConfig(config)));
    console.log(
      `[bridge] ledger ${ledger.path}: ${snapshot.classrooms.length} classrooms, ${snapshot.completions.length} completions, ${snapshot.credentials.length} credentials`,
    );
  });

  const stop = (signal: string) => {
    console.log(`[bridge] ${signal} — closing`);
    server.close(() => process.exit(0));
    // A hung upstream must not hold the process open forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

await start();
