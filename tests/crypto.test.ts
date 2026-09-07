import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("secret encryption", () => {
  it("round-trips a password", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const secret = "hunter2-très-sécurisé-🔐";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const { encryptSecret } = await import("@/lib/crypto");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("never contains the plaintext", async () => {
    const { encryptSecret } = await import("@/lib/crypto");
    expect(encryptSecret("hunter2")).not.toContain("hunter2");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const payload = encryptSecret("hunter2");
    const parts = payload.split(":");
    const bytes = Buffer.from(parts[3], "base64");
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects a malformed payload", async () => {
    const { decryptSecret } = await import("@/lib/crypto");
    expect(() => decryptSecret("garbage")).toThrow("Malformed");
  });

  it("accepts a hex key as well as base64", async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
  });

  it("refuses a key of the wrong length", async () => {
    process.env.ENCRYPTION_KEY = "too-short";
    const { encryptSecret } = await import("@/lib/crypto");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
});

describe("safeEqual", () => {
  it("compares correctly regardless of length", async () => {
    const { safeEqual } = await import("@/lib/crypto");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
