import { describe, it, expect, vi } from "vitest";
import { opsRouter } from "../../routes/ops.routes";
import { dispatchRouter } from "../../routes/dispatch.routes";
import { requireAuth, requireAdmin } from "../../middleware/auth";

// No database in this file. The permission split is the thing most likely to
// be got wrong by accident — somebody adds a route in a hurry and forgets the
// guard — and it is checkable by reading the router itself, so it is checked
// here rather than through one hand-written request per endpoint. Walking the
// stack covers every route at once, including ones added after this was
// written, which a per-endpoint test would silently miss.

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: unknown;
}

const layers: Layer[] = (opsRouter as unknown as { stack: Layer[] }).stack;

function routesOf(router: unknown) {
  return ((router as { stack: Layer[] }).stack ?? [])
    .filter((l): l is Required<Pick<Layer, "route">> & Layer => Boolean(l.route))
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()),
      handlers: l.route.stack.map((s) => s.handle),
    }));
}

const routes = layers
  .filter((l): l is Required<Pick<Layer, "route">> & Layer => Boolean(l.route))
  .map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()),
    handlers: l.route.stack.map((s) => s.handle),
  }));

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];
const isWrite = (r: { methods: string[] }) => r.methods.some((m) => WRITE_METHODS.includes(m));

describe("ops route permissions", () => {
  it("puts every route behind requireAuth at the router level", () => {
    const routerLevel = layers.filter((l) => !l.route).map((l) => l.handle);
    expect(routerLevel).toContain(requireAuth);
  });

  it("guards every write route with requireAdmin", () => {
    const writes = routes.filter(isWrite);
    // If this ever reads zero the test has stopped testing anything.
    expect(writes.length).toBeGreaterThan(0);

    const unguarded = writes
      .filter((r) => !r.handlers.includes(requireAdmin))
      .map((r) => `${r.methods.join("/")} ${r.path}`);
    expect(unguarded).toEqual([]);
  });

  it("leaves reads open to anyone signed in", () => {
    // Everyone can look. If a GET picks up requireAdmin, a dispatcher who is
    // not an admin loses the schedule screen, which is not the intent.
    const guardedReads = routes
      .filter((r) => !isWrite(r) && r.handlers.includes(requireAdmin))
      .map((r) => `${r.methods.join("/")} ${r.path}`);
    expect(guardedReads).toEqual([]);
  });

  it("offers no way to delete a driver, vehicle or affiliate", () => {
    // Trips point at these rows; deleting one puts a hole in the history.
    // Retirement is `active: false`.
    //
    // The two exceptions are things nothing points at. A shift is recomputed
    // availability, and a rate band is read at quoting time with the resulting
    // figure written onto the invoice — so removing either leaves no record
    // unreadable afterwards. Anything else appearing in this list is a
    // question worth answering before it ships, which is why the assertion is
    // an exact match rather than a "contains".
    const deletes = routes
      .filter((r) => r.methods.includes("DELETE"))
      .map((r) => r.path)
      .sort();
    expect(deletes).toEqual(["/shifts/:id", "/zones/:id"]);
  });
});

describe("requireAdmin", () => {
  const fakeRes = () => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    return res;
  };

  it("refuses a signed-in agent who is not an admin", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireAdmin({ session: { role: "AGENT" } } as never, res as never, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses a request with no session at all", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireAdmin({} as never, res as never, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("lets an admin through", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireAdmin({ session: { role: "ADMIN" } } as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});

describe("dispatch route permissions", () => {
  // This router is why the invariant above needs a second home. It was written
  // with its own split — reading a thread and sending a message are ordinary
  // dispatch work — and the split leaked: accepting an offer assigns a driver
  // through `updateTrip`, which is the same change `PATCH /ops/trips/:id`
  // refuses without an admin. Two calls here achieved what one call there
  // would not.
  const dispatch = routesOf(dispatchRouter);

  it("puts every dispatch route behind requireAuth at the router level", () => {
    const routerLevel = ((dispatchRouter as unknown as { stack: Layer[] }).stack ?? [])
      .filter((l) => !l.route)
      .map((l) => l.handle);
    expect(routerLevel).toContain(requireAuth);
  });

  it("guards the routes that can change a trip", () => {
    // The rule, in one place: changing a trip needs an admin, whichever screen
    // it is done from.
    const guarded = dispatch
      .filter((r) => r.handlers.includes(requireAdmin))
      .map((r) => `${r.methods.join("/")} ${r.path}`)
      .sort();
    expect(guarded).toEqual(["POST /offers/:id/response"]);
  });

  it("leaves the rest of dispatch open, deliberately and by name", () => {
    // An exact list rather than a "contains", so a new dispatch write cannot
    // land here without somebody deciding which side of the line it is on.
    // If this test fails because you added a route, that is it working.
    const open = dispatch
      .filter((r) => !r.handlers.includes(requireAdmin))
      .map((r) => `${r.methods.join("/")} ${r.path}`)
      .sort();
    expect(open).toEqual([
      "GET /:kind/:id/messages",
      "POST /:kind/:id/messages",
      "POST /:kind/:id/offers",
    ]);
  });
});
