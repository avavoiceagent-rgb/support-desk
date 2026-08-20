// Drizzle ORM schema for the email ticketing system.
// Naming is provider-agnostic (providerThreadId, providerMessageId, etc.)
// so a second MailProvider (e.g. Outlook/Microsoft Graph) can be added later
// without a data migration.

import {
  pgTable,
  pgEnum,
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
