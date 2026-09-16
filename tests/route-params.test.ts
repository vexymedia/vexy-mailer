import { describe, expect, it } from "vitest";
import { isUuid } from "@/lib/route-params";

/**
 * Id z adresy si může kdokoli napsat ručně.
 *
 * Bez téhle kontroly šlo `where id = 'neni-uuid'` rovnou do Postgresu,
 * ten odpověděl chybou 22P02 a uživatel dostal holé „Application error".
 * Padalo tak všech sedm dynamických stránek.
 */
describe("id z adresy", () => {
  it("platné UUID projde", () => {
    expect(isUuid("e3c6c444-7ac3-4908-acdf-513cbc4d0ee0")).toBe(true);
    expect(isUuid("E3C6C444-7AC3-4908-ACDF-513CBC4D0EE0")).toBe(true);
    expect(isUuid("  e3c6c444-7ac3-4908-acdf-513cbc4d0ee0  ")).toBe(true);
  });

  it("nesmysl neprojde", () => {
    for (const value of [
      "x", "neni-uuid", "", "   ", "123",
      "e3c6c444-7ac3-4908-acdf", // zkrácené
      "e3c6c444-7ac3-4908-acdf-513cbc4d0ee0x", // delší
      "g3c6c444-7ac3-4908-acdf-513cbc4d0ee0", // nehexa znak
      "e3c6c444_7ac3_4908_acdf_513cbc4d0ee0", // podtržítka
      "'; drop table contacts; --",
      "../../etc/passwd",
    ]) {
      expect(isUuid(value), `mělo být odmítnuto: ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("null a undefined neprojdou", () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
