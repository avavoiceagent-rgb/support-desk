import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { notes, tickets } from "../db/schema";

export async function addNote(ticketId: string, authorId: string, body: string) {
  const [note] = await db.insert(notes).values({ ticketId, authorId, body }).returning();
  await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, ticketId));
  return note;
}
