import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { notes, tickets } from "../db/schema";

/**
 * An internal note on a ticket.
 *
 * `authorId` is null only for notes the desk writes itself — see the column
 * comment in the schema. Everything a person types keeps their name on it.
 */
export async function addNote(ticketId: string, authorId: string | null, body: string) {
  const [note] = await db.insert(notes).values({ ticketId, authorId, body }).returning();
  await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));
  return note;
}

/** A note from the desk itself, with no person behind it. */
export async function addDeskNote(ticketId: string, body: string) {
  return addNote(ticketId, null, body);
}
