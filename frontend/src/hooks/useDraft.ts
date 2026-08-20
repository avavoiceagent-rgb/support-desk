// Loading a ticket's drafted reply, and recording what was done with it.
//
// Shared by the reading pane and the full-page ticket view so the two can't
// behave differently. The draft is fetched whatever its status — it lives in
// the timeline permanently, and using or setting it aside only changes its
// label.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { TicketDraft } from "../components/DraftCard";

export function useDraft(ticketId: string) {
  const [draft, setDraft] = useState<TicketDraft | null>(null);

  const load = useCallback(() => {
    if (!ticketId) return;
    api
      .get<{ draft: TicketDraft | null }>(`/tickets/${ticketId}/draft`)
      .then((r) => setDraft(r.draft))
      .catch(() => setDraft(null));
  }, [ticketId]);

  useEffect(() => {
    setDraft(null);
    load();
  }, [ticketId, load]);

  /** Mark it used or set aside. The card stays; only its label changes. */
  const mark = useCallback(
    async (action: "use" | "dismiss") => {
      setDraft((d) => (d ? { ...d, status: action === "use" ? "USED" : "DISMISSED" } : d));
      await api.post(`/tickets/${ticketId}/draft/${action}`).catch(() => {});
    },
    [ticketId]
  );

  return { draft, markUsed: () => mark("use"), markDismissed: () => mark("dismiss"), reloadDraft: load };
}
