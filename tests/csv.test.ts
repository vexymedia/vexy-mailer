import { describe, expect, it } from "vitest";
import { detectDelimiter, isValidEmail, parseContactsCsv, parseCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields containing the delimiter", () => {
    expect(parseCsv('a,b\n"x,y",2')).toEqual([
      ["a", "b"],
      ["x,y", "2"],
    ]);
  });

  it("handles escaped double quotes", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsv('a,b\n"line1\nline2",2')).toEqual([
      ["a", "b"],
      ["line1\nline2", "2"],
    ]);
  });

  it("handles CRLF line endings and a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿email,name\na@b.cz,A")[0][0]).toBe("email");
  });
});

describe("detectDelimiter", () => {
  it("detects comma, semicolon and tab", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });
});

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidEmail("jana@vexy.cz")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.example.co.uk")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "no-at-sign", "a@b", "a b@c.cz", "a@b,c.cz", "@vexy.cz"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});

describe("parseContactsCsv", () => {
  const CSV = [
    "first_name,last_name,company,email,website",
    "Jana,Nováková,Vexy Media,Jana@Vexy.CZ,https://vexy.cz",
    "Petr,Svoboda,Acme,petr@acme.cz,acme.cz",
  ].join("\n");

  it("parses the documented column layout", () => {
    const result = parseContactsCsv(CSV);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      email: "jana@vexy.cz", // lower-cased for the DB check constraint
      first_name: "Jana",
      last_name: "Nováková",
      company: "Vexy Media",
      website: "https://vexy.cz",
    });
  });

  it("accepts alternative header spellings", () => {
    const result = parseContactsCsv("First Name;E-Mail;Organization\nJana;jana@vexy.cz;Vexy");
    expect(result.rows[0]).toMatchObject({
      first_name: "Jana",
      email: "jana@vexy.cz",
      company: "Vexy",
    });
  });

  it("reports unrecognised columns instead of silently dropping them", () => {
    const result = parseContactsCsv("email,linkedin\na@b.cz,foo");
    expect(result.ignoredColumns).toEqual(["linkedin"]);
    expect(result.rows).toHaveLength(1);
  });

  it("fails clearly when there is no email column", () => {
    const result = parseContactsCsv("name,company\nJana,Vexy");
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toContain('No "email" column');
  });

  it("skips bad rows but keeps the good ones", () => {
    const result = parseContactsCsv("email,first_name\ngood@vexy.cz,A\nnot-an-email,B\n,C");
    expect(result.rows.map((r) => r.email)).toEqual(["good@vexy.cz"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("Line 3");
    expect(result.errors[1]).toContain("Line 4");
  });

  it("deduplicates within the file, case-insensitively", () => {
    const result = parseContactsCsv("email\na@vexy.cz\nA@VEXY.CZ");
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]).toContain("more than once");
  });

  it("returns null rather than empty string for blank optional cells", () => {
    const result = parseContactsCsv("email,first_name,company\na@vexy.cz,,");
    expect(result.rows[0].first_name).toBeNull();
    expect(result.rows[0].company).toBeNull();
  });

  it("reports an empty file", () => {
    expect(parseContactsCsv("").errors[0]).toContain("empty");
  });
});
