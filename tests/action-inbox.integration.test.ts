import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { InboxMessage } from "@/lib/imap";

/**
 * Action inbox a klasifikace příchozí pošty, proti skutečné databázi.
 *
 * Kvůli čemu tenhle soubor vznikl: schránka ukazovala stovky vláken
 * "zatím bez odpovědi", bounce od postmastera vypadal jako odpověď
 * prospekta a automatická odpověď o dovolené natrvalo ukončila sekvenci.
 *
 * Stubuje se jen síťové kolo IMAPu. Párování, klasifikace, zápis do
 * vláken i důsledky pro sekvenci běží doopravdy.
 */

const inbox = vi.hoisted(() => ({ messages: [] as InboxMessage[], uidNext: 1, uidValidity: 1 }));

vi.mock("@/lib/imap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/imap")>();
  return {
    ...actual,
    fetchNewMessages: vi.fn(async () => ({
      messages: inbox.messages,
      uidNext: inbox.uidNext,
      uidValidity: inbox.uidValidity,
    })),
  };
});

let uid = 100;
function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  uid += 1;
  return {
    uid,
    messageId: `<incoming-${uid}@mail.example.com>`,
    inReplyTo: null,
    references: null,
    from: "a@example.com",
    to: "sender@example.com",
    subject: "Re: Hi Ann",
    receivedAt: new Date(),
    bodyText: "Díky, zní to zajímavě.",
    bodyHtml: null,
    ...overrides,
  };
}

let sql: typeof import("@/lib/db").sql;
let queries: typeof import("@/lib/queries/inbox");

async function enableImap(mailboxId: string) {
  const { encryptSecret } = await import("@/lib/crypto");
  await sql`
    update mailboxes
       set imap_host = 'imap.example.com', imap_port = 993, imap_username = 'sender@example.com',
           imap_password_enc = ${encryptSecret("secret")}, imap_secure = true
     where id = ${mailboxId}
  `;
}

/** Kampaň, jeden odeslaný krok, IMAP připravený. */
async function seedSent() {
  const seed = await seedCampaign({
    contacts: [{ email: "a@example.com", first_name: "Ann", company: "Acme" }],
  });
  const { startCampaign } = await import("@/lib/queries/campaigns");
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  await dispatchTick();
  await enableImap(seed.mailboxId);

  // Režim simulace nesáhne na SMTP, takže po sobě nenechá ani Message-ID,
  // ani zrcadlo v konverzaci. Doplníme obojí tak, jak by to vypadalo po
  // skutečném odeslání - testuje se příchozí strana, ne odchozí.
  const messageId = "<step1@example.com>";
  const [send] = await sql<{ id: string; campaign_contact_id: string }[]>`
    update email_sends
       set status = 'sent', message_id = ${messageId}, sent_at = now()
     where campaign_id = ${seed.campaignId}
    returning id, campaign_contact_id
  `;
  const { recordOutboundMessage } = await import("@/lib/queries/inbox");
  await recordOutboundMessage({
    mailboxId: seed.mailboxId,
    contactId: seed.contactIds[0],
    campaignId: seed.campaignId,
    campaignContactId: send.campaign_contact_id,
    kind: "campaign",
    fromEmail: "sender@example.com",
    toEmail: "a@example.com",
    subject: "Hi Ann",
    bodyText: "About Acme.",
    messageId,
    emailSendId: send.id,
  });
  return { ...seed, sentMessageId: messageId };
}

async function poll() {
  const { pollReplies } = await import("@/lib/engine/replies");
  return pollReplies(true);
}

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  queries = await import("@/lib/queries/inbox");
  inbox.messages = [];
  inbox.uidNext = 1000;
  inbox.uidValidity = 1;
  uid = 100;
});

afterAll(async () => {
  await closeDatabase();
});

// ======================================================== lidská odpověď

describe("lidská odpověď", () => {
  it("jde do K vyřízení a zastaví další follow-upy", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ bodyText: "Díky, pojďme se pobavit ve čtvrtek." })];
    await poll();

    const todo = await queries.listConversations({ view: "todo" });
    expect(todo).toHaveLength(1);
    expect(todo[0].contact_email).toBe("a@example.com");

    const [cc] = await sql<{ status: string; next_send_at: Date | null }[]>`
      select status, next_send_at from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    expect(cc.status).toBe("replied");
    expect(cc.next_send_at).toBeNull();
  });

  it("vlákno obsahuje odchozí i příchozí historii", async () => {
    await seedSent();
    inbox.messages = [message()];
    await poll();

    const [conversation] = await queries.listConversations({ view: "all" });
    const messages = await queries.listMessages(conversation.id);
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
  });

  it("odpověď se naváže na správný kontakt, kampaň i schránku", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ inReplyTo: seed.sentMessageId })];
    await poll();

    const [conversation] = await queries.listConversations({ view: "all" });
    expect(conversation.campaign_id).toBe(seed.campaignId);
    expect(conversation.mailbox_id).toBe(seed.mailboxId);
    expect(conversation.contact_email).toBe("a@example.com");
  });
});

// =================================================== co do inboxu nepatří

describe("technické e-maily nezaplňují sales inbox", () => {
  it("vlákno bez odpovědi není defaultně v K vyřízení", async () => {
    await seedSent(); // odesláno, nikdo neodpověděl
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);
    // ...ale ve Schránce je pořád vidět.
    expect(await queries.listConversations({ view: "all", scope: "all" })).toHaveLength(1);
  });

  it("bounce od postmastera není odpověď a nezaloží vlákno", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        from: "mailer-daemon@example.com",
        subject: "Undelivered Mail Returned to Sender",
        contentType: "multipart/report; report-type=delivery-status",
        bodyText:
          "Final-Recipient: rfc822; a@example.com\n" +
          "Action: failed\n" +
          "Status: 5.1.1\n" +
          "Diagnostic-Code: smtp; 550 5.1.1 <a@example.com>: Recipient address rejected: User unknown",
      }),
    ];
    await poll();

    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);
    expect(await queries.listConversations({ view: "all" })).toHaveLength(0);

    // Kontakt NENÍ označený jako ten, kdo odpověděl.
    const [cc] = await sql<{ status: string }[]>`
      select status from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    expect(cc.status).not.toBe("replied");

    // Zato se z toho stal záznam o nedoručení u konkrétního e-mailu.
    const [send] = await sql<{ bounce_type: string | null; bounce_code: string | null }[]>`
      select bounce_type, bounce_code from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(send.bounce_type).toBe("HARD_INVALID");
    expect(send.bounce_code).toBe("5.1.1");
  });

  it("mimo kancelář sekvenci odloží, ne ukončí", async () => {
    const seed = await seedSent();
    const [before] = await sql<{ next_send_at: Date | null }[]>`
      select next_send_at from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    inbox.messages = [
      message({
        subject: "Automatická odpověď: mimo kancelář",
        bodyText: "Jsem mimo kancelář do 20. 12. 2030. V naléhavém případě volejte kolegovi.",
      }),
    ];
    await poll();

    const [cc] = await sql<{ status: string; next_send_at: Date | null }[]>`
      select status, next_send_at from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    // Pořád v sekvenci, jen později.
    expect(cc.status).toBe("sent");
    expect(cc.next_send_at).not.toBeNull();
    expect(cc.next_send_at!.getTime()).toBeGreaterThan(before.next_send_at!.getTime());

    // A není to položka k vyřízení.
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);
    expect(await queries.listConversations({ view: "later" })).toHaveLength(1);
  });

  it("automatické potvrzení nic nespustí a nerozsvítí nepřečtené", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        subject: "Vaše zpráva byla přijata",
        bodyText: "Děkujeme, ozveme se.",
        headers: { "auto-submitted": "auto-replied" },
      }),
    ];
    await poll();

    const [cc] = await sql<{ status: string }[]>`
      select status from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    expect(cc.status).not.toBe("replied");
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);

    const [conversation] = await queries.listConversations({ view: "all" });
    expect(conversation.unread_count).toBe(0);
  });

  it("žádost o odhlášení odhlásí globálně a zastaví sekvenci", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ subject: "Re: nabídka", bodyText: "Prosím odhlaste mě ze seznamu." }),
    ];
    await poll();

    const [row] = await sql<{ reason_code: string; source: string | null }[]>`
      select reason_code, source from suppression_list where email = 'a@example.com'
    `;
    expect(row.reason_code).toBe("unsubscribe");
    expect(row.source).toBe("reply");

    const [cc] = await sql<{ status: string }[]>`
      select status from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    expect(["replied", "unsubscribed"]).toContain(cc.status);
  });
});

// ============================================================ pohledy

describe("pohledy", () => {
  it("K vyřízení obsahuje jen nezařazené lidské odpovědi", async () => {
    await seedSent();
    inbox.messages = [message()];
    await poll();
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(1);

    const [conversation] = await queries.listConversations({ view: "all" });
    await queries.setClassification(conversation.id, "positive");

    // Zařazené už k vyřízení není, ale je v Pozitivní.
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);
    expect(await queries.listConversations({ view: "positive" })).toHaveLength(1);
  });

  it("počty na záložkách sedí s tím, co je pod nimi", async () => {
    await seedSent();
    inbox.messages = [message()];
    await poll();

    const counts = await queries.getInboxCounts();
    for (const view of ["todo", "positive", "later", "resolved", "all"] as const) {
      expect(counts[view]).toBe((await queries.listConversations({ view })).length);
    }
  });
});
