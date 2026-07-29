// Hand-built RFC 822 MIME message construction for outgoing Gmail replies.
//
// Gmail's API `messages.send` takes a base64url-encoded raw MIME message and
// will thread it into the right Gmail conversation given `threadId`, but
// Gmail does NOT set In-Reply-To/References for you — and the *customer's*
// mail client (Outlook, Apple Mail, etc.) threads based on those headers,
// not Gmail's internal threadId. So we set them by hand here.

import type { SendReplyParams } from "../provider.interface";

function encodeHeaderValue(value: string): string {
  // Encode non-ASCII header values (e.g. a subject with accented characters)
  // per RFC 2047, so the message is valid even for non-UTF8-safe headers.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMimeMessage(params: SendReplyParams & { from: string }): string {
  const { from, to, cc, subject, bodyHtml, inReplyToMessageIdHeader, referencesHeader } = params;

  const headers: string[] = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ];

  if (inReplyToMessageIdHeader) {
    headers.push(`In-Reply-To: ${inReplyToMessageIdHeader}`);
    const references = referencesHeader
      ? `${referencesHeader} ${inReplyToMessageIdHeader}`
      : inReplyToMessageIdHeader;
    headers.push(`References: ${references}`);
  }

  const message = `${headers.join("\r\n")}\r\n\r\n${bodyHtml}`;

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
