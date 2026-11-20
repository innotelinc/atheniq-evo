/**
 * The institution service's configuration, in one place.
 *
 * The public site and the registrar are one process on two hostnames. Which
 * surface a request sees is decided by `Host` (or by an explicitly trusted
 * `X-Forwarded-Host`), never by a path a visitor can type — so a student link
 * can never render a registrar page by accident.
 */

export class ConfigError extends Error {}

export interface InstitutionConfig {
  port: number;
  /** Where the public site answers. */
  publicOrigin: string;
  /** Where the registrar answers. */
  registrarOrigin: string;
  dataDir: string;
  sessionSecret: string;
  registrarEmail: string;
  /** A scrypt hash (`scrypt$…`) or, for development only, a plain password. */
  registrarPassword: string;
  mailDomain: string;
  mailProvider: "local" | "stalwart";
  stalwartUrl: string;
  stalwartToken: string;
  stalwartQuotaBytes: number;
  bridgeUrl: string;
  bridgeToken: string;
  consoleUrl: string;
  credentialVerifyUrl: string;
  seedDemo: boolean;
  cookieSecure: boolean;
  trustProxy: boolean;
  nodeEnv: string;
  warnings: string[];
}

function read(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  return (env[name] ?? fallback).trim();
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = read(env, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new ConfigError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return parsed;
}

function origin(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = read(env, name, fallback);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  return parsed.origin;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = read(env, name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

/** A development-only key. Never accepted when NODE_ENV=production. */
const DEV_SESSION_SECRET = "atheniq-institution-dev-session-secret-not-for-production";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InstitutionConfig {
  const nodeEnv = read(env, "NODE_ENV", "development");
  const production = nodeEnv === "production";
  const warnings: string[] = [];

  const publicOrigin = origin(env, "INSTITUTION_ORIGIN", "http://localhost:8080");
  const registrarOrigin = origin(env, "REGISTRAR_ORIGIN", "http://registrar.localhost:8080");

  if (new URL(publicOrigin).hostname === new URL(registrarOrigin).hostname) {
    throw new ConfigError("INSTITUTION_ORIGIN and REGISTRAR_ORIGIN must be different hostnames");
  }

  let sessionSecret = read(env, "SESSION_SECRET");
  if (!sessionSecret) {
    if (production) throw new ConfigError("SESSION_SECRET is required in production (32+ characters)");
    sessionSecret = DEV_SESSION_SECRET;
    warnings.push("SESSION_SECRET is unset; using the development key. Set it before exposing this host.");
  } else if (sessionSecret.length < 32) {
    throw new ConfigError("SESSION_SECRET must be at least 32 characters");
  }

  const registrarEmail = read(env, "REGISTRAR_EMAIL", production ? "" : "registrar@atheniq.institute").toLowerCase();
  const registrarPassword = read(env, "REGISTRAR_PASSWORD_HASH") || read(env, "REGISTRAR_PASSWORD");
  if (!registrarEmail) throw new ConfigError("REGISTRAR_EMAIL is required");
  if (!registrarPassword) {
    if (production) throw new ConfigError("REGISTRAR_PASSWORD_HASH (preferred) or REGISTRAR_PASSWORD is required");
    throw new ConfigError("REGISTRAR_PASSWORD is required for development sign-in");
  }
  if (!registrarPassword.startsWith("scrypt$") && registrarPassword.length < 12) {
    throw new ConfigError("REGISTRAR_PASSWORD must be at least 12 characters (or supply REGISTRAR_PASSWORD_HASH)");
  }
  if (!registrarPassword.startsWith("scrypt$") && production) {
    warnings.push("REGISTRAR_PASSWORD is plaintext in the environment; prefer REGISTRAR_PASSWORD_HASH.");
  }

  const mailDomain = read(env, "MAIL_DOMAIN", "atheniq.institute").toLowerCase();
  const provider = read(env, "MAIL_PROVIDER", "local").toLowerCase();
  if (provider !== "local" && provider !== "stalwart") {
    throw new ConfigError("MAIL_PROVIDER must be local or stalwart");
  }
  const mailProvider = provider;
  let stalwartUrl = "";
  let stalwartToken = "";
  let stalwartQuotaBytes = 0;
  if (mailProvider === "stalwart") {
    if (!read(env, "STALWART_URL")) {
      throw new ConfigError("STALWART_URL is required when MAIL_PROVIDER=stalwart");
    }
    stalwartUrl = origin(env, "STALWART_URL", "https://mail.innotel.us");
    if (production && !stalwartUrl.startsWith("https://")) {
      throw new ConfigError("STALWART_URL must use https in production");
    }
    stalwartToken = read(env, "STALWART_TOKEN");
    if (stalwartToken.length < 16) {
      throw new ConfigError("STALWART_TOKEN must be a Stalwart API key (16+ characters)");
    }
    stalwartQuotaBytes = integer(env, "STALWART_QUOTA_BYTES", 0, true);
  }

  const cookieSecure = bool(env, "COOKIE_SECURE", publicOrigin.startsWith("https://"));
  if (production && !cookieSecure) {
    throw new ConfigError("COOKIE_SECURE cannot be false in production: session cookies must be Secure");
  }

  const seedDemo = bool(env, "INSTITUTION_SEED_DEMO", !production);
  if (production && seedDemo) {
    warnings.push("INSTITUTION_SEED_DEMO is on in production; demonstration records will be written.");
  }

  return {
    port: integer(env, "PORT", 8080, true),
    publicOrigin,
    registrarOrigin,
    dataDir: read(env, "INSTITUTION_DATA_DIR", "data/institution"),
    sessionSecret,
    registrarEmail,
    registrarPassword,
    mailDomain,
    mailProvider,
    stalwartUrl,
    stalwartToken,
    stalwartQuotaBytes,
    bridgeUrl: read(env, "ATHENIQ_BRIDGE_URL").replace(/\/+$/, ""),
    bridgeToken: read(env, "ATHENIQ_BRIDGE_SERVICE_TOKEN"),
    consoleUrl: read(env, "CONSOLE_BASE_URL").replace(/\/+$/, ""),
    credentialVerifyUrl: read(env, "CREDENTIAL_VERIFY_URL"),
    seedDemo,
    cookieSecure,
    trustProxy: bool(env, "TRUST_PROXY", false),
    nodeEnv,
    warnings,
  };
}

/** Safe to log: hosts and booleans, never a secret. */
export function describeConfig(config: InstitutionConfig): Record<string, string | number | boolean> {
  return {
    port: config.port,
    publicOrigin: config.publicOrigin,
    registrarOrigin: config.registrarOrigin,
    dataDir: config.dataDir,
    mailDomain: config.mailDomain,
    mailProvider: config.mailProvider,
    stalwart: Boolean(config.stalwartUrl),
    bridge: config.bridgeUrl || "not configured",
    bridgeToken: Boolean(config.bridgeToken),
    console: config.consoleUrl || "not configured",
    seedDemo: config.seedDemo,
    cookieSecure: config.cookieSecure,
  };
}
