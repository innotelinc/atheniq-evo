/**
 * One HTTP call to an upstream, with the error handling every caller needs.
 *
 * An upstream that is down must never take the bridge down with it, and the
 * failure must name the upstream and the HTTP status — a bare "fetch failed"
 * has caused more than one wrong diagnosis.
 */

export interface UpstreamResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  text: string;
  error: string | null;
}

export type Fetcher = typeof fetch;

export interface CallOptions {
  method?: string;
  path: string;
  baseUrl: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  fetcher?: Fetcher;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function call(options: CallOptions): Promise<UpstreamResult> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const url = `${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: options.method ?? (payload ? "POST" : "GET"),
      headers,
      body: payload,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { data: parsed };
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      text: text.slice(0, 1000),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: null, text: "", error: `unreachable: ${message}` };
  }
}
