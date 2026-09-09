import { describe, expect, it } from "vitest";
import { classifyImapError } from "@/lib/imap";

/**
 * These error shapes were captured from real imapflow failures against a live
 * IMAP conversation, not invented. The key fact they encode: imapflow's
 * `.message` is "Command failed" for EVERY rejected command, so a wrong
 * password and an unopenable INBOX are indistinguishable by message alone.
 */
describe("classifyImapError", () => {
  it("recognises a rejected password behind \"Command failed\"", () => {
    const raw = {
      message: "Command failed",
      authenticationFailed: true,
      responseText: "Authentication failed.",
      serverResponseCode: "AUTHENTICATIONFAILED",
      executedCommand: "LOGIN",
    };
    const result = classifyImapError(raw);
    expect(result.kind).toBe("auth_failed");
    expect(result.message).toMatch(/authentication failed/i);
    expect(result.message).not.toBe("Command failed");
  });

  it("recognises an unopenable INBOX behind the same \"Command failed\"", () => {
    const raw = {
      message: "Command failed",
      responseText: "Mailbox does not exist",
      serverResponseCode: "NONEXISTENT",
      executedCommand: "SELECT INBOX",
      mailboxMissing: true,
    };
    const result = classifyImapError(raw);
    expect(result.kind).toBe("select_inbox_failed");
    expect(result.message).toMatch(/INBOX could not be opened/i);
  });

  it("separates the two, which the old code could not", () => {
    const auth = classifyImapError({ message: "Command failed", authenticationFailed: true });
    const select = classifyImapError({ message: "Command failed", mailboxMissing: true });
    expect(auth.kind).not.toBe(select.kind);
    expect(auth.message).not.toBe(select.message);
  });

  it("names an unreachable host", () => {
    expect(classifyImapError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:993" }))
      .toMatchObject({ kind: "connection_failed" });
    expect(classifyImapError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND imap.typo.cz" }))
      .toMatchObject({ kind: "connection_failed" });
  });

  it("names a TLS mismatch and points at the port setting", () => {
    const result = classifyImapError({ message: "C0AB0000:error:0A00010B:SSL routines:wrong version number" });
    expect(result.kind).toBe("tls_failed");
    expect(result.message).toMatch(/993/);
  });

  it("names a timeout", () => {
    expect(classifyImapError({ code: "ETIMEDOUT", message: "Timeout" })).toMatchObject({ kind: "timeout" });
  });

  it("quotes the server for any other rejected command", () => {
    const result = classifyImapError({
      message: "Command failed",
      responseText: "Too many simultaneous connections",
      serverResponseCode: "LIMIT",
      executedCommand: "SELECT INBOX",
    });
    // SELECT is recognised specifically, so the server's words still come through.
    expect(result.message).toContain("Too many simultaneous connections");
  });

  it("redacts the password even if a server ever echoed it back", () => {
    const result = classifyImapError(
      { message: "Command failed", responseText: "bad login for pass hunter2xyz", authenticationFailed: true },
      ["hunter2xyz"],
    );
    expect(result.message).not.toContain("hunter2xyz");
    expect(result.message).toContain("***");
  });

  it("falls back safely on an error it does not recognise", () => {
    expect(classifyImapError(new Error("something odd"))).toMatchObject({
      kind: "unknown",
      message: "something odd",
    });
    expect(classifyImapError(undefined).kind).toBe("unknown");
  });
});
