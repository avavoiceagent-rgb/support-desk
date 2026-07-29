// Provider-agnostic mail integration contract. Implemented today by
// GmailProvider; an OutlookProvider (Microsoft Graph) can implement the same
// interface later without touching ingest.ts, threading.ts, or the routes.

export interface ProviderCursor {
  /** Opaque per-provider cursor (e.g. Gmail's `historyId` or a Graph deltaLink). */
  raw: string;
}

export interface NormalizedAttachment {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface NormalizedEmail {
  providerMessageId: string;
  providerThreadId: string;
  messageIdHeader?: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: NormalizedAttachment[];
  receivedAt: Date;
  /** Parsed from Auto-Submitted / Precedence headers. */
  isAutoReply: boolean;
}

export interface SendReplyParams {
  threadId: string;
  inReplyToMessageIdHeader?: string;
  referencesHeader?: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyHtml: string;
}

export interface SendReplyResult {
  providerMessageId: string;
  providerThreadId: string;
  messageIdHeader: string;
  sentAt: Date;
}

export interface ConnectedAccountInfo {
  accountEmail: string;
  refreshToken: string;
}

export interface MailProvider {
  readonly type: "GMAIL" | "OUTLOOK";

  /** Build the URL the team member is sent to in order to grant mailbox access. */
  getAuthUrl(state: string): string;

  /** Exchange an OAuth callback `code` for a long-lived refresh token. */
  handleOAuthCallback(code: string): Promise<ConnectedAccountInfo>;

  /**
   * Fetch new inbound messages since `cursor`. Pass `null` on first run.
   * Implementations must be safe to call repeatedly with the same cursor
   * (e.g. after a crash) without producing duplicate NormalizedEmail entries
   * for the same providerMessageId — callers additionally enforce this via a
   * unique constraint on Message.providerMessageId, so this is defense in depth.
   */
  listNewMessages(
    refreshToken: string,
    cursor: ProviderCursor | null
  ): Promise<{ messages: NormalizedEmail[]; nextCursor: ProviderCursor }>;

  sendReply(refreshToken: string, params: SendReplyParams): Promise<SendReplyResult>;

  getAttachment(
    refreshToken: string,
    providerMessageId: string,
    providerAttachmentId: string
  ): Promise<{ data: Buffer; mimeType: string; filename: string }>;
}
