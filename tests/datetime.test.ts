import { describe, expect, it } from "vitest";
import { formatPast, formatWhen } from "@/lib/datetime";

/**
 * Formátování časů v pražské zóně.
 *
 * Rozdíl mezi termínem a událostí v minulosti není kosmetický: caller
 * podle něj pozná, co má udělat, od toho, co se stalo.
 */
describe("formatPast", () => {
  const now = new Date("2026-09-14T09:00:00+02:00");

  it("nenazve minulost termínem po splatnosti", () => {
    // formatWhen je pro TERMÍNY; Loom odeslaný před čtyřmi dny není
    // "Po termínu" a takové označení callera jen zmate.
    const sent = new Date("2026-09-10T14:32:00+02:00");
    expect(formatWhen(sent, now)).toContain("Po termínu");
    expect(formatPast(sent, now)).not.toContain("Po termínu");
    expect(formatPast(sent, now)).toBe("10. 9. 14:32");
  });

  it("řekne dnes a včera jménem", () => {
    expect(formatPast(new Date("2026-09-14T08:10:00+02:00"), now)).toBe("Dnes 08:10");
    expect(formatPast(new Date("2026-09-13T17:20:00+02:00"), now)).toBe("Včera 17:20");
  });

  it("prázdnou hodnotu nepřetváří na datum", () => {
    expect(formatPast(null, now)).toBe("—");
  });
});
