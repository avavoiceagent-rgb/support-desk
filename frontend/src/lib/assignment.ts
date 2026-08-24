// Who a job belongs to: one of our drivers, or a partner. Never both.
//
// The rule already lives in the backend, which refuses a patch naming both
// and blanks the other side when a job changes hands. The form did not know
// it, so a dispatcher could set a driver and a partner, press Save, and get
// told no — which is honest but late, and got noticeably easier to walk into
// once the partner box started showing a price worth looking at.
//
// Pure and here rather than inside the component so the rule can be read and
// tested without a browser.

export interface Assignment {
  driverId: string;
  vehicleId: string;
  affiliateId: string;
}

/** Empty string is what an unselected `<select>` gives us. */
const NONE = "";

/**
 * The assignment after somebody picks a driver.
 *
 * Choosing a driver takes the job back off a partner. Choosing "Unassigned"
 * does not hand it to anyone — it just leaves it unassigned, so a partner
 * already on the job stays there.
 */
export function withDriver(current: Assignment, driverId: string): Assignment {
  if (!driverId) return { ...current, driverId: NONE };
  return { ...current, driverId, affiliateId: NONE };
}

/**
 * The assignment after somebody picks a partner.
 *
 * A partner brings their own car, so our driver and our vehicle both come
 * off. Leaving the vehicle behind would keep a car marked out on a job it is
 * not doing, and the schedule board reads those as busy.
 */
export function withPartner(current: Assignment, affiliateId: string): Assignment {
  if (!affiliateId) return { ...current, affiliateId: NONE };
  return { ...current, affiliateId, driverId: NONE, vehicleId: NONE };
}

/**
 * What changing this would do to the other side, in words, or null.
 *
 * Shown before the change rather than after, because "this will take it off
 * Hector" is a thing a dispatcher may want to stop and think about.
 */
export function handoverNote(
  current: Assignment,
  names: { driver?: string | null; partner?: string | null }
): string | null {
  if (current.driverId && names.driver) {
    return `With ${names.driver}. Choosing a partner takes the job off them.`;
  }
  if (current.affiliateId && names.partner) {
    return `Farmed out to ${names.partner}. Choosing one of our drivers brings it back in-house.`;
  }
  return null;
}
