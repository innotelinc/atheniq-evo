/**
 * Boot the institution service.
 *
 * It refuses to start on a weak production session key or a missing registrar
 * credential, for the same reason the bridge refuses a weak signing key: a
 * service that starts insecurely is worse than one that explains why it will
 * not start.
 */

import { ConfigError, describeConfig, loadConfig, type InstitutionConfig } from "./config.ts";
import { Store, StoreError } from "./store.ts";
import { Registry } from "./registry.ts";
import { createInstitutionServer } from "./server.ts";

function fail(message: string): never {
  console.error(`atheniq-institution: ${message}`);
  process.exit(78);
}

function main(): void {
  let config: InstitutionConfig;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : String(error));
  }

  for (const warning of config.warnings) console.warn(`atheniq-institution: warning: ${warning}`);

  let store: Store;
  try {
    store = Store.open(config.dataDir, { seedDemo: config.seedDemo });
  } catch (error) {
    fail(error instanceof StoreError ? error.message : String(error));
  }

  const registry = new Registry(store, config);
  const server = createInstitutionServer({ config, registry });
  const host = process.env.HOST ?? "0.0.0.0";

  server.listen(config.port, host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log(`atheniq-institution: listening on ${host}:${port}`);
    console.log(`  public     ${config.publicOrigin}`);
    console.log(`  registrar  ${config.registrarOrigin}`);
    console.log(`  config     ${JSON.stringify(describeConfig(config))}`);
    if (config.seedDemo) console.log("  data       demonstration records seeded (INSTITUTION_SEED_DEMO)");
  });

  server.on("error", (error) => fail(`could not listen: ${error.message}`));

  const shutdown = (signal: string): void => {
    console.log(`atheniq-institution: ${signal} — closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
