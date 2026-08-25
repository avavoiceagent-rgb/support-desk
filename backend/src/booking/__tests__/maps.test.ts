import { describe, it, expect } from "vitest";
import {
  buildGeocodeUrl,
  parseGeocodeResponse,
  parseRouteResponse,
  describeAddress,
  looksLikeAirport,
  resolveServiceArea,
  tidyAddress,
} from "../maps";
import type { VerifiedAddress } from "../maps";

const parkAve = {
  status: "OK",
  results: [
    {
      formatted_address: "245 Park Ave, New York, NY 10167, USA",
      place_id: "ChIJ_park_ave",
      types: ["street_address"],
      geometry: { location: { lat: 40.7548, lng: -73.9757 } },
      address_components: [
        { long_name: "245", types: ["street_number"] },
        { long_name: "Park Avenue", types: ["route"] },
        { long_name: "New York", types: ["locality"] },
        { long_name: "New York", short_name: "NY", types: ["administrative_area_level_1"] },
        { long_name: "10167", short_name: "10167", types: ["postal_code"] },
      ],
    },
  ],
};

const jfk = {
  status: "OK",
  results: [
    {
      formatted_address: "John F. Kennedy International Airport, Queens, NY 11430, USA",
      place_id: "ChIJ_jfk",
      types: ["airport", "point_of_interest", "establishment"],
      address_components: [
        { long_name: "11430", types: ["postal_code"] },
        { long_name: "New York", short_name: "NY", types: ["administrative_area_level_1"] },
      ],
    },
  ],
};

describe("parseGeocodeResponse", () => {
  it("pulls the tidy address and the postcode out", () => {
    const a = parseGeocodeResponse(parkAve, "245 park ave manhattan");
    expect(a).toMatchObject({
      formattedAddress: "245 Park Ave, New York, NY 10167, USA",
      postalCode: "10167",
      placeId: "ChIJ_park_ave",
      isAirport: false,
      partialMatch: false,
      query: "245 park ave manhattan",
    });
  });

  it("keeps the coordinates Google returned", () => {
    // These used to be dropped on the floor, which left the partner rate
    // cards — priced by distance from a base — with nothing to measure.
    const a = parseGeocodeResponse(parkAve, "245 park ave manhattan");
    expect(a?.lat).toBeCloseTo(40.7548, 4);
    expect(a?.lng).toBeCloseTo(-73.9757, 4);
  });

  it("takes no point at all rather than half of one", () => {
    // A response with one coordinate, or with a string where a number should
    // be, would sail through a cast and become a distance measured from
    // nowhere. Better to have no point and say the job cannot be priced.
    const half = {
      status: "OK",
      results: [
        {
          formatted_address: "Somewhere, NY, USA",
          place_id: "p",
          geometry: { location: { lat: 40.7 } },
        },
      ],
    };
    expect(parseGeocodeResponse(half, "somewhere")).toMatchObject({ lat: null, lng: null });

    const stringy = {
      status: "OK",
      results: [
        {
          formatted_address: "Somewhere, NY, USA",
          place_id: "p",
          geometry: { location: { lat: "40.7", lng: "-74.0" } },
        },
      ],
    };
    expect(parseGeocodeResponse(stringy, "somewhere")).toMatchObject({ lat: null, lng: null });
  });

  it("recognises an airport, so no postcode confirmation is needed", () => {
    expect(parseGeocodeResponse(jfk, "JFK terminal 4")?.isAirport).toBe(true);
  });

  it("flags a partial match so Adam can ask rather than assume", () => {
    const raw = { ...parkAve, results: [{ ...parkAve.results[0], partial_match: true }] };
    expect(parseGeocodeResponse(raw, "park ave")?.partialMatch).toBe(true);
  });

  it("returns null when Google finds nothing", () => {
    expect(parseGeocodeResponse({ status: "ZERO_RESULTS", results: [] }, "asdfgh")).toBeNull();
  });

  it("returns null on a configuration error rather than pretending", () => {
    expect(
      parseGeocodeResponse({ status: "REQUEST_DENIED", error_message: "API not enabled" }, "x")
    ).toBeNull();
  });

  it("returns null for a result with no postcode component rather than inventing one", () => {
    const raw = {
      status: "OK",
      results: [{ formatted_address: "Somewhere, NY, USA", place_id: "p", types: ["locality"] }],
    };
    expect(parseGeocodeResponse(raw, "somewhere")?.postalCode).toBeNull();
  });

  it("copes with junk", () => {
    expect(parseGeocodeResponse(null, "x")).toBeNull();
    expect(parseGeocodeResponse("nope", "x")).toBeNull();
    expect(parseGeocodeResponse({ status: "OK", results: [] }, "x")).toBeNull();
  });
});

describe("parseRouteResponse", () => {
  it("converts the duration and distance Google returns", () => {
    const r = parseRouteResponse({ routes: [{ duration: "3120s", distanceMeters: 28968 }] });
    expect(r).toEqual({ minutes: 52, miles: 18 });
  });

  it("rounds to whole minutes", () => {
    expect(parseRouteResponse({ routes: [{ duration: "3149s" }] })?.minutes).toBe(52);
  });

  it("returns null when there is no route", () => {
    expect(parseRouteResponse({ routes: [] })).toBeNull();
    expect(parseRouteResponse({})).toBeNull();
    expect(parseRouteResponse(null)).toBeNull();
  });

  it("returns null for a nonsense duration instead of NaN minutes", () => {
    expect(parseRouteResponse({ routes: [{ duration: "abc" }] })).toBeNull();
    expect(parseRouteResponse({ routes: [{ duration: "0s" }] })).toBeNull();
  });
});

describe("describeAddress", () => {
  it("uses Google's version, tidied for a customer to read", () => {
    const a = parseGeocodeResponse(parkAve, "245 park ave")!;
    expect(describeAddress(a, "245 park ave")).toBe("245 Park Ave, New York, NY 10167");
  });

  it("quotes the customer's own words back when we don't", () => {
    expect(describeAddress(null, "the blue house on the corner")).toBe("the blue house on the corner");
  });
});

describe("airport detection", () => {
  // This block exists because the mocked tests all passed while the real
  // lookup did not: Google returns a specific TERMINAL as a point of interest
  // with no airport type. The payload below is the genuine response for
  // "JFK Terminal 4", copied from a live call.
  const jfkTerminal4 = {
    status: "OK",
    results: [
      {
        formatted_address: "Terminal 4, Terminal 4 Departures, Jamaica, NY 11430, USA",
        place_id: "ChIJw6g6qfhmwokRbY4s0mSbReY",
        types: ["premise"],
        address_components: [{ long_name: "11430", types: ["postal_code"] }],
      },
    ],
  };

  it("treats a named terminal as an airport even though Google does not", () => {
    expect(parseGeocodeResponse(jfkTerminal4, "JFK Terminal 4")?.isAirport).toBe(true);
  });

  it("still honours Google's own airport type", () => {
    expect(looksLikeAirport(["airport"], "Somewhere", "somewhere")).toBe(true);
  });

  it("recognises the airports this company actually serves", () => {
    for (const q of ["JFK", "pick up at LGA", "EWR terminal B", "Newark Liberty International Airport"]) {
      expect(looksLikeAirport([], "", q), q).toBe(true);
    }
  });

  it("does not mistake ordinary addresses for airports", () => {
    for (const a of [
      "245 Park Ave, New York, NY 10167, USA",
      "40 Wall St, New York, NY 10005, USA",
      "1 Terminal Place, Somewhere, NJ",
      "Jfkennedy Street, Boston, MA",
    ]) {
      expect(looksLikeAirport(["street_address"], a, a), a).toBe(false);
    }
  });
});

describe("resolveServiceArea", () => {
  // The model called Manhattan-to-JFK "external", reasoning that JFK is
  // outside the service area. It is not. These decide it from state codes.
  const at = (state: string | null): VerifiedAddress => ({
    formattedAddress: "somewhere",
    postalCode: null,
    state,
    placeId: "p",
    isAirport: false,
    partialMatch: false,
    lat: null,
    lng: null,
    query: "somewhere",
  });

  it("calls a trip that stays in New York internal — JFK included", () => {
    expect(resolveServiceArea([at("NY"), at("NY")], ["NY", "NJ"])).toBe("INTERNAL");
  });

  it("counts New Jersey as inside too", () => {
    expect(resolveServiceArea([at("NJ"), at("NY")], ["NY", "NJ"])).toBe("INTERNAL");
  });

  it("calls anything reaching another state external", () => {
    expect(resolveServiceArea([at("NY"), at("PA")], ["NY", "NJ"])).toBe("EXTERNAL");
    expect(resolveServiceArea([at("MA"), at("RI")], ["NY", "NJ"])).toBe("EXTERNAL");
  });

  it("takes stops into account, not just the two ends", () => {
    expect(resolveServiceArea([at("NY"), at("CT"), at("NY")], ["NY", "NJ"])).toBe("EXTERNAL");
  });

  it("refuses to decide when any point could not be verified", () => {
    expect(resolveServiceArea([at("NY"), null], ["NY", "NJ"])).toBeNull();
    expect(resolveServiceArea([at("NY"), at(null)], ["NY", "NJ"])).toBeNull();
    expect(resolveServiceArea([], ["NY", "NJ"])).toBeNull();
  });
});

describe("tidyAddress", () => {
  // Google's formatted_address is built for machines. These are the genuine
  // strings it returned for this company's own test bookings.
  it("drops a leading name that just repeats the street that follows", () => {
    expect(tidyAddress("245 Park Avenue, 245 Park Ave, New York, NY 10167, USA")).toBe(
      "245 Park Ave, New York, NY 10167"
    );
  });

  it("drops a terminal name repeated in the line after it", () => {
    expect(tidyAddress("Terminal 4, Terminal 4 Departures, Jamaica, NY 11430, USA")).toBe(
      "Terminal 4 Departures, Jamaica, NY 11430"
    );
  });

  it("keeps a leading name that actually adds something a driver could use", () => {
    expect(tidyAddress("Trump Bldg, 40 Wall St, New York, NY 10005, USA")).toBe(
      "Trump Bldg, 40 Wall St, New York, NY 10005"
    );
    expect(tidyAddress("Sheraton Philadelphia Downtown, 201 N 17th St, Philadelphia, PA 19103, USA")).toBe(
      "Sheraton Philadelphia Downtown, 201 N 17th St, Philadelphia, PA 19103"
    );
  });

  it("drops the country either way it is written", () => {
    expect(tidyAddress("40 Wall St, New York, NY 10005, United States")).toBe("40 Wall St, New York, NY 10005");
  });

  it("leaves an ordinary address alone", () => {
    expect(tidyAddress("40 Wall St, New York, NY 10005")).toBe("40 Wall St, New York, NY 10005");
  });

  it("copes with something too short to tidy", () => {
    expect(tidyAddress("JFK")).toBe("JFK");
    expect(tidyAddress("")).toBe("");
  });
});

describe("buildGeocodeUrl", () => {
  // Google answered a bare "LaGuardia" with Laguardia, Álava, Spain. That went
  // into a customer-facing drop-off line, and because Álava is not NY or NJ it
  // also flagged a Manhattan airport run as leaving the service area.
  const url = buildGeocodeUrl("LaGuardia", "test-key");

  it("restricts the search to the United States, not merely biases it", () => {
    expect(url).toContain("components=country%3AUS");
  });

  it("still sends the query, the region hint and the key", () => {
    expect(url).toContain("address=LaGuardia");
    expect(url).toContain("region=us");
    expect(url).toContain("key=test-key");
  });

  it("escapes an address with spaces and punctuation", () => {
    const messy = buildGeocodeUrl("245 Park Ave, New York", "k");
    expect(messy).toContain("address=245+Park+Ave%2C+New+York");
  });
});

describe("tidyAddress keeps the name of the place", () => {
  // 25 August, ticket #75. The reservation held the airport correctly and the
  // email told the customer their car was taking them to "Newark, NJ 07114".
  // A prefix test could not tell "Newark Liberty International Airport (EWR)"
  // apart from an abbreviation of "Newark".
  it("does not mistake an airport for the city it stands in", () => {
    expect(
      tidyAddress("Newark Liberty International Airport (EWR), Newark, NJ 07114, USA")
    ).toBe("Newark Liberty International Airport (EWR), Newark, NJ 07114");
  });

  it("still keeps a hotel a driver would look for", () => {
    expect(tidyAddress("The Ritz-Carlton, 50 Central Park S, New York, NY 10019, USA")).toBe(
      "The Ritz-Carlton, 50 Central Park S, New York, NY 10019"
    );
  });

  it("still drops a name the next line already contains", () => {
    expect(tidyAddress("Terminal 4, Terminal 4 Departures, Jamaica, NY 11430")).toBe(
      "Terminal 4 Departures, Jamaica, NY 11430"
    );
  });

  it("still drops a street written twice with one abbreviated", () => {
    expect(tidyAddress("245 Park Avenue, 245 Park Ave, New York, NY 10167, USA")).toBe(
      "245 Park Ave, New York, NY 10167"
    );
  });
});
