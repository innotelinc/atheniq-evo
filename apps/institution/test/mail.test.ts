/**
 * The Stalwart calls, without a Stalwart server: a fake fetch records the JMAP
 * method calls and returns the shapes the documentation specifies.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MailError, StalwartMailer } from "../src/mail.ts";

type Call = { method: string; args: Record<string, unknown>; using: string[] };

function reply(method: string, result: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ methodResponses: [[method, result, "0"]] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fake(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      using: string[];
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const call = { method: body.methodCalls[0]![0], args: body.methodCalls[0]![1], using: body.using };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetcher };
}

function mailer(fetcher: typeof fetch) {
  return new StalwartMailer({
    baseUrl: "https://mail.innotel.us/",
    token: "API_test_token_value",
    domain: "atheniq.institute",
    quotaBytes: 1_073_741_824,
    fetcher,
  });
}

test("creates a Stalwart account with the temporary password", async () => {
  const { calls, fetcher } = fake((call) => {
    if (call.method === "x:Domain/query") return reply(call.method, { ids: ["domain-1"] });
    return reply(call.method, { created: { new1: { id: "account-1" } } });
  });

  await mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "temp-pass", "Ada Lovelace");

  assert.equal(calls.length, 2);
  const [domain, set] = calls;
  assert.ok(domain && set);
  assert.deepEqual(domain.args, { filter: { name: "atheniq.institute" } });
  assert.deepEqual(domain.using, ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]);

  const create = set.args.create as Record<string, Record<string, unknown>>;
  const newAccount = create.new1;
  assert.ok(newAccount);
  assert.equal(newAccount["@type"], "User");
  assert.equal(newAccount.name, "ada.lovelace");
  assert.equal(newAccount.domainId, "domain-1");
  assert.deepEqual(newAccount.credentials, { "0": { "@type": "Password", secret: "temp-pass" } });
  assert.deepEqual(newAccount.roles, { "@type": "User" });
  assert.deepEqual(newAccount.quotas, { maxDiskQuota: 1_073_741_824 });
});

test("updates the password when the account already exists", async () => {
  const { calls, fetcher } = fake((call) => {
    if (call.method === "x:Domain/query") return reply(call.method, { ids: ["domain-1"] });
    if ("create" in call.args) {
      return reply(call.method, {
        notCreated: { new1: { type: "alreadyExists", existingId: "account-1" } },
      });
    }
    return reply(call.method, { notUpdated: {} });
  });

  await mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "new-pass", "Ada Lovelace");

  assert.equal(calls.length, 3);
  const set = calls[2];
  assert.ok(set);
  assert.deepEqual(set.args, { update: { "account-1": { "credentials/0/secret": "new-pass" } } });
});

test("refuses an address outside the configured domain without a request", async () => {
  const { calls, fetcher } = fake((call) => reply(call.method, { ids: [] }));
  await assert.rejects(
    mailer(fetcher).ensureAccount("ada@innotel.us", "temp-pass", "Ada"),
    (error: unknown) => error instanceof MailError && /STALWART uses atheniq\.institute/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("explains a missing Stalwart domain", async () => {
  const { fetcher } = fake((call) => reply(call.method, { ids: [] }));
  await assert.rejects(
    mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "temp-pass", "Ada"),
    (error: unknown) => error instanceof MailError && /no domain atheniq\.institute/.test(error.message),
  );
});

test("names a rejected API key without leaking it", async () => {
  const fetcher = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(
    mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "temp-pass", "Ada"),
    (error: unknown) =>
      error instanceof MailError &&
      /refused the API key \(401\)/.test(error.message) &&
      !error.message.includes("API_test_token_value"),
  );
});

test("creates a passwordless mailbox when the directory owns passwords", async () => {
  const { calls, fetcher } = fake((call) => {
    if (call.method === "x:Domain/query") return reply(call.method, { ids: ["domain-1"] });
    const create = call.args.create as Record<string, Record<string, unknown>> | undefined;
    if (create?.new1?.credentials) {
      return reply(call.method, {
        notCreated: {
          new1: { type: "forbidden", description: "Cannot set credentials for accounts in an external directory." },
        },
      });
    }
    return reply(call.method, { created: { new1: { id: "account-2" } } });
  });

  const stalwart = mailer(fetcher);
  assert.equal(stalwart.passwordManaged, true);

  await stalwart.ensureAccount("ada.lovelace@atheniq.institute", "temp-pass", "Ada Lovelace");

  assert.equal(calls.length, 3);
  assert.equal(stalwart.passwordManaged, false);
  const retry = calls[2]?.args.create as Record<string, Record<string, unknown>>;
  assert.equal(retry.new1?.name, "ada.lovelace");
  assert.equal(retry.new1?.credentials, undefined, "the retry must not send a password");
});

test("stops trying to set a password once the directory owns it", async () => {
  const { calls, fetcher } = fake((call) => {
    if (call.method === "x:Domain/query") return reply(call.method, { ids: ["domain-1"] });
    if ("create" in call.args) {
      return reply(call.method, { notCreated: { new1: { type: "alreadyExists", existingId: "account-1" } } });
    }
    return reply(call.method, {
      notUpdated: { "account-1": { type: "forbidden", description: "Cannot set credentials for accounts in an external directory." } },
    });
  });

  const stalwart = mailer(fetcher);
  await stalwart.ensureAccount("ada.lovelace@atheniq.institute", "new-pass", "Ada Lovelace");
  assert.equal(stalwart.passwordManaged, false);

  const before = calls.length;
  await stalwart.ensureAccount("ada.lovelace@atheniq.institute", "another-pass", "Ada Lovelace");
  assert.equal(calls.length, before + 1, "the second call must not attempt a password update");
});

test("finds the existing account when a duplicate create returns no id", async () => {
  const { calls, fetcher } = fake((call) => {
    if (call.method === "x:Domain/query") return reply(call.method, { ids: ["domain-1"] });
    if (call.method === "x:Account/get") {
      return reply(call.method, {
        list: [{ id: "account-9", emailAddress: "ada.lovelace@atheniq.institute" }],
      });
    }
    if (call.method === "x:Account/query") return reply(call.method, { ids: ["account-9"] });
    if ("create" in call.args) {
      return reply(call.method, { notCreated: { new1: { type: "primaryKeyViolation" } } });
    }
    return reply(call.method, { notUpdated: {} });
  });

  await mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "new-pass", "Ada Lovelace");

  const update = calls.find((call) => "update" in call.args);
  assert.deepEqual(update?.args, { update: { "account-9": { "credentials/0/secret": "new-pass" } } });
});

test("preflight passes when the configured domain answers", async () => {
  const { calls, fetcher } = fake((call) => reply(call.method, { ids: ["domain-1"] }));
  await mailer(fetcher).preflight();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "x:Domain/query");
});

test("preflight reports an unreachable URL", async () => {
  const fetcher = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(
    mailer(fetcher).preflight(),
    (error: unknown) =>
      error instanceof MailError &&
      /unreachable at https:\/\/mail\.innotel\.us/.test(error.message),
  );
});

test("preflight reports a rejected token", async () => {
  const fetcher = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
  await assert.rejects(
    mailer(fetcher).preflight(),
    (error: unknown) =>
      error instanceof MailError && /refused the API key \(403\)/.test(error.message),
  );
});

test("preflight reports a missing domain", async () => {
  const { fetcher } = fake((call) => reply(call.method, { ids: [] }));
  await assert.rejects(
    mailer(fetcher).preflight(),
    (error: unknown) => error instanceof MailError && /no domain atheniq\.institute/.test(error.message),
  );
});
