// What the desk already has on file for this ticket.
//
// Fetched fresh whenever a ticket is opened, never cached across tickets: the
// endpoint computes it per request precisely so it cannot go stale, and a
// cached copy on this side would undo that.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export type OpsReason = "QUOTED_IN_EMAIL" | "SENDER_RECENT" | "SENDER_UPCOMING";

export interface OpsTrip {
  reason: OpsReason;
  trip: {
    id: string;
    reference: string;
    passengerName: string;
    pickupAddress: string;
    dropoffAddress: string;
    pickupAt: string;
    bookedHours: number;
    vehicleClass: string;
    status: string;
    assignedKind: string;
    farmOutReason: string | null;
    driver: { name: string; phone: string } | null;
    vehicle: { label: string; class: string } | null;
    affiliate: { company: string; phone: string } | null;
  };
}

export interface OpsInvoice {
  reason: OpsReason;
  invoice: {
    id: string;
    reference: string;
    status: string;
    issuedOn: string;
    totalCents: number;
    disputeNote: string | null;
    lines: { description: string; amountCents: number }[];
  };
}

export interface OpsContext {
  ticketId: string;
  senderEmail: string | null;
  quotedReferences: { trips: string[]; invoices: string[] };
  unresolvedReferences: string[];
  trips: OpsTrip[];
  invoices: OpsInvoice[];
}

export function useOpsContext(ticketId: string) {
  const [context, setContext] = useState<OpsContext | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!ticketId) return;
    setLoading(true);
    api
      .get<{ context: OpsContext }>(`/tickets/${ticketId}/ops-context`)
      .then((r) => setContext(r.context))
      // A desk that cannot reach this endpoint should still show the email.
      .catch(() => setContext(null))
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => {
    setContext(null);
    load();
  }, [ticketId, load]);

  return { context, loading, reload: load };
}
