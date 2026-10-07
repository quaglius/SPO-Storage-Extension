/**
 * HTTP client for SharePoint REST and Microsoft Graph with app-only tokens.
 *
 * - Global token-bucket limiter (requests/minute) + max concurrency shared by all engine slots.
 * - Retries transient failures (429/500/502/503/504, network, truncated JSON) with Retry-After.
 * - Classifies errors so the engine knows whether a task should retry or fail for good.
 * - Counts requests/throttles for engine_throughput.
 */
import { AppOnlyEntraAuth, readAppOnlyEnv } from '../../auth/app-only-entra-auth.js';

export type Api = 'spo' | 'graph';

export class SpoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SpoError';
  }
}

export interface ClientStats {
  requests: number;
  throttled: number;
  errors: number;
}

export interface SpoClientOptions {
  tenant: string; // e.g. 'contoso' for contoso.sharepoint.com
  requestsPerMinute?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  tokenProvider?: (resource: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function errorMessage(body: unknown, text: string): { message: string; code: string | null } {
  const j = body as {
    error?: { message?: string | { value?: string }; code?: string };
    'odata.error'?: { message?: { value?: string }; code?: string };
  } | null;
  const raw = j?.error?.message ?? j?.['odata.error']?.message;
  const message = typeof raw === 'string' ? raw : raw?.value ?? text.slice(0, 300);
  return { message, code: j?.error?.code ?? j?.['odata.error']?.code ?? null };
}

export class SpoClient {
  readonly tenant: string;
  readonly rootUrl: string;
  readonly adminUrl: string;
  readonly stats: ClientStats = { requests: 0, throttled: 0, errors: 0 };

  private readonly rpm: number;
  private readonly maxConcurrency: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly tokenProvider: (resource: string) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  /** Global pause after a 429 so every slot backs off together. */
  private pausedUntil = 0;

  constructor(opts: SpoClientOptions) {
    this.tenant = opts.tenant;
    this.rootUrl = `https://${opts.tenant}.sharepoint.com`;
    this.adminUrl = `https://${opts.tenant}-admin.sharepoint.com`;
    this.rpm = opts.requestsPerMinute ?? 600;
    this.maxConcurrency = opts.maxConcurrency ?? 6;
    this.maxRetries = opts.maxRetries ?? 6;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.tokens = this.rpm;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.tokenProvider) {
      this.tokenProvider = opts.tokenProvider;
    } else {
      const env = readAppOnlyEnv();
      if (!env) throw new Error('App-only credentials are missing (SPOSTORAGE_APP_ONLY_*)');
      const auth = new AppOnlyEntraAuth(env);
      this.tokenProvider = (resource) => auth.getAccessToken(`${resource}/.default`);
    }
  }

  private resourceFor(url: string): string {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      if (elapsed > 0) {
        this.tokens = Math.min(this.rpm, this.tokens + (elapsed * this.rpm) / 60_000);
        this.lastRefill = now;
      }
      if (now >= this.pausedUntil && this.tokens >= 1 && this.inFlight < this.maxConcurrency) {
        this.tokens -= 1;
        this.inFlight += 1;
        return;
      }
      const wait = Math.max(50, this.pausedUntil - now, this.tokens < 1 ? ((1 - this.tokens) * 60_000) / this.rpm : 0);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          signal?.removeEventListener('abort', done);
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        };
        const t = setTimeout(done, Math.min(wait, 5_000));
        signal?.addEventListener('abort', done, { once: true });
        this.waiters.push(done);
      });
    }
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    next?.();
  }

  /** Raw request with retries. Returns parsed JSON (or null for empty bodies). */
  async request<T>(
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; api?: Api; signal?: AbortSignal } = {},
  ): Promise<T> {
    const api: Api = init.api ?? (url.startsWith('https://graph.microsoft.com') ? 'graph' : 'spo');
    const accept = api === 'graph' ? 'application/json' : 'application/json;odata=nometadata';
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.acquire(init.signal);
      let res: Response;
      let text: string;
      try {
        const token = await this.tokenProvider(this.resourceFor(url));
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        this.stats.requests += 1;
        res = await this.fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: accept,
            ...(init.body !== undefined ? { 'Content-Type': accept } : {}),
            ...init.headers,
          },
          body:
            init.body === undefined
              ? undefined
              : typeof init.body === 'string' || init.body instanceof Uint8Array
                ? (init.body as BodyInit)
                : JSON.stringify(init.body),
          signal,
        });
        text = await res.text();
      } catch (err) {
        this.release();
        if (init.signal?.aborted) throw init.signal.reason ?? err;
        this.stats.errors += 1;
        if (attempt > this.maxRetries) {
          throw new SpoError(`Error de red: ${(err as Error).message}`, 0, true);
        }
        await sleep(backoff(attempt), init.signal);
        continue;
      }
      this.release();

      if (res.ok) {
        if (!text) return null as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // SharePoint occasionally truncates large JSON bodies: treat as transient.
          this.stats.errors += 1;
          if (attempt > this.maxRetries) throw new SpoError('Respuesta JSON truncada', res.status, true);
          await sleep(backoff(attempt), init.signal);
          continue;
        }
      }

      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON error body
      }
      const { message, code } = errorMessage(body, text);
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 429 || res.status === 503) {
        this.stats.throttled += 1;
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (retryAfterMs ?? backoff(attempt)));
      } else {
        this.stats.errors += 1;
      }
      if (TRANSIENT.has(res.status) && attempt <= this.maxRetries) {
        await sleep(retryAfterMs ?? backoff(attempt), init.signal);
        continue;
      }
      throw new SpoError(
        `HTTP ${res.status} ${message}`.slice(0, 1000),
        res.status,
        TRANSIENT.has(res.status),
        retryAfterMs,
        code,
      );
    }
  }

  /**
   * Opens a binary download (file content). Retries only until response headers arrive; the caller
   * consumes res.body as a stream. No overall timeout: large files may take long.
   */
  async download(url: string, signal?: AbortSignal): Promise<Response> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.acquire(signal);
      let res: Response;
      try {
        const token = await this.tokenProvider(this.resourceFor(url));
        this.stats.requests += 1;
        res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal });
      } catch (err) {
        this.release();
        if (signal?.aborted) throw signal.reason ?? err;
        this.stats.errors += 1;
        if (attempt > this.maxRetries) throw new SpoError(`Error de red: ${(err as Error).message}`, 0, true);
        await sleep(backoff(attempt), signal);
        continue;
      }
      this.release();
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 429 || res.status === 503) this.stats.throttled += 1;
      else this.stats.errors += 1;
      if (TRANSIENT.has(res.status) && attempt <= this.maxRetries) {
        await sleep(retryAfterMs ?? backoff(attempt), signal);
        continue;
      }
      throw new SpoError(`HTTP ${res.status} ${text.slice(0, 300)}`, res.status, TRANSIENT.has(res.status), retryAfterMs);
    }
  }

  get<T>(url: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, { signal });
  }

  post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, { method: 'POST', body, signal });
  }
}

function backoff(attempt: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** SharePoint server-relative path literal for decodedurl='...'. */
export function spPath(serverRelativeUrl: string): string {
  return encodeURIComponent(serverRelativeUrl.replace(/'/g, "''"));
}

export function isAccessDenied(err: unknown): boolean {
  return err instanceof SpoError && (err.status === 401 || err.status === 403);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof SpoError && err.status === 404;
}
