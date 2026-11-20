/**
 * OmniRoute — the estate's one model gateway.
 *
 * Every model call in the estate (the console's course studio and OpenMAIC's
 * outline, slides, images, speech and video) goes through this gateway on one
 * key. The bridge does not proxy model traffic: it holds the key so the
 * deployment has exactly one place where it is configured, and it exposes a
 * probe and a cached model list so an operator can tell a bad key from a bad
 * model name without opening four admin screens.
 */

import { call, type Fetcher } from "../http.ts";
import type { OmniRouteConfig } from "../config.ts";

export interface OmniRouteOptions extends OmniRouteConfig {
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export interface ModelList {
  ok: boolean;
  models: string[];
  status: number;
  detail: string;
}

export async function listModels(options: OmniRouteOptions): Promise<ModelList> {
  if (!options.baseUrl) {
    return { ok: false, models: [], status: 0, detail: "OMNIROUTE_BASE_URL is not set." };
  }
  if (!options.apiKey) {
    return { ok: false, models: [], status: 0, detail: "OMNIROUTE_API_KEY is not set." };
  }

  const result = await call({
    baseUrl: options.baseUrl,
    path: "/models",
    headers: { authorization: `Bearer ${options.apiKey}` },
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  });

  if (!result.ok) {
    // 401/403 is the one failure worth naming precisely: it is the key, not the network.
    if (result.status === 401 || result.status === 403) {
      return {
        ok: false,
        models: [],
        status: result.status,
        detail: `OmniRoute rejected the API key (HTTP ${result.status}).`,
      };
    }
    return {
      ok: false,
      models: [],
      status: result.status,
      detail: result.error ?? `HTTP ${result.status}`,
    };
  }

  const data = result.body?.data;
  const rows = Array.isArray(data) ? data : [];
  const models = rows
    .map((row) => (typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : null))
    .filter((id): id is string => typeof id === "string" && Boolean(id))
    .sort();

  return { ok: true, models, status: result.status, detail: `OmniRoute answered with ${models.length} models.` };
}

export async function probeGateway(
  options: OmniRouteOptions,
): Promise<{ status: "ok" | "failed" | "not_configured"; detail: string }> {
  if (!options.baseUrl) return { status: "not_configured", detail: "OMNIROUTE_BASE_URL is not set." };
  if (!options.apiKey) return { status: "not_configured", detail: "OMNIROUTE_API_KEY is not set." };
  const models = await listModels(options);
  return { status: models.ok ? "ok" : "failed", detail: models.detail };
}
