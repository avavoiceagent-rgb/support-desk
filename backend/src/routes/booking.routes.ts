import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { isMapsEnabled, verifyAddress, estimateRoute } from "../booking/maps";

export const bookingRouter = Router();

const checkSchema = z.object({
  pickup: z.string().min(1),
  dropoff: z.string().min(1),
});

/**
 * GET /api/booking/maps-check?pickup=...&dropoff=...
 *
 * An admin-only end-to-end test of the Google setup: it geocodes both
 * addresses (Geocoding API) and measures the drive between them (Routes API).
 * The two APIs are enabled separately in Google Cloud and a key that works for
 * one commonly fails on the other, so this checks both and says which broke.
 * No customer data involved — whatever the caller types.
 */
bookingRouter.get("/maps-check", requireAuth, requireAdmin, async (req, res) => {
  if (!isMapsEnabled()) {
    return res.json({ configured: false, message: "GOOGLE_MAPS_API_KEY is not set on the server." });
  }

  const parsed = checkSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Give both a pickup and a dropoff address." });
  }

  const [pickup, dropoff] = await Promise.all([
    verifyAddress(parsed.data.pickup),
    verifyAddress(parsed.data.dropoff),
  ]);

  const geocodingWorks = Boolean(pickup || dropoff);
  const route =
    pickup && dropoff
      ? await estimateRoute({ originPlaceId: pickup.placeId, destinationPlaceId: dropoff.placeId })
      : null;

  res.json({
    configured: true,
    geocoding: {
      working: geocodingWorks,
      pickup,
      dropoff,
      hint: geocodingWorks
        ? undefined
        : "Both lookups failed. Usually means the Geocoding API isn't enabled on the project, billing is off, or the key is restricted to other APIs. Check the server logs for the exact status.",
    },
    routes: {
      working: Boolean(route),
      estimate: route,
      hint: route
        ? undefined
        : pickup && dropoff
          ? "Addresses resolved but the route did not. Usually means the Routes API specifically isn't enabled, or the key restriction excludes it."
          : "Skipped — needs both addresses to resolve first.",
    },
  });
});
