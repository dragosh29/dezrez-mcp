#!/usr/bin/env node
// Dezrez Rezi MCP server: lets Claude, ChatGPT and other MCP clients read an estate agency's Rezi CRM.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DezrezClient, DezrezError, PAGE_SIZE } from "./client.js";
import * as fmt from "./format.js";

const env = (name: string) => process.env[name]?.trim() || undefined;
const accessToken = env("DEZREZ_ACCESS_TOKEN");
const clientId = env("DEZREZ_CLIENT_ID");
const clientSecret = env("DEZREZ_CLIENT_SECRET");
const agencyId = env("DEZREZ_AGENCY_ID");
if (!accessToken && !(clientId && clientSecret)) {
  console.error("No credentials. Set DEZREZ_ACCESS_TOKEN (an OAuth2 access token for the Rezi API), or DEZREZ_CLIENT_ID and DEZREZ_CLIENT_SECRET for the client-credentials flow (with DEZREZ_AGENCY_ID).");
  process.exit(1);
}
if (!accessToken && !agencyId) {
  // AuthorisationBasics.md: with a userless flow "you will need tell us which agencyId you are
  // intending to call, by using the AgencyId parameter".
  console.error("DEZREZ_AGENCY_ID is required with the client-credentials flow: Dezrez documents that every request made with a client token must carry the agencyId parameter.");
  process.exit(1);
}
if (agencyId && !/^\d{1,18}$/.test(agencyId)) {
  console.error(`DEZREZ_AGENCY_ID must be a numeric agency ID, got ${JSON.stringify(agencyId)}.`);
  process.exit(1);
}
// This prototype has no write tools (see README), so DEZREZ_ALLOW_WRITES changes nothing; it is read
// only so a value set by habit (whatever the value) is reported rather than silently ignored.
const allowWritesSet = env("DEZREZ_ALLOW_WRITES") !== undefined;
let api: DezrezClient;
try {
  api = new DezrezClient({ accessToken, clientId, clientSecret, scope: env("DEZREZ_SCOPE"), agencyId, baseUrl: env("DEZREZ_BASE_URL"), tokenUrl: env("DEZREZ_TOKEN_URL") });
} catch (err) {
  console.error(err instanceof DezrezError ? err.message : String(err));
  process.exit(1);
}

const server = new McpServer(
  { name: "dezrez", version: "0.1.0" },
  {
    instructions: [
      "Read-only tools for an estate agency's Dezrez Rezi CRM: properties and their marketing roles, property and group events (viewings, offers, notes, appointments), people, groups (households and companies) and offers.",
      "Everything is identified by a numeric ID. A property carries one or more marketing roles (a sale or a letting); people belong to groups; events hang off properties, groups and roles.",
      "Typical flows: 'what happened at 12 High Street?' -> search_properties, then get_property_events. 'Who is Sam Evans?' -> find_people by surname, then get_person and get_person_roles. 'Which offers are open?' -> list_offers, then get_offer.",
      "Names are returned by default. Email addresses, phone numbers, postal addresses of people, dates of birth, identity and right-to-rent details are only returned when a tool is called with include_contact_details=true. Bank details are never returned.",
      "Event type, event category, role type and role status filters are passed to the API as system names; the swagger does not list the possible values (documented examples: role types Sales and Letting; role statuses OfferAccepted and Exchanged).",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// Every ID on the endpoints this server calls is an int64 path parameter (elsewhere in the spec a
// few IDs are strings), and each get-by-id documents "Pass 0 to be returned an empty data
// contract", so 0 is refused locally along with anything that is not a positive whole number.
const id = (what: string) => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe(`${what} ID (a positive whole number)`);
// Query parameters typed as string in the spec (type names, statuses): one path-safe token each.
const systemName = (what: string) => z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, `${what} must be a system name: letters, digits, _ and -, up to 64 characters`);
// `from`/`to` are typed as date-time. An ISO 8601 date-time is sent as given; a date alone is
// completed to a date-time (see dateTimeParam) so what is sent matches the documented format.
// Date.parse alone would accept 2026-02-30 (V8 rolls it over to 2 March), so the calendar date is
// checked by formatting it back.
const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/, "Use an ISO 8601 date or date-time, e.g. 2026-09-01 or 2026-09-01T09:00:00Z")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Not a valid date/time")
  .refine((s) => new Date(s.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === s.slice(0, 10), "Not a real calendar date");
const dateTimeParam = (s: string | undefined, bound: "from" | "to") => (s === undefined || s.includes("T") ? s : `${s}T${bound === "from" ? "00:00:00" : "23:59:59"}Z`);
// Free-text search fields: surrounding whitespace is dropped and a blank value counts as not given.
const searchText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => s || undefined)
    .describe(what);
const paging = {
  max_results: z.number().int().min(1).max(500).default(25).describe("Most records to return in this call; whole API pages only, so fewer may come back with a next_page to continue from"),
  page: z.number().int().min(1).default(1).describe("API page number to start from (1-based, as this server assumes; use next_page from a previous call)"),
};
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}. Off by default.`);

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof DezrezError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const pageNote = (r: { complete: boolean; next_page?: number; page_size: number }, maxResults: number) =>
  r.complete ? undefined : `More results exist; call again with page ${r.next_page} and the same max_results (${maxResults}) to continue.`;

const eventFilters = {
  from: isoDateTime.optional().describe("Only events from this date/time (API parameter `from`, ISO 8601). A date alone means the start of that day, UTC (2026-09-01 is sent as 2026-09-01T00:00:00Z)."),
  to: isoDateTime.optional().describe("Only events up to this date/time (API parameter `to`, ISO 8601). A date alone means the end of that day, UTC (2026-09-30 is sent as 2026-09-30T23:59:59Z)."),
  types: z.array(systemName("Event type")).max(20).optional().describe("Only these event types, as Rezi system names (API parameter `type`, repeated). The swagger does not list the values."),
  excluded_types: z.array(systemName("Event type")).max(20).optional().describe("Every type except these (API parameter `excludedTypes`, repeated)"),
  event_category_type: systemName("Event category").optional().describe("Only this event category (API parameter `eventCategoryType`)"),
  branch_id: id("Branch").optional().describe("Only events in this branch (API parameter `branchId`)"),
  show_cancelled: z.boolean().optional().describe("Include cancelled events (API parameter `showCancelled`; the API's default is false)"),
  include_only_original_notes: z.boolean().optional().describe("Skip note editions and return only original notes (API parameter `includeOnlyOriginalNotes`; the API's default is true)"),
};

const eventQuery = (a: { from?: string; to?: string; types?: string[]; excluded_types?: string[]; event_category_type?: string; branch_id?: number; show_cancelled?: boolean; include_only_original_notes?: boolean }) => ({
  from: dateTimeParam(a.from, "from"),
  to: dateTimeParam(a.to, "to"),
  type: a.types,
  excludedTypes: a.excluded_types,
  eventCategoryType: a.event_category_type,
  branchId: a.branch_id,
  showCancelled: a.show_cancelled,
  includeOnlyOriginalNotes: a.include_only_original_notes,
});

server.registerTool(
  "get_property",
  {
    title: "Get property",
    description:
      "One property by ID: address, status, its marketing roles (sale or letting, with status), certificates (EPC and the like), special arrangements, keys (holder and check-out status; key codes are never returned), the number of alarms (codes never returned), custom fields and the default picture link. Note that prices and bedrooms live on events and role searches, not on the property record.",
    inputSchema: {
      property_id: id("Property"),
      include_contact_details: includeContact("email addresses and phone numbers typed into names, notes and special arrangements, and custom field values that look like contact data"),
    },
    annotations: READ,
  },
  safe(async ({ property_id, include_contact_details }) => {
    const p = await api.getRecord(`/api/property/${property_id}`, "the property");
    return { property: fmt.property(p, include_contact_details) };
  }),
);

server.registerTool(
  "search_properties",
  {
    title: "Search properties",
    description:
      "Search the agency's property marketing roles (a property being sold or let) by free text such as an address fragment or postcode, optionally only those on the market, of one role type (documented examples: Sales, Letting) or in one role status (documented examples: OfferAccepted, Exchanged). Each result carries the property ID, address, the role with its status, prices, a summary line and the owning group. Uses GET /api/role/suggest; the role type and status values are system names the swagger does not enumerate.",
    inputSchema: {
      query: searchText(200, "Free-text search (API parameter `dataContract.query`)"),
      is_on_market: z.boolean().optional().describe("Only roles currently on the market (`dataContract.isOnMarket`)"),
      role_type: systemName("Role type").optional().describe("Role type system name, e.g. Sales or Letting (`dataContract.roleType`)"),
      role_status: systemName("Role status").optional().describe("Role status system name, e.g. OfferAccepted (`dataContract.roleStatus`)"),
      suggest_type: z.enum(["AgencyOnly", "ViewableOnly"]).optional().describe("The two values the spec documents for `dataContract.suggestType`"),
      ...paging,
      include_contact_details: includeContact("the owning group's members' email addresses, phone numbers and postal addresses, and stop redacting emails and phone numbers from names and summary text"),
    },
    annotations: READ,
  },
  safe(async ({ query, is_on_market, role_type, role_status, suggest_type, max_results, page, include_contact_details }) => {
    const r = await api.list("/api/role/suggest", {
      maxItems: max_results,
      maxPages: 20,
      page,
      prefix: "dataContract.",
      query: { "dataContract.query": query, "dataContract.isOnMarket": is_on_market, "dataContract.roleType": role_type, "dataContract.roleStatus": role_status, "dataContract.suggestType": suggest_type },
    });
    return { count: r.items.length, total: r.total, page, page_size: r.page_size, complete: r.complete, next_page: r.next_page, note: pageNote(r, max_results), results: r.items.map((x) => fmt.roleSuggestResult(x, include_contact_details)) };
  }),
);

server.registerTool(
  "get_property_events",
  {
    title: "Property events",
    description:
      "The timeline of one property: viewings, offers, notes, appointments and other events, newest to oldest as the API returns them, with dates, status, prices, the groups and people attending (names only by default), notes and negotiators. Filter by date range, event type(s), category, branch, and whether cancelled events are included. Uses GET /api/property/{id}/events.",
    inputSchema: {
      property_id: id("Property"),
      ...eventFilters,
      ...paging,
      include_contact_details: includeContact("attendees' and negotiators' email addresses and phone numbers, and stop redacting emails and phone numbers from notes, names and descriptions"),
    },
    annotations: READ,
  },
  safe(async ({ property_id, max_results, page, include_contact_details, ...filters }) => {
    const r = await api.list(`/api/property/${property_id}/events`, { maxItems: max_results, maxPages: 20, page, query: eventQuery(filters), nullMeansMissing: "the property" });
    return { property_id, count: r.items.length, total: r.total, page, page_size: r.page_size, complete: r.complete, next_page: r.next_page, note: pageNote(r, max_results), events: r.items.map((e) => fmt.eventSummary(e, include_contact_details)) };
  }),
);

server.registerTool(
  "get_person",
  {
    title: "Get person",
    description:
      "One person by ID: name, gender, group memberships (the households or companies they belong to), marketing preferences, custom fields and dates. Contact items (emails, phones), postal addresses, the free-text note and the identity, right-to-rent and NRL details are only returned with include_contact_details. Bank details are never returned. Uses GET /api/people/{id}.",
    inputSchema: {
      person_id: id("Person"),
      include_contact_details: includeContact("email addresses, phone numbers, postal addresses, the note, and identity/right-to-rent/NRL details"),
    },
    annotations: READ,
  },
  safe(async ({ person_id, include_contact_details }) => {
    const p = await api.getRecord(`/api/people/${person_id}`, "the person");
    return { person: fmt.person(p, include_contact_details) };
  }),
);

server.registerTool(
  "find_people",
  {
    title: "Find people",
    description:
      "Search people by surname, postcode, email address, telephone and/or mobile number, exactly the fields GET /api/people/findbydetails accepts; at least one is required. Results are returned as get_person returns them: names by default, contact details only with include_contact_details. Note that searching by an email or number and getting a match confirms that detail exists on the account even when it is not returned.",
    inputSchema: {
      surname: searchText(100, "Surname (API parameter `surname`)"),
      postcode: searchText(20, "Postcode (API parameter `postcode`)"),
      email: searchText(200, "Email address (API parameter `email`)"),
      telephone: searchText(30, "Main telephone number (API parameter `telephone`)"),
      mobile: searchText(30, "Mobile number (API parameter `mobile`)"),
      max_results: z.number().int().min(1).max(200).default(25).describe("Most people to return; the API has no paging on this endpoint, so the rest are dropped and reported"),
      include_contact_details: includeContact("email addresses, phone numbers, postal addresses, notes and identity details"),
    },
    annotations: READ,
  },
  safe(async ({ surname, postcode, email, telephone, mobile, max_results, include_contact_details }) => {
    if (!surname && !postcode && !email && !telephone && !mobile) throw new DezrezError("Give at least one of surname, postcode, email, telephone or mobile (a blank value does not count).");
    const res = await api.get<unknown>("/api/people/findbydetails", { surname, postcode, email, telephone, mobile });
    const all = Array.isArray(res) ? res : [];
    return {
      count: Math.min(all.length, max_results),
      total_matching: all.length,
      note: all.length > max_results ? `${all.length} people matched; only the first ${max_results} are returned. Narrow the search or raise max_results.` : undefined,
      people: all.slice(0, max_results).map((p) => fmt.person(p, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_person_roles",
  {
    title: "Person's roles",
    description:
      "The properties a person is selling, letting, buying or renting: each role with its type, the property ID, headline price, offer and viewing counts and the accepted offer price. A role ties a named person to a property, and for someone renting or buying that property is their home, so by default the address is reduced to town, county and country; the full address (number, street, postcode, coordinates) is returned with include_contact_details, or from get_property by ID. Uses GET /api/people/{id}/roles, which answers a plain list without a total, so paging ends at a short page.",
    inputSchema: { person_id: id("Person"), ...paging, include_contact_details: includeContact("the full property address of each role (number, street, building, postcode, coordinates)") },
    annotations: READ,
  },
  safe(async ({ person_id, max_results, page, include_contact_details }) => {
    const r = await api.listArray(`/api/people/${person_id}/roles`, { maxItems: max_results, maxPages: 20, page });
    return { person_id, count: r.items.length, page, page_size: r.page_size, complete: r.complete, next_page: r.next_page, note: pageNote(r, max_results), roles: r.items.map((x) => fmt.basicPersonRole(x, include_contact_details)) };
  }),
);

server.registerTool(
  "get_group",
  {
    title: "Get group",
    description:
      "One group by ID: a household or company (vendors, applicants, landlords, tenants, suppliers) with its members (names by default), type, status, applicant qualification answers, preferred companies and custom fields. Members' emails, phones and addresses only with include_contact_details. Uses GET /api/group/{id}.",
    inputSchema: {
      group_id: id("Group"),
      include_contact_details: includeContact("members' email addresses, phone numbers and postal addresses, and stop redacting emails and phone numbers from names, notes and descriptions"),
    },
    annotations: READ,
  },
  safe(async ({ group_id, include_contact_details }) => {
    const g = await api.getRecord(`/api/group/${group_id}`, "the group");
    return { group: fmt.group(g, include_contact_details) };
  }),
);

server.registerTool(
  "get_group_events",
  {
    title: "Group events",
    description:
      "The timeline of one group (household or company): viewings, offers, notes, appointments and other events, with the same filters as get_property_events plus the group-only ones: only active roles, one property, one role, and drafts. Uses GET /api/group/{id}/events.",
    inputSchema: {
      group_id: id("Group"),
      ...eventFilters,
      active_roles_only: z.boolean().optional().describe("Only events on the group's active roles (API parameter `activeRolesOnly`)"),
      property_id: id("Property").optional().describe("Only events relating to this property (API parameter `propertyId`)"),
      role_id: id("Role").optional().describe("Only events on this role (API parameter `roleId`)"),
      include_drafts: z.boolean().optional().describe("Include draft events (API parameter `includeDrafts`)"),
      ...paging,
      include_contact_details: includeContact("attendees' and negotiators' email addresses and phone numbers, and stop redacting emails and phone numbers from notes, names and descriptions"),
    },
    annotations: READ,
  },
  safe(async ({ group_id, active_roles_only, property_id, role_id, include_drafts, max_results, page, include_contact_details, ...filters }) => {
    const r = await api.list(`/api/group/${group_id}/events`, {
      maxItems: max_results,
      maxPages: 20,
      page,
      query: { ...eventQuery(filters), activeRolesOnly: active_roles_only, propertyId: property_id, roleId: role_id, includeDrafts: include_drafts },
      nullMeansMissing: "the group",
    });
    return { group_id, count: r.items.length, total: r.total, page, page_size: r.page_size, complete: r.complete, next_page: r.next_page, note: pageNote(r, max_results), events: r.items.map((e) => fmt.eventSummary(e, include_contact_details)) };
  }),
);

server.registerTool(
  "list_offers",
  {
    title: "List offers",
    description:
      "Offers on the agency's properties, in the order the API returns them, each with its value, status, the property and address, the applicant and vendor groups (names by default), the marketed price, the vendor's response and the negotiators. The endpoint has no filters; page through with page/max_results. Uses GET /api/Offer.",
    inputSchema: {
      ...paging,
      include_contact_details: includeContact("applicants', vendors' and negotiators' email addresses, phone numbers and postal addresses, and stop redacting emails and phone numbers from names and notes"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, page, include_contact_details }) => {
    const r = await api.list("/api/Offer", { maxItems: max_results, maxPages: 20, page });
    return { count: r.items.length, total: r.total, page, page_size: r.page_size, complete: r.complete, next_page: r.next_page, note: pageNote(r, max_results), offers: r.items.map((o) => fmt.offer(o, include_contact_details)) };
  }),
);

server.registerTool(
  "get_offer",
  {
    title: "Get offer",
    description: "One offer by ID, in full: value, validity, status, the property, applicant and vendor groups with their primary members (names by default), the marketed price, the vendor's response and communication, notes, documents (name, type and link) and negotiators. Uses GET /api/Offer/{id}.",
    inputSchema: {
      offer_id: id("Offer"),
      include_contact_details: includeContact("applicants', vendors' and negotiators' email addresses, phone numbers and postal addresses, and stop redacting emails and phone numbers from names and notes"),
    },
    annotations: READ,
  },
  safe(async ({ offer_id, include_contact_details }) => {
    const o = await api.getRecord(`/api/Offer/${offer_id}`, "the offer");
    return { offer: fmt.offer(o, include_contact_details) };
  }),
);

await server.connect(new StdioServerTransport());
console.error(`Dezrez MCP server running (auth: ${api.authMode}${agencyId ? `, agency ${agencyId}` : ""}; read-only${allowWritesSet ? "; DEZREZ_ALLOW_WRITES is set but this version has no write tools" : ""}).`);
