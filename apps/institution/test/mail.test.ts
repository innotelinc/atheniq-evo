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

test("does not leak the API key when Stalwart refuses the request", async () => {
  const fetcher = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(
    mailer(fetcher).ensureAccount("ada.lovelace@atheniq.institute", "temp-pass", "Ada"),
    (error: unknown) =>
      error instanceof MailError &&
      /Stalwart answered 401/.test(error.message) &&
      !error.message.includes("API_test_token_value"),
  );
});
