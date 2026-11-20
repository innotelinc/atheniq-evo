/**
 * Boot the institution service.
 *
 * It refuses to start on a weak production session key, a missing registrar
 * credential, or a Stalwart mailbox that cannot be reached and used, for the
 * same reason the bridge refuses a weak signing key: a service that starts
 * misconfigured is worse than one that explains why it will not start.
 */

import { ConfigError, describeConfig, loadConfig, type InstitutionConfig } from "./config.ts";
import { Store, StoreError } from "./store.ts";
import { Registry } from "./registry.ts";
import { createMailer } from "./mail.ts";
import { createInstitutionServer } from "./server.ts";

function fail(message: string): never {
  console.error(`atheniq-institution: ${message}`);
  process.exit(78);
}

async function main(): Promise<void> {
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
  const mailer = createMailer(config);
  if (mailer) {
    try {
      await mailer.preflight();
    } catch (error) {
      fail(`mail preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`atheniq-institution: mail preflight ok (${config.mailDomain} at ${config.stalwartUrl})`);
  }

  const server = createInstitutionServer({ config, registry, mailer });
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

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
