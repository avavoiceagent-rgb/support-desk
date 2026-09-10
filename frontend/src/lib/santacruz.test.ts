import { describe, it, expect } from "vitest";
import { parseCsv } from "../api/santacruz";

describe("reading a SantaCruz export", () => {
  it("reads a plain file", () => {
    const { rows, problems } = parseCsv("RES_ID,PAX_NAME\nSC-1,Ana Costa\nSC-2,Daniel Weiss");
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { RES_ID: "SC-1", PAX_NAME: "Ana Costa" },
      { RES_ID: "SC-2", PAX_NAME: "Daniel Weiss" },
    ]);
  });

  it("keeps an address with commas in one column", () => {
    // The failure this exists to prevent: every column after the address
    // shifting along by one, on the rows with addresses and nowhere else.
    const { rows } = parseCsv('RES_ID,PU_ADDR,PAX_CNT\nSC-1,"245 Park Ave, New York, NY 10167",3');
    expect(rows[0].PU_ADDR).toBe("245 Park Ave, New York, NY 10167");
    expect(rows[0].PAX_CNT).toBe("3");
  });

  it("handles a quote inside a quoted value", () => {
    const { rows } = parseCsv('A,B\n"He said ""go""",2');
    expect(rows[0].A).toBe('He said "go"');
  });

  it("keeps a newline inside a quoted note", () => {
    const { rows } = parseCsv('A,NOTE\nSC-1,"line one\nline two"');
    expect(rows[0].NOTE).toBe("line one\nline two");
  });

  it("leaves out a row with the wrong number of values, and says which", () => {
    const { rows, problems } = parseCsv("A,B,C\n1,2,3\n4,5");
    expect(rows).toHaveLength(1);
    expect(problems.join(" ")).toContain("Row 3");
  });

  it("does not pad a short row into looking complete", () => {
    const { rows } = parseCsv("A,B,C\n4,5");
    expect(rows).toEqual([]);
  });

  it("says so when a column has no name", () => {
    const { problems } = parseCsv("A,,C\n1,2,3");
    expect(problems.join(" ")).toContain("no name");
  });

  it("ignores a trailing blank line", () => {
    const { rows, problems } = parseCsv("A,B\n1,2\n");
    expect(rows).toHaveLength(1);
    expect(problems).toEqual([]);
  });
});

describe("however the export reached the clipboard", () => {
  // A .csv opened in Excel and copied out arrives tab separated. That is how
  // most people will get an export onto the clipboard, and reading it as
  // commas produced one column named after every heading at once.
  it("reads a file copied out of a spreadsheet, which is tab separated", () => {
    const { rows, problems } = parseCsv(
      "RES_ID\tPU_ADDR\tPAX_CNT\nSC-1\t245 Park Ave, New York, NY\t3"
    );
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({
      RES_ID: "SC-1",
      PU_ADDR: "245 Park Ave, New York, NY",
      PAX_CNT: "3",
    });
  });

  it("does not let a comma inside an address outvote the tabs", () => {
    // The address alone has two commas in it and there are only two tabs, so
    // counting commas anywhere would pick the wrong separator.
    const { rows } = parseCsv("A\tB\tC\n1\t2, 3, 4\t5");
    expect(rows[0].B).toBe("2, 3, 4");
    expect(rows[0].C).toBe("5");
  });

  it("reads semicolons, which is what European Excel writes", () => {
    const { rows, problems } = parseCsv("RES_ID;PAX_NAME\nSC-1;Ana Costa");
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({ RES_ID: "SC-1", PAX_NAME: "Ana Costa" });
  });

  it("still reads an ordinary comma file", () => {
    const { rows, problems } = parseCsv("RES_ID,PAX_NAME\nSC-1,Ana Costa");
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({ RES_ID: "SC-1", PAX_NAME: "Ana Costa" });
  });

  it("says something useful when it can find no columns at all", () => {
    const { problems } = parseCsv("RES_ID PAX_NAME\nSC-1 Ana Costa");
    expect(problems.join(" ")).toContain("Only one column");
  });
});
