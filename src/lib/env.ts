/**
 * Environment access. Reads are lazy so that `next build` (which imports
 * modules without a runtime env) never crashes on a missing secret.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  get appPassword() {
    return required("APP_PASSWORD");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  /** Hard ceiling on retries for a provably-undelivered send. */
  get maxSendAttempts() {
    return Number(process.env.MAX_SEND_ATTEMPTS ?? 3);
  },
  /**
   * A send claimed longer ago than this is considered indeterminate: the
   * worker died somewhere around the SMTP call and we cannot know whether the
   * message left. Such rows become `unknown` and are never retried.
   */
  get sendClaimTimeoutMs() {
    return Number(process.env.SEND_CLAIM_TIMEOUT_MS ?? 5 * 60 * 1000);
  },
  /** How often each mailbox's IMAP inbox is polled. */
  get replyPollIntervalMs() {
    return Number(process.env.REPLY_POLL_INTERVAL_MS ?? 5 * 60 * 1000);
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
