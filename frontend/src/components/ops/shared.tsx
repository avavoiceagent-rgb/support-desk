// Pieces the three operations tabs share.
//
// The date helpers match OpsContextPanel exactly. A dispatcher moving between
// a ticket and this screen should not have to re-read a time in a second
// format to know it is the same trip.

import { useEffect, type ReactNode } from "react";
import { ApiError } from "../../api/client";

// Formatting lives in lib/time so this screen, the ticket panel and the
// emails Adam sends cannot drift into three different ideas of what time it is.
export { when, onDate, atTime, span, longDate, OPERATING_ZONE_LABEL } from "../../lib/time";

/** Shortened for a narrow column; the full address stays in the record. */
export function shortAddress(address: string): string {
  const firstPart = address.split(",").slice(0, 2).join(",");
  return firstPart.length > 46 ? `${firstPart.slice(0, 45)}…` : firstPart;
}

const STATUS_STYLE: Record<string, string> = {
  SCHEDULED: "bg-sky-100 text-sky-800",
  IN_PROGRESS: "bg-violet-100 text-violet-800",
  COMPLETED: "bg-gray-100 text-gray-600",
  CANCELLED: "bg-amber-100 text-amber-800",
  NO_SHOW: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "On the road",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No show",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
        STATUS_STYLE[status] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * What went wrong, in the server's own words.
 *
 * The operations API writes its refusals for a dispatcher to act on —
 * "Marco Rinaldi is already on T-10432 (22 Jul, 09:00–13:00)". Replacing that
 * with "Could not save" would throw away the only useful part.
 */
export function apiMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}

export const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  kind = "secondary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300",
    secondary:
      "border border-gray-300 text-gray-700 hover:border-gray-400 hover:text-gray-900 disabled:text-gray-400",
    danger: "border border-red-200 text-red-700 hover:border-red-400 hover:bg-red-50",
  }[kind];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-gray-500">{children}</p>;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-gray-900/40 p-4 sm:p-8">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
