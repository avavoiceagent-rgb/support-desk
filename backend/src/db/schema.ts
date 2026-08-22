// Drizzle ORM schema for the email ticketing system.
// Naming is provider-agnostic (providerThreadId, providerMessageId, etc.)
// so a second MailProvider (e.g. Outlook/Microsoft Graph) can be added later
// without a data migration.

import {
  pgTable,
  pgEnum,
  doublePrecision,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  serial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

import type { TicketStatus, TicketQueue, TicketChannel, ReservationType, ReservationSource } from "../types";

export const userRoleEnum = pgEnum("user_role", ["ADMIN", "AGENT"]);
export const mailProviderEnum = pgEnum("mail_provider_type", ["GMAIL", "OUTLOOK"]);
export const messageDirectionEnum = pgEnum("message_direction", ["INBOUND", "OUTBOUND"]);

const cuid = () => text("id").primaryKey().$defaultFn(() => createId());

export const users = pgTable("users", {
  id: cuid(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("AGENT"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const emailAccounts = pgTable("email_accounts", {
  id: cuid(),
  provider: mailProviderEnum("provider").notNull(),
  email: text("email").notNull().unique(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenAuthTag: text("token_auth_tag").notNull(),
  syncCursor: text("sync_cursor"),
  status: text("status").notNull().default("connected"), // connected | disconnected | error
  lastError: text("last_error"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tickets = pgTable(
  "tickets",
  {
    id: cuid(),
    ticketNumber: serial("ticket_number").notNull(),
    subject: text("subject").notNull(),
    requesterEmail: text("requester_email"),
    requesterName: text("requester_name"),
    requesterPhone: text("requester_phone"),
    // Status is a plain text column (validated in the API layer) so new
    // statuses can be added without a Postgres enum migration.
    status: text("status").$type<TicketStatus>().notNull().default("OPEN"),
    queue: text("queue").$type<TicketQueue>(),
    channel: text("channel").$type<TicketChannel>().notNull().default("EMAIL"),
    // Machine-generated mail (newsletters, marketing, auto-replies). Bulk
    // tickets are created already closed and are excluded from the Active
    // list and from every SLA / Dashboard / Reports calculation.
    isBulk: boolean("is_bulk").notNull().default(false),
    // --- AI triage (see ai/classifier.ts). All nullable: a ticket is never
    // blocked on classification, and a human editing any of these clears
    // autoClassified so it is obvious who decided what.
    reservationType: text("reservation_type").$type<ReservationType>(),
    reservationSource: text("reservation_source").$type<ReservationSource>(),
    autoClassified: boolean("auto_classified").notNull().default(false),
    classificationReason: text("classification_reason"),
    classificationConfidence: text("classification_confidence"),
    providerThreadId: text("provider_thread_id").notNull(),
    emailAccountId: text("email_account_id")
      .notNull()
      .references(() => emailAccounts.id),
    assigneeId: text("assignee_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tickets_ticket_number_key").on(t.ticketNumber),
    uniqueIndex("tickets_account_thread_key").on(t.emailAccountId, t.providerThreadId),
    index("tickets_status_idx").on(t.status),
    index("tickets_is_bulk_idx").on(t.isBulk),
    index("tickets_assignee_idx").on(t.assigneeId),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: cuid(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    authorId: text("author_id").references(() => users.id),
    fromAddress: text("from_address").notNull(),
    toAddresses: jsonb("to_addresses").notNull().$type<string[]>(),
    ccAddresses: jsonb("cc_addresses").notNull().$type<string[]>(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    providerMessageId: text("provider_message_id").notNull().unique(),
    providerThreadId: text("provider_thread_id").notNull(),
    messageIdHeader: text("message_id_header"),
    inReplyToHeader: text("in_reply_to_header"),
    referencesHeader: text("references_header"),
    isAutoReply: boolean("is_auto_reply").notNull().default(false),
    sentAt: timestamp("sent_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_ticket_idx").on(t.ticketId)]
);

/**
 * A reply Adam has drafted for a ticket. Never sent automatically: a person
 * opens the ticket, reads it, edits it and sends it under their own name.
 * One per ticket — regenerating replaces it.
 */
export const ticketDrafts = pgTable("ticket_drafts", {
  id: cuid(),
  ticketId: text("ticket_id")
    .notNull()
    .unique()
    .references(() => tickets.id, { onDelete: "cascade" }),
  /** Body with a {{AGENT_NAME}} placeholder, filled in when it is served. */
  bodyHtml: text("body_html").notNull(),
  /** What the draft states as established fact, for the reviewer to scan. */
  confirmations: jsonb("confirmations").notNull().$type<string[]>(),
  /** What it asks the customer for. */
  questions: jsonb("questions").notNull().$type<string[]>(),
  /** Warnings for the reviewer only — never sent. */
  internalNotes: jsonb("internal_notes").notNull().$type<string[]>(),
  /** The indicative market rate and its sources, if one was found. */
  rate: jsonb("rate").$type<unknown>(),
  /** READY (awaiting review) | USED (loaded into the composer) | DISMISSED */
  status: text("status").notNull().default("READY"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const ticketDraftsRelations = relations(ticketDrafts, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketDrafts.ticketId], references: [tickets.id] }),
}));

export const attachments = pgTable(
  "attachments",
  {
    id: cuid(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)]
);

export const notes = pgTable(
  "notes",
  {
    id: cuid(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("notes_ticket_idx").on(t.ticketId)]
);

// --- Relations (used for query API convenience) ---

export const usersRelations = relations(users, ({ many }) => ({
  assignedTickets: many(tickets),
  notes: many(notes),
  sentMessages: many(messages),
}));

export const emailAccountsRelations = relations(emailAccounts, ({ many }) => ({
  tickets: many(tickets),
}));

export const ticketsRelations = relations(tickets, ({ one, many }) => ({
  emailAccount: one(emailAccounts, { fields: [tickets.emailAccountId], references: [emailAccounts.id] }),
  assignee: one(users, { fields: [tickets.assigneeId], references: [users.id] }),
  messages: many(messages),
  notes: many(notes),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  ticket: one(tickets, { fields: [messages.ticketId], references: [tickets.id] }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
  attachments: many(attachments),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
}));

export const notesRelations = relations(notes, ({ one }) => ({
  ticket: one(tickets, { fields: [notes.ticketId], references: [tickets.id] }),
  author: one(users, { fields: [notes.authorId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Operations: who can drive, when, in what, and what it cost.
//
// This exists so Adam never has to guess at an operational fact. "Is anyone
// free at 3pm on the 24th", "who covers Philadelphia", "what did we charge
// this customer last month" are all questions with one correct answer, and a
// model asked to guess at them would sound just as confident when wrong.
// ---------------------------------------------------------------------------

export const vehicleClassEnum = pgEnum("vehicle_class", ["SEDAN", "SUV", "VAN", "SPRINTER"]);
export type VehicleClass = (typeof vehicleClassEnum.enumValues)[number];
export const tripStatusEnum = pgEnum("trip_status", [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);
export const assignedToEnum = pgEnum("assigned_to_kind", ["DRIVER", "AFFILIATE", "UNASSIGNED"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "SENT", "PAID", "DISPUTED", "VOID"]);

export const vehicles = pgTable("vehicles", {
  id: cuid(),
  /** What staff and customers call it: "Sedan 4", "SUV 2". */
  label: text("label").notNull(),
  class: vehicleClassEnum("class").notNull(),
  makeModel: text("make_model").notNull(),
  plate: text("plate").notNull(),
  passengerCapacity: integer("passenger_capacity").notNull(),
  luggageCapacity: integer("luggage_capacity").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const drivers = pgTable("drivers", {
  id: cuid(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  /** The vehicle they normally take out; shifts can override it. */
  defaultVehicleId: text("default_vehicle_id").references(() => vehicles.id),
  /** TLC / livery licence number — dispatch quotes it to airports. */
  licenceNumber: text("licence_number"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * When a driver is available to work. Availability is the SHIFT minus the
 * trips already assigned inside it — never a flag on the driver, which would
 * go stale the moment a trip moved.
 */
export const driverShifts = pgTable(
  "driver_shifts",
  {
    id: cuid(),
    driverId: text("driver_id").notNull().references(() => drivers.id, { onDelete: "cascade" }),
    vehicleId: text("vehicle_id").references(() => vehicles.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** Holiday, sickness, training — a shift that exists but cannot take work. */
    unavailable: boolean("unavailable").notNull().default(false),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("driver_shifts_driver_start_idx").on(t.driverId, t.startsAt)]
);

/** Partner operators who cover trips we cannot: out of area, or out of cars. */
export const affiliates = pgTable("affiliates", {
  id: cuid(),
  company: text("company").notNull(),
  contactName: text("contact_name"),
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  /** Where they operate: US state codes, plus "NY"/"NJ" for overflow partners. */
  coverageStates: jsonb("coverage_states").$type<string[]>().notNull().default([]),
  /** Cities they name as their own, for when a state is too coarse. */
  coverageCities: jsonb("coverage_cities").$type<string[]>().notNull().default([]),
  /** True for local partners who take our overflow when every car is busy. */
  overflowPartner: boolean("overflow_partner").notNull().default(false),
  /**
   * Flat fallback rate, in whole dollars, from before rate cards existed.
   * Used only when a partner has no zone covering the job.
   */
  hourlyRateUsd: integer("hourly_rate_usd"),
  /** Where their cars actually sit — the centre every distance band measures from. */
  baseAddress: text("base_address"),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  /** 1 (first call) to 5 (last resort), from experience. */
  preference: integer("preference").notNull().default(3),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * A partner's rate card, one row per distance band.
 *
 * Bands rather than named neighbourhoods because an address then lands in a
 * zone on its own: we already know where the partner is based and where the
 * job goes, and a mileage is arithmetic. Named zones would price more exactly
 * and need a person to decide which one "1 Hotel Brooklyn Bridge" belongs to
 * every time an unfamiliar address turns up.
 *
 * `toMiles` null means "and everything beyond", so a card always has a last
 * band that catches whatever the first ones did not.
 */
export const affiliateZones = pgTable(
  "affiliate_zones",
  {
    id: cuid(),
    affiliateId: text("affiliate_id")
      .notNull()
      .references(() => affiliates.id, { onDelete: "cascade" }),
    /** What the partner calls it on their own sheet: "Metro", "North Shore". */
    label: text("label").notNull(),
    fromMiles: integer("from_miles").notNull().default(0),
    toMiles: integer("to_miles"),
    /** The shortest this band is ever billed at. */
    minimumHours: integer("minimum_hours").notNull().default(2),
    /**
     * Hourly rate per class of car, in cents.
     *
     * Cents, like every other sum in this database. A class missing from here
     * means the partner does not offer it in this band, which is different
     * from offering it at nothing.
     */
    rateCents: jsonb("rate_cents").$type<Partial<Record<VehicleClass, number>>>().notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("affiliate_zones_affiliate_idx").on(t.affiliateId, t.sortOrder)]
);

export const trips = pgTable(
  "trips",
  {
    id: cuid(),
    /** Human reference quoted in email: "T-10432". */
    reference: text("reference").notNull().unique(),
    /** The ticket this came from, when it came from email at all. */
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),

    passengerName: text("passenger_name").notNull(),
    passengerPhone: text("passenger_phone"),
    bookerName: text("booker_name"),
    bookerEmail: text("booker_email"),

    pickupAddress: text("pickup_address").notNull(),
    dropoffAddress: text("dropoff_address").notNull(),
    stops: jsonb("stops").$type<string[]>().notNull().default([]),
    pickupAt: timestamp("pickup_at", { withTimezone: true }).notNull(),
    /** Hours booked. Everything here is charged as directed, by the hour. */
    bookedHours: integer("booked_hours").notNull().default(2),
    actualHours: integer("actual_hours"),

    vehicleClass: vehicleClassEnum("vehicle_class").notNull(),
    passengerCount: integer("passenger_count"),
    luggageCount: integer("luggage_count"),
    flightNumber: text("flight_number"),

    status: tripStatusEnum("status").notNull().default("SCHEDULED"),
    assignedKind: assignedToEnum("assigned_kind").notNull().default("UNASSIGNED"),
    driverId: text("driver_id").references(() => drivers.id),
    vehicleId: text("vehicle_id").references(() => vehicles.id),
    affiliateId: text("affiliate_id").references(() => affiliates.id),
    /** Why it went to a partner: OUT_OF_AREA or NO_VEHICLE. */
    farmOutReason: text("farm_out_reason"),

    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("trips_pickup_idx").on(t.pickupAt),
    index("trips_driver_pickup_idx").on(t.driverId, t.pickupAt),
    index("trips_booker_email_idx").on(t.bookerEmail),
  ]
);

export const invoices = pgTable("invoices", {
  id: cuid(),
  /** Quoted by customers in billing emails: "INV-10432". */
  reference: text("reference").notNull().unique(),
  tripId: text("trip_id").references(() => trips.id, { onDelete: "set null" }),
  billToName: text("bill_to_name").notNull(),
  billToEmail: text("bill_to_email").notNull(),
  issuedOn: timestamp("issued_on", { withTimezone: true }).notNull(),
  dueOn: timestamp("due_on", { withTimezone: true }),
  status: invoiceStatusEnum("status").notNull().default("SENT"),
  /** Cents throughout: money in floating point is how rounding bugs start. */
  subtotalCents: integer("subtotal_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  paidOn: timestamp("paid_on", { withTimezone: true }),
  disputeNote: text("dispute_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * One line per charge. Hourly is the main one; tolls, waiting and gratuity are
 * rows here rather than columns, so adding a charge type later is data entry
 * and not a migration.
 */
export const invoiceLines = pgTable("invoice_lines", {
  id: cuid(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  /** Hours, or 1 for a flat charge. Tenths of a unit, so 25 means 2.5 hours. */
  quantityTenths: integer("quantity_tenths").notNull().default(10),
  unitPriceCents: integer("unit_price_cents").notNull(),
  amountCents: integer("amount_cents").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const driversRelations = relations(drivers, ({ one, many }) => ({
  defaultVehicle: one(vehicles, { fields: [drivers.defaultVehicleId], references: [vehicles.id] }),
  shifts: many(driverShifts),
  trips: many(trips),
}));

export const driverShiftsRelations = relations(driverShifts, ({ one }) => ({
  driver: one(drivers, { fields: [driverShifts.driverId], references: [drivers.id] }),
  vehicle: one(vehicles, { fields: [driverShifts.vehicleId], references: [vehicles.id] }),
}));

export const tripsRelations = relations(trips, ({ one, many }) => ({
  driver: one(drivers, { fields: [trips.driverId], references: [drivers.id] }),
  vehicle: one(vehicles, { fields: [trips.vehicleId], references: [vehicles.id] }),
  affiliate: one(affiliates, { fields: [trips.affiliateId], references: [affiliates.id] }),
  ticket: one(tickets, { fields: [trips.ticketId], references: [tickets.id] }),
  invoices: many(invoices),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  trip: one(trips, { fields: [invoices.tripId], references: [trips.id] }),
  lines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));
