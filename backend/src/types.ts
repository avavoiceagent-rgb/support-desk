export type TicketStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "AWAITING_CUSTOMER"
  | "AWAITING_DISPATCH"
  | "NO_RESPONSE"
  | "FOLLOW_UP"
  | "ESCALATED"
  | "FEEDBACK"
  | "AFFILIATE"
  | "RESOLVED_CLOSED"
  | "UNRESOLVED_CLOSED";

export const ALL_STATUSES: TicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_CUSTOMER",
  "AWAITING_DISPATCH",
  "NO_RESPONSE",
  "FOLLOW_UP",
  "ESCALATED",
  "FEEDBACK",
  "AFFILIATE",
  "RESOLVED_CLOSED",
  "UNRESOLVED_CLOSED",
];

/** Statuses that mean the ticket is finished. */
export const CLOSED_STATUSES: TicketStatus[] = ["RESOLVED_CLOSED", "UNRESOLVED_CLOSED"];

export type TicketQueue = "RESERVATION" | "DISPATCH" | "ACCOUNTING";
export const ALL_QUEUES: TicketQueue[] = ["RESERVATION", "DISPATCH", "ACCOUNTING"];

export type TicketChannel = "EMAIL" | "PHONE";

export type UserRole = "ADMIN" | "AGENT";
