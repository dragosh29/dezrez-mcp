# Dezrez Rezi MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients read an estate agency's Dezrez Rezi CRM: properties and their marketing roles, property and group timelines (viewings, offers, notes, appointments), people, groups (households and companies) and offers. It is built from Dezrez's public documentation: the Rezi API Swagger 2.0 document at `api.dezrez.com/swagger/docs/v1` and the developer guides in the public [DezrezCoreAPI](https://github.com/dezrez/DezrezCoreAPI) repository (OAuth2 flows, the `Rezi-Api-Version` header, the `agencyId` rule).

Once it's connected, someone at the agency can ask things like:

- "What happened at 12 High Street this month? Any feedback from the viewings?"
- "Which of our sales are under offer, and at what price?"
- "Find the Evans family. What are they buying and renting, and how many viewings have they had?"
- "List the open offers and who made them."
- "Who is in the Patel group, and what did they answer about their mortgage?"

This version is read-only. There are no write tools at all: creating leads, booking viewings and recording offers need scopes and a test agency that were not available when it was built, and a write that cannot be tested against a real account should not be shipped (see Status).

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `get_property` | One property: address, status, marketing roles (sale or letting, with status), certificates, special arrangements, keys (holder and check-out status), the number of alarms, custom fields, default picture link. Key and alarm codes are never returned. | `GET /api/property/{id}` |
| `search_properties` | Search property marketing roles by free text, on-market flag, role type and role status, with the property address, prices, summary line and owning group. Pages by `page`/`max_results`. | `GET /api/role/suggest` |
| `get_property_events` | A property's timeline: viewings, offers, notes, appointments and other events, with the documented filters `from`, `to`, `type` (repeated), `excludedTypes` (repeated), `eventCategoryType`, `branchId`, `showCancelled` and `includeOnlyOriginalNotes`. | `GET /api/property/{id}/events` |
| `get_person` | One person: name, gender, group memberships, marketing preferences, custom fields, dates. Contact items, addresses, the note and identity details only on request. | `GET /api/people/{id}` |
| `find_people` | Search by `surname`, `postcode`, `email`, `telephone` and/or `mobile`, exactly the parameters the endpoint documents. No paging on the API side. | `GET /api/people/findbydetails` |
| `get_person_roles` | The properties a person is selling, letting, buying or renting, with price, offer and viewing counts. The address is reduced to town, county and country by default (a buyer's or tenant's property is their home); the full address on request. | `GET /api/people/{id}/roles` |
| `get_group` | One group (household or company): members by name, type, status, applicant qualification answers, preferred companies, custom fields. | `GET /api/group/{id}` |
| `get_group_events` | A group's timeline, with the property-event filters plus `activeRolesOnly`, `propertyId`, `roleId` and `includeDrafts`. | `GET /api/group/{id}/events` |
| `list_offers` | Offers across the agency, paged: value, status, property, applicant and vendor groups, marketed price, response, negotiators. | `GET /api/Offer` |
| `get_offer` | One offer in full, including the vendor's response and communication, notes and documents (name, type, link). | `GET /api/Offer/{id}` |

Not covered on purpose: everything else in a 1,400-operation API, including documents and their downloads, diary and appointments, valuations, progression, tenancies, accounting, and every write. `GET /api/people/{id}/accounts` and `GET /api/people/{id}/bankReferences` (bank details) are never called; the test suite asserts it.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an OAuth2 client registered with Dezrez. Registration is by request ([developer.dezrez.com/api-request](http://developer.dezrez.com/api-request) or developer.registration@dezrez.com, per `HowToRegister.md`); Dezrez decides the flow (code, implicit, resource owner, client credentials) and the scopes. Two environments exist: LIVE (`https://api.dezrez.com`, token endpoint `https://auth.dezrez.com/Dezrez.Core.Api/oauth/token/`) and UAT (`https://core-api-uat.dezrez.com`, `https://dezrez-core-auth-uat.dezrez.com/Dezrez.Core.Api/oauth/token/`).

The server authenticates in one of two ways:

- **An access token you already have** (`DEZREZ_ACCESS_TOKEN`), obtained through whichever flow your client is registered for. Access tokens last about two hours according to the overview, so this is for testing and for hosts that refresh the token themselves. A value pasted with its `Bearer ` prefix is accepted. With a user token (code, implicit or resource-owner flow) no `agencyId` is needed; if `DEZREZ_AGENCY_ID` is set it is sent anyway.
- **Client credentials** (`DEZREZ_CLIENT_ID` and `DEZREZ_CLIENT_SECRET`): the server posts to the token endpoint as `DezrezCoreAPIOverview.md` documents (`Authorization: Basic base64(clientId:clientSecret)`, JSON body `{"grant_type":"client_credentials","scope":"..."}`), caches the token until a minute before its `expires_in` (or halfway through its life, for a token shorter than two minutes; an hour when `expires_in` is absent), shares one token request between tool calls that start at the same time, and fetches a new one if the API answers 401. Dezrez documents that a client token "must" carry the `agencyId` parameter on every request, so `DEZREZ_AGENCY_ID` is required and the server refuses to start without it.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dezrez": {
      "command": "node",
      "args": ["/absolute/path/to/dezrez-mcp/dist/index.js"],
      "env": { "DEZREZ_CLIENT_ID": "your-client-id", "DEZREZ_CLIENT_SECRET": "your-client-secret", "DEZREZ_AGENCY_ID": "1234" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add dezrez -e DEZREZ_CLIENT_ID=your-client-id -e DEZREZ_CLIENT_SECRET=your-client-secret -e DEZREZ_AGENCY_ID=1234 -- node /absolute/path/to/dezrez-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `DEZREZ_ACCESS_TOKEN` | one of the two | An OAuth2 access token for the Rezi API, sent as `Authorization: Bearer …`. When set, the token endpoint is never called. |
| `DEZREZ_CLIENT_ID`, `DEZREZ_CLIENT_SECRET` | one of the two | The client ID and secret Dezrez issued, used for the client-credentials flow. |
| `DEZREZ_AGENCY_ID` | with client credentials | The agency to act for, sent as the `agencyId` query parameter on every request. Optional with an access token. |
| `DEZREZ_SCOPE` | no | The scope asked for in the client-credentials request. Defaults to `impersonate_web_user`, the value in the documented example; set it to whatever Dezrez granted your client. |
| `DEZREZ_BASE_URL` | no | Defaults to `https://api.dezrez.com`. Set to `https://core-api-uat.dezrez.com` for UAT. Used by the tests. Must not contain a username or password; the server refuses to start if it does. |
| `DEZREZ_TOKEN_URL` | no | Defaults to `https://auth.dezrez.com/Dezrez.Core.Api/oauth/token/`. Set to the UAT token endpoint for UAT. Used by the tests. Same rule about credentials in the URL. |
| `DEZREZ_ALLOW_WRITES` | no | Has no effect: this version has no write tools. A set value (whatever it is) is only mentioned in the start-up log. |

Every request carries `Rezi-Api-Version: 1.0`, which the overview says is mandatory.

## Safety defaults

- Read-only. Every tool carries the MCP `readOnlyHint` annotation and only `GET`s the API; the one `POST` the server makes is the OAuth2 token request.
- People are heavily personal in a CRM, so by default a person, group member, attendee, negotiator or applicant is identified by ID and name only. Email addresses, phone numbers, postal addresses, the free-text note on a person, identity, right-to-rent, NRL and housing-benefit details (the spec's `AdditionalInformationDataContract`, including its documents), attendees' contact items on events and negotiators' emails and phones are only returned when a tool is called with `include_contact_details=true`. Custom field values whose name looks like contact data (email, phone, address, date of birth, passport, bank and the like) are withheld by default too.
- In free text (notes, descriptions, special arrangements, summary lines, names, group names, custom field values) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]` by default. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings starting with `0` are redacted too, while numeric IDs, timestamps and hyphenated references are left alone; the raw text is available with `include_contact_details`. The same redaction is applied to Dezrez's error messages before they are passed on.
- Error messages never quote a response body. From an error response only a JSON message field (`Message`, `ExceptionMessage`, `message`, `error`, `error_description`) is passed on, redacted as above; a non-JSON body (a gateway page, a login page) is described by content type and size only. Every message is also scrubbed of the server's own secrets (the configured access token, each token the token endpoint issued, the client secret and the `Basic` credential), so an error body that echoes the request's `Authorization` header shows `Bearer [redacted]` or `Basic [redacted]`. A token endpoint answer without `access_token` is described by its content type, size and JSON key names, never its content. An unreachable endpoint is named by origin and path, without the query string.
- Never returned, even on request: bank details (`HasBankAccounts` is dropped from person records and the `/accounts` and `/bankReferences` endpoints are never called), property key codes (`PropertyKeyDataContract.Code`, `KeySignedOutDataContract.Code`) and alarm codes (`PropertyAlarmDataContract`, reduced to a count).
- Property addresses are the agency's stock and are returned by default on properties, searches, events and offers. The one exception is `get_person_roles`, where a role ties a named person to a property that, for someone renting or buying, is their home: there the address is reduced to town, county and country by default (the role type is a free string in the spec, so no type is treated as exempt), and the full address comes with `include_contact_details` or from `get_property` by ID. Document links (certificates, offer documents, pictures) are returned as stored, with the spec's `RequiresAuthentication` flag; the files are never fetched.
- IDs are checked before any call: every ID on the endpoints this server calls is an `int64` path parameter (a few elsewhere in the spec are strings) and each get-by-id says "Pass 0 to be returned an empty data contract", so only positive whole numbers are accepted. Type, status and category filters must be single tokens (letters, digits, `_`, `-`). `from`/`to` must be ISO 8601 and real calendar dates (2026-02-30 is refused, not rolled over); a date-time is sent as given and a date alone is completed to the start of that day for `from` (`T00:00:00Z`) and the end of it for `to` (`T23:59:59Z`), since the parameters are typed `date-time`. Search fields are trimmed and a blank value counts as not given.
- Dezrez documents no rate limit. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds, so one request waits at most 20 seconds in all; a tool call that makes several requests (pages, lookups) can still run past the MCP client's default 60-second request timeout. Past the cap: if Dezrez asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML. The token `POST` is never retried after a gateway error.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `DEZREZ_BASE_URL`, never as an empty record. A 200 with a `null` body is reported as not found where the spec documents it that way: every get-by-id ("null if it does not exist") and the two events endpoints ("null if the property/group does not exist"); on `GET /api/Offer` the spec says "null if none exist", so there it is an empty list.
- A rejected token or rejected client credentials produce messages that say which variables to check; a 403 names the documented read scopes and the agency in use.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the definitions in Dezrez's published Swagger 2.0 document (`PropertyDataContract`, `EventListDataContract`, `PersonDataContract`, `BasicPersonRoleDataContract`, `GroupDataContract`, `OfferDataContract`, `PropertyRoleSuggestResultDataContract` and everything they embed) with `ajv-draft-04`, the JSON Schema dialect Swagger 2.0 uses, plus `ajv-formats` for `date-time`, `int64` and `double`. The document is downloaded from `api.dezrez.com/swagger/docs/v1` to `spec.json` on the first run. Because the definitions set no `additionalProperties: false`, Ajv alone would accept a fixture field the spec never declares, so every fixture is also walked key by key against its definition (following `$ref` and `items`; the `Dates` and `Descriptions` maps take any key) and an undeclared key fails the check. One deliberate loosening: the spec types custom field values as its `Object` definition, which it describes as "an unspecified legacy API value", so that definition is validated as "any value", left opaque by the key walk, and the fixtures use plain strings there. Negative controls check that the schemas still reject wrong types and that the key walk reports undeclared keys at any depth.
2. Starts a local mock of the API and of the OAuth2 token endpoint that serves those fixtures with the documented `pageSize`/`pageNumber` paging (`PagedCollectionDataContract`, pages capped at 10 to exercise paging), the documented auth (`Bearer` token plus `Rezi-Api-Version: 1.0`; `Basic client:secret` and a JSON `grant_type`/`scope` body at the token endpoint; `agencyId` required with a client token), 401 on a bad token or bad client secret, 404 for unknown IDs, the documented `200` with `null` for one reserved ID, and a one-off 429 with `Retry-After` on `GET /api/Offer`. The mock's list, detail and paged-collection responses are validated against the response schemas the spec names for each operation.
3. Starts the built server and drives it over stdio with the official MCP client: 22 checks covering tools/list and annotations (10 read tools, none writable, `DEZREZ_ALLOW_WRITES` adding nothing), the client-credentials token request in its documented form with the token cached across calls, one token request shared by two concurrent first calls, and `agencyId` on every request, every read tool, paging to `TotalCount` across pages 1, 2, 3 and whole-page continuation with `next_page` covering every event exactly once, the bare-array paging of person roles with the address reduced to the area by default and complete on request, each documented filter passed through exactly (`from`, `to`, `type` and `excludedTypes` as repeated keys, `eventCategoryType`, `branchId`, `showCancelled`, `includeOnlyOriginalNotes`, `activeRolesOnly`, `propertyId`, `roleId`, `includeDrafts`, the five `findbydetails` fields, the `dataContract.*` search parameters), a date-only `from`/`to` completed to a date-time and impossible calendar dates refused, blank search fields treated as absent, redaction of contact details by default and their return on request, key and alarm codes never returned, bank fields never returned and bank endpoints never called, ID validation before any call, the 404 message, a null body reported as not found on get-by-id and on the events endpoints and as an empty list on `GET /api/Offer`, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 502 retried for `GET`, a `GET` failing three times with 503 reported with advice and without the gateway HTML, a non-JSON 200 reported as an error described by content type and size with nothing of the body (its email, phone number and token) quoted, a non-JSON 400 body not passed on at all, error bodies that echo the `Authorization` header (a `Bearer` token on a 400 and a 401, the `Basic` credential at the token endpoint) scrubbed to `[redacted]`, a token endpoint 200 without `access_token` described by its JSON keys or content type without the token, a revoked token fetched again once, a token response without `expires_in` still cached, a token with `expires_in` of 30 seconds reused across three calls, a 502 from the token endpoint not retried, a 400 whose message contains an email and a phone number passed on redacted, the 401 messages for a wrong access token and wrong client credentials, a token pasted with its `Bearer ` prefix sent once, the 403 message, start-up refused without credentials, without `DEZREZ_AGENCY_ID` in the client flow, or with a username and password inside `DEZREZ_BASE_URL` or `DEZREZ_TOKEN_URL` (without repeating them), an unreachable endpoint named without its query string, and that every request used the documented headers and a documented method and path.

The spec marks no property as required on any of these definitions, so schema validation proves the types of fields that are present, not that any field is present; the checks in step 3 assert the fields the tools rely on explicitly.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a registered client, a token or an agency to test on. Everything below is taken from the published documentation and should be confirmed on a real account (UAT first):

- Authentication end to end: that a client registered for the client-credentials flow gets a token with the documented request (the overview's example scope is `impersonate_web_user`; the read scopes it lists are `property_read`, `property_basic_read`, `people_read`, `people_basic_read`, `event_read` and `document_read`, and which of them a reading client is actually granted is decided by Dezrez), that `expires_in` is present in the token response (the server keeps a token for an hour when it is not) and how long the tokens really last, what the API answers when `agencyId` is missing or wrong (the mock answers 400 and 403), and the body of a 401 (undocumented; the server reads `Message`, `ExceptionMessage`, `message`, `error` and `error_description` when present).
- Paging: that `pageNumber` is 1-based (the server assumes it), that `TotalCount` and `PageSize` are filled on every `PagedCollectionDataContract`, what the maximum `pageSize` is (the server sends at most 100, its own cap; the spec says "Can be null" and gives no limit) and what a page past the end returns (the mock answers an empty `Collection`). `GET /api/people/{id}/roles` answers a bare array with no total, so the only end condition is a page shorter than the requested size; if the live API capped pages below the requested size, that walk would stop early.
- The sort order of every list. The spec documents none; the mock serves timelines newest first and the server returns whatever order the API uses.
- Filter semantics: whether `from`/`to` compare against `DateTime`, `StartDate` or `CreatedDate` and are inclusive; whether `type`, `excludedTypes`, `eventCategoryType`, `roleType` and `roleStatus` take the enum system names (the swagger types them as plain strings and lists no values; the documented examples are role types `Sales` and `Letting`, role statuses `OfferAccepted` and `Exchanged`, and suggest types `AgencyOnly` and `ViewableOnly`); whether the `findbydetails` matches are exact or partial; and whether `GET /api/role/suggest` needs a `query` at all.
- The `EnumDataContract` values that come back (`SystemName` is what the server shows, falling back to `Name`) and the event types that represent viewings, offers and notes in a live agency.
- Date formats: the spec says `date-time`; the fixtures use RFC 3339 with a `Z` and `ajv-formats` requires a zone designator, so a live API emitting `2026-09-01T10:00:00` without one would still be passed through by the server but would fail the suite's schema check. A `from`/`to` date-time is sent exactly as given; a date alone is completed to `T00:00:00Z` (`from`) or `T23:59:59Z` (`to`), and whether the live API reads the `Z` as UTC or ignores the zone is unconfirmed.
- Which fields the live API fills: `Keys`, `Alarms`, `SpecialArrangements` and `Certificates` on a property, `AttendingGroups`, `Notes`, `KeySignedOut` and `Dates` on events, `AdditionalInformation` and `CustomFields` on people, `Owner` and `Prices` on suggest results, `Response`, `VendorCommunication` and `Documents` on offers. The team-level security described in `Breaking_Change_Log.md` can reduce a record to `Id`, `OwningTeamId`, `BranchId`, `Name` and `TeamAccessType`; the server passes such records through as they are.
- Whether the documented "null if it does not exist" is what the API really answers for an unknown ID (on get-by-id and on the events endpoints), or a 404; both are handled.
- The wording of Dezrez's error messages and whether any of them echo request data; the server passes on only JSON message fields, redacts contact details from them and scrubs its own secrets regardless.
- How many requests per second the API tolerates; nothing is documented, so the 250 ms spacing is a guess on the polite side.

## Going to production

This version runs locally over stdio with the agency's own client credentials or token. For agencies to connect from claude.ai or ChatGPT without handling credentials, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Dezrez, that uses the code flow Dezrez already offers so each user's own token and branch context apply, and then a listing in the Claude and ChatGPT connector directories. Write tools (leads, viewings, offers) can follow once they can be tested on a UAT agency.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
