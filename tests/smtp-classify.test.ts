import { describe, expect, it } from "vitest";
import { classifySmtpError, generateMessageId } from "@/lib/smtp";

/**
 * These assertions encode the safety rule the whole retry mechanism rests on:
 * an error may only be marked retryable when the message provably did not go
 * out. Anything ambiguous must come back as "unknown" and never be retried.
 */
describe("classifySmtpError", () => {
  it("treats a 4xx server response as a transient, retryable failure", () => {
    const result = classifySmtpError({ responseCode: 451, message: "Greylisted, try later" });
    expect(result).toMatchObject({ outcome: "failed", retryable: true, responseCode: 451 });
  });

  it("treats a 5xx server response as a permanent failure, not retried", () => {
    const result = classifySmtpError({ responseCode: 550, message: "Mailbox unavailable" });
    expect(result).toMatchObject({ outcome: "failed", retryable: false });
  });

  it("treats an auth failure as permanent - retrying cannot fix credentials", () => {
    const result = classifySmtpError({ code: "EAUTH", message: "Invalid login" });
    expect(result).toMatchObject({ outcome: "failed", retryable: false });
  });

  it("treats a connection failure as retryable - nothing was transmitted", () => {
    const result = classifySmtpError({ code: "ECONNECTION", message: "connect ECONNREFUSED" });
    expect(result).toMatchObject({ outcome: "failed", retryable: true });
  });

  it("treats an envelope rejection as failed, since the body was never sent", () => {
    const result = classifySmtpError({ code: "EENVELOPE", message: "recipient rejected" });
    expect(result.outcome).toBe("failed");
  });

  it("treats DNS failure as permanent", () => {
    expect(classifySmtpError({ code: "EDNS" })).toMatchObject({
      outcome: "failed",
      retryable: false,
    });
  });

  // --- the ambiguous cases: these MUST NOT be retried -------------------
  it("marks a socket reset with no server response as unknown", () => {
    const result = classifySmtpError({ code: "ECONNRESET", message: "socket hang up" });
    expect(result).toMatchObject({ outcome: "unknown", retryable: false });
  });

  it("marks a timeout with no server response as unknown", () => {
    // A timeout could have struck after DATA was accepted but before the
    // server's 250 reached us - the message may well have been delivered.
    const result = classifySmtpError({ code: "ETIMEDOUT", message: "Timeout" });
    expect(result).toMatchObject({ outcome: "unknown", retryable: false });
  });

  it("marks a stream error as unknown", () => {
    expect(classifySmtpError({ code: "ESTREAM" })).toMatchObject({ outcome: "unknown" });
  });

  it("marks a completely unrecognised error as unknown", () => {
    expect(classifySmtpError(new Error("something odd"))).toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
    expect(classifySmtpError(undefined)).toMatchObject({ outcome: "unknown" });
  });

  it("never marks an unknown outcome as retryable, whatever the input", () => {
    const inputs = [
      { code: "ECONNRESET" },
      { code: "ETIMEDOUT" },
      { code: "ESOCKET" },
      { code: "ESTREAM" },
      {},
      null,
      "string error",
    ];
    for (const input of inputs) {
      const result = classifySmtpError(input);
      if (result.outcome === "unknown") expect(result.retryable).toBe(false);
    }
  });

  it("includes the server response text in the stored message", () => {
    const result = classifySmtpError({
      responseCode: 550,
      message: "Message rejected",
      response: "550 5.7.1 Spam detected",
    });
    expect(result.message).toContain("550 5.7.1 Spam detected");
  });
});

describe("generateMessageId", () => {
  it("roots the id at the sender's domain and is unique per call", () => {
    const id = generateMessageId("me@vexy.cz");
    expect(id).toMatch(/^<[0-9a-f-]{36}@vexy\.cz>$/);
    expect(generateMessageId("me@vexy.cz")).not.toBe(id);
  });

  it("falls back gracefully on a malformed address", () => {
    expect(generateMessageId("nodomain")).toContain("@localhost");
  });
});
