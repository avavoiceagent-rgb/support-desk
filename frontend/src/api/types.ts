export type TicketStatus = "OPEN" | "IN_PROGRESS" | "CLOSED";
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
  requesterEmail: string;
  requesterName: string | null;
  status: TicketStatus;
  assignee: { id: string; name: string; email: string } | null;
  mailbox: string;
  createdAt: string;
  updatedAt: string;
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
  sentAt: string;
  attachments: Attachment[];
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
  requesterEmail: string;
  requesterName: string | null;
  status: TicketStatus;
  providerThreadId: string;
  emailAccountId: string;
  assigneeId: string | null;
  assignee: PublicUser | null;
  emailAccount: { id: string; email: string; provider: "GMAIL" | "OUTLOOK" };
  createdAt: string;
  updatedAt: string;
  messages: TicketMessage[];
  notes: TicketNote[];
}

export interface EmailAccountStatus {
  id: string;
  provider: "GMAIL" | "OUTLOOK";
  email: string;
  status: string;
  lastError: string | null;
  connectedAt: string;
}
