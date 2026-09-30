// Local stand-in for api.dezrez.com plus its OAuth2 token endpoint, serving the fixtures with the
// documented pageSize/pageNumber paging (PagedCollectionDataContract) and the documented auth:
// "Authorization: Bearer <token>" and "Rezi-Api-Version: 1.0" on every API request; the token
// endpoint takes "Authorization: Basic base64(clientId:clientSecret)" and a JSON body
// {grant_type, scope} (DezrezCoreAPIOverview.md, "Client Flow").
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const ACCESS_TOKEN = "dz-test-access-token-123";
export const CLIENT_ID = "TestClient";
export const CLIENT_SECRET = "dz-test-secret-not-real";
export const CLIENT_BASIC = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
export const AGENCY_ID = "4";
export const TOKEN_PATH = "/Dezrez.Core.Api/oauth/token/";
export const API_VERSION = "1.0";

// Dezrez documents no error body. These shapes are the mock's own placeholders: {Message} for API
// errors (the usual ASP.NET Web API form) and the RFC 6749 {error} form for the token endpoint.
const apiError = (message) => ({ Message: message });

export function startMock() {
  const requests = [];
  let issued = 0;
  const liveTokens = new Set();
  // Injected failures: { method, path, status, times, headers, body, text }. Each matching request consumes
  // one "time" and gets that status instead of the normal answer. `body` is JSON (or a function of the
  // request that returns it, for an error that echoes request headers); `text` is a raw text/plain body;
  // neither means a gateway-style HTML page. The suite starts with a single 429 on GET /api/Offer so the
  // retry path is exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/api/Offer", status: 429, times: 1, headers: { "Retry-After": "1" }, body: apiError("Too many requests.") });
  let failures = [failure429()];
  // Page size the mock serves at most, whatever was asked for (undefined = honour the request).
  let pageCap = 10;
  // The expires_in the token endpoint reports, in seconds; undefined leaves the field out (the
  // overview documents expires_in only for the code and refresh-token exchanges).
  let expiresIn = 7200;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let body = "";
    for await (const chunk of req) body += chunk;
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
    // Repeated keys (collectionFormat multi) are recorded as arrays.
    requests.push({ method: req.method, path, query, auth: req.headers.authorization, version: req.headers["rezi-api-version"], contentType: req.headers["content-type"], body: body ? JSON.parse(body) : undefined, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.text !== undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/plain", ...(failure.headers ?? {}) });
        return res.end(failure.text);
      }
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, typeof failure.body === "function" ? failure.body(req) : failure.body, failure.headers ?? {});
    }

    // OAuth2 token endpoint (client-credentials only; the other flows need a browser or a user's password).
    if (path === TOKEN_PATH) {
      if (req.method !== "POST") return send(405, { error: "invalid_request" });
      if (req.headers.authorization !== CLIENT_BASIC) return send(401, { error: "invalid_client", error_description: "Client authentication failed." });
      const b = body ? JSON.parse(body) : {};
      if (b.grant_type !== "client_credentials") return send(400, { error: "unsupported_grant_type" });
      if (typeof b.scope !== "string" || !b.scope) return send(400, { error: "invalid_scope" });
      const token = `dz-issued-token-${++issued}`;
      liveTokens.add(token);
      return send(200, expiresIn === undefined ? { access_token: token, token_type: "bearer" } : { access_token: token, token_type: "bearer", expires_in: expiresIn });
    }

    // API: bearer token, then the mandatory version header, then agencyId for client tokens.
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const clientToken = bearer !== undefined && liveTokens.has(bearer);
    if (bearer !== ACCESS_TOKEN && !clientToken) return send(401, apiError("Authorization has been denied for this request."));
    if (req.headers["rezi-api-version"] !== API_VERSION) return send(400, apiError(`Rezi-Api-Version header missing or not ${API_VERSION} (mock).`));
    if (clientToken && url.searchParams.get("agencyId") !== AGENCY_ID) return send(400, apiError("A client token must name the agency with the agencyId parameter (mock)."));
    if (url.searchParams.has("agencyId") && url.searchParams.get("agencyId") !== AGENCY_ID) return send(403, apiError("Not allowed for that agency (mock)."));

    // PagedCollectionDataContract with pageSize/pageNumber (1-based here; the spec does not say).
    // Without pageSize the whole collection is returned ("Can be null").
    const paged = (items, prefix = "") => {
      const requested = Number(url.searchParams.get(`${prefix}pageSize`));
      const size = Number.isFinite(requested) && requested > 0 ? Math.min(requested, pageCap ?? requested) : items.length || 1;
      const number = Math.max(1, Number(url.searchParams.get(`${prefix}pageNumber`) || 1));
      const data = items.slice((number - 1) * size, number * size);
      return { TotalCount: items.length, CurrentCount: data.length, PageSize: size, PageNumber: number, Collection: data };
    };
    // Bare arrays with pageSize/pageNumber (GET /api/people/{id}/roles). The page cap is not applied
    // here: with no total in the response, a short page is the only end condition the client has.
    const pagedArray = (items) => {
      const requested = Number(url.searchParams.get("pageSize"));
      const size = Number.isFinite(requested) && requested > 0 ? requested : items.length || 1;
      const number = Math.max(1, Number(url.searchParams.get("pageNumber") || 1));
      return items.slice((number - 1) * size, number * size);
    };
    const multi = (name) => url.searchParams.getAll(name);
    const boolParam = (name) => (url.searchParams.has(name) ? url.searchParams.get(name) === "true" : undefined);

    // The event filters documented on /api/property/{id}/events and /api/group/{id}/events.
    const filterEvents = (events) => {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const types = multi("type");
      const excluded = multi("excludedTypes");
      const category = url.searchParams.get("eventCategoryType");
      const branchId = url.searchParams.get("branchId");
      const showCancelled = boolParam("showCancelled") ?? false;
      const includeDrafts = boolParam("includeDrafts") ?? false;
      const propertyId = url.searchParams.get("propertyId");
      const roleId = url.searchParams.get("roleId");
      return events.filter(
        (e) =>
          (!from || Date.parse(e.DateTime) >= Date.parse(from)) &&
          (!to || Date.parse(e.DateTime) <= Date.parse(to)) &&
          (types.length === 0 || types.includes(e.EventType.SystemName)) &&
          !excluded.includes(e.EventType.SystemName) &&
          (!category || e.EventCategory.SystemName === category) &&
          (!branchId || String(e.BranchId) === branchId) &&
          (showCancelled || e.EventStatus.SystemName !== "Cancelled") &&
          (includeDrafts || e.EventStatus.SystemName !== "Draft") &&
          (!propertyId || e.Properties.some((p) => String(p.Id) === propertyId)) &&
          (!roleId || e.Roles.some((r) => String(r.Id) === roleId)),
      );
    };

    const p = path.split("/").filter(Boolean);
    const m = req.method;
    if (m !== "GET" || p[0] !== "api") return send(404, apiError(`No route for ${m} ${path} (mock).`));
    const idOf = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);
    const byId = (list, id) => (id === fx.NULL_ID ? null : list.find((x) => x.Id === id));
    const notFound = () => send(404, apiError("Not found (mock)."));

    if (p[1] === "property") {
      const id = idOf(p[2]);
      if (Number.isNaN(id)) return notFound();
      const prop = byId(fx.properties, id);
      if (prop === undefined) return notFound();
      if (p.length === 3) return send(200, prop);
      if (p.length === 4 && p[3] === "events") return send(200, prop === null ? null : paged(filterEvents(fx.propertyEvents[id] ?? [])));
    }

    if (p[1] === "role" && p[2] === "suggest" && p.length === 3) {
      const q = url.searchParams.get("dataContract.query")?.toLowerCase();
      const onMarket = boolParam("dataContract.isOnMarket");
      const roleType = url.searchParams.get("dataContract.roleType");
      const roleStatus = url.searchParams.get("dataContract.roleStatus");
      const items = fx.roleSuggestions
        .filter(
          (r) =>
            (!q || [r.Address.Number, r.Address.BuildingName, r.Address.Street, r.Address.Town, r.Address.Postcode, r.SummaryText].filter(Boolean).join(" ").toLowerCase().includes(q)) &&
            (onMarket === undefined || r.isOnMarket === onMarket) &&
            (!roleType || r.PropertyRole.RoleType.SystemName === roleType) &&
            (!roleStatus || r.PropertyRole.RoleStatus.SystemName === roleStatus),
        )
        .map(({ isOnMarket, ...r }) => r);
      return send(200, paged(items, "dataContract."));
    }

    if (p[1] === "people") {
      if (p[2] === "findbydetails" && p.length === 3) {
        const surname = url.searchParams.get("surname")?.toLowerCase();
        const postcode = url.searchParams.get("postcode")?.replace(/\s+/g, "").toLowerCase();
        const email = url.searchParams.get("email")?.toLowerCase();
        const digits = (s) => (s ?? "").replace(/\D/g, "");
        const telephone = digits(url.searchParams.get("telephone"));
        const mobile = digits(url.searchParams.get("mobile"));
        const items = fx.people.filter(
          (x) =>
            (!surname || (x.LastName ?? "").toLowerCase().startsWith(surname)) &&
            (!postcode || x.Addresses.some((a) => a.Postcode.replace(/\s+/g, "").toLowerCase() === postcode)) &&
            (!email || x.ContactItems.some((c) => c.Type.SystemName === "Email" && c.Value.toLowerCase() === email)) &&
            (!telephone || x.ContactItems.some((c) => c.Type.SystemName !== "Email" && digits(c.Value).endsWith(telephone.slice(-9)))) &&
            (!mobile || x.ContactItems.some((c) => c.Type.SystemName === "Mobile" && digits(c.Value).endsWith(mobile.slice(-9)))),
        );
        return send(200, items);
      }
      const id = idOf(p[2]);
      if (Number.isNaN(id)) return notFound();
      const person = byId(fx.people, id);
      if (person === undefined) return notFound();
      if (p.length === 3) return send(200, person);
      if (p.length === 4 && p[3] === "roles") return send(200, person === null ? null : pagedArray(fx.personRoles[id] ?? []));
      // GET /api/people/{id}/accounts and /bankReferences exist in the spec; the server must never call
      // them, and the suite asserts that. They answer here only so a call would be recorded, not confused
      // with a routing gap.
      if (p.length === 4 && (p[3] === "accounts" || p[3] === "bankReferences")) return send(200, []);
    }

    if (p[1] === "group") {
      const id = idOf(p[2]);
      if (Number.isNaN(id)) return notFound();
      const group = byId(fx.groups, id);
      if (group === undefined) return notFound();
      if (p.length === 3) return send(200, group);
      if (p.length === 4 && p[3] === "events") return send(200, group === null ? null : paged(filterEvents(fx.groupEvents[id] ?? [])));
    }

    if (p[1] === "Offer") {
      if (p.length === 2) return send(200, paged(fx.offers));
      const id = idOf(p[2]);
      if (Number.isNaN(id)) return notFound();
      const offer = byId(fx.offers, id);
      if (offer === undefined) return notFound();
      if (p.length === 3) return send(200, offer);
    }

    return send(404, apiError(`No route for ${m} ${path} (mock).`));
  });

  /** Queue a failure for the next `times` requests matching method+path (neither body nor text = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Cap every page at `n` items (undefined removes the cap). */
  const setPageCap = (n) => {
    pageCap = n;
  };
  /** Forget every token the mock issued, so the next API call with one gets a 401. */
  const revokeTokens = () => liveTokens.clear();
  const tokensIssued = () => issued;
  /** Seconds of expires_in the token endpoint reports from now on; undefined leaves the field out. */
  const setExpiresIn = (seconds) => {
    expiresIn = seconds;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, setPageCap, revokeTokens, tokensIssued, setExpiresIn })));
}
