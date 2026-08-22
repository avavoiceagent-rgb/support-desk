// What we already have on file for the person who wrote in.
//
// Staff-facing only. Nothing here has been shown to the customer, and the
// panel says so: a trip listed because the customer NAMED it is evidence,
// while a trip listed because they have booked with us before is a guess that
// happens to be useful. Those two are never allowed to look the same.

import { useState } from "react";
import type { OpsContext, OpsReason, OpsTrip, OpsInvoice } from "../hooks/useOpsContext";

const REASON_LABEL: Record<OpsReason, string> = {
  QUOTED_IN_EMAIL: "Named in this email",
  SENDER_UPCOMING: "Coming up for this sender",
  SENDER_RECENT: "Past trip for this sender",
};

const REASON_STYLE: Record<OpsReason, string> = {
  QUOTED_IN_EMAIL: "bg-emerald-100 text-emerald-800",
  SENDER_UPCOMING: "bg-sky-100 text-sky-800",
  SENDER_RECENT: "bg-gray-100 text-gray-600",
};

const STATUS_STYLE: Record<string, string> = {
  SCHEDULED: "text-sky-700",
  IN_PROGRESS: "text-violet-700",
  COMPLETED: "text-gray-500",
  CANCELLED: "text-amber-700",
  NO_SHOW: "text-red-700",
  PAID: "text-emerald-700",
  SENT: "text-sky-700",
  DISPUTED: "text-red-700",
  VOID: "text-gray-400",
};

// One date style for the whole panel. It previously mixed "Wed 22 Jul, 05:00 pm"
// with "issued 28/07/2026", and neither is how a person writes a time. Adam
// already says "2:10 PM" in drafts; a staff panel should not disagree with the
// email sitting beside it.
function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${date}, ${time}`;
}

function onDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** Shortened for a narrow column — the full address is in the trip record. */
function shortAddress(address: string): string {
  const firstPart = address.split(",").slice(0, 2).join(",");
  return firstPart.length > 46 ? `${firstPart.slice(0, 45)}…` : firstPart;
}

function Reason({ reason }: { reason: OpsReason }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${REASON_STYLE[reason]}`}>
      {REASON_LABEL[reason]}
    </span>
  );
}

function TripRow({ entry }: { entry: OpsTrip }) {
  const t = entry.trip;
  const who = t.driver
    ? `${t.driver.name}${t.vehicle ? ` · ${t.vehicle.label}` : ""}`
    : t.affiliate
      ? `${t.affiliate.company} (partner)`
      : "Unassigned";

  return (
    <li className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-gray-900">{t.reference}</span>
        <Reason reason={entry.reason} />
      </div>
      <p className="mt-1 text-[12px] text-gray-700">
        {when(t.pickupAt)} · {t.bookedHours}h · {t.vehicleClass}
        <span className={`ml-1 font-medium ${STATUS_STYLE[t.status] ?? "text-gray-600"}`}>
          {t.status.replace("_", " ").toLowerCase()}
        </span>
      </p>
      <p className="text-[11px] text-gray-500">
        {shortAddress(t.pickupAddress)} → {shortAddress(t.dropoffAddress)}
      </p>
      <p className="text-[11px] text-gray-500">
        {who}
        {t.farmOutReason === "OUT_OF_AREA" && " · outside the service area"}
        {t.farmOutReason === "NO_VEHICLE" && " · no vehicle free"}
      </p>
    </li>
  );
}

function InvoiceRow({ entry }: { entry: OpsInvoice }) {
  const i = entry.invoice;
  return (
    <li className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-gray-900">{i.reference}</span>
        <Reason reason={entry.reason} />
      </div>
      <p className="mt-1 text-[12px] text-gray-700">
        {money(i.totalCents)}
        <span className={`ml-1 font-medium ${STATUS_STYLE[i.status] ?? "text-gray-600"}`}>
          {i.status.toLowerCase()}
        </span>
        <span className="ml-1 text-gray-400">· issued {onDate(i.issuedOn)}</span>
      </p>
      {i.lines.map((line, n) => (
        <p key={n} className="text-[11px] text-gray-500">
          {line.description} — {money(line.amountCents)}
        </p>
      ))}
      {i.disputeNote && (
        <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-800">Disputed: {i.disputeNote}</p>
      )}
    </li>
  );
}

/** A regular customer has plenty of history; the panel should not swamp the email. */
const VISIBLE = 4;

export function OpsContextPanel({ context }: { context: OpsContext | null }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (!context) return null;

  const { trips, invoices, unresolvedReferences } = context;
  const nothingOnFile = trips.length === 0 && invoices.length === 0 && unresolvedReferences.length === 0;
  // An empty panel is noise on a first-time enquiry, which is most of them.
  if (nothingOnFile) return null;

  const count = trips.length + invoices.length;
  const hidden = Math.max(0, trips.length - VISIBLE) + Math.max(0, invoices.length - VISIBLE);

  return (
    <section className="border-b border-gray-100 bg-slate-50/70 px-4 py-2.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[12px] font-semibold text-gray-700">
          On file for this sender
          <span className="ml-1.5 font-normal text-gray-500">
            {count} record{count === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-[11px] text-gray-400">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {unresolvedReferences.length > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              Quoted {unresolvedReferences.join(", ")}, which matches nothing on file — worth checking
              whether it is a typo or another company's reference.
            </p>
          )}

          {trips.length > 0 && (
            <ul className="space-y-1.5">
              {(showAll ? trips : trips.slice(0, VISIBLE)).map((t) => (
                <TripRow key={t.trip.id} entry={t} />
              ))}
            </ul>
          )}
          {invoices.length > 0 && (
            <ul className="space-y-1.5">
              {(showAll ? invoices : invoices.slice(0, VISIBLE)).map((i) => (
                <InvoiceRow key={i.invoice.id} entry={i} />
              ))}
            </ul>
          )}

          {hidden > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-[11px] font-medium text-indigo-600 hover:underline"
            >
              {showAll ? "Show fewer" : `Show ${hidden} more`}
            </button>
          )}

          <p className="text-[10px] text-gray-400">
            Not shown to the customer. Adam does not use any of this when drafting.
          </p>
        </div>
      )}
    </section>
  );
}
