// Small shared UI helpers.

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe" ; "jane@x.com" -> "jane@x.com" */
export function displayName(fromHeader: string): string {
  const match = fromHeader.match(/^(.*?)<(.+?)>$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    if (name) return name;
    return match[2].trim();
  }
  return fromHeader.trim();
}

export function initials(nameOrEmail: string): string {
  const name = displayName(nameOrEmail);
  const beforeAt = name.includes("@") ? name.split("@")[0] : name;
  const parts = beforeAt
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-teal-500",
  "bg-orange-500",
];

export function avatarColor(nameOrEmail: string): string {
  let hash = 0;
  for (const ch of nameOrEmail) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
