import { describe, expect, it } from "vitest";
import {
  extractVariables,
  findEmptyVariables,
  findUnknownVariables,
  renderTemplate,
  textToHtml,
} from "@/lib/template";

describe("renderTemplate", () => {
  const vars = {
    first_name: "Jana",
    last_name: "Nováková",
    company: "Vexy Media",
    website: "vexy.cz",
  };

  it("substitutes every supported variable", () => {
    expect(renderTemplate("Ahoj {{first_name}} {{last_name}} z {{company}} ({{website}})", vars)).toBe(
      "Ahoj Jana Nováková z Vexy Media (vexy.cz)",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Ahoj {{ first_name }},", vars)).toBe("Ahoj Jana,");
  });

  it("is case-insensitive on the variable name", () => {
    expect(renderTemplate("Ahoj {{First_Name}}", vars)).toBe("Ahoj Jana");
  });

  it("renders a missing value as empty string", () => {
    expect(renderTemplate("Ahoj {{first_name}}", {})).toBe("Ahoj ");
  });

  it("renders a whitespace-only value as missing", () => {
    expect(renderTemplate("Ahoj {{first_name}}", { first_name: "   " })).toBe("Ahoj ");
  });

  it("uses the fallback after a pipe when the value is missing", () => {
    expect(renderTemplate("Ahoj {{first_name|there}},", {})).toBe("Ahoj there,");
    expect(renderTemplate("Ahoj {{first_name|there}},", vars)).toBe("Ahoj Jana,");
  });

  it("leaves an unknown variable's fallback in place", () => {
    expect(renderTemplate("{{nonsense|x}}", vars)).toBe("x");
    expect(renderTemplate("{{nonsense}}", vars)).toBe("");
  });

  it("substitutes the same variable more than once", () => {
    expect(renderTemplate("{{company}} - {{company}}", vars)).toBe("Vexy Media - Vexy Media");
  });

  it("leaves non-template braces untouched", () => {
    expect(renderTemplate("a { b } c {{}} d", vars)).toBe("a { b } c {{}} d");
  });

  it("does not recursively expand a substituted value", () => {
    // A contact whose company literally contains a token must not trigger a
    // second pass - that would be a template-injection vector.
    expect(renderTemplate("{{company}}", { company: "{{first_name}}", first_name: "Jana" })).toBe(
      "{{first_name}}",
    );
  });
});

describe("variable inspection", () => {
  it("lists referenced variables once, in order", () => {
    expect(extractVariables("{{first_name}} {{company}} {{first_name}}")).toEqual([
      "first_name",
      "company",
    ]);
  });

  it("flags typos as unknown variables", () => {
    expect(findUnknownVariables("Ahoj {{firstname}} z {{company}}")).toEqual(["firstname"]);
    expect(findUnknownVariables("Ahoj {{first_name}}")).toEqual([]);
  });

  it("reports which variables would render blank for a contact", () => {
    expect(findEmptyVariables("{{first_name}} {{company}}", { first_name: "Jana" })).toEqual([
      "company",
    ]);
  });

  it("does not report a blank variable that has a fallback", () => {
    expect(findEmptyVariables("{{first_name|there}}", {})).toEqual([]);
  });
});

describe("textToHtml", () => {
  it("escapes HTML so a contact value cannot inject markup", () => {
    expect(textToHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("turns newlines into line breaks", () => {
    expect(textToHtml("a\nb")).toBe("a<br>b");
    expect(textToHtml("a\r\nb")).toBe("a<br>b");
  });

  it("linkifies bare URLs", () => {
    expect(textToHtml("see https://vexy.cz now")).toContain('<a href="https://vexy.cz"');
  });
});
