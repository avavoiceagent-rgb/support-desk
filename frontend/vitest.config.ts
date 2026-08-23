import { defineConfig } from "vitest/config";

// The frontend had no test runner at all, which was fine while the frontend
// was only screens — a wrong colour shows up the moment somebody looks. It
// stopped being fine when `lib/time.ts` started doing DST arithmetic and
// `lib/bookings.ts` started deciding whether a booking has already happened.
// Those are answers nobody can eyeball, and a wrong one moves a real booking.
//
// `node`, not `jsdom`: everything under test here is pure and needs only
// `Intl`. When a component genuinely needs rendering, add jsdom then rather
// than carrying it now.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
