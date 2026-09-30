// End-to-end test: fixtures are validated against the definitions in Dezrez's published Swagger 2.0
// document, then the built MCP server is driven over stdio by a real MCP client against a local mock
// of the API and its OAuth2 token endpoint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, ACCESS_TOKEN, CLIENT_ID, CLIENT_SECRET, CLIENT_BASIC, AGENCY_ID, TOKEN_PATH, API_VERSION } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://api.dezrez.com/swagger/docs/v1";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL, { headers: { Accept: "application/json" } })).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Rezi API swagger (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.swagger, "2.0", "the Rezi API document is Swagger 2.0");
// Swagger 2.0 definitions are JSON Schema draft-04 (its `id` keyword, not `$id`); ajv-draft-04 is Ajv
// with that dialect. The generic definition names contain brackets (PagedCollectionDataContract[...])
// and resolve fine as JSON pointers.
const ajv = new Ajv04({ strict: false, allErrors: true });
addFormats(ajv);
// The spec's "Object" definition ("Represents an unspecified legacy API value whose concrete data
// contract is not declared by the action", type object with no properties) is what custom field
// values are typed as. Since the spec itself calls it unspecified, it is validated here as "any value",
// so a string custom field value (the natural JSON of a .NET object holding a string) passes.
assert.match(spec.definitions.Object.description, /unspecified/, "the override below relies on the spec calling Object unspecified");
ajv.addSchema({ id: "dz", definitions: { ...spec.definitions, Object: { description: spec.definitions.Object.description } } });
// An inline response schema (the bare arrays of findbydetails and people roles) refers to
// "#/definitions/..." relative to the swagger document, so its refs are pointed at the "dz" schema.
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/definitions/', '"dz#/definitions/'));
// The definitions set no additionalProperties:false, so Ajv would accept a fixture field the spec
// never defines (and the formatter could come to rely on a field the live API never sends). This walk
// reports every key that the referenced definition does not declare, following $ref and items;
// a definition with `additionalProperties` (the Dates and Descriptions maps) takes any key, and the
// spec's own "unspecified" Object definition is opaque.
const resolveRef = (schema) => (schema?.$ref ? spec.definitions[schema.$ref.replace(/^(dz)?#\/definitions\//, "")] : schema);
const unknownKeys = (schema, value, path, out = []) => {
  if (schema?.$ref?.endsWith("/Object")) return out;
  const s = resolveRef(schema);
  if (!s || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => unknownKeys(s.items, item, `${path}[${i}]`, out));
    return out;
  }
  if (s.additionalProperties && typeof s.additionalProperties === "object") {
    for (const [k, v] of Object.entries(value)) unknownKeys(s.additionalProperties, v, `${path}.${k}`, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const prop = s.properties?.[k];
    if (!prop) out.push(`${path}.${k}`);
    else unknownKeys(prop, v, `${path}.${k}`, out);
  }
  return out;
};
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`dz#/definitions/${schema}`) ?? ajv.compile({ $ref: `dz#/definitions/${schema}` }) : ajv.compile(inline(schema));
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
  const unknown = unknownKeys(typeof schema === "string" ? { $ref: `#/definitions/${schema}` } : schema, obj, label);
  assert.deepEqual(unknown, [], `${label}: keys the spec does not declare: ${unknown.join(", ")}`);
};
const validate = (name, obj, id = "") => validateWith(name, obj, `${name} ${id}`);
const responseSchema = (path, method = "get", status = "200") => spec.paths[path][method].responses[status].schema;
const refName = (schema) => schema.$ref.replace("#/definitions/", "");

console.log("fixtures vs Swagger definitions");
await check("properties, property events, people, basic person roles, groups, group events, offers, role suggest results", async () => {
  fx.properties.forEach((p) => validate("PropertyDataContract", p, p.Id));
  Object.values(fx.propertyEvents).flat().forEach((e) => validate("EventListDataContract", e, e.Id));
  Object.values(fx.groupEvents).flat().forEach((e) => validate("EventListDataContract", e, e.Id));
  fx.people.forEach((p) => validate("PersonDataContract", p, p.Id));
  Object.values(fx.personRoles).flat().forEach((r) => validate("BasicPersonRoleDataContract", r, r.RoleId));
  fx.groups.forEach((g) => validate("GroupDataContract", g, g.Id));
  fx.offers.forEach((o) => validate("OfferDataContract", o, o.Id));
  fx.roleSuggestions.forEach(({ isOnMarket, ...r }) => validate("PropertyRoleSuggestResultDataContract", r, r.PropertyId));
  // Negative controls, so a schema that accepted anything, or a key walk that saw nothing, would be noticed.
  const v = ajv.compile({ $ref: "dz#/definitions/PersonDataContract" });
  assert.equal(v({ Id: "seven", CreatedDate: "yesterday" }), false, "the schema must reject a string Id and a non-date-time");
  assert.deepEqual(unknownKeys({ $ref: "#/definitions/PersonDataContract" }, { Id: 1, JobTitle: "x", CreatedBy: { Id: 2, Nickname: "y" }, CustomFields: [{ Name: "g", Values: [{ Name: "v", Value: { anything: 1 } }] }] }, "p"), ["p.JobTitle", "p.CreatedBy.Nickname"], "undeclared keys are reported at any depth; Object values are opaque");
  assert.deepEqual(unknownKeys({ $ref: "#/definitions/EventListDataContract" }, { Dates: { OfferMade: "2026-09-21T10:00:00Z" } }, "e"), [], "a map with additionalProperties takes any key");
});

// 2. The mock's responses (lists, single records, token, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, setPageCap, revokeTokens, tokensIssued, setExpiresIn } = await startMock();
const base = `http://127.0.0.1:${port}`;
const tokenUrl = `${base}${TOKEN_PATH}`;
const raw = async (path, init = {}) => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Rezi-Api-Version": API_VERSION }, ...init });
  return { status: res.status, json: await res.json() };
};
await check("mock responses match the documented list, detail and paged-collection schemas; token endpoint and errors behave as documented", async () => {
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  const property = await raw(`/api/property/${fx.PROPERTY_HIGH_ST}`);
  validate(refName(responseSchema("/api/property/{id}")), property.json);
  keys(property.json, "Id", "Address", "Roles", "Keys", "Alarms", "Certificates");
  const events = await raw(`/api/property/${fx.PROPERTY_HIGH_ST}/events?pageSize=10&pageNumber=1`);
  validate(refName(responseSchema("/api/property/{id}/events")), events.json);
  keys(events.json, "TotalCount", "CurrentCount", "PageSize", "PageNumber", "Collection");
  assert.deepEqual([events.json.TotalCount, events.json.CurrentCount, events.json.PageSize, events.json.PageNumber], [24, 10, 10, 1], "cancelled events are hidden unless showCancelled=true");
  validate(refName(responseSchema("/api/people/{id}")), (await raw(`/api/people/${fx.PERSON_SAM}`)).json);
  const found = await raw("/api/people/findbydetails?surname=Evans");
  validateWith(responseSchema("/api/people/findbydetails"), found.json, "findbydetails response");
  assert.deepEqual(found.json.map((p) => p.Id), [fx.PERSON_SAM, fx.PERSON_ALEX]);
  const roles = await raw(`/api/people/${fx.PERSON_SAM}/roles?pageSize=10&pageNumber=1`);
  validateWith(responseSchema("/api/people/{id}/roles"), roles.json, "person roles response");
  assert.equal(roles.json.length, 10);
  validate(refName(responseSchema("/api/group/{id}")), (await raw(`/api/group/${fx.GROUP_EVANS}`)).json);
  validate(refName(responseSchema("/api/group/{id}/events")), (await raw(`/api/group/${fx.GROUP_EVANS}/events`)).json);
  const limited = await raw("/api/Offer"); // the mock answers the first GET /api/Offer with a 429
  assert.equal(limited.status, 429);
  const offers = await raw("/api/Offer?pageSize=10&pageNumber=2");
  validate(refName(responseSchema("/api/Offer")), offers.json);
  assert.deepEqual([offers.json.TotalCount, offers.json.CurrentCount, offers.json.PageNumber], [12, 2, 2]);
  validate(refName(responseSchema("/api/Offer/{id}")), (await raw(`/api/Offer/${fx.OFFER_MAIN}`)).json);
  const suggest = await raw("/api/role/suggest?dataContract.query=high%20street&dataContract.pageSize=10&dataContract.pageNumber=1");
  validate(refName(responseSchema("/api/role/suggest")), suggest.json);
  assert.equal(suggest.json.TotalCount, 1);
  // Auth as documented: no bearer -> 401; the mandatory Rezi-Api-Version header; the documented "null if it does not exist"; 404.
  assert.equal((await fetch(`${base}/api/property/${fx.PROPERTY_HIGH_ST}`, { headers: { "Rezi-Api-Version": API_VERSION } })).status, 401);
  assert.equal((await fetch(`${base}/api/property/${fx.PROPERTY_HIGH_ST}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } })).status, 400, "the mock refuses a request without the version header");
  assert.deepEqual(await raw(`/api/property/${fx.NULL_ID}`), { status: 200, json: null });
  assert.equal((await raw("/api/property/1")).status, 404);
  // Token endpoint: documented Basic header and JSON body; the response has access_token, token_type, expires_in.
  const tokenRes = await fetch(tokenUrl, { method: "POST", headers: { Authorization: CLIENT_BASIC, "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", scope: "impersonate_web_user" }) });
  const token = await tokenRes.json();
  assert.equal(tokenRes.status, 200);
  keys(token, "access_token", "token_type", "expires_in");
  assert.equal((await fetch(tokenUrl, { method: "POST", headers: { Authorization: "Basic " + Buffer.from("wrong:wrong").toString("base64"), "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", scope: "x" }) })).status, 401);
  // A client token must carry agencyId (AuthorisationBasics.md); the mock enforces it.
  assert.equal((await fetch(`${base}/api/property/${fx.PROPERTY_HIGH_ST}`, { headers: { Authorization: `Bearer ${token.access_token}`, "Rezi-Api-Version": API_VERSION } })).status, 400);
  assert.equal((await fetch(`${base}/api/property/${fx.PROPERTY_HIGH_ST}?agencyId=${AGENCY_ID}`, { headers: { Authorization: `Bearer ${token.access_token}`, "Rezi-Api-Version": API_VERSION } })).status, 200);
});
requests.length = 0; // only count what the MCP server does from here on
const issuedBeforeMcp = tokensIssued(); // the one token the raw request above obtained
arm429();

// 3. Drive the server through MCP.
const connect = async ({ env: extra = {}, mode = "client" } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, DEZREZ_BASE_URL: base, DEZREZ_TOKEN_URL: tokenUrl };
  for (const k of ["DEZREZ_ACCESS_TOKEN", "DEZREZ_CLIENT_ID", "DEZREZ_CLIENT_SECRET", "DEZREZ_AGENCY_ID", "DEZREZ_SCOPE", "DEZREZ_ALLOW_WRITES"]) delete env[k];
  if (mode === "client") Object.assign(env, { DEZREZ_CLIENT_ID: CLIENT_ID, DEZREZ_CLIENT_SECRET: CLIENT_SECRET, DEZREZ_AGENCY_ID: AGENCY_ID });
  if (mode === "token") env.DEZREZ_ACCESS_TOKEN = ACCESS_TOKEN;
  Object.assign(env, extra);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const apiSince = (n) => since(n).filter((r) => r.path !== TOKEN_PATH);
const TOOLS = ["find_people", "get_group", "get_group_events", "get_offer", "get_person", "get_person_roles", "get_property", "get_property_events", "list_offers", "search_properties"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes the 10 read tools, all read-only and non-destructive; DEZREZ_ALLOW_WRITES adds nothing", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
  }
  const withFlag = await connect({ env: { DEZREZ_ALLOW_WRITES: "true" } });
  assert.deepEqual((await withFlag.listTools()).tools.map((t) => t.name).sort(), TOOLS, "no write tool exists in this version");
  await withFlag.close();
});

await check("client-credentials flow: one documented token request (Basic client:secret, JSON grant_type+scope), the token cached across calls, agencyId on every API request", async () => {
  const n = requests.length;
  const issuedBefore = tokensIssued();
  const first = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(!first.res.isError, first.text);
  const second = await call(client, "get_group", { group_id: fx.GROUP_PATEL });
  assert.ok(!second.res.isError, second.text);
  const tokenCalls = since(n).filter((r) => r.path === TOKEN_PATH);
  assert.equal(tokenCalls.length, 1, "one token request for two tool calls");
  assert.equal(tokensIssued(), issuedBefore + 1);
  assert.deepEqual([tokenCalls[0].method, tokenCalls[0].auth, tokenCalls[0].contentType, tokenCalls[0].body], ["POST", CLIENT_BASIC, "application/json", { grant_type: "client_credentials", scope: "impersonate_web_user" }], "DezrezCoreAPIOverview.md, Client Flow");
  assert.deepEqual(apiSince(n).map((r) => [r.path, r.query.agencyId]), [[`/api/property/${fx.PROPERTY_FLAT}`, AGENCY_ID], [`/api/group/${fx.GROUP_PATEL}`, AGENCY_ID]]);
  assert.equal(first.data.property.address.text, "Flat 3 Harbour View, Bute Street, Cardiff, CF10 5BZ");
  assert.deepEqual(first.data.property.roles.map((r) => [r.id, r.type, r.status]), [[fx.ROLE_FLAT_LET, "Letting", "Available"]]);
  assert.deepEqual(first.data.property.certificates.map((c) => [c.name, c.type, c.expired]), [["Gas safety", "GasSafety", false]]);
  // Two calls made at the same time on a fresh server share one token request: the request in flight
  // is kept on the client and every caller waits for it.
  const fresh = await connect();
  const m = requests.length;
  const issuedBeforeFresh = tokensIssued();
  const both = await Promise.all([call(fresh, "get_property", { property_id: fx.PROPERTY_FLAT }), call(fresh, "get_group", { group_id: fx.GROUP_PATEL })]);
  for (const r of both) assert.ok(!r.res.isError, r.text);
  assert.equal(since(m).filter((r) => r.path === TOKEN_PATH).length, 1, "one token request for two concurrent first calls");
  assert.equal(tokensIssued(), issuedBeforeFresh + 1);
  assert.deepEqual(new Set(apiSince(m).map((r) => r.auth)).size, 1, "both calls used the same token");
  await fresh.close();
});

await check("get_property never returns key or alarm codes, redacts phone numbers and emails in notes and special arrangements, withholds contact-like custom fields; include_contact_details returns the text as stored", async () => {
  const { data, text } = await call(client, "get_property", { property_id: fx.PROPERTY_HIGH_ST });
  const p = data.property;
  assert.deepEqual([p.id, p.status, p.address.postcode, p.address.latitude, p.inactive_role_ids, p.default_picture_url, p.retention_amount], [fx.PROPERTY_HIGH_ST, "Active", "BS1 4DJ", 51.4545, [8001], "https://cdn.example.com/photos/55010.jpg", 250]);
  assert.deepEqual(p.roles.map((r) => [r.id, r.name, r.type, r.status, r.branch_id]), [[fx.ROLE_HIGH_ST_SALE, "Sale of 12 High Street", "Sales", "OfferAccepted", fx.BRANCH_BRISTOL]]);
  assert.deepEqual(p.keys.map((k) => [k.name, k.is_checked_out, k.checked_out_by, k.holder?.name, k.holder?.group, k.code]), [["Front door set", true, "Ms Jo Bloggs", "Sam Evans", "Mr and Mrs Evans", undefined], ["Garage key", false, undefined, undefined, undefined, undefined]]);
  assert.equal(p.keys[0].note_on_check_out, "Given to Sam Evans for the second viewing, ring [phone redacted] if late back");
  assert.equal(p.alarm_count, 1);
  assert.equal(p.alarms, undefined);
  assert.equal(p.special_arrangements[0].text, "Call the tenant on [phone redacted] or [email redacted] before any viewing");
  assert.deepEqual(p.certificates[0].documents, [{ id: 55003, file_name: "epc-12-high-street.pdf", type: "Certificate", content_type: "application/pdf", url: "https://api.dezrez.com/api/document/55003/download", requires_authentication: true, created_date: "2026-09-02T10:00:00Z" }]);
  assert.deepEqual(p.custom_fields, [
    {
      group: "Marketing",
      values: [
        { name: "Vendor mobile", type: "Text", value: "[withheld: looks like contact data; available with include_contact_details]" },
        { name: "Board", type: "Text", value: "Yes, slip on" },
        { name: "Notes", type: "Text", value: "Neighbour at no. 14 ([phone redacted]) holds a spare key" },
      ],
    },
  ]);
  for (const leak of ["K-0042", "K-0043", "1234", "07700 900789", "07700 900456", "020 7946 0958", "07700 900123", "tenant@example.com", "jo.bloggs@example.org", "0117 496 0000"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "get_property", { property_id: fx.PROPERTY_HIGH_ST, include_contact_details: true });
  assert.equal(full.data.property.special_arrangements[0].text, fx.properties[0].SpecialArrangements[0].Text);
  assert.equal(full.data.property.custom_fields[0].values[0].value, "07700 900456");
  assert.equal(full.data.property.keys[0].note_on_check_out, fx.properties[0].Keys[0].NoteOnCheckOut);
  assert.ok(!full.text.includes("K-0042") && !full.text.includes('"1234"'), "key and alarm codes are never returned, even on request");
});

await check("search_properties sends the documented dataContract.* parameters exactly and returns property, role, prices and owner (names only by default)", async () => {
  const n = requests.length;
  const { data } = await call(client, "search_properties", { query: "High Street" });
  const q = apiSince(n)[0].query;
  assert.deepEqual([apiSince(n)[0].path, q["dataContract.query"], q["dataContract.pageSize"], q["dataContract.pageNumber"], q["dataContract.isOnMarket"], q["dataContract.roleType"], q["dataContract.roleStatus"], q["dataContract.suggestType"]], ["/api/role/suggest", "High Street", "25", "1", undefined, undefined, undefined, undefined]);
  assert.deepEqual([data.count, data.total, data.complete], [1, 1, true]);
  const r = data.results[0];
  assert.deepEqual([r.property_id, r.address.text, r.role.status, r.prices[0].value, r.prices[0].qualifier, r.summary, r.owner.name, r.owner.members[0].name, r.owner.members[0].primary_email], [fx.PROPERTY_HIGH_ST, "12 High Street, Bristol, BS1 4DJ", "OfferAccepted", 435000, "OffersOver", "3 bed semi, offer accepted. Vendor Raj on [phone redacted]", "Mr Patel", "Mr Raj Patel", undefined]);
  const filtered = await call(client, "search_properties", { is_on_market: true, role_type: "Sales", role_status: "OfferAccepted", suggest_type: "AgencyOnly", max_results: 10, page: 1 });
  const fq = requests.at(-1).query;
  assert.deepEqual([fq["dataContract.isOnMarket"], fq["dataContract.roleType"], fq["dataContract.roleStatus"], fq["dataContract.suggestType"], fq["dataContract.pageSize"], fq["dataContract.query"]], ["true", "Sales", "OfferAccepted", "AgencyOnly", "10", undefined]);
  assert.deepEqual(filtered.data.results.map((x) => x.property_id), [fx.PROPERTY_HIGH_ST]);
  const offMarket = await call(client, "search_properties", { is_on_market: false });
  assert.deepEqual([requests.at(-1).query["dataContract.isOnMarket"], offMarket.data.results.map((x) => [x.property_id, x.role.status])], ["false", [[fx.PROPERTY_WITHDRAWN, "Withdrawn"]]]);
  const lettings = await call(client, "search_properties", { role_type: "Letting", include_contact_details: true });
  assert.deepEqual([lettings.data.results[0].property_id, lettings.data.results[0].prices[0].text, lettings.data.results[0].owner.members[0].primary_email], [fx.PROPERTY_FLAT, "£950 pcm", "raj.patel@example.com"]);
});

await check("get_property_events pages 1, 2, 3 at the mock's page size and stops at TotalCount; whole pages only when max_results is smaller", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, max_results: 100 });
  assert.deepEqual([data.count, data.total, data.complete, data.next_page, data.note], [24, 24, true, undefined, undefined]);
  assert.deepEqual(apiSince(n).map((r) => [r.path, r.query.pageSize, r.query.pageNumber]), [1, 2, 3].map((p) => [`/api/property/${fx.PROPERTY_HIGH_ST}/events`, "100", String(p)]), "three pages, no fourth call once TotalCount is reached");
  assert.deepEqual(data.events.slice(0, 2).map((e) => [e.id, e.name, e.type, e.status]), [[10001, "Offer accepted", "Offer", "Confirmed"], [10002, "Second viewing", "Viewing", "Confirmed"]]);
  // max_results 4 with pages of 10: a cut at 4 would skip events 5-10, so the call returns the whole page and the next page number.
  const m = requests.length;
  const ids = [];
  let page = 1;
  const calls = [];
  for (;;) {
    const r = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, max_results: 4, page });
    assert.ok(r.data, r.text);
    calls.push([r.data.count, r.data.next_page, r.data.complete]);
    ids.push(...r.data.events.map((e) => e.id));
    if (r.data.complete) break;
    assert.match(r.data.note, new RegExp(`call again with page ${r.data.next_page} and the same max_results \\(4\\)`));
    page = r.data.next_page;
  }
  assert.deepEqual(since(m).map((r) => [r.query.pageSize, r.query.pageNumber]), [["4", "1"], ["4", "2"], ["4", "3"], ["4", "4"], ["4", "5"], ["4", "6"]], "no seventh call: page 6 of 4 reaches TotalCount 24");
  assert.deepEqual(calls, [[4, 2, false], [4, 3, false], [4, 4, false], [4, 5, false], [4, 6, false], [4, undefined, true]]);
  assert.deepEqual(ids, fx.propertyEvents[fx.PROPERTY_HIGH_ST].filter((e) => e.EventStatus.SystemName !== "Cancelled").map((e) => e.Id), "every event once, in order");
});

await check("get_property_events passes every documented filter through exactly (from, to, type multi, excludedTypes multi, eventCategoryType, branchId, showCancelled, includeOnlyOriginalNotes)", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_property_events", {
    property_id: fx.PROPERTY_HIGH_ST,
    from: fx.SEP_10,
    to: fx.SEP_20,
    types: ["Viewing", "Note"],
    excluded_types: ["Task"],
    event_category_type: "Sales",
    branch_id: fx.BRANCH_BRISTOL,
    show_cancelled: true,
    include_only_original_notes: false,
  });
  const q = apiSince(n)[0].query;
  assert.deepEqual(
    [q.from, q.to, q.type, q.excludedTypes, q.eventCategoryType, q.branchId, q.showCancelled, q.includeOnlyOriginalNotes, q.pageSize, q.pageNumber, q.agencyId],
    [fx.SEP_10, fx.SEP_20, ["Viewing", "Note"], "Task", "Sales", String(fx.BRANCH_BRISTOL), "true", "false", "25", "1", AGENCY_ID],
    "collectionFormat multi: the key repeated once per value",
  );
  assert.deepEqual(data.events.map((e) => [e.id, e.type, e.status]), [[10002, "Viewing", "Confirmed"], [10003, "Viewing", "Cancelled"], [10007, "Viewing", "Confirmed"]], "sales viewings 10-20 September in Bristol, including the cancelled one (the routine viewings from 9 September on are outside the range)");
  const plain = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, max_results: 5 });
  const pq = requests.at(-1).query;
  assert.deepEqual([pq.from, pq.to, pq.type, pq.excludedTypes, pq.eventCategoryType, pq.branchId, pq.showCancelled, pq.includeOnlyOriginalNotes], [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined], "nothing is sent unless asked");
  assert.ok(!plain.data.events.some((e) => e.status === "Cancelled"), "the API hides cancelled events by default");
  const cardiff = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, branch_id: fx.BRANCH_CARDIFF });
  assert.deepEqual(cardiff.data.events.map((e) => e.id), [10005]);
  // The parameters are typed date-time: a date alone is completed to the start (from) or end (to) of that day, UTC.
  const dateOnly = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, from: "2026-09-22" });
  assert.deepEqual([requests.at(-1).query.from, dateOnly.data.events.map((e) => e.id)], ["2026-09-22T00:00:00Z", [10001]], "a date without a time is sent as a date-time");
  const toDate = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, from: "2026-09-18", to: "2026-09-18", max_results: 100 });
  assert.deepEqual([requests.at(-1).query.from, requests.at(-1).query.to, toDate.data.events.map((e) => e.id)], ["2026-09-18T00:00:00Z", "2026-09-18T23:59:59Z", [10002]], "a `to` date alone covers the whole day");
  const withTime = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, from: "2026-09-22T13:00:00+01:00", to: fx.SEP_20.replace("Z", "") });
  assert.deepEqual([requests.at(-1).query.from, requests.at(-1).query.to], ["2026-09-22T13:00:00+01:00", "2026-09-20T00:00:00"], "a date-time is sent exactly as given");
  assert.ok(!withTime.res.isError, withTime.text);
  const before = requests.length;
  for (const bad of ["next tuesday", "22/09/2026", "2026-13-45", "2026-09", "2026-02-30", "2026-09-31T10:00:00Z", "2026-00-10"]) {
    const r = await client.callTool({ name: "get_property_events", arguments: { property_id: fx.PROPERTY_HIGH_ST, from: bad } });
    assert.ok(r.isError, `from ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(requests.length, before, "no request for a refused date");
});

await check("events withhold attendee contact items and negotiator emails and redact emails and phone numbers in notes, descriptions and names by default; key codes never; everything as stored on request", async () => {
  const { data, text } = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, max_results: 3 });
  const offer = data.events[0];
  assert.deepEqual([offer.offer_status, offer.prices[0].value, offer.price_type, offer.method_of_contact, offer.dates], ["Accepted", 425000, "Fixed", "Telephone", { OfferMade: "2026-09-21T10:00:00Z", OfferAccepted: "2026-09-22T14:00:00Z" }]);
  assert.equal(offer.description, "Offer of £425,000 from Mr and Mrs Evans, accepted by Mr Patel ([email redacted])");
  assert.equal(offer.notes[0].note, "Sam said to call her on [phone redacted] or mail [email redacted] to arrange the survey");
  assert.deepEqual(offer.attending_groups[0].group, { group_id: fx.GROUP_EVANS, name: "Mr and Mrs Evans", type: "Individual", grade: "Hot", financial_status: "MortgageAgreedInPrinciple", primary_member: { id: fx.PERSON_SAM, name: "Ms Sam Evans", gender: "Female" }, branch_id: fx.BRANCH_BRISTOL });
  assert.deepEqual(offer.attending_groups[0].attending_people, [{ person_id: fx.PERSON_SAM, name: "Sam Evans" }, { person_id: fx.PERSON_ALEX, name: "Alex Evans" }]);
  assert.deepEqual(offer.negotiators, [{ id: fx.PERSON_JO, name: "Ms Jo Bloggs", gender: "Female", job_title: "Senior Negotiator" }]);
  assert.deepEqual(offer.properties[0].address, { text: "12 High Street, Bristol, BS1 4DJ", number: "12", street: "High Street", town: "Bristol", county: "Bristol", postcode: "BS1 4DJ" });
  assert.deepEqual([offer.properties[0].bedrooms, offer.properties[0].owning_group.name, offer.roles[0].milestones, offer.roles[0].property_address, offer.branch], [3, "Mr Patel", "2/8", "12, High Street, Bristol, BS1 4DJ", { id: fx.BRANCH_BRISTOL, name: "Bristol" }]);
  const viewing = data.events[1];
  assert.deepEqual(viewing.key_signed_out, { key_id: 701, name: "Front door set", group: "Mr and Mrs Evans", person: "Sam Evans" });
  assert.equal(viewing.notes[0].note, "Measured the kitchen. Feedback: loved it.");
  for (const leak of ["K-0042", "sam.evans@example.com", "07700 900789", "raj.patel@example.com", "jo.bloggs@example.org", "0117 496 0000", "07700 900321"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, max_results: 3, include_contact_details: true });
  const o = full.data.events[0];
  assert.equal(o.notes[0].note, fx.propertyEvents[fx.PROPERTY_HIGH_ST][0].Notes[0].Note);
  assert.deepEqual(o.attending_groups[0].attending_people, [{ person_id: fx.PERSON_SAM, name: "Sam Evans", address: "sam.evans@example.com" }, { person_id: fx.PERSON_ALEX, name: "Alex Evans", address: "07700 900321" }]);
  assert.deepEqual([o.negotiators[0].primary_email, o.negotiators[0].primary_telephone, o.attending_groups[0].group.primary_member.primary_email], ["jo.bloggs@example.org", "0117 496 0000", "sam.evans@example.com"]);
  assert.ok(!full.text.includes("K-0042"), "key codes are never returned, even on request");
  const cancelled = await call(client, "get_property_events", { property_id: fx.PROPERTY_HIGH_ST, show_cancelled: true, types: ["Viewing"], max_results: 2 });
  assert.equal(cancelled.data.events[1].attending_groups[0].group.name, "Lee Chen ([email redacted])", "an email typed into a group name is redacted");
});

await check("get_person returns names, groups and preferences by default and withholds the note, contact items, addresses, identity details and contact-like custom fields; never HasBankAccounts", async () => {
  const { data, text } = await call(client, "get_person", { person_id: fx.PERSON_SAM });
  const p = data.person;
  assert.deepEqual([p.id, p.name, p.title, p.first_name, p.last_name, p.gender, p.group_count, p.group_ids, p.created_by], [fx.PERSON_SAM, "Ms Sam Evans", "Ms", "Sam", "Evans", "Female", 1, [fx.GROUP_EVANS], "Ms Jo Bloggs"]);
  assert.equal(p.note, "[withheld: free-text note about the person; available with include_contact_details]");
  assert.deepEqual(p.group_memberships, [{ group_id: fx.GROUP_EVANS, group_name: "Mr and Mrs Evans", group_type: "Individual", group_status: "Active", relationship: "PrimaryGroupMember", status: "Active" }]);
  assert.deepEqual(p.marketing_preferences, [{ service: "Sales", status: "OptedIn", referral: false }]);
  assert.deepEqual(p.custom_fields[0].values, [
    { name: "Date of birth", type: "Date", value: "[withheld: looks like contact data; available with include_contact_details]" },
    { name: "Source", type: "Text", value: "Rightmove" },
    { name: "Comments", type: "Text", value: "Sister on [phone redacted] can let us in" },
  ]);
  for (const k of ["primary_email", "primary_telephone", "contact_items", "addresses", "archived_addresses", "additional_information", "has_bank_accounts"]) assert.equal(p[k], undefined, `${k} must not be returned by default`);
  for (const leak of ["sam.evans@example.com", "07700 900789", "020 7946 0958", "Park Row", "BS1 5LY", "Old Lane", "1990-04-12", "07700 900999", "passport", fx.PASSPORT_URL, "HasBankAccounts", "bank"]) assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `${leak} leaked in the default output`);
  const full = await call(client, "get_person", { person_id: fx.PERSON_SAM, include_contact_details: true });
  const f = full.data.person;
  assert.deepEqual([f.note, f.primary_email, f.primary_telephone], ["Prefers email: sam.evans@example.com. Do not call before 10am.", "sam.evans@example.com", "07700 900789"]);
  assert.deepEqual(f.contact_items.map((c) => [c.type, c.value, c.notes, c.marketing_status]), [["Mobile", "07700 900789", undefined, undefined], ["Email", "sam.evans@example.com", undefined, undefined], ["Work", "020 7946 0958", "Reception, ask for Sam", "DoNotContact"]]);
  assert.deepEqual([f.addresses[0].text, f.addresses[0].type, f.archived_addresses[0].postcode], ["44 Park Row, Bristol, BS1 5LY", "Home", "BA1 1AA"]);
  assert.deepEqual([f.additional_information.proof_of_id_received, f.additional_information.right_to_rent_type, f.additional_information.documents[0].url, f.additional_information.housing_benefit.receives_benefits], [true, "Passport", fx.PASSPORT_URL, false]);
  assert.equal(f.custom_fields[0].values[0].value, "1990-04-12");
  assert.equal(f.has_bank_accounts, undefined, "bank-related fields are never returned");
  assert.ok(!full.text.includes("HasBankAccounts") && !full.text.toLowerCase().includes("bank"));
});

await check("find_people sends surname, postcode, email, telephone and mobile exactly as documented, needs at least one, and redacts results like get_person", async () => {
  const n = requests.length;
  const { data } = await call(client, "find_people", { surname: "Evans" });
  assert.deepEqual([apiSince(n)[0].path, apiSince(n)[0].query.surname, apiSince(n)[0].query.postcode, apiSince(n)[0].query.email, apiSince(n)[0].query.telephone, apiSince(n)[0].query.mobile, apiSince(n)[0].query.pageSize], ["/api/people/findbydetails", "Evans", undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual([data.count, data.total_matching, data.note, data.people.map((p) => [p.id, p.name, p.primary_email])], [2, 2, undefined, [[fx.PERSON_SAM, "Ms Sam Evans", undefined], [fx.PERSON_ALEX, "Mr Alex Evans", undefined]]]);
  const all = await call(client, "find_people", { surname: "Shah", postcode: "BS1 4NT", email: "priya.shah@example.com", telephone: "+44 7700 900123", mobile: "+44 7700 900123" });
  const q = requests.at(-1).query;
  assert.deepEqual([q.surname, q.postcode, q.email, q.telephone, q.mobile], ["Shah", "BS1 4NT", "priya.shah@example.com", "+44 7700 900123", "+44 7700 900123"]);
  assert.deepEqual(all.data.people.map((p) => [p.id, p.name, p.last_name]), [[fx.PERSON_PRIYA, "Dr Priya Shah ([email redacted])", "Shah ([email redacted])"]], "an email typed into a name field is redacted by default");
  assert.ok(!all.text.includes("priya.shah@"));
  const asStored = await call(client, "find_people", { email: "priya.shah@example.com", include_contact_details: true });
  assert.deepEqual([asStored.data.people[0].last_name, asStored.data.people[0].primary_telephone, asStored.data.people[0].addresses[0].postcode], ["Shah (priya.shah@example.com)", "+44 7700 900123", "BS1 4NT"]);
  const capped = await call(client, "find_people", { postcode: "BS1 5LY", max_results: 1 });
  assert.deepEqual([capped.data.count, capped.data.total_matching, capped.data.people.length], [1, 2, 1]);
  assert.match(capped.data.note, /2 people matched; only the first 1 are returned/);
  const before = requests.length;
  const none = await client.callTool({ name: "find_people", arguments: {} });
  assert.ok(none.isError);
  assert.match(none.content[0].text, /at least one of surname, postcode, email, telephone or mobile/);
  const blank = await client.callTool({ name: "find_people", arguments: { surname: "   ", email: "\t" } });
  assert.ok(blank.isError, "whitespace-only fields are not a search");
  assert.match(blank.content[0].text, /at least one of surname/);
  assert.equal(requests.length, before, "no request without a search field");
  const padded = await call(client, "find_people", { surname: "  Evans " });
  assert.deepEqual([requests.at(-1).query.surname, padded.data.count], ["Evans", 2], "surrounding whitespace is dropped");
  const paddedSearch = await call(client, "search_properties", { query: " High Street " });
  assert.deepEqual([requests.at(-1).query["dataContract.query"], paddedSearch.data.count], ["High Street", 1]);
  const blankSearch = await call(client, "search_properties", { query: "  " });
  assert.equal(requests.at(-1).query["dataContract.query"], undefined, "a blank search query is not sent");
  assert.ok(!blankSearch.res.isError);
  const nobody = await call(client, "find_people", { surname: "Nobody" });
  assert.deepEqual([nobody.data.count, nobody.data.people], [0, []]);
});

await check("get_person_roles reduces each role's address to the area by default and returns it in full on request; pages a bare array and ends at a short page (the endpoint has no total); a continuation from next_page covers every role once", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "get_person_roles", { person_id: fx.PERSON_SAM, max_results: 50 });
  assert.deepEqual([data.count, data.complete, data.next_page], [12, true, undefined]);
  assert.deepEqual(apiSince(n).map((r) => [r.path, r.query.pageSize, r.query.pageNumber]), [[`/api/people/${fx.PERSON_SAM}/roles`, "50", "1"]], "12 of 50 asked for is a short page, which ends the walk");
  const m = requests.length;
  const tens = await call(client, "get_person_roles", { person_id: fx.PERSON_SAM, max_results: 10 });
  assert.deepEqual([tens.data.count, tens.data.complete, tens.data.next_page], [10, false, 2], "a full page of 10 cannot be told from the end, so the walk points at page 2");
  const rest = await call(client, "get_person_roles", { person_id: fx.PERSON_SAM, max_results: 10, page: 2 });
  assert.deepEqual([rest.data.count, rest.data.complete, rest.data.roles.map((r) => r.role_id)], [2, true, [8218, 8219]]);
  assert.deepEqual(apiSince(m).map((r) => [r.query.pageSize, r.query.pageNumber]), [["10", "1"], ["10", "2"]]);
  // A role ties a named person to a property that, for a buyer or tenant, is their home: by default the
  // address is the area only (town, county, country), for every role type, since the API does not
  // enumerate the types. The full address comes with include_contact_details.
  assert.deepEqual(data.roles[0], { role_id: 8201, role_type: "Buying", property_id: fx.PROPERTY_HIGH_ST, property_status: "OfferAccepted", address: { id: 601, text: "Bristol", town: "Bristol", county: "Bristol", country: "United Kingdom" }, price: 435000, price_type: "OffersOver", offer_count: 1, offer_accepted_price: 425000, viewing_count: 2, primary_photo_url: "https://cdn.example.com/photos/55010.jpg" });
  assert.deepEqual([data.roles[1].role_type, data.roles[1].price, data.roles[1].price_type, data.roles[1].address], ["Renting", 950, "PerMonth", { id: 602, text: "Cardiff", town: "Cardiff", county: "Cardiff", country: "United Kingdom" }]);
  for (const leak of ["High Street", "BS1 4DJ", "Harbour View", "Bute Street", "CF10 5BZ", "Archive Street", "BS2 0AA", "51.4545", '"12"']) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "get_person_roles", { person_id: fx.PERSON_SAM, max_results: 50, include_contact_details: true });
  assert.deepEqual(full.data.roles[0].address, { id: 601, text: "12 High Street, Bristol, BS1 4DJ", number: "12", street: "High Street", town: "Bristol", county: "Bristol", country: "United Kingdom", postcode: "BS1 4DJ", latitude: 51.4545, longitude: -2.5879 });
  assert.equal(full.data.roles[1].address.text, "Flat 3 Harbour View, Bute Street, Cardiff, CF10 5BZ");
  assert.equal(requests.at(-1).path, `/api/people/${fx.PERSON_SAM}/roles`);
  const ids = [];
  for (let page = 1; ; ) {
    const r = await call(client, "get_person_roles", { person_id: fx.PERSON_SAM, max_results: 5, page });
    ids.push(...r.data.roles.map((x) => x.role_id));
    assert.ok(r.data.count <= 5);
    if (r.data.complete) break;
    page = r.data.next_page;
  }
  assert.deepEqual(ids, fx.personRoles[fx.PERSON_SAM].map((r) => r.RoleId), "every role once, in order");
  const empty = await call(client, "get_person_roles", { person_id: fx.PERSON_PRIYA });
  assert.deepEqual([empty.data.count, empty.data.complete, empty.data.roles], [0, true, []]);
});

await check("get_group returns members by name with contact details withheld, redacts notes and descriptions, and withholds contact-like custom fields; get_group_events passes activeRolesOnly, propertyId, roleId and includeDrafts through", async () => {
  const { data, text } = await call(client, "get_group", { group_id: fx.GROUP_EVANS });
  const g = data.group;
  assert.deepEqual([g.id, g.name, g.type, g.status, g.description, g.notes, g.separated], [fx.GROUP_EVANS, "Mr and Mrs Evans", "Individual", "Active", "First-time buyers, chain free. Sam: [email redacted]", "Ring Alex on [phone redacted] in the evenings", false]);
  assert.deepEqual(g.members.map((m) => [m.person_id, m.name, m.relationship, m.order, m.external_applicant_reference, m.primary_email, m.addresses]), [[fx.PERSON_SAM, "Ms Sam Evans", "PrimaryGroupMember", 1, "RM-88123", undefined, undefined], [fx.PERSON_ALEX, "Mr Alex Evans", "GroupMember", 2, undefined, undefined, undefined]]);
  assert.deepEqual(g.preferred_companies, [{ group_id: 3901, name: "Bristol Solicitors LLP", service_types: ["Conveyancing"], preferred_contact_id: 7901 }]);
  assert.deepEqual([g.additional_questions.arranged_mortgage, g.additional_questions.mortgage_provider, g.additional_questions.current_status, g.additional_questions.financial], [true, "Example Building Society (adviser [phone redacted])", "FirstTimeBuyer", "MortgageAgreedInPrinciple"]);
  assert.deepEqual(g.custom_fields[0].values, [{ name: "AML check", type: "Text", value: "Passed 2026-09-03" }, { name: "Contact email", type: "Text", value: "[withheld: looks like contact data; available with include_contact_details]" }]);
  for (const leak of ["sam.evans@example.com", "07700 900321", "07700 900789", "0117 496 0222", "Park Row"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "get_group", { group_id: fx.GROUP_EVANS, include_contact_details: true });
  assert.deepEqual([full.data.group.members[0].primary_email, full.data.group.members[0].addresses[0].postcode, full.data.group.members[0].contact_items.length, full.data.group.notes], ["sam.evans@example.com", "BS1 5LY", 2, "Ring Alex on 07700 900321 in the evenings"]);
  const n = requests.length;
  const events = await call(client, "get_group_events", { group_id: fx.GROUP_EVANS });
  assert.deepEqual([apiSince(n)[0].path, apiSince(n)[0].query.includeDrafts, events.data.events.map((e) => e.id)], [`/api/group/${fx.GROUP_EVANS}/events`, undefined, [10001, 10002, 10201]], "drafts hidden unless asked");
  const drafts = await call(client, "get_group_events", { group_id: fx.GROUP_EVANS, include_drafts: true, active_roles_only: true, property_id: fx.PROPERTY_HIGH_ST, role_id: fx.ROLE_HIGH_ST_SALE });
  const q = requests.at(-1).query;
  assert.deepEqual([q.includeDrafts, q.activeRolesOnly, q.propertyId, q.roleId], ["true", "true", String(fx.PROPERTY_HIGH_ST), String(fx.ROLE_HIGH_ST_SALE)]);
  assert.deepEqual(drafts.data.events.map((e) => e.id), [10001, 10002]);
  const onlyDrafts = await call(client, "get_group_events", { group_id: fx.GROUP_EVANS, include_drafts: true, types: ["Task"] });
  assert.deepEqual(onlyDrafts.data.events.map((e) => [e.id, e.status]), [[10202, "Draft"]]);
  const flat = await call(client, "get_group_events", { group_id: fx.GROUP_EVANS, property_id: fx.PROPERTY_FLAT });
  assert.deepEqual(flat.data.events.map((e) => [e.id, e.category, e.properties[0].property_id]), [[10201, "Lettings", fx.PROPERTY_FLAT]]);
});

await check("list_offers (after a 429 retry that waits for Retry-After) pages 1, 2 to TotalCount; get_offer redacts by default and returns everything on request", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_offers", { max_results: 100 });
  const tries = apiSince(n).filter((r) => r.path === "/api/Offer");
  assert.equal(tries.length, 3, "page 1 retried once after the 429, then page 2");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(tries.map((r) => r.query.pageNumber), ["1", "1", "2"]);
  assert.deepEqual([data.count, data.total, data.complete], [12, 12, true]);
  const o = data.offers[0];
  assert.deepEqual([o.id, o.name, o.value, o.valid_for, o.status, o.type, o.property.property_id, o.property.address.text, o.marketing_role_id, o.role_type, o.marketed_price.value, o.marketed_price.qualifier], [fx.OFFER_MAIN, "Offer of £425,000", 425000, 7, "Accepted", "Offer", fx.PROPERTY_HIGH_ST, "12 High Street, Bristol, BS1 4DJ", fx.ROLE_HIGH_ST_SALE, "Sales", 435000, "OffersOver"]);
  assert.deepEqual([o.applicant_group.name, o.applicant_group.grade, o.applicant_group.primary_member.name, o.applicant_group.primary_member.primary_email, o.vendor_group.name, o.vendor_group.primary_member.name], ["Mr and Mrs Evans", "Hot", "Ms Sam Evans", undefined, "Mr Patel", "Mr Raj Patel"]);
  assert.equal(o.on_behalf_of, "Mr and Mrs Evans ([email redacted])");
  assert.deepEqual([o.response.type, o.response.notes[0].note, o.response.notes[0].negotiator, o.response.notes[0].negotiator_email], ["Accepted", "Accepted subject to survey", "Jo Bloggs", undefined]);
  assert.deepEqual([o.vendor_communication.name, o.vendor_communication.notes], ["Vendor told by phone", ["Raj happy, call him back on [phone redacted] about the survey date"]]);
  assert.equal(o.notes[0].note, "Proof of funds received; solicitor is Bristol Solicitors, ring [phone redacted]");
  assert.deepEqual(o.documents.map((d) => [d.file_name, d.type, d.url]), [["proof-of-funds-evans.pdf", "ProofOfFunds", fx.PROOF_OF_FUNDS_URL]]);
  assert.deepEqual(data.offers[1].applicant_group.name, "Lee Chen ([email redacted])");
  const text = JSON.stringify(data);
  for (const leak of ["sam.evans@example.com", "raj.patel@example.com", "jo.bloggs@example.org", "0117 496 0333", "0117 496 0111", "lee.chen@", "0117 496 0000"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const single = await call(client, "get_offer", { offer_id: fx.OFFER_MAIN, include_contact_details: true });
  assert.equal(requests.at(-1).path, `/api/Offer/${fx.OFFER_MAIN}`);
  const s = single.data.offer;
  assert.deepEqual([s.on_behalf_of, s.applicant_group.primary_member.primary_email, s.response.notes[0].negotiator_email, s.vendor_communication.notes[0], s.negotiators[0].primary_telephone], ["Mr and Mrs Evans (sam.evans@example.com)", "sam.evans@example.com", "jo.bloggs@example.org", "Raj happy, call him back on (0117) 496 0111 about the survey date", "0117 496 0000"]);
  const paged = await call(client, "list_offers", { max_results: 10, page: 2 });
  assert.deepEqual([paged.data.count, paged.data.complete, paged.data.offers.map((x) => x.id)], [2, true, [9011, 9012]]);
});

await check("bad IDs are rejected before any API call; an unknown ID gives a clear 404; the documented 200-with-null is reported as not found", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_property", { property_id: 0 }], // "Pass 0 to be returned an empty data contract"
    ["get_property", { property_id: -5 }],
    ["get_property", { property_id: 1.5 }],
    ["get_property", { property_id: "501" }],
    ["get_property", { property_id: "../people/7001" }],
    ["get_property_events", { property_id: 9007199254740993 }],
    ["get_person", { person_id: "abc" }],
    ["get_person_roles", { person_id: 0 }],
    ["get_group", { group_id: "" }],
    ["get_group_events", { group_id: fx.GROUP_EVANS, role_id: 0 }],
    ["get_offer", { offer_id: null }],
    ["search_properties", { role_type: "has space" }],
    ["get_property_events", { property_id: fx.PROPERTY_HIGH_ST, types: ["Viewing/../x"] }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_property", { property_id: 1 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/api\/property\/1\. Check the ID\./);
  const missingOffer = await call(client, "get_offer", { offer_id: 1 });
  assert.match(missingOffer.text, /^Not found: \/api\/Offer\/1\. Check the ID\./);
  const missingEvents = await call(client, "get_group_events", { group_id: 1 });
  assert.match(missingEvents.text, /^Not found: \/api\/group\/1\/events\. Check the ID\./);
  const nullBody = await call(client, "get_person", { person_id: fx.NULL_ID });
  assert.ok(nullBody.res.isError, "a 200 with a null body must not be reported as a person");
  assert.match(nullBody.text, /^Not found: \/api\/people\/404404\. Dezrez answered with null, which the API documents as "the person does not exist"\. Check the ID\./);
  // The events endpoints document a null answer as "null if the property/group does not exist", so it
  // is not found, not an empty timeline; GET /api/Offer documents "null if none exist", an empty list.
  const nullEvents = await call(client, "get_property_events", { property_id: fx.NULL_ID });
  assert.ok(nullEvents.res.isError, "a null events page must not be reported as an empty timeline");
  assert.match(nullEvents.text, /^Not found: \/api\/property\/404404\/events\. Dezrez answered with null, which the API documents as "the property does not exist"\. Check the ID\./);
  const nullGroupEvents = await call(client, "get_group_events", { group_id: fx.NULL_ID });
  assert.ok(nullGroupEvents.res.isError);
  assert.match(nullGroupEvents.text, /^Not found: \/api\/group\/404404\/events\. Dezrez answered with null, which the API documents as "the group does not exist"\. Check the ID\./);
  arm({ method: "GET", path: "/api/Offer", status: 200, body: null });
  const nullOffers = await call(client, "list_offers");
  assert.deepEqual([nullOffers.data.count, nullOffers.data.complete, nullOffers.data.offers], [0, true, []], "a null offer list reads as an empty list");
  disarm();
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message; a Retry-After above the cap gives up at once; HTTP-date and fractional Retry-After are honoured", async () => {
  arm429({ persistent: true });
  let n = requests.length;
  const stuck = await call(client, "list_offers");
  assert.ok(stuck.res.isError);
  assert.equal(apiSince(n).filter((r) => r.path === "/api/Offer").length, 3, "exactly three attempts");
  assert.match(stuck.text, /Dezrez rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  arm429({ retryAfter: "600" });
  n = requests.length;
  const long = await call(client, "list_offers");
  assert.ok(long.res.isError);
  assert.equal(apiSince(n).filter((r) => r.path === "/api/Offer").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/api\/Offer \(HTTP 429\)/);
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  n = requests.length;
  const dated = await call(client, "list_offers", { max_results: 5 });
  assert.ok(!dated.res.isError, dated.text);
  let tries = apiSince(n).filter((r) => r.path === "/api/Offer");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  const fractional = await call(client, "list_offers", { max_results: 5 });
  assert.ok(!fractional.res.isError);
  tries = apiSince(n).filter((r) => r.path === "/api/Offer");
  assert.equal(tries.length, 2);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried (even with a non-JSON gateway body); a GET failing three times with 503 reports advice without the HTML; a 200 whose body is not JSON is an error", async () => {
  arm({ method: "GET", path: `/api/group/${fx.GROUP_PATEL}`, status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, data } = await call(client, "get_group", { group_id: fx.GROUP_PATEL });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.group.name, "Mr Patel");
  assert.equal(apiSince(n).length, 2);
  arm({ method: "GET", path: `/api/group/${fx.GROUP_PATEL}`, status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "get_group", { group_id: fx.GROUP_PATEL });
  assert.ok(down.res.isError);
  assert.equal(apiSince(n).length, 3);
  assert.match(down.text, /Dezrez returned 503 for GET \/api\/group\/3002 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"), "gateway HTML should not be passed on");
  arm({ method: "GET", path: "/api/Offer", status: 200 }); // the mock answers with an HTML page
  const html = await call(client, "list_offers");
  assert.ok(html.res.isError, `a non-JSON 200 must not be reported as success: ${html.text}`);
  assert.match(html.text, /returned 200 for GET \/api\/Offer but the body was not JSON \(text\/html, \d+ bytes\)\. Check DEZREZ_BASE_URL/);
  assert.ok(!html.text.includes("<html>"), "the body is described, not quoted");
  // A non-JSON body is never quoted, so whatever a proxy or login page carries stays out of the tool result.
  arm({ method: "GET", path: "/api/Offer", status: 200, text: "<html>proxy: mail admin@corp.example, call 07700 900111; auth was Bearer dz-issued-token-1</html>" });
  const page = await call(client, "list_offers");
  assert.ok(page.res.isError);
  assert.match(page.text, /body was not JSON \(text\/plain, \d+ bytes\)/);
  for (const leak of ["admin@corp.example", "07700 900111", "auth was", "dz-issued-token"]) assert.ok(!page.text.includes(leak), `${leak} leaked from a non-JSON 200 body`);
  disarm();
  const ok = await call(client, "list_offers", { max_results: 1 });
  assert.ok(!ok.res.isError);
  // Dezrez's error bodies are undocumented free text; whatever they carry is redacted like any other text.
  arm({ method: "GET", path: "/api/Offer", status: 400, body: { Message: "Offer filter rejected for sam.evans@example.com, call 07700 900789" } });
  const refused = await call(client, "list_offers", { max_results: 1 });
  assert.ok(refused.res.isError);
  assert.match(refused.text, /Dezrez refused GET \/api\/Offer \(400\)\. Offer filter rejected for \[email redacted\], call \[phone redacted\]/);
  // A non-JSON error body is not passed on at all.
  arm({ method: "GET", path: "/api/Offer", status: 400, text: "Bad request from sam.evans@example.com with Bearer dz-issued-token-1" });
  const refusedText = await call(client, "list_offers", { max_results: 1 });
  assert.ok(refusedText.res.isError);
  assert.match(refusedText.text, /^Dezrez refused GET \/api\/Offer \(400\)\.$/);
  disarm();
});

await check("no secret ever reaches a tool result: an error body that echoes the Authorization header (Bearer token or Basic client:secret) is scrubbed, and a token under another key is described, not quoted", async () => {
  // An API error whose JSON message echoes the bearer token of the request.
  arm({ method: "GET", path: `/api/property/${fx.PROPERTY_FLAT}`, status: 400, body: (req) => ({ Message: `Bad request with ${req.headers.authorization}` }) });
  const echoed = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /Dezrez refused GET \/api\/property\/502 \(400\)\. Bad request with Bearer \[redacted\]$/);
  assert.ok(!/dz-issued-token-\d+/.test(echoed.text), "the issued token leaked");
  // A 401 whose message echoes the token, then the retry's token as well.
  arm({ method: "GET", path: `/api/property/${fx.PROPERTY_FLAT}`, status: 401, times: 2, body: (req) => ({ Message: `Denied: ${req.headers.authorization} expired` }) });
  const denied = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(denied.res.isError);
  assert.match(denied.text, /rejected a token obtained with the client credentials \(401\).*Denied: Bearer \[redacted\] expired$/);
  assert.ok(!/dz-issued-token-\d+/.test(denied.text), "the issued token leaked");
  // The token endpoint rejecting the client with a message that echoes the Basic header.
  revokeTokens();
  arm({ method: "POST", path: TOKEN_PATH, status: 401, body: (req) => ({ error: "invalid_client", error_description: `bad auth header ${req.headers.authorization}` }) });
  const basic = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(basic.res.isError);
  assert.match(basic.text, /token endpoint rejected the client credentials \(401\).*invalid_client bad auth header Basic \[redacted\]$/);
  for (const leak of [CLIENT_BASIC.slice(6), CLIENT_SECRET]) assert.ok(!basic.text.includes(leak), "the client credential leaked");
  // A 200 from the token endpoint with the token under another key: the body is described by content
  // type, size and JSON keys, never quoted.
  arm({ method: "POST", path: TOKEN_PATH, status: 200, body: { AccessToken: "eyJ-ISSUEDTOKEN-ZZ-0123456789abcdef0123456789abcdef", token_type: "bearer" } });
  const otherKey = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(otherKey.res.isError);
  assert.match(otherKey.text, /token endpoint answered 200 but the body had no access_token \(application\/json, \d+ bytes, JSON with keys \[AccessToken, token_type\]\)\. Check DEZREZ_TOKEN_URL/);
  assert.ok(!otherKey.text.includes("ISSUEDTOKEN"), "the token leaked");
  arm({ method: "POST", path: TOKEN_PATH, status: 200, text: "<html>token: eyJ-ISSUEDTOKEN-ZZ-0123456789abcdef; mail admin@corp.example</html>" });
  const htmlToken = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(htmlToken.res.isError);
  assert.match(htmlToken.text, /body had no access_token \(not JSON: text\/plain, \d+ bytes\)/);
  for (const leak of ["ISSUEDTOKEN", "admin@corp.example", "<html>"]) assert.ok(!htmlToken.text.includes(leak), `${leak} leaked`);
  // A non-JSON 4xx from the token endpoint is not quoted either.
  arm({ method: "POST", path: TOKEN_PATH, status: 400, text: `Bad client ${CLIENT_SECRET}` });
  const textReject = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(textReject.res.isError);
  assert.match(textReject.text, /token endpoint rejected the client credentials \(400\).*DEZREZ_TOKEN_URL \(http:\/\/127\.0\.0\.1:\d+\/Dezrez\.Core\.Api\/oauth\/token\/\)\.$/);
  assert.ok(!textReject.text.includes(CLIENT_SECRET));
  disarm();
  const back = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(!back.res.isError, back.text);
});

await check("a token the API no longer accepts is fetched again once and the request retried; a 502 from the token endpoint is not retried", async () => {
  revokeTokens();
  const n = requests.length;
  const issued = tokensIssued();
  const { res, data } = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.property.id, fx.PROPERTY_FLAT);
  assert.deepEqual(since(n).map((r) => r.path), [`/api/property/${fx.PROPERTY_FLAT}`, TOKEN_PATH, `/api/property/${fx.PROPERTY_FLAT}`], "401 with the cached token, one new token, one retry");
  assert.equal(tokensIssued(), issued + 1);
  revokeTokens();
  arm({ method: "POST", path: TOKEN_PATH, status: 502 });
  const m = requests.length;
  const failed = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(failed.res.isError);
  assert.equal(since(m).filter((r) => r.path === TOKEN_PATH).length, 1, "the token POST is never retried after a gateway error");
  assert.match(failed.text, /Dezrez's token endpoint returned 502\. The token request was not retried/);
  disarm();
  const back = await call(client, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(!back.res.isError, back.text);
  // A token response without expires_in (documented only for the code and refresh exchanges) is still cached.
  revokeTokens();
  setExpiresIn(undefined);
  const k = requests.length;
  const noExpiry = tokensIssued();
  for (const id of [fx.PROPERTY_FLAT, fx.PROPERTY_HIGH_ST]) assert.ok(!(await call(client, "get_property", { property_id: id })).res.isError);
  assert.equal(since(k).filter((r) => r.path === TOKEN_PATH).length, 1, "one token request for two calls when expires_in is absent");
  assert.equal(tokensIssued(), noExpiry + 1);
  // A short-lived token (expires_in at or under the one-minute refresh margin) is still reused: the
  // margin is half the lifetime for tokens shorter than two minutes, not a flat minute.
  revokeTokens();
  setExpiresIn(30);
  const s = requests.length;
  const shortLived = tokensIssued();
  for (const id of [fx.PROPERTY_FLAT, fx.PROPERTY_HIGH_ST, fx.PROPERTY_WITHDRAWN]) assert.ok(!(await call(client, "get_property", { property_id: id })).res.isError);
  assert.equal(since(s).filter((r) => r.path === TOKEN_PATH).length, 1, "one token request for three calls with expires_in 30");
  assert.equal(tokensIssued(), shortLived + 1);
  setExpiresIn(7200);
});

await check("every request carried the documented auth (Bearer token and Rezi-Api-Version: 1.0; Basic client:secret at the token endpoint), hit a documented method+path, and never touched the bank endpoints", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 60);
  const bearers = new Set();
  for (const r of requests) {
    if (r.path === TOKEN_PATH) {
      assert.deepEqual([r.method, r.auth, r.contentType], ["POST", CLIENT_BASIC, "application/json"]);
      assert.deepEqual(Object.keys(r.body).sort(), ["grant_type", "scope"]);
      continue;
    }
    assert.match(r.auth ?? "", /^Bearer dz-issued-token-\d+$/, `${r.method} ${r.path} auth`);
    bearers.add(r.auth);
    assert.equal(r.version, API_VERSION, `${r.method} ${r.path} Rezi-Api-Version`);
    assert.equal(r.query.agencyId, AGENCY_ID, `${r.method} ${r.path} agencyId`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    assert.ok(!/\/(accounts|bankReferences)$/i.test(r.path), `bank endpoint called: ${r.path}`);
  }
  assert.equal(bearers.size, tokensIssued() - issuedBeforeMcp, "every token issued to the MCP server was used (the mock issued one more to the raw request in section 2; the armed token-endpoint failures never reached the issuer)");
  const used = new Set(requests.filter((r) => r.path !== TOKEN_PATH).map((r) => `${r.method} ${r.path.replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    ["GET /api/Offer", "GET /api/Offer/{id}", "GET /api/group/{id}", "GET /api/group/{id}/events", "GET /api/people/findbydetails", "GET /api/people/{id}", "GET /api/people/{id}/roles", "GET /api/property/{id}", "GET /api/property/{id}/events", "GET /api/role/suggest"],
  );
});
await client.close();

await check("with DEZREZ_ACCESS_TOKEN the token endpoint is never called and the token is sent as given (a pasted \"Bearer \" prefix is dropped); a wrong token gives an actionable 401, a refused agency an actionable 403, and an error that echoes the token is scrubbed", async () => {
  const n = requests.length;
  const direct = await connect({ mode: "token" });
  const { data } = await call(direct, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.equal(data.property.id, fx.PROPERTY_FLAT);
  assert.deepEqual(since(n).map((r) => [r.path, r.auth, r.query.agencyId]), [[`/api/property/${fx.PROPERTY_FLAT}`, `Bearer ${ACCESS_TOKEN}`, undefined]], "no token request, no agencyId unless configured");
  arm({ method: "GET", path: `/api/property/${fx.PROPERTY_FLAT}`, status: 400, body: (req) => ({ Message: `token ${req.headers.authorization} expired` }) });
  const echoed = await call(direct, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /\(400\)\. token Bearer \[redacted\] expired$/);
  assert.ok(!echoed.text.includes(ACCESS_TOKEN), "the configured token leaked");
  disarm();
  await direct.close();
  const prefixed = await connect({ mode: "token", env: { DEZREZ_ACCESS_TOKEN: `Bearer ${ACCESS_TOKEN}` } });
  const viaPrefix = await call(prefixed, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(!viaPrefix.res.isError, viaPrefix.text);
  assert.equal(requests.at(-1).auth, `Bearer ${ACCESS_TOKEN}`, "a token pasted with its Bearer prefix is sent once, not as Bearer Bearer");
  await prefixed.close();
  const withAgency = await connect({ mode: "token", env: { DEZREZ_AGENCY_ID: AGENCY_ID } });
  await call(withAgency, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.equal(requests.at(-1).query.agencyId, AGENCY_ID, "agencyId is passed on when set with a user token");
  await withAgency.close();
  const bad = await connect({ mode: "token", env: { DEZREZ_ACCESS_TOKEN: "dz-wrong-token" } });
  const { res, text } = await call(bad, "list_offers");
  assert.ok(res.isError);
  assert.match(text, /Dezrez rejected the access token \(401\)\. Check DEZREZ_ACCESS_TOKEN/);
  await bad.close();
  const otherAgency = await connect({ mode: "token", env: { DEZREZ_AGENCY_ID: "5" } });
  const forbidden = await call(otherAgency, "get_property", { property_id: fx.PROPERTY_FLAT });
  assert.ok(forbidden.res.isError);
  assert.match(forbidden.text, /Dezrez refused GET \/api\/property\/502 \(403\)\. The token may lack a scope this call needs .*property_read.*agency 5.*Not allowed for that agency/);
  await otherAgency.close();
});

await check("wrong client credentials give an actionable message from the token endpoint; the client flow refuses to start without DEZREZ_AGENCY_ID, with credentials inside a URL, or without credentials at all; an unreachable endpoint is named without its query string", async () => {
  const wrong = await connect({ env: { DEZREZ_CLIENT_SECRET: "nope" } });
  const { res, text } = await call(wrong, "list_offers");
  assert.ok(res.isError);
  assert.match(text, /token endpoint rejected the client credentials \(401\)\. Check DEZREZ_CLIENT_ID and DEZREZ_CLIENT_SECRET.*Client authentication failed/);
  assert.equal(requests.at(-1).path, TOKEN_PATH, "no API call was attempted");
  await wrong.close();
  await assert.rejects(connect({ env: { DEZREZ_AGENCY_ID: "" } }), "the server must exit when the client flow has no agency ID");
  await assert.rejects(connect({ mode: "none" }), "the server must exit without credentials");
  // A URL with userinfo is refused at start-up (fetch would refuse it later and quote the whole URL),
  // and the refusal itself does not repeat the credentials.
  const baseEnv = { ...process.env, DEZREZ_CLIENT_ID: CLIENT_ID, DEZREZ_CLIENT_SECRET: CLIENT_SECRET, DEZREZ_AGENCY_ID: AGENCY_ID, DEZREZ_TOKEN_URL: tokenUrl };
  for (const [variable, env] of [
    ["DEZREZ_BASE_URL", { ...baseEnv, DEZREZ_BASE_URL: `http://${["ZZCLIENTIDZZ", "ZZSECRETZZ"].join(":")}@127.0.0.1:1/` }],
    ["DEZREZ_TOKEN_URL", { ...baseEnv, DEZREZ_BASE_URL: base, DEZREZ_TOKEN_URL: `http://${["ZZCLIENTIDZZ", "ZZSECRETZZ"].join(":")}@127.0.0.1:1/tok` }],
  ]) {
    const run = spawnSync(process.execPath, [`${root}dist/index.js`], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 1, `${variable} with userinfo must stop the server`);
    assert.match(run.stderr, new RegExp(`${variable} must not contain a username or password`));
    assert.ok(!run.stderr.includes("ZZSECRETZZ") && !run.stderr.includes("ZZCLIENTIDZZ"), `the credentials from ${variable} were repeated on stderr`);
  }
  // Nothing listens on port 1: the message names the endpoint by origin and path, without the query string.
  const unreachable = await connect({ mode: "token", env: { DEZREZ_BASE_URL: "http://127.0.0.1:1", DEZREZ_AGENCY_ID: AGENCY_ID } });
  const down = await call(unreachable, "search_properties", { query: "secret street" });
  assert.ok(down.res.isError);
  assert.match(down.text, /^Could not reach Dezrez at http:\/\/127\.0\.0\.1:1\/api\/role\/suggest: /);
  assert.ok(!down.text.includes("secret street") && !down.text.includes("agencyId"), "the query string leaked into the message");
  await unreachable.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} requests made against the mock.`);
