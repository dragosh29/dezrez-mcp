// Minimal Dezrez Rezi API client used by the MCP tools.
// Docs: https://github.com/dezrez/DezrezCoreAPI (DezrezCoreAPIOverview.md, AuthorisationBasics.md)
// Spec: https://api.dezrez.com/swagger/docs/v1 (Swagger 2.0, "Rezi API v1")
import { redactContacts } from "./format.js";

export class DezrezError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "DezrezError";
  }
}

// Spec: PagedCollectionDataContract[T] {TotalCount, CurrentCount, PageSize, PageNumber, Collection}.
export interface PagedCollection<T> {
  TotalCount?: number;
  CurrentCount?: number;
  PageSize?: number;
  PageNumber?: number;
  Collection?: T[] | null;
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET. This server only makes GET requests to the API; the one POST it makes is the OAuth2 token
// request, which is not retried after a gateway error either, so the rule stays simple.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// The spec documents pageSize as "The number of ... to return. Can be null" and no maximum. 100 per
// page is this server's own cap, not a documented limit.
export const PAGE_SIZE = 100;

// DezrezCoreAPIOverview.md: LIVE API https://api.dezrez.com (the swagger's host), token endpoint
// https://auth.dezrez.com/Dezrez.Core.Api/oauth/token/; UAT https://core-api-uat.dezrez.com and
// https://dezrez-core-auth-uat.dezrez.com/Dezrez.Core.Api/oauth/token/.
export const DEFAULT_BASE_URL = "https://api.dezrez.com";
export const DEFAULT_TOKEN_URL = "https://auth.dezrez.com/Dezrez.Core.Api/oauth/token/";
// DezrezCoreAPIOverview.md, "Client Flow": the documented example body is
// { grant_type:'client_credentials', scope:'impersonate_web_user' }. Which scopes a client may ask
// for is decided by Dezrez at registration; DEZREZ_SCOPE overrides this default.
export const DEFAULT_CLIENT_SCOPE = "impersonate_web_user";
// DezrezCoreAPIOverview.md: "Every request must specify the API version that is being targeted using
// a request header: Rezi-Api-Version: 1.0".
export const API_VERSION_HEADER = "Rezi-Api-Version";
export const API_VERSION = "1.0";

export type QueryValue = string | number | boolean | string[] | number[] | undefined;

export interface ClientOptions {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  agencyId?: string;
  baseUrl?: string;
  tokenUrl?: string;
}

export class DezrezClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly staticToken?: string;
  private readonly clientBasic?: string;
  private readonly scope: string;
  readonly agencyId?: string;
  private cachedToken?: { token: string; expiresAt: number };
  // The token request in progress, shared by every caller that needs a token before it settles, so
  // concurrent first calls make one POST to the token endpoint rather than one each.
  private tokenInFlight?: Promise<string>;
  private tokenRequests = 0;
  // Every value that must never appear in an error message: the configured token, each token the
  // token endpoint issued (a 401 body might echo the Authorization header of the request), the Basic
  // credential and the raw client secret. Error messages are scrubbed against this list before they
  // leave the client.
  private readonly secrets = new Set<string>();
  // Dezrez does not document a rate limit. Space requests at about four per second so a tool
  // call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(opts: ClientOptions) {
    this.baseUrl = withoutUserinfo(opts.baseUrl || DEFAULT_BASE_URL, "DEZREZ_BASE_URL").replace(/\/+$/, "");
    this.tokenUrl = withoutUserinfo(opts.tokenUrl || DEFAULT_TOKEN_URL, "DEZREZ_TOKEN_URL");
    // A token pasted with its "Bearer " prefix (the usual copy from a curl example or a browser's
    // network tab) would otherwise be sent as "Bearer Bearer <token>" and fail with a 401.
    this.staticToken = opts.accessToken?.trim().replace(/^bearer\s+/i, "").trim() || undefined;
    this.scope = opts.scope?.trim() || DEFAULT_CLIENT_SCOPE;
    this.agencyId = opts.agencyId?.trim() || undefined;
    if (opts.clientId && opts.clientSecret) {
      // DezrezCoreAPIOverview.md, "Client Flow": the token request authenticates with HTTP Basic,
      // "Authorization: Basic <Base64 of ClientId:ClientSecret>".
      const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, "utf8").toString("base64");
      this.clientBasic = "Basic " + basic;
      this.secrets.add(basic).add(opts.clientSecret);
    }
    if (this.staticToken) this.secrets.add(this.staticToken);
    if (!this.staticToken && !this.clientBasic) throw new DezrezError("No credentials: set DEZREZ_ACCESS_TOKEN, or DEZREZ_CLIENT_ID and DEZREZ_CLIENT_SECRET.");
  }

  /** Replace every known secret in a message with "[redacted]". */
  private scrub(message: string): string {
    let out = message;
    for (const s of this.secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
    return out;
  }

  /** Run a client operation and make sure no error that escapes it carries a secret. */
  private async scrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DezrezError) throw new DezrezError(this.scrub(err.message), err.status);
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  /** "client_credentials" when the server fetches its own tokens, "access_token" when one was supplied. */
  get authMode(): "access_token" | "client_credentials" {
    return this.staticToken ? "access_token" : "client_credentials";
  }

  /** Number of token requests made so far (the tests check the token is cached). */
  get tokenRequestCount(): number {
    return this.tokenRequests;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * The bearer token for the next request: the configured DEZREZ_ACCESS_TOKEN, or a token from the
   * client-credentials flow, cached until a minute before the expires_in the token endpoint gave.
   */
  private token(force = false): Promise<string> {
    if (this.staticToken) return Promise.resolve(this.staticToken);
    if (!force && this.cachedToken && Date.now() < this.cachedToken.expiresAt) return Promise.resolve(this.cachedToken.token);
    // A request already in flight is fresh enough for a forced refresh too: join it.
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.fetchToken().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    // DezrezCoreAPIOverview.md, "Client Flow":
    //   POST <token endpoint>  Authorization: Basic <Base64 of ClientId:ClientSecret>  Content-Type: application/json
    //   { grant_type:'client_credentials', scope:'...' }
    // Response: access_token, token_type, expires_in (documented for the code and refresh-token exchanges).
    const res = await this.fetchWithRetry("POST", this.tokenUrl, {
      headers: { Authorization: this.clientBasic!, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", scope: this.scope }),
      describe: "the token endpoint",
    });
    this.tokenRequests++;
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      // Only a JSON message is passed on. A raw body is never quoted: an error page or a debugging
      // proxy might echo the request, Authorization header included.
      const detail = describeError(json);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new DezrezError(
          `Dezrez's token endpoint rejected the client credentials (${res.status}). Check DEZREZ_CLIENT_ID and DEZREZ_CLIENT_SECRET (the client ID and secret Dezrez issued when the application was registered), DEZREZ_SCOPE (currently "${this.scope}"; it must be a scope the client was granted) and DEZREZ_TOKEN_URL (${this.tokenUrl}).${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (res.status === 429) throw new DezrezError("Dezrez's token endpoint is rate limiting requests (the limit is not documented). Wait a minute and try again.", 429);
      throw new DezrezError(`Dezrez's token endpoint returned ${res.status}. The token request was not retried; try again in a few minutes.${detail ? " " + detail : ""}`, res.status);
    }
    const token = json && typeof json === "object" ? json.access_token : undefined;
    if (typeof token !== "string" || !token) {
      // The body is described, not quoted: a token under another key, or inside a page, must not
      // end up in a tool result.
      throw new DezrezError(`Dezrez's token endpoint answered ${res.status} but the body had no access_token (${json === undefined ? "not JSON: " : ""}${describeBody(res, text, json)}). Check DEZREZ_TOKEN_URL (${this.tokenUrl}).`, res.status);
    }
    this.secrets.add(token);
    // The overview says access tokens last about two hours; expires_in is taken from the response and
    // the token is refreshed early: a minute before it expires, or halfway through its life when it is
    // shorter than two minutes, so a short-lived token is still reused rather than fetched every call.
    // Without a usable expires_in the token is kept for an hour.
    const expiresIn = Number(json.expires_in);
    const ttlMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    this.cachedToken = { token, expiresAt: Date.now() + ttlMs - Math.min(60_000, ttlMs / 2) };
    return token;
  }

  /** fetch() with the throttle and the 429 / gateway-error retry policy; returns the final Response. */
  private async fetchWithRetry(method: string, url: string, opts: { headers: Record<string, string>; body?: string; describe: string }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: opts.headers, body: opts.body });
      } catch (err) {
        // Origin and path only: no query string (agencyId, search terms) in the message.
        throw new DezrezError(`Could not reach ${opts.describe} at ${originAndPath(url)}: ${(err as Error).message}`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new DezrezError(`Dezrez asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${new URL(url).pathname} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    }
  }

  request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue> } = {}): Promise<T> {
    return this.scrubbed(() => this.send<T>(method, path, opts));
  }

  private async send<T>(method: string, path: string, opts: { query?: Record<string, QueryValue> }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    // AuthorisationBasics.md: with a "Userless OAuth2 Flow" (client credentials) every request must
    // carry the agencyId parameter; with a user token it is not needed, but it is passed on when set.
    if (this.agencyId) url.searchParams.set("agencyId", this.agencyId);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      // Swagger 2.0 collectionFormat "multi" (type, excludedTypes): the key repeated once per value.
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }

    for (let tokenAttempt = 0; ; tokenAttempt++) {
      const fresh = !this.staticToken && (!this.cachedToken || Date.now() >= this.cachedToken.expiresAt);
      const bearer = await this.token(tokenAttempt > 0);
      const res = await this.fetchWithRetry(method, url.toString(), {
        headers: { Authorization: `Bearer ${bearer}`, [API_VERSION_HEADER]: API_VERSION, Accept: "application/json" },
        describe: "Dezrez",
      });
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 2xx body is JSON (an object, an array, or the documented "null if it does not
        // exist"). A 200 with HTML (a proxy, a login page) must not be mistaken for an empty record.
        if (json === undefined) {
          // The body is described (content type and size), never quoted: a login page or a proxy's
          // page can carry anything, including contact details and the request that was made.
          throw new DezrezError(
            `Dezrez returned ${res.status} for ${method} ${path} but the body was not JSON (${describeBody(res, text, json)}). Check DEZREZ_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Dezrez's error bodies are not documented; only a JSON message is passed on (never a raw
      // body), and since that message is free text, anything that looks like a contact detail is
      // redacted first. Known secrets are scrubbed from the whole message by scrubbed().
      const detail = redactContacts(describeError(json), false);
      if (res.status === 401) {
        // A cached client-credentials token may simply have expired early: fetch a new one and retry
        // once. A token that was fetched for this very request, or a configured access token, is not.
        if (!this.staticToken && !fresh && tokenAttempt === 0) continue;
        throw new DezrezError(
          this.staticToken
            ? `Dezrez rejected the access token (401). Check DEZREZ_ACCESS_TOKEN: it must be a current OAuth2 access token for the Rezi API (the overview says they expire after about two hours) and the request must carry the ${API_VERSION_HEADER} header, which this server sends.${detail ? " " + detail : ""}`
            : `Dezrez rejected a token obtained with the client credentials (401), even after fetching a new one. Check that the client is registered for ${this.baseUrl} and that DEZREZ_AGENCY_ID (${this.agencyId ?? "not set"}) is the agency the client may access.${detail ? " " + detail : ""}`,
          401,
        );
      }
      if (res.status === 403) {
        throw new DezrezError(
          `Dezrez refused ${method} ${path} (403). The token may lack a scope this call needs (the overview lists property_read, property_basic_read, people_read, people_basic_read, event_read and document_read), the client may not be allowed to act for agency ${this.agencyId ?? "(none given)"}, or team-level security may restrict the record.${detail ? " " + detail : ""}`,
          403,
        );
      }
      if (res.status === 404) throw new DezrezError(`Not found: ${path}. Check the ID.${detail ? " " + detail : ""}`, 404);
      if (res.status === 429) throw new DezrezError("Dezrez rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400) throw new DezrezError(`Dezrez refused ${method} ${path} (400).${detail ? " " + detail : ""}`, 400);
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row.
        throw new DezrezError(`Dezrez returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${detail ? " " + detail : ""}`, res.status);
      }
      throw new DezrezError(`Dezrez returned ${res.status} for ${method} ${path}.${detail ? " " + detail : ""}`, res.status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * GET one record by ID. The spec documents every get-by-id here as "The <thing> or null if it does
   * not exist", so a 200 with a null body is reported as not found, like a 404.
   */
  async getRecord<T = any>(path: string, what: string): Promise<T> {
    const rec = await this.get<T | null>(path);
    if (rec === null || rec === undefined) throw new DezrezError(`Not found: ${path}. Dezrez answered with null, which the API documents as "${what} does not exist". Check the ID.`, 404);
    return rec;
  }

  /**
   * Fetch a PagedCollectionDataContract endpoint (pageSize/pageNumber query parameters, or the
   * `dataContract.`-prefixed pair on the suggest endpoints). Whole pages only: the page size sent is
   * min(PAGE_SIZE, maxItems) and the loop stops BEFORE a page that could take the total past
   * `maxItems`, so a page is never cut in the middle. `next_page` is the first page not fetched and a
   * continuation call must send the same `page_size`.
   *
   * Stops at an empty page, once the page just fetched reaches `TotalCount` (page number times the
   * served page size plus this page's length), or at `maxPages`. A page shorter than the requested
   * size is also taken as the end when TotalCount is absent. Page numbers are assumed to start at 1;
   * the spec does not say (see README).
   *
   * A `null` body means different things per endpoint: the events endpoints document it as "null if
   * the property/group does not exist", so with `nullMeansMissing` set to the thing's name a null
   * first page is reported as not found, like getRecord(); GET /api/Offer documents "null if none
   * exist", which is an empty list.
   */
  async list<T = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, page = 1, query = {} as Record<string, QueryValue>, prefix = "", nullMeansMissing = undefined as string | undefined } = {},
  ): Promise<{ items: T[]; total?: number; page_size: number; complete: boolean; next_page?: number }> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, maxItems));
    const items: T[] = [];
    let total: number | undefined;
    let current = page;
    for (let n = 0; n < maxPages; n++) {
      const res = await this.get<PagedCollection<T> | null>(path, { ...query, [`${prefix}pageSize`]: pageSize, [`${prefix}pageNumber`]: current });
      if (nullMeansMissing && (res === null || res === undefined) && n === 0) {
        throw new DezrezError(`Not found: ${path}. Dezrez answered with null, which the API documents as "${nullMeansMissing} does not exist". Check the ID.`, 404);
      }
      const data = Array.isArray(res?.Collection) ? res!.Collection! : [];
      total = intOrUndefined(res?.TotalCount) ?? total;
      items.push(...data);
      // The size the API actually serves per page (PageSize, if given, else what was asked for): it
      // decides both where this page sits in the whole collection and how big the next one may be.
      const served = intOrUndefined(res?.PageSize) || pageSize;
      const seen = (current - 1) * served + data.length;
      current++;
      const exhausted = data.length === 0 || (total !== undefined && seen >= total) || (total === undefined && data.length < pageSize);
      if (exhausted) return { items, total, page_size: pageSize, complete: true };
      if (items.length + served > maxItems) break;
    }
    return { items, total, page_size: pageSize, complete: false, next_page: current };
  }

  /**
   * Fetch an endpoint that takes pageSize/pageNumber but answers with a bare JSON array (no total),
   * such as GET /api/people/{id}/roles. The only end condition the API offers is a page shorter than
   * the requested size (or empty); if the live API capped pages below the requested size, the walk
   * would stop early (see README).
   */
  async listArray<T = any>(path: string, { maxItems = PAGE_SIZE, maxPages = 10, page = 1, query = {} as Record<string, QueryValue> } = {}): Promise<{ items: T[]; page_size: number; complete: boolean; next_page?: number }> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, maxItems));
    const items: T[] = [];
    let current = page;
    for (let n = 0; n < maxPages; n++) {
      const res = await this.get<T[] | null>(path, { ...query, pageSize, pageNumber: current });
      const data = Array.isArray(res) ? res : [];
      items.push(...data);
      current++;
      if (data.length < pageSize) return { items, page_size: pageSize, complete: true };
      if (items.length + pageSize > maxItems) break;
    }
    return { items, page_size: pageSize, complete: false, next_page: current };
  }
}

/** The URL without query string or userinfo, for error messages. */
function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * A base or token URL must not carry credentials ("https://user:secret@host/"): fetch() refuses such
 * a URL and its refusal message would quote it, so the server refuses it at start-up instead.
 */
function withoutUserinfo(url: string, variable: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DezrezError(`${variable} is not a valid URL.`);
  }
  if (u.username || u.password) throw new DezrezError(`${variable} must not contain a username or password (got ${u.origin + u.pathname} with credentials in it). Use DEZREZ_CLIENT_ID and DEZREZ_CLIENT_SECRET or DEZREZ_ACCESS_TOKEN.`);
  return url;
}

/**
 * What a body was, without quoting it: content type, size, and the JSON keys when it parsed as an
 * object. Key names are the response's own field names (at most ten, shortened), never values.
 */
function describeBody(res: Response, text: string, json: unknown): string {
  const type = res.headers.get("content-type")?.split(";")[0].trim() || "no content-type";
  const size = `${Buffer.byteLength(text)} bytes`;
  if (json === undefined) return `${type}, ${size}`;
  if (json === null) return `${type}, ${size}, JSON null`;
  if (Array.isArray(json)) return `${type}, ${size}, a JSON array of ${json.length}`;
  if (typeof json === "object") {
    const keys = Object.keys(json as object);
    const shown = keys.slice(0, 10).map((k) => (k.length > 40 ? k.slice(0, 40) + "…" : k));
    return `${type}, ${size}, JSON with keys [${shown.join(", ")}${keys.length > 10 ? ", …" : ""}]`;
  }
  return `${type}, ${size}, a JSON ${typeof json}`;
}

function intOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Dezrez documents no error body. The keys read here are the common ASP.NET Web API ones (Message,
// ExceptionMessage), the OAuth2 ones (error, error_description) and lower-case message; the
// Breaking_Change_Log says a SecurityException "explaining why" is returned when access is refused.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  for (const k of ["Message", "message", "ExceptionMessage", "error", "error_description"]) if (typeof json[k] === "string" && json[k].trim() && !parts.includes(json[k].trim())) parts.push(json[k].trim());
  return parts.length ? parts.join(" ") : undefined;
}
