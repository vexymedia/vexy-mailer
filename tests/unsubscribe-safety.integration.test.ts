import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign, type Seed } from "./helpers/fixtures";

/**
 * The unsubscribe URL must not be a booby trap.
 *
 * Every link we put in an email is followed, unasked, by things that are not
 * the recipient: Microsoft Safe Links and its equivalents rewrite and fetch it,
 * spam filters retrieve it to score the mail, link checkers issue HEAD against
 * it, and mail clients prefetch for previews. When the unsubscribe URL was a
 * server component, rendering it suppressed the address - so any one of those
 * silently unsubscribed a prospect who had not touched the email, and the
 * campaign simply stopped reaching them with no trace of a decision.
 *
 * The rule these tests pin down is the HTTP one: GET and HEAD are safe methods
 * and change nothing; only an explicit POST - the confirmation button, or a
 * mail client's RFC 8058 one-click - removes anybody. And once that POST has
 * happened it must be honoured: suppression has to hold across the sequence,
 * re-import and re-enrolment, or an unsubscribe is only a suggestion.
 */

let sql: typeof import("@/lib/db").sql;
let GET: typeof import("@/app/u/[id]/[token]/route").GET;
let POST: typeof import("@/app/u/[id]/[token]/route").POST;
let unsubscribeUrl: typeof import("@/lib/unsubscribe").unsubscribeUrl;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ GET, POST } = await import("@/app/u/[id]/[token]/route"));
  ({ unsubscribeUrl } = await import("@/lib/unsubscribe"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  await enableSimulateMode();
});

afterAll(async () => {
  await closeDatabase();
});

/** The id and token exactly as they appear in the link we mail out. */
function linkParts(contactId: string): { id: string; token: string } {
  const [id, token] = new URL(unsubscribeUrl(contactId)).pathname.split("/").slice(-2);
  return { id, token };
}

function context(id: string, token: string) {
  return { params: Promise.resolve({ id, token }) };
}

async function request(
  handler: typeof GET,
  contactId: string,
  token?: string,
): Promise<Response> {
  const parts = linkParts(contactId);
  return handler(new Request(unsubscribeUrl(contactId), { method: "GET" }), context(parts.id, token ?? parts.token));
}

/** Whether the address is on the suppression list at all. */
async function isSuppressed(email: string): Promise<boolean> {
  const rows = await sql<{ email: string }[]>`select email from suppression_list where email = ${email}`;
  return rows.length > 0;
}

async function contactStatus(campaignContactId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from campaign_contacts where id = ${campaignContactId}
  `;
  return row.status;
}

async function seedOne(): Promise<Seed> {
  return seedCampaign({ contacts: [{ email: "prospect@example.com", first_name: "Pat", company: "Acme" }] });
}

describe("GET is safe", () => {
  it("does not unsubscribe the contact", async () => {
    const seed = await seedOne();
    const response = await request(GET, seed.contactIds[0]);

    expect(response.status).toBe(200);
    expect(await isSuppressed("prospect@example.com")).toBe(false);
    expect(await contactStatus(seed.campaignContactIds[0])).not.toBe("unsubscribed");
  });

  it("renders a confirmation the recipient has to act on", async () => {
    const seed = await seedOne();
    const body = await (await request(GET, seed.contactIds[0])).text();

    expect(body).toContain("prospect@example.com");
    // The only way onward is a POST the recipient submits themselves.
    expect(body).toMatch(/<form[^>]+method="post"/i);
    expect(body).toMatch(/<button[^>]*type="submit"/i);
  });

  it("survives a scanner hitting it repeatedly without suppressing anyone", async () => {
    const seed = await seedOne();
    for (let i = 0; i < 5; i++) await request(GET, seed.contactIds[0]);

    expect(await isSuppressed("prospect@example.com")).toBe(false);
    const rows = await sql<{ id: string }[]>`select id from suppression_list`;
    expect(rows).toHaveLength(0);
  });

  it("writes no activity log entry", async () => {
    const seed = await seedOne();
    await request(GET, seed.contactIds[0]);

    const rows = await sql<{ action: string }[]>`
      select action from activity_logs where action = 'Contact unsubscribed'
    `;
    expect(rows).toHaveLength(0);
  });

  it("leaves the contact fully sendable", async () => {
    const seed = await seedOne();
    await request(GET, seed.contactIds[0]);

    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    const sends = await sql<{ id: string }[]>`
      select id from email_sends where campaign_contact_id = ${seed.campaignContactIds[0]}
    `;
    expect(sends).toHaveLength(1);
  });
});

describe("HEAD is safe", () => {
  /**
   * Next serves HEAD from the GET handler and discards the body, so the proof
   * that HEAD is harmless is that the handler GET runs is itself harmless.
   * The real request over the wire is asserted by the browser E2E run.
   */
  it("does not unsubscribe the contact", async () => {
    const seed = await seedOne();
    const parts = linkParts(seed.contactIds[0]);
    const response = await GET(
      new Request(unsubscribeUrl(seed.contactIds[0]), { method: "HEAD" }),
      context(parts.id, parts.token),
    );

    expect(response.status).toBe(200);
    expect(await isSuppressed("prospect@example.com")).toBe(false);
    expect(await contactStatus(seed.campaignContactIds[0])).not.toBe("unsubscribed");
  });
});

describe("POST unsubscribes", () => {
  it("suppresses the address and stops the sequence", async () => {
    const seed = await seedOne();
    const response = await request(POST, seed.contactIds[0]);

    expect(response.status).toBe(200);
    // The UI is Czech; the confirmation names the address that was removed.
    expect(await (await request(POST, seed.contactIds[0])).text()).toContain("byl odebrán");
    expect(await isSuppressed("prospect@example.com")).toBe(true);
    expect(await contactStatus(seed.campaignContactIds[0])).toBe("unsubscribed");
  });

  it("clears the pending send so nothing is queued for them", async () => {
    const seed = await seedOne();
    await request(POST, seed.contactIds[0]);

    const [row] = await sql<{ next_send_at: Date | null }[]>`
      select next_send_at from campaign_contacts where id = ${seed.campaignContactIds[0]}
    `;
    expect(row.next_send_at).toBeNull();
  });

  it("is idempotent - a double submit suppresses once", async () => {
    const seed = await seedOne();
    await request(POST, seed.contactIds[0]);
    await request(POST, seed.contactIds[0]);

    const rows = await sql<{ email: string }[]>`
      select email from suppression_list where email = 'prospect@example.com'
    `;
    expect(rows).toHaveLength(1);
  });

  it("records the reason so the decision is traceable", async () => {
    const seed = await seedOne();
    await request(POST, seed.contactIds[0]);

    const [row] = await sql<{ reason: string }[]>`
      select reason from suppression_list where email = 'prospect@example.com'
    `;
    expect(row.reason).toBe("unsubscribe_link");
  });
});

describe("suppression holds after a real unsubscribe", () => {
  it("the worker sends them nothing more", async () => {
    const seed = await seedCampaign({
      contacts: [
        { email: "prospect@example.com", first_name: "Pat" },
        { email: "other@example.com", first_name: "Other" },
      ],
    });
    await request(POST, seed.contactIds[0]);
    await startCampaign(seed.campaignId);

    for (let i = 0; i < 4; i++) {
      await clearPacing(seed.campaignId);
      await dispatchTick();
    }

    const sends = await sql<{ id: string }[]>`
      select id from email_sends where campaign_contact_id = ${seed.campaignContactIds[0]}
    `;
    expect(sends).toHaveLength(0);

    // The campaign is not stalled - the other contact still gets their mail.
    const others = await sql<{ id: string }[]>`
      select id from email_sends where campaign_contact_id = ${seed.campaignContactIds[1]}
    `;
    expect(others.length).toBeGreaterThan(0);
  });

  it("re-enrolling the same address into a new campaign is refused", async () => {
    const seed = await seedOne();
    await request(POST, seed.contactIds[0]);

    const [fresh] = await sql<{ id: string }[]>`
      insert into campaigns (name, daily_limit, send_days, send_start_minute, send_end_minute, timezone)
      values ('Second campaign', 100, ${[1, 2, 3, 4, 5, 6, 7] as unknown as number[]}, 0, 1440, 'Europe/Prague')
      returning id
    `;

    // The suppression trigger is the authority, not application code.
    await expect(
      sql`insert into campaign_contacts (campaign_id, contact_id)
          values (${fresh.id}, ${seed.contactIds[0]})`,
    ).rejects.toThrow();
  });
});

describe("a bad link changes nothing", () => {
  it("a forged token is rejected without suppressing", async () => {
    const seed = await seedOne();
    const response = await request(POST, seed.contactIds[0], "0".repeat(32));

    expect(response.status).toBe(400);
    expect(await isSuppressed("prospect@example.com")).toBe(false);
    expect(await contactStatus(seed.campaignContactIds[0])).not.toBe("unsubscribed");
  });

  it("a valid token for a contact that no longer exists is rejected", async () => {
    const seed = await seedOne();
    const parts = linkParts(seed.contactIds[0]);
    await sql`delete from campaign_contacts where contact_id = ${seed.contactIds[0]}`;
    await sql`delete from contacts where id = ${seed.contactIds[0]}`;

    const response = await POST(
      new Request(unsubscribeUrl(seed.contactIds[0]), { method: "POST" }),
      context(parts.id, parts.token),
    );

    expect(response.status).toBe(400);
    const rows = await sql<{ id: string }[]>`select id from suppression_list`;
    expect(rows).toHaveLength(0);
  });
});
