import nodemailer, { type Transporter } from "nodemailer";
import { randomUUID } from "node:crypto";
import { decryptSecret } from "./crypto";
import type { Mailbox } from "./types";

export interface SendRequest {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Message-ID we mint ourselves so replies can be matched to this exact send. */
  messageId: string;
  /** Set on follow-ups so the whole sequence lands in one mail-client thread. */
  inReplyTo?: string | null;
  references?: string | null;
  listUnsubscribeUrl?: string | null;
}

export interface SendSuccess {
  ok: true;
  messageId: string;
  response: string;
}

/**
 * `outcome` is the whole point of this module.
 *
 *   "failed"  - the message provably did NOT go out. The SMTP server either
 *               refused it with a response code, or the failure happened
 *               before the message was ever transmitted. Safe to retry.
 *   "unknown" - the connection died at or after DATA with no server response.
 *               The message may or may not have been delivered. NEVER retried:
 *               for cold outreach a silent miss is far cheaper than a prospect
 *               receiving the same email twice.
 */
export interface SendFailure {
  ok: false;
  outcome: "failed" | "unknown";
  retryable: boolean;
  message: string;
  code: string | null;
  responseCode: number | null;
}

export type SendResult = SendSuccess | SendFailure;

interface SmtpError {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

/**
 * Error codes raised strictly before the message body is transmitted.
 * A failure here cannot have delivered anything.
 */
const PRE_TRANSMISSION_CODES = new Set([
  "EAUTH", // authentication rejected
  "ECONNECTION", // could not open the connection
  "EDNS", // hostname did not resolve
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETLS", // TLS negotiation failed
  "EENVELOPE", // MAIL FROM / RCPT TO rejected
]);

/** Codes that mean "fix the configuration", where retrying changes nothing. */
const PERMANENT_CODES = new Set(["EAUTH", "EDNS", "ENOTFOUND", "ETLS"]);

export function classifySmtpError(error: unknown): SendFailure {
  const err = (error ?? {}) as SmtpError;
  const code = err.code ?? null;
  const responseCode = typeof err.responseCode === "number" ? err.responseCode : null;
  const message = [err.message, err.response].filter(Boolean).join(" | ") || String(error);

  // The server answered with a status code. Whatever it said, it did not
  // silently accept the message - so we know it was not delivered.
  if (responseCode !== null) {
    return {
      ok: false,
      outcome: "failed",
      // 4xx is a transient refusal (greylisting, rate limit); 5xx is permanent.
      retryable: responseCode >= 400 && responseCode < 500,
      message,
      code,
      responseCode,
    };
  }

  if (code && PRE_TRANSMISSION_CODES.has(code)) {
    return {
      ok: false,
      outcome: "failed",
      retryable: !PERMANENT_CODES.has(code),
      message,
      code,
      responseCode: null,
    };
  }

  // Everything else - socket resets, stream errors, timeouts with no server
  // response - happened at an unknown point in the conversation. Fail closed.
  return { ok: false, outcome: "unknown", retryable: false, message, code, responseCode: null };
}

export function buildTransport(mailbox: Mailbox): Transporter {
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    // Implicit TLS on 465; STARTTLS upgrade on 587/25.
    secure: mailbox.smtp_secure && mailbox.smtp_port === 465,
    requireTLS: mailbox.smtp_secure && mailbox.smtp_port !== 465,
    auth: { user: mailbox.smtp_username, pass: decryptSecret(mailbox.smtp_password_enc) },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS ?? 20_000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS ?? 20_000),
    // A socket that goes quiet after DATA yields an indeterminate outcome, so
    // this timeout is the boundary between "failed" and "unknown". Tunable
    // mainly so tests can exercise that path quickly.
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 60_000),
  });
}

/** Mints a Message-ID rooted at the sender's domain. */
export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}

export async function sendMail(mailbox: Mailbox, request: SendRequest): Promise<SendResult> {
  let transport: Transporter | null = null;
  try {
    transport = buildTransport(mailbox);
    const info = await transport.sendMail({
      from: { name: mailbox.from_name, address: mailbox.from_email },
      to: request.to,
      subject: request.subject,
      text: request.text,
      html: request.html,
      messageId: request.messageId,
      inReplyTo: request.inReplyTo ?? undefined,
      references: request.references ?? undefined,
      headers: request.listUnsubscribeUrl
        ? {
            "List-Unsubscribe": `<${request.listUnsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
    });
    return {
      ok: true,
      messageId: info.messageId || request.messageId,
      response: info.response ?? "accepted",
    };
  } catch (error) {
    return classifySmtpError(error);
  } finally {
    transport?.close();
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
}

/** Verifies SMTP credentials without sending anything. */
export async function testSmtpConnection(mailbox: Mailbox): Promise<ConnectionTestResult> {
  let transport: Transporter | null = null;
  try {
    transport = buildTransport(mailbox);
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: classifySmtpError(error).message };
  } finally {
    transport?.close();
  }
}
