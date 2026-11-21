/**
 * Mailbox provisioning through Stalwart's JMAP management API.
 *
 * The registry reserves an address on admission. When Stalwart is configured,
 * this module turns that reservation into a real account whose password is the
 * student's temporary password, and keeps the password in step when the student
 * changes it or the registrar resets access.
 *
 * Stalwart object lists are encoded as JSON objects, not arrays. See
 * https://stalw.art/docs/auth/accounts/manage and /docs/ref/object/domain.
 */

import type { InstitutionConfig } from "./config.ts";

export interface Mailer {
  /** "stalwart" — used in notices and the mailbox record. */
  readonly provider: string;
  /**
   * False when the provider keeps passwords in an external directory (OIDC or
   * LDAP), where a mailbox is created but its password is not Stalwart's to set.
   */
  readonly passwordManaged: boolean;
  /** Prove the provider is reachable and configured before the service listens. */
  preflight(): Promise<void>;
  /** Create the account, or update its password if it already exists. */
  ensureAccount(address: string, password: string, displayName: string): Promise<void>;
}

export class MailError extends Error {}

interface StalwartOptions {
  baseUrl: string;
  token: string;
  domain: string;
  quotaBytes?: number;
  fetcher?: typeof fetch;
}

type JmapMethodResponse = [string, Record<string, unknown>, string];

export class StalwartMailer implements Mailer {
  readonly provider = "stalwart";
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly domain: string;
  private readonly quotaBytes: number;
  private readonly fetcher: typeof fetch;
  private domainId: string | null = null;
  /** Set once Stalwart says the account's credentials live elsewhere. */
  private externalDirectory = false;

  constructor(options: StalwartOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.domain = options.domain.toLowerCase();
    this.quotaBytes = options.quotaBytes ?? 0;
    this.fetcher = options.fetcher ?? fetch;
  }

  /**
   * One domain query proves all three settings this module depends on: the URL
   * answers, the key is accepted, and `MAIL_DOMAIN` exists. Startup runs it so a
   * typo is reported once, at boot, rather than on the first admission.
   */
  async preflight(): Promise<void> {
    await this.stalwartDomainId();
  }

  get passwordManaged(): boolean {
    return !this.externalDirectory;
  }

  async ensureAccount(address: string, password: string, displayName: string): Promise<void> {
    const { local, domain } = this.split(address);
    const domainId = await this.stalwartDomainId();

    // At most two attempts: the first may learn that the directory owns
    // passwords, so the second creates the mailbox without one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const withPassword = !this.externalDirectory;
      const result = await this.createAccount(local, domainId, displayName, withPassword ? password : null);

      const created = result.created as Record<string, { id?: string }> | undefined;
      if (created?.new1?.id) return;

      const failure = (result.notCreated as Record<string, { type?: string; existingId?: string; description?: string }> | undefined)?.new1;
      if (failure?.existingId) {
        await this.setPassword(failure.existingId, password);
        return;
      }

      // A concurrent or earlier attempt created the same address. Stalwart
      // reports that as primaryKeyViolation (older builds: alreadyExists) and
      // does not always return the id, so look the account up by address.
      if (/primaryKeyViolation|alreadyExists/i.test(String(failure?.type ?? ""))) {
        const existing = await this.accountIdFor(local, address);
        if (existing) {
          await this.setPassword(existing, password);
          return;
        }
      }

      // A server whose directory is OIDC or LDAP refuses passwords: the mailbox
      // is still ours to create, but the student signs in to mail through that
      // directory instead.
      if (withPassword && /external directory/i.test(String(failure?.description ?? ""))) {
        this.externalDirectory = true;
        continue;
      }

      const reason = failure?.description ?? failure?.type ?? "unknown error";
      throw new MailError(`Stalwart could not create ${local}@${domain}: ${reason}`);
    }
    throw new MailError(`Stalwart could not create ${local}@${domain}: account already exists`);
  }

  /** The account id for an address, used when a duplicate create gives none. */
  private async accountIdFor(local: string, address: string): Promise<string | null> {
    const result = await this.jmap("x:Account/query", { filter: { name: local } });
    const ids = Array.isArray(result.ids) ? result.ids.map(String) : [];
    if (ids.length === 0) return null;
    const got = await this.jmap("x:Account/get", { ids });
    const list = Array.isArray(got.list) ? (got.list as Array<{ id?: string; emailAddress?: string }>) : [];
    const match = list.find((account) => (account.emailAddress ?? "").toLowerCase() === address.toLowerCase());
    return match?.id ?? ids[0] ?? null;
  }

  private createAccount(
    local: string,
    domainId: string,
    displayName: string,
    password: string | null,
  ): Promise<Record<string, unknown>> {
    return this.jmap("x:Account/set", {
      create: {
        new1: {
          "@type": "User",
          name: local,
          domainId,
          description: displayName.slice(0, 200),
          ...(password ? { credentials: { "0": { "@type": "Password", secret: password } } } : {}),
          aliases: {},
          memberGroupIds: {},
          roles: { "@type": "User" },
          permissions: { "@type": "Inherit" },
          quotas: this.quotaBytes > 0 ? { maxDiskQuota: this.quotaBytes } : {},
          encryptionAtRest: { "@type": "Disabled" },
        },
      },
    });
  }

  private split(address: string): { local: string; domain: string } {
    const at = address.lastIndexOf("@");
    const local = at > 0 ? address.slice(0, at) : "";
    const domain = at > 0 ? address.slice(at + 1).toLowerCase() : "";
    if (!local || domain !== this.domain) {
      throw new MailError(`Refusing to provision ${address}: STALWART uses ${this.domain}`);
    }
    return { local, domain };
  }

  private async stalwartDomainId(): Promise<string> {
    if (this.domainId) return this.domainId;
    const result = await this.jmap("x:Domain/query", { filter: { name: this.domain } });
    const ids = Array.isArray(result.ids) ? result.ids : [];
    if (ids.length === 0) {
      throw new MailError(
        `Stalwart has no domain ${this.domain}. Check MAIL_DOMAIN, or add the domain under Management → Domains.`,
      );
    }
    this.domainId = String(ids[0]);
    return this.domainId;
  }

  private async setPassword(accountId: string, password: string): Promise<void> {
    if (this.externalDirectory) return;
    const result = await this.jmap("x:Account/set", {
      update: { [accountId]: { "credentials/0/secret": password } },
    });
    const notUpdated = result.notUpdated as Record<string, { description?: string }> | undefined;
    const failure = notUpdated?.[accountId];
    if (!failure) return;
    // The directory owns the password; the mailbox itself is unaffected.
    if (/external directory/i.test(String(failure.description ?? ""))) {
      this.externalDirectory = true;
      return;
    }
    throw new MailError(`Stalwart could not set the mailbox password: ${failure.description ?? "unknown error"}`);
  }

  private async jmap(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/jmap/`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
          methodCalls: [[method, args, "0"]],
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new MailError(
        `Stalwart is unreachable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new MailError(
          `Stalwart refused the API key (${response.status}). Check STALWART_TOKEN and its permissions.`,
        );
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new MailError(`Stalwart answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    let payload: { methodResponses?: JmapMethodResponse[] };
    try {
      payload = (await response.json()) as { methodResponses?: JmapMethodResponse[] };
    } catch {
      throw new MailError("Stalwart returned a response that is not JSON");
    }
    const entry = payload.methodResponses?.[0];
    if (!entry) throw new MailError(`Stalwart returned no response for ${method}`);
    const [name, result] = entry;
    if (name === "error") {
      const description = typeof result.description === "string" ? result.description : String(result.type ?? "error");
      throw new MailError(`Stalwart rejected ${method}: ${description}`);
    }
    return result;
  }
}

/** Null means "reserve the address in the registry only". */
export function createMailer(config: InstitutionConfig): Mailer | null {
  if (config.mailProvider === "local") return null;
  return new StalwartMailer({
    baseUrl: config.stalwartUrl,
    token: config.stalwartToken,
    domain: config.mailDomain,
    quotaBytes: config.stalwartQuotaBytes,
  });
}
