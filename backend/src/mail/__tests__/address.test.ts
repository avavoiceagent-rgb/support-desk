import { describe, it, expect } from "vitest";
import { emailFromHeader, looksLikeEmail } from "../address";

describe("emailFromHeader", () => {
  it("takes a bare address as it stands", () => {
    expect(emailFromHeader("ana@customer.example")).toBe("ana@customer.example");
  });

  it("pulls the address out of a display name", () => {
    // This is the case that mattered: the raw header was being stored in
    // booker_email, which is later matched with lower(...) = ..., so that
    // customer's trips never appeared in their own history again.
    expect(emailFromHeader("Ana Costa <ana@customer.example>")).toBe("ana@customer.example");
    expect(emailFromHeader('"Costa, Ana" <ana@customer.example>')).toBe("ana@customer.example");
  });

  it("prefers the brackets when the display name has an @ in it", () => {
    // "billing@acme" <ana@…> is from Ana, not from billing.
    expect(emailFromHeader('"billing@acme" <ana@customer.example>')).toBe("ana@customer.example");
  });

  it("says nothing rather than storing something that is not an address", () => {
    // Null is recoverable. A wrong key is not — it looks like data forever.
    expect(emailFromHeader("Ana Costa")).toBeNull();
    expect(emailFromHeader("")).toBeNull();
    expect(emailFromHeader(null)).toBeNull();
    expect(emailFromHeader(undefined)).toBeNull();
    expect(emailFromHeader("<not an address>")).toBeNull();
  });

  it("trims the whitespace real headers carry", () => {
    expect(emailFromHeader("  Ana Costa  < ana@customer.example > ")).toBe("ana@customer.example");
  });
});

describe("looksLikeEmail", () => {
  it("accepts the ordinary shapes", () => {
    expect(looksLikeEmail("ana@customer.example")).toBe(true);
    expect(looksLikeEmail("a.b+tag@sub.domain.co.uk")).toBe(true);
  });

  it("rejects what is not one", () => {
    expect(looksLikeEmail("Ana Costa")).toBe(false);
    expect(looksLikeEmail("ana@localhost")).toBe(false);
    expect(looksLikeEmail("ana@@customer.example")).toBe(false);
    expect(looksLikeEmail("Ana Costa <ana@customer.example>")).toBe(false);
  });
});
