import type {
  ReservationSource,
  ReservationType,
  TicketChannel,
  TicketQueue,
  TicketStatus,
} from "../api/types";

export type StatusGroup = "ACTIVE" | "WAITING" | "CLOSED";

export interface StatusMeta {
  value: TicketStatus;
  label: string;
  group: StatusGroup;
  /** Tailwind classes for the badge pill. */
  badge: string;
  /** Tailwind class for the badge dot. */
  dot: string;
}

export const STATUSES: StatusMeta[] = [
  { value: "OPEN", label: "Open", group: "ACTIVE", badge: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  { value: "IN_PROGRESS", label: "In Progress", group: "ACTIVE", badge: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" },
  { value: "ESCALATED", label: "Escalated", group: "ACTIVE", badge: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
  { value: "FEEDBACK", label: "Feedback", group: "ACTIVE", badge: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200", dot: "bg-fuchsia-500" },
  { value: "AWAITING_CUSTOMER", label: "Awaiting customer", group: "WAITING", badge: "bg-sky-50 text-sky-700 border-sky-200", dot: "bg-sky-500" },
  { value: "AWAITING_DISPATCH", label: "Awaiting dispatch", group: "WAITING", badge: "bg-violet-50 text-violet-700 border-violet-200", dot: "bg-violet-500" },
  { value: "NO_RESPONSE", label: "No response from customer", group: "WAITING", badge: "bg-slate-100 text-slate-600 border-slate-200", dot: "bg-slate-400" },
  { value: "FOLLOW_UP", label: "Scheduled for follow-up", group: "WAITING", badge: "bg-cyan-50 text-cyan-700 border-cyan-200", dot: "bg-cyan-500" },
  { value: "AFFILIATE", label: "Assigned to affiliate", group: "WAITING", badge: "bg-teal-50 text-teal-700 border-teal-200", dot: "bg-teal-500" },
  { value: "RESOLVED_CLOSED", label: "Resolved · Closed", group: "CLOSED", badge: "bg-gray-100 text-gray-600 border-gray-200", dot: "bg-emerald-400" },
  { value: "UNRESOLVED_CLOSED", label: "Unresolved · Closed", group: "CLOSED", badge: "bg-gray-100 text-gray-600 border-gray-200", dot: "bg-rose-400" },
];

const byValue = new Map(STATUSES.map((s) => [s.value, s]));

export function statusMeta(value: TicketStatus): StatusMeta {
  return byValue.get(value) ?? STATUSES[0];
}

export const GROUP_LABELS: Record<StatusGroup, string> = {
  ACTIVE: "Active",
  WAITING: "Waiting",
  CLOSED: "Closed",
};

export function statusesInGroup(group: StatusGroup): TicketStatus[] {
  return STATUSES.filter((s) => s.group === group).map((s) => s.value);
}

export const QUEUES: { value: TicketQueue; label: string }[] = [
  { value: "RESERVATION", label: "Reservation" },
  { value: "DISPATCH", label: "Dispatch" },
  { value: "ACCOUNTING", label: "Accounting" },
];

export function queueLabel(q: TicketQueue | null): string {
  return QUEUES.find((x) => x.value === q)?.label ?? "No queue";
}

// --- Reservation sub-labels (AI triage) ---

export const RESERVATION_TYPES: { value: ReservationType; label: string }[] = [
  { value: "NEW", label: "New reservation" },
  { value: "CHANGE", label: "Change to existing" },
];

export const RESERVATION_SOURCES: { value: ReservationSource; label: string }[] = [
  { value: "INTERNAL", label: "Internal" },
  { value: "EXTERNAL", label: "External" },
];

export function reservationTypeLabel(v: ReservationType | null): string | null {
  return RESERVATION_TYPES.find((x) => x.value === v)?.label ?? null;
}

export function reservationSourceLabel(v: ReservationSource | null): string | null {
  return RESERVATION_SOURCES.find((x) => x.value === v)?.label ?? null;
}

export const CHANNELS: { value: TicketChannel; label: string }[] = [
  { value: "EMAIL", label: "Email" },
  { value: "PHONE", label: "Phone" },
];

// --- SLA (first reply within target) ---

export const SLA_TARGET_MS = 24 * 60 * 60 * 1000;

export interface SlaInfo {
  label: string;
  /** met = replied in time; pending = no reply yet, still in time; overdue = past target. */
  state: "met" | "pending" | "overdue" | "none";
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function slaInfo(receivedAt: string, firstReplyAt: string | null, isClosed: boolean): SlaInfo {
  const received = new Date(receivedAt).getTime();
  if (firstReplyAt) {
    const ms = new Date(firstReplyAt).getTime() - received;
    return { label: formatDuration(ms), state: ms <= SLA_TARGET_MS ? "met" : "overdue" };
  }
  if (isClosed) return { label: "—", state: "none" };
  const elapsed = Date.now() - received;
  return { label: formatDuration(elapsed), state: elapsed <= SLA_TARGET_MS ? "pending" : "overdue" };
}

export function isClosedStatus(s: TicketStatus): boolean {
  return statusMeta(s).group === "CLOSED";
}
