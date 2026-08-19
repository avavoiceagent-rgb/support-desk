// Applies AI triage to a freshly created ticket.
//
// Kept separate from ingest.ts so that mail ingestion has no hard dependency
// on the AI being available: if this whole step is skipped the ticket is
// simply untriaged, which is exactly how the app behaved before.

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, messages } from "../db/schema";
import { classifyEmail, isClassificationEnabled } from "../ai/classifier";

/**
 * Classify one ticket from its first inbound message and store the result.
 * Returns true when labels were written.
 *
 * Only ever applied to brand-new tickets: re-running it would silently undo a
 * person's correction, and a human's judgement outranks the model's.
 */
export async function classifyNewTicket(ticketId: string): Promise<boolean> {
  if (!isClassificationEnabled()) return false;

  try {
    const ticket = await db.query.tickets.findFirst({ where: eq(tickets.id, ticketId) });
    // Never overwrite a queue somebody already chose.
    if (!ticket || ticket.isBulk || ticket.queue) return false;

    const [firstInbound] = await db
      .select({
        subject: messages.subject,
        bodyHtml: messages.bodyHtml,
        bodyText: messages.bodyText,
        fromAddress: messages.fromAddress,
      })
      .from(messages)
      .where(eq(messages.ticketId, ticketId))
      .orderBy(asc(messages.sentAt))
      .limit(1);
    if (!firstInbound) return false;

    const result = await classifyEmail({
      subject: firstInbound.subject,
      bodyHtml: firstInbound.bodyHtml,
      bodyText: firstInbound.bodyText,
      fromAddress: firstInbound.fromAddress,
    });
    // No queue means the model declined to guess — leave the ticket for a
    // human rather than filing it somewhere arbitrary.
    if (!result || !result.queue) return false;

    // The guard is repeated in the WHERE clause, not just checked above:
    // the AI call takes a second or two, and in that window an agent can
    // open the ticket and set the queue themselves. Without this, their
    // choice would be silently overwritten by the model's.
    const [written] = await db
      .update(tickets)
      .set({
        queue: result.queue,
        reservationType: result.reservationType,
        reservationSource: result.reservationSource,
        autoClassified: true,
        classificationReason: result.reasoning || null,
        classificationConfidence: result.confidence,
        // Deliberately NOT touching updatedAt: triage happens seconds after
        // the ticket arrives and shouldn't reorder the "recently updated" list.
      })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.queue), isNull(tickets.reservationType), isNull(tickets.reservationSource)))
      .returning({ id: tickets.id });

    return Boolean(written);
  } catch (err) {
    console.error(`[classifier] could not classify ticket ${ticketId}:`, err);
    return false;
  }
}
