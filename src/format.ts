// Turn Rezi API records into compact objects an assistant can read quickly.
// Field names follow the definitions in the Rezi API swagger (PropertyDataContract,
// EventListDataContract, PersonDataContract, BasicPersonRoleDataContract, GroupDataContract,
// OfferDataContract, PropertyRoleSuggestResultDataContract and the contracts they embed).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so numeric IDs, timestamps and
// hyphenated references such as PO-0001-000123 are left alone. Any other 9-11 digit string starting
// with 0 (an order number, say) is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (notes, descriptions,
 * names, summary text, custom field values) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// Custom field values are typed as Object in the spec and may be nested. Objects and arrays below
// this depth are replaced by a placeholder rather than returned unredacted.
const MAX_DEPTH = 20;

/** Apply redactContacts to every string key and value inside an arbitrary JSON value. */
export function redactDeep(value: unknown, includeContact: boolean, depth = 0): unknown {
  if (includeContact) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[value nested deeper than ${MAX_DEPTH} levels omitted; available with include_contact_details]`;
    return value.map((v) => redactDeep(v, includeContact, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return `[value nested deeper than ${MAX_DEPTH} levels omitted; available with include_contact_details]`;
    const out: Rec = {};
    for (const [k, v] of Object.entries(value as Rec)) out[redactString(k)] = redactDeep(v, includeContact, depth + 1);
    return out;
  }
  return value;
}

// Custom field names that mark the value as contact data (an email, phone, name, address, date of
// birth, IP address, or an official identifier). Such values are withheld entirely by default; other
// values get the email/phone redaction. The name is normalised first (camelCase split at each
// capital, spaces and hyphens turned into "_", lower-cased) so that "customerName", "E-Mail",
// "Date of birth" and "home_address" all read the same. Tokens that only ever mean contact data
// match anywhere in the name; the rest match as whole words so that "zip" is caught but
// "description" (contains "ip") is not.
const CONTACT_ANYWHERE = /e_?mail|phone|mobile|post_?code|birth|passport|nhs|address|bank|sort_?code|iban|account_?n/;
const CONTACT_WORD = /(?:^|_)(?:tel|fax|cell|names?|surname|forename|firstname|lastname|first_name|last_name|full_name|zip|dob|ip|ni_number|national_insurance|contact|licence|license)(?:_|$)/;
const normaliseName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
export const looksLikeContactField = (name: unknown) => {
  if (typeof name !== "string") return false;
  const n = normaliseName(name);
  return CONTACT_ANYWHERE.test(n) || CONTACT_WORD.test(n);
};

const WITHHELD = "[withheld: looks like contact data; available with include_contact_details]";

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v : []);
const compact = <T extends Rec>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

// EnumDataContract {Id, Name, SystemName}: the SystemName is the stable identifier (the spec's
// examples such as "Male", "Email", "PrimaryGroupMember", "Individual" are system names).
export const enumName = (e: unknown): string | undefined => {
  if (!e || typeof e !== "object") return undefined;
  const r = e as Rec;
  return str(r.SystemName) ?? str(r.Name);
};

// AddressDataContract / ContactAddressDataContract / ListPropertyAddressDataContract, as one line
// plus the parts. Property addresses are the agency's stock and are returned by default; a person's
// contact addresses go through this too, but only when contact details were requested.
export function address(a: Rec | undefined | null) {
  if (!a || typeof a !== "object") return undefined;
  // One line in the usual UK order: "12 High Street, Bristol, BS1 4DJ" or "Flat 3 Harbour View, Bute
  // Street, Cardiff, CF10 5BZ"; a county equal to the town is not repeated.
  const firstLine = a.BuildingName ? [a.Number, a.BuildingName].filter(Boolean).join(" ") : [a.Number, a.Street].filter(Boolean).join(" ");
  const parts = [a.OrganizationName, firstLine, a.BuildingName ? a.Street : undefined, a.Locality, a.Town, a.County !== a.Town ? a.County : undefined, a.Postcode].map(str).filter(Boolean);
  return compact({
    id: num(a.Id),
    text: parts.length ? parts.join(", ") : undefined,
    number: str(a.Number),
    building_name: str(a.BuildingName),
    organisation: str(a.OrganizationName),
    street: str(a.Street),
    locality: str(a.Locality),
    town: str(a.Town),
    county: str(a.County),
    country: str(a.Country),
    postcode: str(a.Postcode),
    uprn: str(a.Uprn),
    latitude: num(a.Location?.CenterPoint?.Latitude),
    longitude: num(a.Location?.CenterPoint?.Longitude),
    type: enumName(a.AddressType),
  });
}

// ContactItemDataContract {Type, Value, Notes, ContactOrder, AllowContact, MarketingContactStatus, Name, Id}.
// Only ever built when contact details were requested.
export function contactItem(c: Rec | undefined | null) {
  if (!c || typeof c !== "object") return undefined;
  return compact({
    id: num(c.Id),
    type: enumName(c.Type),
    value: str(c.Value),
    name: str(c.Name),
    notes: str(c.Notes),
    allow_contact: bool(c.AllowContact),
    marketing_status: enumName(c.MarketingContactStatus),
  });
}

// A person's display name from Title/FirstName/LastName/ContactName, with any email or phone typed
// into a name field redacted by default.
export function personName(p: Rec | undefined | null, includeContact: boolean) {
  if (!p || typeof p !== "object") return undefined;
  const full = [p.Title, p.FirstName, p.LastName].map(str).filter(Boolean).join(" ");
  return redactContacts(full || p.ContactName, includeContact);
}

// The people-shaped contracts that only carry a name and primary contact items (ListPersonDataContract,
// ListNegotiatorDataContract, CreatedByDataContract, OfferNegotiatorDataContract, KeyNegotiatorDataContract).
// Negotiators are the agency's staff, but their email and phone are still personal data of an
// identifiable employee, so they go behind include_contact_details like everyone else's.
export function personSummary(p: Rec | undefined | null, includeContact: boolean) {
  if (!p || typeof p !== "object") return undefined;
  return compact({
    id: num(p.Id),
    name: personName(p, includeContact),
    gender: enumName(p.Gender),
    job_title: redactContacts(p.JobTitle, includeContact),
    initials: str(p.Initials),
    ...(includeContact ? { primary_telephone: str(p.PrimaryTelephone?.Value), primary_email: str(p.PrimaryEmail?.Value) } : {}),
  });
}

// CustomFieldGroupWithValuesDataContract {Name, Values: [{Type, Name, Value}]}. Values are typed Object.
export function customFields(groups: unknown, includeContact: boolean) {
  const out = arr(groups).map((g) =>
    compact({
      group: redactContacts(g.Name, includeContact),
      values: arr(g.Values).map((v) =>
        compact({
          name: redactContacts(v.Name, includeContact),
          type: enumName(v.Type),
          value: !includeContact && looksLikeContactField(v.Name) ? WITHHELD : redactDeep(v.Value, includeContact),
        }),
      ),
    }),
  );
  return out.length ? out : undefined;
}

// RoleDataContract {OwningTeamId, BranchId, Name, TeamAccessType, RoleType, RoleStatus, CustomFields, CreatedDate, CreatedBy, Id}.
export function role(r: Rec | undefined | null, includeContact: boolean) {
  if (!r || typeof r !== "object") return undefined;
  return compact({
    id: num(r.Id),
    name: redactContacts(r.Name, includeContact),
    type: enumName(r.RoleType),
    status: enumName(r.RoleStatus),
    branch_id: num(r.BranchId),
    owning_team_id: num(r.OwningTeamId),
    team_access: str(r.TeamAccessType),
    created_date: str(r.CreatedDate),
    custom_fields: customFields(r.CustomFields, includeContact),
  });
}

// DocumentDataContract: name, type and link only. The link is returned as stored (RequiresAuthentication
// says whether it needs the API credentials); the file itself is never fetched.
export function document(d: Rec | undefined | null) {
  if (!d || typeof d !== "object") return undefined;
  return compact({
    id: num(d.Id),
    file_name: str(d.FileName),
    type: enumName(d.DocumentType),
    sub_type: enumName(d.DocumentSubType),
    content_type: str(d.ContentType),
    url: str(d.Url),
    requires_authentication: bool(d.RequiresAuthentication),
    expiry_date: str(d.ExpiryDate),
    created_date: str(d.CreatedDate),
  });
}

// PropertyCertificateDataContract (EPC, gas safety and the like: business records of the property).
function certificate(c: Rec) {
  return compact({
    id: num(c.Id),
    name: str(c.Name),
    type: enumName(c.CertificateType),
    status: str(c.Status),
    expired: bool(c.Expired),
    start_date: str(c.StartDate),
    expiry_date: str(c.ExpiryDate),
    received_date: str(c.ReceivedDate),
    documents: arr(c.Documents).map(document),
  });
}

// PropertyKeyDataContract. The key Code (the tag or safe code that opens the property) is never
// returned; who holds the key and since when is.
function propertyKey(k: Rec, includeContact: boolean) {
  return compact({
    id: num(k.Id),
    name: redactContacts(k.Name, includeContact),
    is_checked_out: bool(k.IsCheckedOut),
    is_permanent: bool(k.IsPermanent),
    checked_out_at: str(k.CheckedOutAt),
    checked_out_by: personName(k.CheckedOutBy, includeContact),
    checked_in_at: str(k.CheckedInAt),
    checked_in_by: personName(k.CheckedInBy, includeContact),
    note_on_check_out: redactContacts(k.NoteOnCheckOut, includeContact),
    note_on_check_in: redactContacts(k.NoteOnCheckIn, includeContact),
    holder: k.RecipientDetails
      ? compact({ id: num(k.RecipientDetails.RecipientId), name: redactContacts(k.RecipientDetails.RecipientName, includeContact), group: redactContacts(k.RecipientDetails.RecipientGroupName, includeContact), type: enumName(k.RecipientDetails.RecipientType) })
      : undefined,
  });
}

// PropertyDataContract. Alarms (PropertyAlarmDataContract {Name, Code}) are reduced to a count: the
// code is the alarm code. Key codes are dropped by propertyKey().
export function property(p: Rec, includeContact: boolean) {
  return compact({
    id: num(p.Id),
    address: address(p.Address),
    status: str(p.SystemStatusName),
    roles: arr(p.Roles).map((r) => role(r, includeContact)),
    inactive_role_ids: Array.isArray(p.InactiveRoleIds) && p.InactiveRoleIds.length ? p.InactiveRoleIds : undefined,
    default_picture_url: str(p.DefaultPicture?.Url),
    certificates: arr(p.Certificates).map(certificate),
    special_arrangements: arr(p.SpecialArrangements).map((s) => compact({ id: num(s.Id), type: enumName(s.SpecialArrangementType), text: redactContacts(s.Text, includeContact), applicable_to_group_ids: Array.isArray(s.ApplicableToGroupIds) && s.ApplicableToGroupIds.length ? s.ApplicableToGroupIds : undefined })),
    keys: arr(p.Keys).map((k) => propertyKey(k, includeContact)),
    alarm_count: Array.isArray(p.Alarms) ? p.Alarms.length : undefined,
    retention_amount: num(p.RetentionAmount),
    pre_approved_spend_amount: num(p.PreApprovedSpendAmount),
    custom_fields: customFields(p.CustomFields, includeContact),
  });
}

// PriceDataContract and ListPriceDataContract.
export function price(p: Rec | undefined | null) {
  if (!p || typeof p !== "object") return undefined;
  return compact({
    value: num(p.PriceValue ?? p.Value),
    currency: str(p.CurrencyCode ?? p.Currency),
    text: str(p.PriceText ?? p.Text),
    name: str(p.Name),
    type: enumName(p.PriceType),
    qualifier: enumName(p.PriceQualifierType),
    other: str(p.Other),
  });
}

// GroupMemberDataContract {Person: GroupMemberPersonDataContract, RelationshipType, SystemStatus, Order, Id}.
export function groupMember(m: Rec, includeContact: boolean) {
  const p: Rec = m.Person ?? {};
  return compact({
    membership_id: num(m.Id),
    relationship: enumName(m.RelationshipType),
    status: enumName(m.SystemStatus),
    order: num(m.Order),
    person_id: num(p.Id),
    name: personName(p, includeContact),
    gender: enumName(p.Gender),
    external_applicant_reference: str(p.ExternalApplicantReference),
    marketing_preferences: marketingPreferences(p.MarketingPreferences),
    ...(includeContact
      ? {
          primary_telephone: str(p.PrimaryTelephone?.Value),
          primary_email: str(p.PrimaryEmail?.Value),
          contact_items: arr(p.ContactItems).map(contactItem),
          addresses: arr(p.Addresses).map(address),
        }
      : {}),
  });
}

// PropertyOwnerDataContract (on a role suggest result): the owning group and its members.
export function owner(o: Rec | undefined | null, includeContact: boolean) {
  if (!o || typeof o !== "object") return undefined;
  return compact({
    group_id: num(o.Id),
    name: redactContacts(o.Name, includeContact),
    type: enumName(o.GroupType),
    description: redactContacts(o.Description, includeContact),
    notes: redactContacts(o.Notes, includeContact),
    branch_id: num(o.BranchId),
    team_access: str(o.TeamAccessType),
    members: arr(o.Members).map((m) => groupMember(m, includeContact)),
  });
}

// PropertyRoleSuggestResultDataContract (GET /api/role/suggest).
export function roleSuggestResult(r: Rec, includeContact: boolean) {
  return compact({
    property_id: num(r.PropertyId),
    address: address(r.Address),
    role: role(r.PropertyRole, includeContact),
    prices: arr(r.Prices).map(price),
    summary: redactContacts(r.SummaryText, includeContact),
    picture_url: str(r.DefaultPicture?.Url),
    owner: owner(r.Owner, includeContact),
  });
}

// MarketingPreferenceDataContract {ServiceType, ServiceStatusType, Referral, ReferralStatusType, Id}.
function marketingPreferences(list: unknown) {
  const out = arr(list).map((m) => compact({ service: enumName(m.ServiceType), status: enumName(m.ServiceStatusType), referral: bool(m.Referral), referral_status: enumName(m.ReferralStatusType) }));
  return out.length ? out : undefined;
}

// AdditionalInformationDataContract: proof-of-identity, right-to-rent, NRL and housing-benefit
// details of a person. All of it identifies or documents the person, so it is only built when
// contact details were requested.
function additionalInformation(a: Rec | undefined | null) {
  if (!a || typeof a !== "object") return undefined;
  return compact({
    proof_of_id_received: bool(a.ProofOfIdReceived),
    proof_of_address_received: bool(a.ProofOfAddressReceived),
    proof_of_sanctions_received: bool(a.ProofOfSanctionsReceived),
    right_to_rent_received: bool(a.RightToRentReceived),
    right_to_rent_type: enumName(a.RightToRentType),
    tob_signed: bool(a.TOBSigned),
    nrl_status: bool(a.NRLStatus),
    nrl_number: str(a.NRLNumber),
    nrl_reference: str(a.NrlReference),
    deduct_nrl_tax: bool(a.DeductNrlTax),
    nrl_tax_percentage: num(a.NrlTaxPercentage),
    landlord_resident_status: enumName(a.LandlordResidentStatus),
    housing_benefit: a.HousingBenefit ? compact({ receives_benefits: bool(a.HousingBenefit.ReceivesBenefits), reference: str(a.HousingBenefit.Reference), local_authority_id: num(a.HousingBenefit.LocalAuthorityId) }) : undefined,
    registration_scheme: a.RegistrationScheme ? compact({ name: str(a.RegistrationScheme.Name), registration_date: str(a.RegistrationScheme.RegistrationDate), expiry_date: str(a.RegistrationScheme.ExpiryDate) }) : undefined,
    documents: arr(a.Documents).map(document),
  });
}

// PersonDataContract. By default: identity of the record (id, name, gender), group memberships,
// marketing preferences and dates. Contact items, addresses, the free-text note and the
// identity/right-to-rent details only with include_contact_details. HasBankAccounts and anything
// from /accounts or /bankReferences is never returned.
export function person(p: Rec, includeContact: boolean) {
  return compact({
    id: num(p.Id),
    name: personName(p, includeContact),
    title: str(p.Title),
    first_name: redactContacts(p.FirstName, includeContact),
    last_name: redactContacts(p.LastName, includeContact),
    gender: enumName(p.Gender),
    note: includeContact ? str(p.Note) : p.Note ? "[withheld: free-text note about the person; available with include_contact_details]" : undefined,
    group_count: num(p.GroupCount),
    group_ids: Array.isArray(p.GroupIds) && p.GroupIds.length ? p.GroupIds : undefined,
    group_memberships: arr(p.GroupMemberships).map((m) =>
      compact({
        group_id: num(m.Group?.Id),
        group_name: redactContacts(m.Group?.Name, includeContact),
        group_type: enumName(m.Group?.GroupType),
        group_status: enumName(m.Group?.SystemStatus),
        relationship: enumName(m.RelationshipType),
        status: enumName(m.SystemStatus),
      }),
    ),
    marketing_preferences: marketingPreferences(p.MarketingPreferences),
    custom_fields: customFields(p.CustomFields, includeContact),
    created_date: str(p.CreatedDate),
    created_by: personName(p.CreatedBy, includeContact),
    ...(includeContact
      ? {
          primary_telephone: str(p.PrimaryTelephone?.Value),
          primary_email: str(p.PrimaryEmail?.Value),
          contact_items: arr(p.ContactItems).map(contactItem),
          addresses: arr(p.Addresses).map(address),
          archived_addresses: arr(p.ArchivedAddresses).map(address),
          additional_information: additionalInformation(p.AdditionalInformation),
        }
      : {}),
  });
}

// A property address reduced to the area (town, county, country) for records that tie a named
// person to where they live.
function areaOnly(a: Rec | undefined | null) {
  if (!a || typeof a !== "object") return undefined;
  const parts = [a.Town, a.County !== a.Town ? a.County : undefined].map(str).filter(Boolean);
  return compact({ id: num(a.Id), text: parts.length ? parts.join(", ") : undefined, town: str(a.Town), county: str(a.County), country: str(a.Country) });
}

// BasicPersonRoleDataContract (GET /api/people/{id}/roles): the properties a person is selling,
// letting, buying or renting, with headline figures. The role types are plain strings the spec does
// not enumerate, and for someone renting or buying the property is their home, so by default every
// role's address is reduced to the area; the full address comes with include_contact_details.
export function basicPersonRole(r: Rec, includeContact: boolean) {
  return compact({
    role_id: num(r.RoleId),
    role_type: str(r.RoleType),
    property_id: num(r.PropertyId),
    property_status: str(r.PropertyStatus),
    address: includeContact ? address(r.Address) : areaOnly(r.Address),
    price: num(r.Price),
    price_type: str(r.PriceType),
    offer_count: num(r.OfferCount),
    offer_accepted_price: num(r.OfferAcceptedPrice),
    viewing_count: num(r.ViewingCount),
    primary_photo_url: str(r.PrimaryPhoto?.Url),
  });
}

// AdditionalQuestionsDataContract on a group: the applicant qualification answers.
function additionalQuestions(q: Rec | undefined | null, includeContact: boolean) {
  if (!q || typeof q !== "object") return undefined;
  return compact({
    arranged_mortgage: bool(q.ArrangedMortgage),
    mortgage_provider: redactContacts(q.MortgageProvider, includeContact),
    how_long_to_move: redactContacts(q.HowLongToMove, includeContact),
    reason_for_moving: redactContacts(q.ReasonForMoving, includeContact),
    how_heard: redactContacts(q.HowHeard, includeContact),
    enquiry_method: redactContacts(q.EnquiryMethod, includeContact),
    best_time_to_call: redactContacts(q.BestTimeToCall, includeContact),
    when_can_view: redactContacts(q.WhenCanView, includeContact),
    happy_to_receive_property_emails: bool(q.HappyToReceivePropertyEmails),
    viewed_any_properties: bool(q.ViewedAnyProperties),
    local_own_to_sell: bool(q.LocalOwnToSell),
    asking_price: redactContacts(q.AskingPrice, includeContact),
    bedrooms: num(q.Bedrooms),
    currently_on_market: bool(q.CurrentlyOnMarket),
    selling_with: redactContacts(q.SellingWith, includeContact),
    on_market_since: str(q.OnMarketSince),
    reason_for_sale: redactContacts(q.ReasonForSale, includeContact),
    offered_ma: bool(q.OfferedMA),
    current_status: enumName(q.CurrentStatus),
    financial: enumName(q.Financial),
    reason: enumName(q.Reason),
  });
}

// GroupDataContract: a household or company (vendors, applicants, landlords, tenants) and its members.
export function group(g: Rec, includeContact: boolean) {
  return compact({
    id: num(g.Id),
    name: redactContacts(g.Name, includeContact),
    description: redactContacts(g.Description, includeContact),
    type: enumName(g.GroupType),
    status: enumName(g.SystemStatus),
    notes: redactContacts(g.Notes, includeContact),
    separated: bool(g.Separated),
    members: arr(g.Members).map((m) => groupMember(m, includeContact)),
    preferred_companies: arr(g.PreferredCompanies).map((c) =>
      compact({ group_id: num(c.Group?.Id), name: redactContacts(c.Group?.Name, includeContact), service_types: Array.isArray(c.CompanyServiceTypes) && c.CompanyServiceTypes.length ? c.CompanyServiceTypes : undefined, preferred_contact_id: num(c.PreferredContactId) }),
    ),
    additional_questions: additionalQuestions(g.AdditionalQuestions, includeContact),
    custom_fields: customFields(g.CustomFields, includeContact),
    created_date: str(g.CreatedDate),
    created_by: personName(g.CreatedBy, includeContact),
  });
}

// EventListPeopleGroupDataContract (the group attending an event, or owning a property in an event).
function eventGroup(g: Rec | undefined | null, includeContact: boolean) {
  if (!g || typeof g !== "object") return undefined;
  return compact({
    group_id: num(g.Id),
    name: redactContacts(g.Name, includeContact),
    type: enumName(g.GroupType),
    grade: enumName(g.Grade),
    financial_status: enumName(g.FinancialStatus),
    primary_member: personSummary(g.PrimaryGroupMember, includeContact),
    branch_id: num(g.BranchId),
  });
}

// EventListDataContract (GET /api/property/{id}/events and /api/group/{id}/events): viewings, offers,
// notes, appointments and other timeline entries. KeySignedOut.Code is a key code and is dropped.
export function eventSummary(e: Rec, includeContact: boolean) {
  const dates = e.Dates && typeof e.Dates === "object" && Object.keys(e.Dates).length ? e.Dates : undefined;
  return compact({
    id: num(e.Id),
    name: redactContacts(e.Name, includeContact),
    type: enumName(e.EventType),
    category: enumName(e.EventCategory),
    status: enumName(e.EventStatus),
    date_time: str(e.DateTime),
    start_date: str(e.StartDate),
    end_date: str(e.EndDate),
    all_day: bool(e.AllDayEvent),
    description: redactContacts(e.Description, includeContact),
    offer_status: enumName(e.OfferStatus),
    prices: arr(e.Prices).map(price),
    price_type: enumName(e.PriceType),
    properties: arr(e.Properties).map((p) =>
      compact({
        property_id: num(p.Id),
        address: address(p.Address),
        bedrooms: num(p.Bedrooms),
        property_type: enumName(p.PropertyType),
        owning_group: eventGroup(p.OwningGroup, includeContact),
        roles: arr(p.PropertyRoles).map((r) => role(r, includeContact)),
      }),
    ),
    roles: arr(e.Roles).map((r) =>
      compact({
        role_id: num(r.Id),
        name: redactContacts(r.Name, includeContact),
        type: enumName(r.RoleType),
        status: enumName(r.Rolestatus),
        property_id: num(r.PropertyId),
        property_address: redactContacts(r.PropertyAddress, includeContact),
        group_name: redactContacts(r.GroupName, includeContact),
        milestones: r.TotalMilestones !== undefined && r.TotalMilestones !== null ? `${num(r.CompletedMilestones) ?? 0}/${num(r.TotalMilestones)}` : undefined,
      }),
    ),
    attending_groups: arr(e.AttendingGroups).map((a) =>
      compact({
        type: enumName(a.Type),
        group: eventGroup(a.Group, includeContact),
        // EventListAttendeePersonDataContract: FirstName, LastName and an Address typed as a contact item.
        attending_people: arr(a.AttendingPeople).map((p) => compact({ person_id: num(p.Id), name: personName(p, includeContact), ...(includeContact ? { address: str(p.Address?.Value) } : {}) })),
      }),
    ),
    notes: arr(e.Notes).map((n) => compact({ id: num(n.Id), note: redactContacts(n.Note, includeContact), created_date: str(n.CreatedDate), negotiator_id: num(n.NegotiatorId) })),
    negotiators: arr(e.Negotiators).map((n) => personSummary(n, includeContact)),
    branch: e.Branch ? compact({ id: num(e.Branch.Id), name: str(e.Branch.Name) }) : undefined,
    branch_id: num(e.BranchId),
    dates,
    method_of_contact: enumName(e.MethodOfContact),
    key_signed_out: e.KeySignedOut ? compact({ key_id: num(e.KeySignedOut.KeyId), name: redactContacts(e.KeySignedOut.Name, includeContact), group: redactContacts(e.KeySignedOut.GroupName, includeContact), person: redactContacts(e.KeySignedOut.PersonName, includeContact) }) : undefined,
    document_ids: Array.isArray(e.DocumentIds) && e.DocumentIds.length ? e.DocumentIds : undefined,
    pinned: bool(e.Pinned),
    is_original: bool(e.IsOriginal),
    edited_version_id: num(e.EditedVersionId),
    source: str(e.Source),
    created_date: str(e.CreatedDate),
    created_by: personName(e.CreatedBy, includeContact),
    custom_fields: customFields(e.CustomFields, includeContact),
  });
}

// OfferGroupDataContract: the applicant or vendor side of an offer.
function offerGroup(g: Rec | undefined | null, includeContact: boolean) {
  if (!g || typeof g !== "object") return undefined;
  return compact({
    group_id: num(g.Id),
    name: redactContacts(g.Name, includeContact),
    type: enumName(g.GroupType),
    grade: enumName(g.Grade),
    primary_member: g.PrimaryMember ? person(g.PrimaryMember, includeContact) : undefined,
  });
}

// EventNoteCommandDataContract {Note, DateAdded, NegotiatorId, NegotiatorEmail, NegotiatorName, Id}.
function offerNote(n: Rec, includeContact: boolean) {
  return compact({
    id: num(n.Id),
    note: redactContacts(n.Note, includeContact),
    date_added: str(n.DateAdded),
    negotiator_id: num(n.NegotiatorId),
    negotiator: redactContacts(n.NegotiatorName, includeContact),
    ...(includeContact ? { negotiator_email: str(n.NegotiatorEmail?.Value) } : {}),
  });
}

// OfferDataContract (GET /api/Offer and /api/Offer/{id}).
export function offer(o: Rec, includeContact: boolean) {
  return compact({
    id: num(o.Id),
    name: redactContacts(o.Name, includeContact),
    value: num(o.Value),
    valid_for: num(o.ValidFor),
    status: enumName(o.EventStatus),
    type: enumName(o.EventType),
    category: enumName(o.EventCategory),
    date_time: str(o.DateTime),
    last_updated: str(o.LastUpdated),
    description: redactContacts(o.Description, includeContact),
    on_behalf_of: redactContacts(o.OnBehalfOf, includeContact),
    property: o.Property ? compact({ property_id: num(o.Property.Id), address: address(o.Property.Address) }) : undefined,
    marketing_role_id: num(o.MarketingRoleId),
    role_type: enumName(o.RoleType),
    marketed_price: price(o.MarketedPrice),
    applicant_group: offerGroup(o.ApplicantGroup, includeContact),
    vendor_group: offerGroup(o.VendorGroup, includeContact),
    roles: arr(o.Roles).map((r) => role(r, includeContact)),
    response: o.Response
      ? compact({
          id: num(o.Response.Id),
          type: enumName(o.Response.ResponseType),
          status: enumName(o.Response.EventStatus),
          date_time: str(o.Response.DateTime),
          description: redactContacts(o.Response.Description, includeContact),
          notes: arr(o.Response.Notes).map((n) => offerNote(n, includeContact)),
          negotiators: arr(o.Response.Negotiators).map((n) => personSummary(n, includeContact)),
        })
      : undefined,
    vendor_communication: o.VendorCommunication
      ? compact({
          id: num(o.VendorCommunication.Id),
          name: redactContacts(o.VendorCommunication.Name, includeContact),
          status: enumName(o.VendorCommunication.EventStatus),
          date_time: str(o.VendorCommunication.DateTime),
          description: redactContacts(o.VendorCommunication.Description, includeContact),
          notes: arr(o.VendorCommunication.Notes).map((n: unknown) => redactContacts(n, includeContact)),
          negotiators: arr(o.VendorCommunication.Negotiators).map((n) => personSummary(n, includeContact)),
        })
      : undefined,
    notes: arr(o.Notes).map((n) => offerNote(n, includeContact)),
    documents: arr(o.Documents).map(document),
    negotiators: arr(o.Negotiators).map((n) => personSummary(n, includeContact)),
    note_of_interest_id: num(o.NoteOfInterestId),
    branch_id: num(o.BranchId),
    team: o.Team ? compact({ id: num(o.Team.Id), name: str(o.Team.Name) }) : undefined,
    created_date: str(o.CreatedDate),
    created_by: personName(o.CreatedBy, includeContact),
    custom_fields: customFields(o.CustomFields, includeContact),
  });
}
