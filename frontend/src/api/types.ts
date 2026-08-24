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

export type TicketQueue = "RESERVATION" | "DISPATCH" | "ACCOUNTING";
/** Reservation tickets carry two independent labels, not one combined one. */
export type ReservationType = "NEW" | "CHANGE";
export type ReservationSource = "INTERNAL" | "EXTERNAL";
export type TicketChannel = "EMAIL" | "PHONE";
export type UserRole = "ADMIN" | "AGENT";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface TicketListItem {
  id: string;
  ticketNumber: number;
  subject: string;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterPhone: string | null;
  status: TicketStatus;
  queue: TicketQueue | null;
  channel: TicketChannel;
  reservationType: ReservationType | null;
  reservationSource: ReservationSource | null;
  /** True while the labels above are still the ones AI triage chose. */
  autoClassified: boolean;
  classificationReason: string | null;
  classificationConfidence: string | null;
  /** Newsletter / marketing / auto-reply mail. Hidden from the normal tabs. */
  isBulk: boolean;
  assignee: { id: string; name: string; email: string } | null;
  mailbox: string;
  createdAt: string;
  updatedAt: string;
  receivedAt: string;
  firstReplyAt: string | null;
  lastMessagePreview: { direction: "INBOUND" | "OUTBOUND"; snippet: string; sentAt: string } | null;
}

export interface Attachment {
  id: string;
  messageId: string;
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  direction: "INBOUND" | "OUTBOUND";
  authorId: string | null;
  author: PublicUser | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  isAutoReply: boolean;
  /** Which bulk markers the email carried, by name. Empty for older messages. */
  bulkSignals: string[];
  sentAt: string;
  attachments: Attachment[];
}

/**
 * Something said to a driver or a partner about this ticket's booking.
 *
 * Internal without exception — none of it has ever been near the customer.
 */
export interface TicketDispatchEntry {
  id: string;
  at: string;
  direction: "OUT" | "IN";
  kind: "OFFER" | "ACCEPT" | "DECLINE" | "TEXT";
  body: string;
  contactKind: "DRIVER" | "AFFILIATE";
  contactName: string;
  authorName: string | null;
  actedByName: string | null;
}

export interface TicketNote {
  id: string;
  ticketId: string;
  authorId: string;
  author: PublicUser;
  body: string;
  createdAt: string;
}

export interface TicketDetail {
  id: string;
  ticketNumber: number;
  subject: string;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterPhone: string | null;
  status: TicketStatus;
  queue: TicketQueue | null;
  channel: TicketChannel;
  reservationType: ReservationType | null;
  reservationSource: ReservationSource | null;
  /** True while the labels above are still the ones AI triage chose. */
  autoClassified: boolean;
  classificationReason: string | null;
  classificationConfidence: string | null;
  providerThreadId: string;
  emailAccountId: string;
  assigneeId: string | null;
  assignee: PublicUser | null;
  emailAccount: { id: string; email: string; provider: "GMAIL" | "OUTLOOK" };
  createdAt: string;
  updatedAt: string;
  messages: TicketMessage[];
  notes: TicketNote[];
  /** Offers and answers about this ticket's booking. Empty when there is none. */
  dispatch: TicketDispatchEntry[];
}

export interface TicketHistoryItem {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  requesterEmail: string | null;
  requesterName: string | null;
  updatedAt: string;
  snippet: string;
}

export interface DashboardStats {
  totalTickets: number;
  byStatus: Record<string, number>;
  byQueue: Record<string, number>;
  byChannel: Record<string, number>;
  agents: { id: string | null; name: string; open: number; closed: number; total: number }[];
  sla: {
    targetHours: number;
    repliedCount: number;
    repliedWithinTarget: number;
    avgFirstReplyMs: number | null;
    awaitingReply: number;
    awaitingOverdue: number;
  };
  volume: { day: string; count: number }[];
}

export interface ReportsData {
  rangeDays: number;
  totals: {
    created: number;
    resolved: number;
    openNow: number;
    unassignedOpen: number;
    slaBreaches: number;
    avgFirstReplyMs: number | null;
    avgResolutionMs: number | null;
    repeatCustomerPct: number | null;
  };
  trend: { bucket: string; created: number; resolved: number }[];
  byStatus: Record<string, number>;
  byQueue: Record<string, number>;
  byChannel: Record<string, number>;
  oldestOpen: {
    id: string;
    ticketNumber: number;
    subject: string;
    status: TicketStatus;
    ageMs: number;
    assigneeId: string | null;
  }[];
  agents: {
    id: string;
    name: string;
    assigned: number;
    open: number;
    closed: number;
    repliesSent: number;
    notesAdded: number;
    avgFirstReplyMs: number | null;
    slaMetPct: number | null;
    avgResolutionMs: number | null;
  }[];
  customers: {
    label: string;
    email: string | null;
    tickets: number;
    open: number;
    closed: number;
    lastContact: string;
    avgFirstReplyMs: number | null;
  }[];
}

export interface EmailAccountStatus {
  id: string;
  provider: "GMAIL" | "OUTLOOK";
  email: string;
  status: string;
  lastError: string | null;
  connectedAt: string;
}
