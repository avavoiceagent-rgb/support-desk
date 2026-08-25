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

/**
 * Statuses that mean "the ball is in somebody else's court".
 *
 * A reply from the customer is exactly the event that ends that wait, so
 * these move back to IN_PROGRESS on their own when one arrives. Anything not
 * on this list is a state somebody chose for a reason a new email does not
 * settle: ESCALATED is still escalated, FEEDBACK is still awaiting feedback,
 * and AWAITING_DISPATCH is waiting on a driver rather than on the customer.
 */
export const AWAITING_CUSTOMER_STATUSES: TicketStatus[] = [
  "AWAITING_CUSTOMER",
  "NO_RESPONSE",
  "FOLLOW_UP",
];

export type TicketQueue = "RESERVATION" | "DISPATCH" | "ACCOUNTING";
export const ALL_QUEUES: TicketQueue[] = ["RESERVATION", "DISPATCH", "ACCOUNTING"];

/**
 * Reservation tickets carry two independent labels rather than one combined
 * sub-queue, so "a new booking that came from outside our area" can be both
 * NEW and EXTERNAL instead of forcing a choice between them.
 */
export type ReservationType = "NEW" | "CHANGE";
export const ALL_RESERVATION_TYPES: ReservationType[] = ["NEW", "CHANGE"];

export type ReservationSource = "INTERNAL" | "EXTERNAL";
export const ALL_RESERVATION_SOURCES: ReservationSource[] = ["INTERNAL", "EXTERNAL"];

/**
 * Where our own drivers operate. A trip that starts and ends inside this area
 * is INTERNAL; anything reaching outside it is farmed out, so EXTERNAL.
 * Edit this list if the service area changes.
 */
export const SERVICE_AREA = ["New York", "New Jersey"];

/**
 * The same area as US state codes, for deciding INTERNAL vs EXTERNAL from a
 * geocoded address rather than from a model's opinion. Keep in step with
 * SERVICE_AREA above.
 */
export const SERVICE_AREA_STATES = ["NY", "NJ"];

export type TicketChannel = "EMAIL" | "PHONE";

export type UserRole = "ADMIN" | "AGENT";
