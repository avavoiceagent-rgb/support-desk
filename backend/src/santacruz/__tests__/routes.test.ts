import { describe, it, expect, afterEach } from "vitest";
import {
  santacruzRouter,
  santacruzOutboundRouter,
  keyIsRight,
} from "../../routes/santacruz.routes";
import { requireAuth, requireAdmin } from "../../middleware/auth";
import { env } from "../../config/env";

// No database here. This file is about who is allowed through which door,
// which is the thing most easily broken by adding a route in a hurry — and it
// is answerable by reading the routers themselves, so every route is covered
// including ones written after this test.

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: unknown;
}

function routesOf(router: unknown) {
  return ((router as { stack: Layer[] }).stack ?? [])
    .filter((l): l is Required<Pick<Layer, "route">> & Layer => Boolean(l.route))
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()),
      handlers: l.route.stack.map((s) => s.handle),
    }));
}

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

describe("the desk's routes", () => {
  it("requires a login for the whole router", () => {
    const stack = (santacruzRouter as unknown as { stack: Layer[] }).stack;
    expect(stack.some((l) => l.handle === requireAuth)).toBe(true);
  });

  it("requires an admin for every route that changes something", () => {
    const writes = routesOf(santacruzRouter).filter((r) =>
      r.methods.some((m) => WRITE_METHODS.includes(m))
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.handlers, `${route.methods.join("/")} ${route.path} is missing requireAdmin`)
        .toContain(requireAdmin);
    }
  });

  it("does not put an admin guard on reading", () => {
    const reads = routesOf(santacruzRouter).filter((r) => r.methods.includes("GET"));
    expect(reads.length).toBeGreaterThan(0);
    for (const route of reads) {
      expect(route.handlers).not.toContain(requireAdmin);
    }
  });
});

describe("the door SantaCruz knocks on", () => {
  it("has no login guard, because SantaCruz has no login", () => {
    const stack = (santacruzOutboundRouter as unknown as { stack: Layer[] }).stack;
    expect(stack.some((l) => l.handle === requireAuth)).toBe(false);
    expect(stack.some((l) => l.handle === requireAdmin)).toBe(false);
  });

  it("offers nothing that changes anything", () => {
    const writes = routesOf(santacruzOutboundRouter).filter((r) =>
      r.methods.some((m) => WRITE_METHODS.includes(m))
    );
    expect(writes).toEqual([]);
  });
});

describe("the shared secret", () => {
  const original = env.SANTACRUZ_INBOUND_KEY;

  afterEach(() => {
    env.SANTACRUZ_INBOUND_KEY = original;
  });

  it("refuses everybody when no key is configured", () => {
    // The direction this has to fail in. An endpoint with no key set must shut
    // rather than open, or forgetting to set one publishes it to the world.
    env.SANTACRUZ_INBOUND_KEY = "";
    expect(keyIsRight(("anything"))).toBe(false);
    expect(keyIsRight((""))).toBe(false);
    expect(keyIsRight((undefined))).toBe(false);
  });

  it("accepts the right key and refuses a wrong one", () => {
    env.SANTACRUZ_INBOUND_KEY = "correct-horse-battery-staple";
    expect(keyIsRight(("correct-horse-battery-staple"))).toBe(true);
    expect(keyIsRight(("correct-horse-battery-stapl3"))).toBe(false);
    expect(keyIsRight(("wrong"))).toBe(false);
    expect(keyIsRight((undefined))).toBe(false);
  });

  it("is not fooled by a prefix of the real key", () => {
    env.SANTACRUZ_INBOUND_KEY = "abcdefghij";
    expect(keyIsRight(("abcde"))).toBe(false);
    expect(keyIsRight(("abcdefghijk"))).toBe(false);
  });
});
