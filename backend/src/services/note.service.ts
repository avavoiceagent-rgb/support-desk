import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { notes, tickets } from "../db/schema";

/**
 * Notes are attributed to the ticket's current assignee (the person
 * responsible for the ticket). If the ticket is unassigned, they fall back
 * to whoever is logged in.
 */
export async function addNote(ticketId: string, userId: string, body: string) {
  const [ticket] = await db
    .select({ assigneeId: tickets.assigneeId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  const authorId = ticket?.assigneeId ?? userId;

  const [note] = await db.insert(notes).values({ ticketId, authorId, body }).returning();
  await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));
  return note;
}
