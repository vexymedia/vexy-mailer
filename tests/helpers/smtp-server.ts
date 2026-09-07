import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";

export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
  messageId: string | null;
  inReplyTo: string | null;
  subject: string | null;
}

export interface FakeSmtp {
  port: number;
  received: CapturedMail[];
  /** Makes the next N deliveries fail with the given SMTP response code. */
  failNext(count: number, code: number, message: string): void;
  /** Drops the connection mid-DATA, producing an indeterminate outcome. */
  dropNext(count: number): void;
  close(): Promise<void>;
}

function header(raw: string, name: string): string | null {
  // Unfold continuation lines before matching, per RFC 5322 section 2.2.3.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(unfolded);
  return match ? match[1].trim() : null;
}

/**
 * A real SMTP server on a random port. Lets the tests exercise nodemailer,
 * the TLS-free auth path and true delivery failures instead of a stub.
 */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const received: CapturedMail[] = [];
  let failCount = 0;
  let failCode = 550;
  let failMessage = "Rejected";
  let dropCount = 0;

  const server = new SMTPServer({
    authOptional: false,
    secure: false,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _session, callback) {
      if (auth.username === "sender@example.com" && auth.password === "secret") {
        return callback(null, { user: auth.username });
      }
      return callback(new Error("Invalid username or password"));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (dropCount > 0) {
          dropCount--;
          // Never call back: the client's socket times out with no server
          // response, which is exactly the indeterminate case.
          session.envelope.rcptTo = [];
          return;
        }
        if (failCount > 0) {
          failCount--;
          const error = new Error(failMessage) as Error & { responseCode: number };
          error.responseCode = failCode;
          return callback(error);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          messageId: header(raw, "Message-ID"),
          inReplyTo: header(raw, "In-Reply-To"),
          subject: header(raw, "Subject"),
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;

  return {
    port,
    received,
    failNext(count, code, message) {
      failCount = count;
      failCode = code;
      failMessage = message;
    },
    dropNext(count) {
      dropCount = count;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
