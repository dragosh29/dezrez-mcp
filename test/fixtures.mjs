// Fixture records shaped like the Rezi API swagger definitions (PascalCase, EnumDataContract for
// enums, PagedCollectionDataContract for lists). Field names come from the definitions in spec.json;
// the values are invented test data. Emails use example.com/.net/.org and phone numbers the Ofcom
// drama ranges (07700 900xxx, 0117 496 0xxx, 020 7946 0xxx).

export const PROPERTY_HIGH_ST = 501;
export const PROPERTY_FLAT = 502;
export const PROPERTY_WITHDRAWN = 503;
export const PERSON_SAM = 7001;
export const PERSON_PRIYA = 7002;
export const PERSON_LEE = 7003;
export const PERSON_ALEX = 7004;
export const PERSON_PATEL = 7005;
export const PERSON_JO = 7101; // negotiator
export const GROUP_EVANS = 3001;
export const GROUP_PATEL = 3002;
export const GROUP_CHEN = 3003;
export const ROLE_HIGH_ST_SALE = 8101;
export const ROLE_FLAT_LET = 8102;
export const ROLE_WITHDRAWN = 8103;
export const OFFER_MAIN = 9001;
export const BRANCH_BRISTOL = 31;
export const BRANCH_CARDIFF = 32;
// The swagger documents every get-by-id as "The <thing> or null if it does not exist": the mock answers
// this ID with a 200 and a null body, and every other unknown ID with a 404.
export const NULL_ID = 404404;
export const PASSPORT_URL = "https://api.dezrez.com/api/document/55001/download";
export const PROOF_OF_FUNDS_URL = "https://api.dezrez.com/api/document/55002/download";

const stamp = (day, hour, minute = 0) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
export const SEP_10 = stamp(10, 0);
export const SEP_20 = stamp(20, 0);
const en = (systemName, id) => ({ Id: id, Name: systemName.replace(/([a-z])([A-Z])/g, "$1 $2"), SystemName: systemName });
const contact = (type, value, id, extra = {}) => ({ Id: id, Type: en(type), Value: value, ContactOrder: 1, AllowContact: true, ...extra });

// AddressDataContract
const addr = (id, parts, lat, lon) => ({
  Id: id,
  Location: lat !== undefined ? { CenterPoint: { Latitude: lat, Longitude: lon }, Id: id * 10 } : undefined,
  AddressSource: en("RoyalMailPaf"),
  Country: "United Kingdom",
  ...parts,
});
const HIGH_ST_ADDR = addr(601, { Number: "12", Street: "High Street", Town: "Bristol", County: "Bristol", Postcode: "BS1 4DJ" }, 51.4545, -2.5879);
const FLAT_ADDR = addr(602, { Number: "Flat 3", BuildingName: "Harbour View", Street: "Bute Street", Town: "Cardiff", County: "Cardiff", Postcode: "CF10 5BZ" }, 51.4636, -3.1651);
const WITHDRAWN_ADDR = addr(603, { Number: "7", Street: "Station Road", Locality: "Clifton", Town: "Bristol", Postcode: "BS8 2AB" });
const SAM_HOME = { ...addr(611, { Number: "44", Street: "Park Row", Town: "Bristol", Postcode: "BS1 5LY" }), AddressType: en("Home"), ContactOrder: 1 };

// The people-shaped contracts (ListPersonDataContract, ListNegotiatorDataContract, CreatedByDataContract,
// GroupMemberPersonDataContract, PersonDataContract) share these fields.
const JO = { Id: PERSON_JO, Gender: en("Female"), Title: "Ms", FirstName: "Jo", LastName: "Bloggs", ContactName: "Jo Bloggs", JobTitle: "Senior Negotiator", PrimaryTelephone: contact("Work", "0117 496 0000", 7201), PrimaryEmail: contact("Email", "jo.bloggs@example.org", 7202) };
// The same negotiator shaped for two narrower definitions: KeyNegotiatorDataContract (a key's
// CheckedOutBy/CheckedInBy) declares no ContactName and PersonDataContract declares no JobTitle. The
// fixture check walks every key against the definitions, so an undeclared key fails the suite.
const { ContactName: _keyContactName, ...KEY_NEGOTIATOR_JO } = JO;
const { JobTitle: _personJobTitle, ...JO_AS_PERSON } = JO;
const SAM_BASIC = { Id: PERSON_SAM, Gender: en("Female"), Title: "Ms", FirstName: "Sam", LastName: "Evans", ContactName: "Sam Evans", PrimaryTelephone: contact("Mobile", "07700 900789", 7301), PrimaryEmail: contact("Email", "sam.evans@example.com", 7302) };
const ALEX_BASIC = { Id: PERSON_ALEX, Gender: en("Male"), Title: "Mr", FirstName: "Alex", LastName: "Evans", ContactName: "Alex Evans", PrimaryTelephone: contact("Mobile", "07700 900321", 7401), PrimaryEmail: contact("Email", "alex.evans@example.com", 7402) };
const PRIYA_BASIC = { Id: PERSON_PRIYA, Gender: en("Female"), Title: "Dr", FirstName: "Priya", LastName: "Shah (priya.shah@example.com)", ContactName: "Priya Shah", PrimaryTelephone: contact("Mobile", "+44 7700 900123", 7501), PrimaryEmail: contact("Email", "priya.shah@example.com", 7502) };
const LEE_BASIC = { Id: PERSON_LEE, Gender: en("Unknown"), FirstName: "Lee", LastName: "Chen", ContactName: "Lee Chen", PrimaryEmail: contact("Email", "lee.chen@example.net", 7602) };
const PATEL_BASIC = { Id: PERSON_PATEL, Gender: en("Male"), Title: "Mr", FirstName: "Raj", LastName: "Patel", ContactName: "Raj Patel", PrimaryTelephone: contact("Home", "(0117) 496 0111", 7701), PrimaryEmail: contact("Email", "raj.patel@example.com", 7702) };

const groupRef = (id, name, type = "Individual", status = "Active") => ({ Id: id, Name: name, GroupType: en(type), GroupIcon: en("House"), SystemStatus: en(status) });

// RoleDataContract
const roleRec = (id, name, type, status, branchId) => ({ Id: id, Name: name, RoleType: en(type), RoleStatus: en(status), BranchId: branchId, OwningTeamId: 1, TeamAccessType: "FullAccess", CreatedDate: stamp(1, 9), CreatedBy: JO });
export const HIGH_ST_ROLE = roleRec(ROLE_HIGH_ST_SALE, "Sale of 12 High Street", "Sales", "OfferAccepted", BRANCH_BRISTOL);
export const FLAT_ROLE = roleRec(ROLE_FLAT_LET, "Letting of Flat 3 Harbour View", "Letting", "Available", BRANCH_CARDIFF);
export const WITHDRAWN_ROLE = roleRec(ROLE_WITHDRAWN, "Sale of 7 Station Road", "Sales", "Withdrawn", BRANCH_BRISTOL);

// DocumentDataContract
const doc = (id, fileName, type, url, extra = {}) => ({ Id: id, FileName: fileName, DocumentType: en(type), ContentType: "application/pdf", FileExtension: ".pdf", FileSize: "204800", Url: url, RequiresAuthentication: true, CreatedDate: stamp(2, 10), CreatedBy: JO, ...extra });

// PropertyDataContract
export const properties = [
  {
    Id: PROPERTY_HIGH_ST,
    Address: HIGH_ST_ADDR,
    SystemStatusName: "Active",
    Roles: [HIGH_ST_ROLE],
    InactiveRoleIds: [8001],
    Keys: [
      {
        Id: 701,
        Name: "Front door set",
        Code: "K-0042",
        IsCheckedOut: true,
        IsPermanent: false,
        CheckedOutAt: stamp(18, 9, 30),
        CheckedOutBy: KEY_NEGOTIATOR_JO,
        NoteOnCheckOut: "Given to Sam Evans for the second viewing, ring 07700 900789 if late back",
        RecipientDetails: { RecipientId: PERSON_SAM, RecipientName: "Sam Evans", RecipientGroupName: "Mr and Mrs Evans", RecipientType: en("Applicant") },
      },
      { Id: 702, Name: "Garage key", Code: "K-0043", IsCheckedOut: false, IsPermanent: true, CheckedInAt: stamp(3, 17), CheckedInBy: KEY_NEGOTIATOR_JO },
    ],
    Alarms: [{ Id: 711, Name: "Main alarm", Code: "1234" }],
    SpecialArrangements: [{ Id: 721, Text: "Call the tenant on 07700 900123 or tenant@example.com before any viewing", SpecialArrangementType: en("Viewing"), ApplicableToGroupIds: [GROUP_EVANS] }],
    Certificates: [{ Id: 731, Name: "EPC", CertificateType: en("EPC"), StartDate: stamp(1, 0), ExpiryDate: "2036-09-01T00:00:00Z", ReceivedDate: stamp(2, 0), Expired: false, Status: "Valid", Documents: [doc(55003, "epc-12-high-street.pdf", "Certificate", "https://api.dezrez.com/api/document/55003/download")] }],
    DefaultPicture: doc(55010, "front.jpg", "Photo", "https://cdn.example.com/photos/55010.jpg", { ContentType: "image/jpeg", FileExtension: ".jpg", RequiresAuthentication: false }),
    CustomFields: [{ Name: "Marketing", Values: [{ Type: en("Text"), Name: "Vendor mobile", Value: "07700 900456" }, { Type: en("Text"), Name: "Board", Value: "Yes, slip on" }, { Type: en("Text"), Name: "Notes", Value: "Neighbour at no. 14 (020 7946 0958) holds a spare key" }] }],
    RetentionAmount: 250,
    PreApprovedSpendAmount: 100,
  },
  {
    Id: PROPERTY_FLAT,
    Address: FLAT_ADDR,
    SystemStatusName: "Active",
    Roles: [FLAT_ROLE],
    InactiveRoleIds: [],
    Keys: [],
    Alarms: [],
    SpecialArrangements: [],
    Certificates: [{ Id: 732, Name: "Gas safety", CertificateType: en("GasSafety"), StartDate: stamp(1, 0), ExpiryDate: "2027-09-01T00:00:00Z", Expired: false, Status: "Valid", Documents: [] }],
    CustomFields: [],
  },
  { Id: PROPERTY_WITHDRAWN, Address: WITHDRAWN_ADDR, SystemStatusName: "Active", Roles: [WITHDRAWN_ROLE], InactiveRoleIds: [], Keys: [], Alarms: [], SpecialArrangements: [], Certificates: [], CustomFields: [] },
];

// EventListPeopleGroupDataContract
const eventGroup = (id, name, primary, extra = {}) => ({ Id: id, Name: name, GroupType: en("Individual"), GroupIcon: en("House"), Grade: en("Hot"), FinancialStatus: en("MortgageAgreedInPrinciple"), PrimaryGroupMember: primary, BranchId: BRANCH_BRISTOL, OwningTeamId: 1, TeamAccessType: "FullAccess", ...extra });
const EVANS_EVENT_GROUP = eventGroup(GROUP_EVANS, "Mr and Mrs Evans", SAM_BASIC);
const PATEL_EVENT_GROUP = eventGroup(GROUP_PATEL, "Mr Patel", PATEL_BASIC);
// ListPropertyDataContract
const listProperty = (id, a, bedrooms, owningGroup, roles) => ({ Id: id, Address: { Number: a.Number, BuildingName: a.BuildingName, Street: a.Street, Town: a.Town, Locality: a.Locality, County: a.County, Postcode: a.Postcode, LatitudeLongitude: a.Location ? `${a.Location.CenterPoint.Latitude},${a.Location.CenterPoint.Longitude}` : undefined }, Bedrooms: bedrooms, PropertyType: en("SemiDetached"), OwningGroup: owningGroup, PropertyRoles: roles });
const HIGH_ST_LIST = listProperty(PROPERTY_HIGH_ST, HIGH_ST_ADDR, 3, PATEL_EVENT_GROUP, [HIGH_ST_ROLE]);
const FLAT_LIST = listProperty(PROPERTY_FLAT, FLAT_ADDR, 1, undefined, [FLAT_ROLE]);
// EventListRoleDataContract
const eventRole = (r, a, groupName) => ({ Id: r.Id, Name: r.Name, RoleType: r.RoleType, Rolestatus: r.RoleStatus, PropertyAddress: [a.Number, a.Street, a.Town, a.Postcode].filter(Boolean).join(", "), GroupName: groupName, PropertyId: undefined, CompletedMilestones: 2, TotalMilestones: 8 });

// EventListDataContract
const event = (id, { name, type, category, status = "Confirmed", when, branch = BRANCH_BRISTOL, properties = [HIGH_ST_LIST], roles = [eventRole(HIGH_ST_ROLE, HIGH_ST_ADDR, "Mr Patel")], ...rest }) => ({
  Id: id,
  Name: name,
  Description: rest.description,
  DateTime: when,
  StartDate: rest.start ?? when,
  EndDate: rest.end,
  AllDayEvent: false,
  EventCategory: en(category),
  EventType: en(type),
  EventStatus: en(status),
  Properties: properties,
  Roles: roles,
  AttendingGroups: rest.attending ?? [],
  Notes: rest.notes ?? [],
  Negotiators: rest.negotiators ?? [JO],
  Branch: { Id: branch, Name: branch === BRANCH_BRISTOL ? "Bristol" : "Cardiff", VAT: "GB123456789" },
  BranchId: branch,
  OwningTeamId: 1,
  TeamAccessType: "FullAccess",
  Prices: rest.prices ?? [],
  PriceType: rest.priceType,
  OfferStatus: rest.offerStatus,
  Descriptions: rest.descriptions,
  Dates: rest.dates,
  MethodOfContact: rest.methodOfContact,
  KeySignedOut: rest.keySignedOut,
  DocumentIds: rest.documentIds ?? [],
  Pinned: rest.pinned ?? false,
  IsOriginal: true,
  Source: rest.source,
  CreatedDate: when,
  CreatedBy: JO,
  Count: 1,
});

const samAttending = { EventId: 0, Type: en("Applicant"), Group: EVANS_EVENT_GROUP, AttendingPeople: [{ Id: PERSON_SAM, FirstName: "Sam", LastName: "Evans", Address: contact("Email", "sam.evans@example.com", 7302) }, { Id: PERSON_ALEX, FirstName: "Alex", LastName: "Evans", Address: contact("Mobile", "07700 900321", 7401) }] };

// 25 events on 12 High Street: 3 pages of 10 at the mock's page size. Newest first, like a timeline.
export const propertyEvents = {
  [PROPERTY_HIGH_ST]: [
    event(10001, {
      name: "Offer accepted",
      type: "Offer",
      category: "Sales",
      when: stamp(22, 14),
      offerStatus: en("Accepted"),
      prices: [{ Name: "Offer", Value: 425000, Currency: "GBP", Text: "£425,000" }],
      priceType: en("Fixed"),
      attending: [samAttending],
      notes: [{ Id: 20001, Note: "Sam said to call her on 07700 900789 or mail sam.evans@example.com to arrange the survey", CreatedDate: stamp(22, 14, 5), NegotiatorId: PERSON_JO, ApplicableToGroupIds: [GROUP_EVANS] }],
      description: "Offer of £425,000 from Mr and Mrs Evans, accepted by Mr Patel (raj.patel@example.com)",
      dates: { OfferMade: stamp(21, 10), OfferAccepted: stamp(22, 14) },
      methodOfContact: en("Telephone"),
    }),
    event(10002, {
      name: "Second viewing",
      type: "Viewing",
      category: "Sales",
      when: stamp(18, 10),
      start: stamp(18, 10),
      end: stamp(18, 10, 30),
      attending: [{ ...samAttending, EventId: 10002 }],
      notes: [{ Id: 20002, Note: "Measured the kitchen. Feedback: loved it.", CreatedDate: stamp(18, 11), NegotiatorId: PERSON_JO }],
      keySignedOut: { KeyId: 701, Name: "Front door set", Code: "K-0042", GroupId: GROUP_EVANS, GroupName: "Mr and Mrs Evans", PersonId: PERSON_SAM, PersonName: "Sam Evans" },
      descriptions: { Feedback: "Loved it, will offer" },
    }),
    event(10003, { name: "Cancelled viewing", type: "Viewing", category: "Sales", status: "Cancelled", when: stamp(15, 16), attending: [{ EventId: 10003, Type: en("Applicant"), Group: eventGroup(GROUP_CHEN, "Lee Chen (lee.chen@example.net)", LEE_BASIC), AttendingPeople: [{ Id: PERSON_LEE, FirstName: "Lee", LastName: "Chen" }] }] }),
    event(10004, { name: "Price reduced", type: "PriceChange", category: "Sales", when: stamp(12, 9), prices: [{ Name: "Asking", Value: 435000, Currency: "GBP", Text: "£435,000" }], priceType: en("OffersOver") }),
    event(10005, { name: "Cardiff office note", type: "Note", category: "General", when: stamp(11, 9), branch: BRANCH_CARDIFF, notes: [{ Id: 20005, Note: "Vendor moving to Cardiff, wants a letting valuation", CreatedDate: stamp(11, 9), NegotiatorId: PERSON_JO }] }),
    ...Array.from({ length: 20 }, (_, i) =>
      event(10006 + i, {
        name: i % 2 ? `Viewing ${i + 1}` : `Note ${i + 1}`,
        type: i % 2 ? "Viewing" : "Note",
        category: i % 2 ? "Sales" : "General",
        when: stamp(10 - Math.floor(i / 3), 9 + (i % 8)),
        attending: i % 2 ? [{ EventId: 10006 + i, Type: en("Applicant"), Group: eventGroup(3100 + i, `Applicant ${i + 1}`, { Id: 7800 + i, FirstName: "Applicant", LastName: `Number${i + 1}` }), AttendingPeople: [{ Id: 7800 + i, FirstName: "Applicant", LastName: `Number${i + 1}` }] }] : [],
        notes: i % 2 ? [] : [{ Id: 20006 + i, Note: `Routine note ${i + 1}`, CreatedDate: stamp(10 - Math.floor(i / 3), 9 + (i % 8)), NegotiatorId: PERSON_JO }],
      }),
    ),
  ],
  [PROPERTY_FLAT]: [
    event(10101, { name: "Letting valuation", type: "Valuation", category: "Lettings", when: stamp(5, 11), branch: BRANCH_CARDIFF, properties: [FLAT_LIST], roles: [eventRole(FLAT_ROLE, FLAT_ADDR, "Mr Patel")] }),
  ],
  [PROPERTY_WITHDRAWN]: [],
};

// Events on the Evans group: two on 12 High Street (one on the sale role), one on the flat, one draft.
export const groupEvents = {
  [GROUP_EVANS]: [
    propertyEvents[PROPERTY_HIGH_ST][0],
    propertyEvents[PROPERTY_HIGH_ST][1],
    event(10201, { name: "Viewing", type: "Viewing", category: "Lettings", when: stamp(8, 12), branch: BRANCH_CARDIFF, properties: [FLAT_LIST], roles: [eventRole(FLAT_ROLE, FLAT_ADDR, "Mr Patel")], attending: [{ ...samAttending, EventId: 10201 }] }),
    event(10202, { name: "Draft call-back", type: "Task", category: "General", status: "Draft", when: stamp(25, 9), properties: [], roles: [] }),
  ],
  [GROUP_PATEL]: [propertyEvents[PROPERTY_HIGH_ST][0]],
  [GROUP_CHEN]: [propertyEvents[PROPERTY_HIGH_ST][2]],
};

// PersonDataContract
const personRec = (basic, extra) => ({
  ...basic,
  GroupCount: extra.groupMemberships?.length ?? 0,
  GroupMemberships: (extra.groupMemberships ?? []).map((g, i) => ({ Id: 4000 + basic.Id + i, Group: { ...groupRef(g.id, g.name, g.type), GroupBackgroundImageUrl: undefined }, RelationshipType: en(g.relationship ?? "PrimaryGroupMember"), SystemStatus: en("Active") })),
  GroupIds: (extra.groupMemberships ?? []).map((g) => g.id),
  ContactItems: extra.contactItems ?? [basic.PrimaryTelephone, basic.PrimaryEmail].filter(Boolean),
  Addresses: extra.addresses ?? [],
  ArchivedAddresses: extra.archivedAddresses ?? [],
  MarketingPreferences: [{ Id: 5001 + basic.Id, ServiceType: en("Sales"), ServiceStatusType: en("OptedIn"), Referral: false }],
  HasBankAccounts: extra.hasBankAccounts ?? false,
  Note: extra.note,
  AdditionalInformation: extra.additionalInformation,
  CustomFields: extra.customFields ?? [],
  CreatedDate: stamp(1, 8),
  CreatedBy: JO,
});

export const people = [
  personRec(SAM_BASIC, {
    groupMemberships: [{ id: GROUP_EVANS, name: "Mr and Mrs Evans" }],
    contactItems: [SAM_BASIC.PrimaryTelephone, SAM_BASIC.PrimaryEmail, contact("Work", "020 7946 0958", 7303, { Notes: "Reception, ask for Sam", MarketingContactStatus: en("DoNotContact") })],
    addresses: [SAM_HOME],
    archivedAddresses: [{ ...addr(612, { Number: "2", Street: "Old Lane", Town: "Bath", Postcode: "BA1 1AA" }), AddressType: en("Previous") }],
    note: "Prefers email: sam.evans@example.com. Do not call before 10am.",
    hasBankAccounts: true,
    additionalInformation: {
      ProofOfIdReceived: true,
      ProofOfAddressReceived: true,
      ProofOfSanctionsReceived: false,
      RightToRentReceived: true,
      RightToRentType: en("Passport"),
      TOBSigned: false,
      NRLStatus: false,
      Documents: [doc(55001, "passport-sam-evans.pdf", "ProofOfId", PASSPORT_URL)],
      HousingBenefit: { LocalAuthorityId: 12, ReceivesBenefits: false, Id: 1 },
      RightToRentStatus: 1,
      ProofOfIdStatus: 1,
      ProofOfAddressStatus: 1,
      ProofOfSanctionsStatus: 0,
    },
    customFields: [{ Name: "KYC", Values: [{ Type: en("Date"), Name: "Date of birth", Value: "1990-04-12" }, { Type: en("Text"), Name: "Source", Value: "Rightmove" }, { Type: en("Text"), Name: "Comments", Value: "Sister on 07700 900999 can let us in" }] }],
  }),
  personRec(PRIYA_BASIC, { groupMemberships: [{ id: 3004, name: "Dr Shah" }], addresses: [{ ...addr(613, { Number: "9", Street: "Queen Square", Town: "Bristol", Postcode: "BS1 4NT" }), AddressType: en("Home") }] }),
  personRec(LEE_BASIC, { groupMemberships: [{ id: GROUP_CHEN, name: "Lee Chen (lee.chen@example.net)" }] }),
  personRec(ALEX_BASIC, { groupMemberships: [{ id: GROUP_EVANS, name: "Mr and Mrs Evans", relationship: "GroupMember" }], addresses: [SAM_HOME] }),
  personRec(PATEL_BASIC, { groupMemberships: [{ id: GROUP_PATEL, name: "Mr Patel" }], addresses: [{ ...HIGH_ST_ADDR, Id: 614, AddressType: en("Home") }], hasBankAccounts: true }),
  personRec(JO_AS_PERSON, { groupMemberships: [] }),
];

// BasicPersonRoleDataContract: Sam is buying 12 High Street, renting the flat and has ten older roles.
const basicRole = (roleId, propertyId, a, roleType, status, price, priceType, extra = {}) => ({ RoleId: roleId, PropertyId: propertyId, Address: a, RoleType: roleType, PropertyStatus: status, Price: price, PriceType: priceType, OfferCount: 0, ViewingCount: 0, ...extra });
export const personRoles = {
  [PERSON_SAM]: [
    basicRole(8201, PROPERTY_HIGH_ST, HIGH_ST_ADDR, "Buying", "OfferAccepted", 435000, "OffersOver", { OfferCount: 1, OfferAcceptedPrice: 425000, ViewingCount: 2, PrimaryPhoto: doc(55010, "front.jpg", "Photo", "https://cdn.example.com/photos/55010.jpg", { ContentType: "image/jpeg", FileExtension: ".jpg", RequiresAuthentication: false }) }),
    basicRole(8202, PROPERTY_FLAT, FLAT_ADDR, "Renting", "Available", 950, "PerMonth", { ViewingCount: 1 }),
    ...Array.from({ length: 10 }, (_, i) => basicRole(8210 + i, 600 + i, addr(620 + i, { Number: String(i + 1), Street: "Archive Street", Town: "Bristol", Postcode: "BS2 0AA" }), "Buying", "Completed", 200000 + i * 1000, "Fixed")),
  ],
  [PERSON_PRIYA]: [],
  [PERSON_LEE]: [basicRole(8301, PROPERTY_HIGH_ST, HIGH_ST_ADDR, "Buying", "Withdrawn", 435000, "OffersOver")],
  [PERSON_ALEX]: [],
  [PERSON_PATEL]: [basicRole(8401, PROPERTY_HIGH_ST, HIGH_ST_ADDR, "Selling", "OfferAccepted", 435000, "OffersOver", { OfferCount: 2, OfferAcceptedPrice: 425000, ViewingCount: 12 })],
  [PERSON_JO]: [],
};

// GroupMemberDataContract
const member = (id, basic, relationship, order, extra = {}) => ({ Id: id, Person: { ...basic, ContactItems: [basic.PrimaryTelephone, basic.PrimaryEmail].filter(Boolean), Addresses: extra.addresses ?? [], MarketingPreferences: [], ExternalApplicantReference: extra.ref }, RelationshipType: en(relationship), SystemStatus: en("Active"), Order: order });

// GroupDataContract
export const groups = [
  {
    ...groupRef(GROUP_EVANS, "Mr and Mrs Evans"),
    Description: "First-time buyers, chain free. Sam: sam.evans@example.com",
    Notes: "Ring Alex on 07700 900321 in the evenings",
    Members: [member(4101, SAM_BASIC, "PrimaryGroupMember", 1, { addresses: [SAM_HOME], ref: "RM-88123" }), member(4102, ALEX_BASIC, "GroupMember", 2, { addresses: [SAM_HOME] })],
    PreferredCompanies: [{ Id: 4201, Group: groupRef(3901, "Bristol Solicitors LLP", "Company"), PreferredContactId: 7901, CompanyServiceTypes: ["Conveyancing"], CreatedDate: stamp(2, 9), CreatedBy: JO }],
    AdditionalQuestions: { ArrangedMortgage: true, MortgageProvider: "Example Building Society (adviser 0117 496 0222)", HowLongToMove: "3 months", ReasonForMoving: "Growing family", HowHeard: "Rightmove", BestTimeToCall: "Evenings", HappyToReceivePropertyEmails: true, ViewedAnyProperties: true, LocalOwnToSell: false, CurrentlyOnMarket: false, CurrentStatus: en("FirstTimeBuyer"), Financial: en("MortgageAgreedInPrinciple"), Reason: en("Upsizing") },
    Separated: false,
    CustomFields: [{ Name: "Compliance", Values: [{ Type: en("Text"), Name: "AML check", Value: "Passed 2026-09-03" }, { Type: en("Text"), Name: "Contact email", Value: "sam.evans@example.com" }] }],
    CreatedDate: stamp(1, 8),
    CreatedBy: JO,
  },
  { ...groupRef(GROUP_PATEL, "Mr Patel"), Members: [member(4111, PATEL_BASIC, "PrimaryGroupMember", 1, { addresses: [{ ...HIGH_ST_ADDR, Id: 614, AddressType: en("Home") }] })], PreferredCompanies: [], Separated: false, CustomFields: [], CreatedDate: stamp(1, 8), CreatedBy: JO },
  { ...groupRef(GROUP_CHEN, "Lee Chen (lee.chen@example.net)"), Members: [member(4121, LEE_BASIC, "PrimaryGroupMember", 1)], PreferredCompanies: [], Separated: false, CustomFields: [], CreatedDate: stamp(1, 8), CreatedBy: JO },
];

// OfferGroupDataContract
const offerGroup = (id, name, primary, grade) => ({ Id: id, Name: name, GroupType: en("Individual"), GroupIcon: en("House"), Grade: en(grade), PrimaryMember: personRec(primary, {}), CustomFields: [], CreatedDate: stamp(1, 8), CreatedBy: JO });
// OfferDataContract
const offerRec = (id, { value, status, when, property = properties[0], role = HIGH_ST_ROLE, applicant, vendor, response, notes = [], documents = [], name, onBehalfOf, validFor = 7 }) => ({
  Id: id,
  Name: name ?? `Offer of £${value.toLocaleString("en-GB")}`,
  Description: undefined,
  Value: value,
  ValidFor: validFor,
  Property: { Id: property.Id, Address: property.Address },
  ApplicantGroup: applicant,
  VendorGroup: vendor,
  MarketingRoleId: role.Id,
  Roles: [role],
  RoleType: role.RoleType,
  MarketedPrice: { Id: 6001, PriceValue: 435000, CurrencyCode: "GBP", PriceText: "£435,000", PriceType: en("Asking"), PriceQualifierType: en("OffersOver") },
  OnBehalfOf: onBehalfOf,
  LastUpdated: when,
  Team: { Id: 1, Name: "Bristol Sales", CreatedDate: stamp(1, 8), CreatedBy: JO },
  Notes: notes,
  Documents: documents,
  DateTime: when,
  EventCategory: en("Sales"),
  EventType: en("Offer"),
  EventStatus: en(status),
  Negotiators: [JO],
  BranchId: BRANCH_BRISTOL,
  OwningTeamId: 1,
  TeamAccessType: "FullAccess",
  CustomFields: [],
  CreatedDate: when,
  CreatedBy: JO,
  Response: response,
  VendorCommunication: response ? { Id: id * 10 + 2, Name: "Vendor told by phone", DateTime: when, EventStatus: en("Completed"), Notes: ["Raj happy, call him back on (0117) 496 0111 about the survey date"], Negotiators: [{ ...JO }] } : undefined,
});
const EVANS_OFFER_GROUP = offerGroup(GROUP_EVANS, "Mr and Mrs Evans", SAM_BASIC, "Hot");
const PATEL_OFFER_GROUP = offerGroup(GROUP_PATEL, "Mr Patel", PATEL_BASIC, "Warm");

export const offers = [
  offerRec(OFFER_MAIN, {
    value: 425000,
    status: "Accepted",
    when: stamp(22, 14),
    applicant: EVANS_OFFER_GROUP,
    vendor: PATEL_OFFER_GROUP,
    onBehalfOf: "Mr and Mrs Evans (sam.evans@example.com)",
    response: { Id: 90011, OfferId: OFFER_MAIN, ResponseType: en("Accepted"), DateTime: stamp(22, 14), Name: "Accepted", EventCategory: en("Sales"), EventType: en("OfferResponse"), EventStatus: en("Completed"), Notes: [{ Id: 90012, Note: "Accepted subject to survey", DateAdded: stamp(22, 14), NegotiatorId: PERSON_JO, NegotiatorName: "Jo Bloggs", NegotiatorEmail: contact("Email", "jo.bloggs@example.org", 7202) }], Negotiators: [JO], BranchId: BRANCH_BRISTOL, CreatedDate: stamp(22, 14), CreatedBy: JO },
    notes: [{ Id: 90013, Note: "Proof of funds received; solicitor is Bristol Solicitors, ring 0117 496 0333", DateAdded: stamp(21, 10), NegotiatorId: PERSON_JO, NegotiatorName: "Jo Bloggs", NegotiatorEmail: contact("Email", "jo.bloggs@example.org", 7202) }],
    documents: [doc(55002, "proof-of-funds-evans.pdf", "ProofOfFunds", PROOF_OF_FUNDS_URL)],
  }),
  offerRec(9002, { value: 410000, status: "Rejected", when: stamp(16, 9), applicant: offerGroup(GROUP_CHEN, "Lee Chen (lee.chen@example.net)", LEE_BASIC, "Cold"), vendor: PATEL_OFFER_GROUP, response: { Id: 90021, OfferId: 9002, ResponseType: en("Rejected"), DateTime: stamp(16, 12), Name: "Rejected", EventCategory: en("Sales"), EventType: en("OfferResponse"), EventStatus: en("Completed"), Notes: [], Negotiators: [JO], BranchId: BRANCH_BRISTOL, CreatedDate: stamp(16, 12), CreatedBy: JO } }),
  ...Array.from({ length: 10 }, (_, i) => offerRec(9003 + i, { value: 300000 + i * 5000, status: "Withdrawn", when: stamp(2 + i, 10), property: properties[2], role: WITHDRAWN_ROLE, applicant: offerGroup(3200 + i, `Applicant ${i + 1}`, { Id: 7900 + i, FirstName: "Applicant", LastName: `Number${i + 1}` }, "Cold"), vendor: offerGroup(3300 + i, `Vendor ${i + 1}`, { Id: 7950 + i, FirstName: "Vendor", LastName: `Number${i + 1}` }, "Warm") })),
];

// PropertyOwnerDataContract
const ownerRec = (g) => ({ Id: g.Id, Name: g.Name, Description: g.Description, GroupType: g.GroupType, GroupIcon: g.GroupIcon, Notes: g.Notes, Members: g.Members, OwningTeamId: 1, BranchId: BRANCH_BRISTOL, TeamAccessType: "FullAccess" });
// PropertyRoleSuggestResultDataContract (GET /api/role/suggest). isOnMarket and the role fields are
// what the mock filters on.
export const roleSuggestions = [
  { PropertyId: PROPERTY_HIGH_ST, Address: HIGH_ST_ADDR, DefaultPicture: properties[0].DefaultPicture, PropertyRole: HIGH_ST_ROLE, Owner: ownerRec(groups[1]), Prices: [{ Id: 6001, PriceValue: 435000, CurrencyCode: "GBP", PriceText: "£435,000", PriceType: en("Asking"), PriceQualifierType: en("OffersOver") }], SummaryText: "3 bed semi, offer accepted. Vendor Raj on 07700 900222", isOnMarket: true },
  { PropertyId: PROPERTY_FLAT, Address: FLAT_ADDR, PropertyRole: FLAT_ROLE, Owner: ownerRec(groups[1]), Prices: [{ Id: 6002, PriceValue: 950, CurrencyCode: "GBP", PriceText: "£950 pcm", PriceType: en("Rent"), PriceQualifierType: en("PerMonth") }], SummaryText: "1 bed flat, available now", isOnMarket: true },
  { PropertyId: PROPERTY_WITHDRAWN, Address: WITHDRAWN_ADDR, PropertyRole: WITHDRAWN_ROLE, Owner: ownerRec(groups[2]), Prices: [{ Id: 6003, PriceValue: 310000, CurrencyCode: "GBP", PriceText: "£310,000", PriceType: en("Asking"), PriceQualifierType: en("GuidePrice") }], SummaryText: "Withdrawn in August", isOnMarket: false },
];
