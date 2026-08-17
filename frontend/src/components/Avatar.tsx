import { avatarColor, initials } from "../lib/ui";

export function Avatar({ name, size = 8 }: { name: string; size?: 6 | 7 | 8 | 9 | 10 }) {
  const sizeClass = { 6: "h-6 w-6 text-[10px]", 7: "h-7 w-7 text-[11px]", 8: "h-8 w-8 text-xs", 9: "h-9 w-9 text-sm", 10: "h-10 w-10 text-sm" }[size];
  return (
    <span
      className={`inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-full font-semibold text-white ${avatarColor(name)}`}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
