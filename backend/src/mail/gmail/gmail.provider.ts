import { google, gmail_v1 } from "googleapis";
import {
  MailProvider,
  NormalizedEmail,
  NormalizedAttachment,
  ProviderCursor,
  SendReplyParams,
  SendReplyResult,
  ConnectedAccountInfo,
} from "../provider.interface";
import { buildAuthUrl, exchangeCodeForTokens, clientWithRefreshToken } from "./gmail.auth";
import { buildRawMimeMessage } from "./gmail.mime";

const SYNCED_LABEL_NAME = "TicketSystem/Synced";

// Bounded lookback window used as the primary poll filter. Combined with the
// "already labeled" exclusion below, steady-state polls only re-scan a few
// days of mail rather than the whole inbox, while staying self-healing if a
// poll is missed (e.g. server restart) — see plan doc for the reasoning
// behind skipping Gmail's history API (historyId expiry) for v1.
const LOOKBACK_WINDOW = "newer_than:7d";

async function getOrCreateSyncedLabelId(gmail: gmail_v1.Gmail): Promise<string> {
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = list.data.labels?.find((l) => l.name === SYNCED_LABEL_NAME);
  if (existing?.id) return existing.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: SYNCED_LABEL_NAME,
      labelListVisibility: "labelHide",
      messageListVisibility: "hide",
    },
  });
  return created.data.id!;
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function collectAttachments(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: NormalizedAttachment[]
): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      providerAttachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  part.parts?.forEach((p) => collectAttachments(p, out));
}

function findBody(part: gmail_v1.Schema$MessagePart | undefined): { text?: string; html?: string } {
  if (!part) return {};
  const result: { text?: string; html?: string } = {};

  function walk(p: gmail_v1.Schema$MessagePart) {
    if (p.mimeType === "text/plain" && p.body?.data && !result.text) {
      result.text = Buffer.from(p.body.data, "base64").toString("utf8");
    } else if (p.mimeType === "text/html" && p.body?.data && !result.html) {
      result.html = Buffer.from(p.body.data, "base64").toString("utf8");
    }
    p.parts?.forEach(walk);
  }
  walk(part);
  return result;
}

function isAutoReply(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): boolean {
  const autoSubmitted = header(headers, "Auto-Submitted");
  const precedence = header(headers, "Precedence");
  const xAutoreply = header(headers, "X-Autoreply");
  return Boolean(
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
      (precedence && ["bulk", "auto_reply", "junk"].includes(precedence.toLowerCase())) ||
      xAutoreply
  );
}

export class GmailProvider implements MailProvider {
  readonly type = "GMAIL" as const;

  getAuthUrl(state: string): string {
    return buildAuthUrl(state);
  }

  async handleOAuthCallback(code: string): Promise<ConnectedAccountInfo> {
    const { client, tokens } = await exchangeCodeForTokens(code);
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    if (!profile.data.emailAddress) {
      throw new Error("Could not determine the Gmail address for this account.");
    }
    return { accountEmail: profile.data.emailAddress, refreshToken: tokens.refresh_token! };
  }

  async listNewMessages(
    refreshToken: string,
    _cursor: ProviderCursor | null
  ): Promise<{ messages: NormalizedEmail[]; nextCursor: ProviderCursor }> {
    const auth = clientWithRefreshToken(refreshToken);
    const gmail = google.gmail({ version: "v1", auth });

    const profile = await gmail.users.getProfile({ userId: "me" });
    const ownAddress = profile.data.emailAddress?.toLowerCase();

    const labelId = await getOrCreateSyncedLabelId(gmail);

    const list = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox -label:${SYNCED_LABEL_NAME} ${LOOKBACK_WINDOW}`,
      maxResults: 50,
    });

    const ids = list.data.messages ?? [];
    const messages: NormalizedEmail[] = [];

    for (const { id } of ids) {
      if (!id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const payload = full.data.payload;
      const headers = payload?.headers;

      const from = header(headers, "From") ?? "";
      // Never re-ingest mail the connected account sent itself (avoids the
      // shared inbox creating a ticket out of its own outbound replies, or
      // looping on an auto-reply from itself).
      if (ownAddress && from.toLowerCase().includes(ownAddress)) {
        await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [labelId] } });
        continue;
      }

      const { text, html } = findBody(payload);
      const attachments: NormalizedAttachment[] = [];
      collectAttachments(payload, attachments);

      messages.push({
        providerMessageId: id,
        providerThreadId: full.data.threadId ?? id,
        messageIdHeader: header(headers, "Message-ID"),
        inReplyToHeader: header(headers, "In-Reply-To"),
        referencesHeader: header(headers, "References"),
        from,
        to: (header(headers, "To") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        cc: (header(headers, "Cc") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        subject: header(headers, "Subject") ?? "(no subject)",
        bodyText: text ?? (html ? html.replace(/<[^>]+>/g, " ") : ""),
        bodyHtml: html,
        attachments,
        receivedAt: full.data.internalDate ? new Date(Number(full.data.internalDate)) : new Date(),
        isAutoReply: isAutoReply(headers),
      });

      await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [labelId] } });
    }

    return { messages, nextCursor: { raw: new Date().toISOString() } };
  }

  async sendReply(refreshToken: string, params: SendReplyParams): Promise<SendReplyResult> {
    const auth = clientWithRefreshToken(refreshToken);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const from = profile.data.emailAddress!;

    const raw = buildRawMimeMessage({ ...params, from });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: params.threadId },
    });

    const sentFull = await gmail.users.messages.get({
      userId: "me",
      id: sent.data.id!,
      format: "metadata",
      metadataHeaders: ["Message-ID"],
    });

    return {
      providerMessageId: sent.data.id!,
      providerThreadId: sent.data.threadId ?? params.threadId,
      messageIdHeader: header(sentFull.data.payload?.headers, "Message-ID") ?? "",
      sentAt: new Date(),
    };
  }

  async getAttachment(
    refreshToken: string,
    providerMessageId: string,
    providerAttachmentId: string
  ): Promise<{ data: Buffer; mimeType: string; filename: string }> {
    const auth = clientWithRefreshToken(refreshToken);
    const gmail = google.gmail({ version: "v1", auth });

    const [attachment, message] = await Promise.all([
      gmail.users.messages.attachments.get({
        userId: "me",
        messageId: providerMessageId,
        id: providerAttachmentId,
      }),
      gmail.users.messages.get({ userId: "me", id: providerMessageId, format: "full" }),
    ]);

    const attachments: NormalizedAttachment[] = [];
    collectAttachments(message.data.payload, attachments);
    const meta = attachments.find((a) => a.providerAttachmentId === providerAttachmentId);

    const data = Buffer.from(attachment.data.data ?? "", "base64");
    return {
      data,
      mimeType: meta?.mimeType ?? "application/octet-stream",
      filename: meta?.filename ?? "attachment",
    };
  }
}
