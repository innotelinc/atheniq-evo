/**
 * Boot the institution service.
 *
 * It refuses to start on a weak production session key, a missing registrar
 * credential, or a Stalwart mailbox that cannot be reached and used, for the
 * same reason the bridge refuses a weak signing key: a service that starts
 * misconfigured is worse than one that explains why it will not start.
 */

import {
  loadConfigWithSetup,
  missingBootstrapValues,
  readSetupRecord,
  SetupError,
  setupPath,
  startSetupServer,
  type SetupRecord,
} from "./bootstrap.ts";
import { ConfigError, describeConfig, institutionDataDir, type InstitutionConfig } from "./config.ts";
import { Catalog, CatalogError } from "./catalog.ts";
import { Store, StoreError } from "./store.ts";
import { Registry } from "./registry.ts";
import { createMailer } from "./mail.ts";
import { createInstitutionServer } from "./server.ts";

function fail(message: string): never {
  console.error(`atheniq-institution: ${message}`);
  process.exit(78);
}

async function main(): Promise<void> {
  const dataDir = institutionDataDir(process.env);
  let record: SetupRecord | null;
  try {
    record = readSetupRecord(dataDir);
  } catch (error) {
    fail(error instanceof SetupError ? error.message : String(error));
  }

  // Nothing has configured the institution yet: serve only the setup wizard.
  // A partially configured environment is not this case; it is a mistake, and
  // the normal validator below names the setting to fix.
  if (!record && missingBootstrapValues(process.env)) {
    const parsedPort = Number.parseInt(process.env.PORT ?? "8080", 10);
    const port = Number.isFinite(parsedPort) ? parsedPort : 8080;
    const publicOrigin = (process.env.INSTITUTION_ORIGIN?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
    const host = process.env.HOST ?? "0.0.0.0";
    const setup = startSetupServer({ dataDir, publicOrigin });
    setup.server.on("error", (error) => fail(`could not listen: ${error.message}`));
    setup.server.listen(port, host, () => {
      console.log("atheniq-institution: setup required — no configuration found");
      console.log(`  open       ${publicOrigin}/setup?token=${setup.token}`);
      console.log("  token      printed once per start; restarting the service rotates it");
      console.log(`  writes     ${setupPath(dataDir)} (0600)`);
    });
    return;
  }

  let config: InstitutionConfig;
  try {
    config = loadConfigWithSetup(process.env);
  } catch (error) {
    fail(error instanceof ConfigError || error instanceof SetupError ? error.message : String(error));
  }

  for (const warning of config.warnings) console.warn(`atheniq-institution: warning: ${warning}`);

  let store: Store;
  try {
    store = Store.open(config.dataDir, { seedDemo: config.seedDemo });
  } catch (error) {
    fail(error instanceof StoreError ? error.message : String(error));
  }

  let catalog: Catalog;
  try {
    catalog = Catalog.open(config.dataDir);
  } catch (error) {
    fail(error instanceof CatalogError ? error.message : String(error));
  }

  const registry = new Registry(store, config, catalog);
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
    const counts = catalog.summary();
    console.log(`  catalog    ${counts.courses} courses (${counts.published} published, ${counts.draft} draft)`);
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
