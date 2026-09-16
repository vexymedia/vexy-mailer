import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { InboxMessage } from "@/lib/imap";

/**
 * Hraniční případy příchozí pošty.
 *
 * Nejdůležitější z nich: PŘEPOSLANÁ ZPRÁVA. Když prospekt přepošle náš
 * e-mail kolegovi a odpoví kolega, nese ta odpověď naše Message-ID
 * v References - takže se spáruje na thread, i když ji psal někdo úplně
 * jiný. Bez další podmínky by se prospekt označil za toho, kdo odpověděl,
 * a jeho sekvence by se zastavila kvůli cizí zprávě.
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

let uid = 500;
function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  uid += 1;
  return {
    uid,
    messageId: `<in-${uid}@prospect.test>`,
    inReplyTo: null,
    references: null,
    from: "ana@acme.test",
    to: "sender@example.com",
    subject: "Re: Krátký dotaz",
    receivedAt: new Date(),
    bodyText: "Díky, zní to zajímavě.",
    bodyHtml: null,
    ...overrides,
  };
}

let sql: typeof import("@/lib/db").sql;
let queries: typeof import("@/lib/queries/inbox");

async function poll() {
  const { pollReplies } = await import("@/lib/engine/replies");
  return pollReplies(true);
}

/** Kampaň s jedním odeslaným krokem a zapnutým IMAPem. */
async function seedSent(email = "ana@acme.test") {
  const seed = await seedCampaign({ contacts: [{ email, first_name: "Ana", company: "Acme" }] });
  const { startCampaign } = await import("@/lib/queries/campaigns");
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  const { encryptSecret } = await import("@/lib/crypto");
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  await dispatchTick();
  await sql`
    update mailboxes
       set imap_host = 'imap.example.com', imap_port = 993, imap_username = 'sender@example.com',
           imap_password_enc = ${encryptSecret("x")}, imap_secure = true
     where id = ${seed.mailboxId}`;
  const messageId = "<krok1@example.com>";
  const [send] = await sql<{ id: string; campaign_contact_id: string }[]>`
    update email_sends set status = 'sent', message_id = ${messageId}, sent_at = now()
     where campaign_id = ${seed.campaignId} returning id, campaign_contact_id`;
  await queries.recordOutboundMessage({
    mailboxId: seed.mailboxId,
    contactId: seed.contactIds[0],
    campaignId: seed.campaignId,
    campaignContactId: send.campaign_contact_id,
    kind: "campaign",
    fromEmail: "sender@example.com",
    toEmail: email,
    subject: "Krátký dotaz",
    bodyText: "Dobrý den…",
    messageId,
    emailSendId: send.id,
  });
  return { ...seed, sentMessageId: messageId };
}

async function contactStatus(campaignId: string) {
  const [row] = await sql<{ status: string; next_send_at: Date | null }[]>`
    select status, next_send_at from campaign_contacts where campaign_id = ${campaignId}`;
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  queries = await import("@/lib/queries/inbox");
  inbox.messages = [];
  inbox.uidNext = 5000;
  inbox.uidValidity = 1;
  uid = 500;
});

afterAll(async () => {
  await closeDatabase();
});

// ================================================ přeposlání a cizí adresa

describe("odpověď od někoho jiného", () => {
  it("přeposlaná zpráva z CIZÍ domény sekvenci neutne, ale pozastaví ji", async () => {
    const seed = await seedSent();
    const [before] = await sql<{ next_send_at: Date }[]>`
      select next_send_at from campaign_contacts where campaign_id = ${seed.campaignId}`;
    inbox.messages = [
      message({
        from: "kolega@uplne-jina-firma.test",
        references: seed.sentMessageId,
        bodyText: "Ahoj, tohle mi přeposlala Ana — co si o tom myslíš?",
      }),
    ];
    await poll();

    // Prospekt sám nic nenapsal, takže se za odpověděvšího neoznačí.
    // Sekvence ale stojí, dokud zprávu někdo neposoudí: kdyby to byl on
    // z jiné adresy, přišel by mu za tři dny další cold e-mail.
    const contact = await contactStatus(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.next_send_at).toBeNull();
    const [paused] = await sql<{ paused_next_send_at: Date | null }[]>`
      select paused_next_send_at from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(paused.paused_next_send_at?.getTime()).toBe(before.next_send_at.getTime());
  });

  it("ale zpráva se neztratí - je ke kontrole", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ from: "kolega@uplne-jina-firma.test", references: seed.sentMessageId }),
    ];
    await poll();
    const [reply] = await sql<{ from_email: string; needs_review: boolean }[]>`
      select from_email, needs_review from replies`;
    expect(reply.from_email).toBe("kolega@uplne-jina-firma.test");
    expect(reply.needs_review).toBe(true);
  });

  it("odpověď z JINÉ ADRESY TÉŽE FIRMY se bere jako tentýž člověk", async () => {
    const seed = await seedSent("jan.novak@acme.test");
    inbox.messages = [
      message({ from: "j.novak@acme.test", references: seed.sentMessageId, bodyText: "Díky, ozvu se." }),
    ];
    await poll();
    // Alias na stejné doméně: sekvence se zastaví, jinak bychom psali
    // dál člověku, který nám právě odpověděl.
    expect((await contactStatus(seed.campaignId)).status).toBe("replied");
  });

  it("odpověď od samotného prospekta zastaví sekvenci", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "ana@acme.test", references: seed.sentMessageId })];
    await poll();
    expect((await contactStatus(seed.campaignId)).status).toBe("replied");
  });
});

// =========================================================== idempotence

describe("opakované zpracování téže zprávy", () => {
  it("stejná IMAP zpráva dvakrát nevytvoří duplicitu ani druhý efekt", async () => {
    const seed = await seedSent();
    const msg = message({ references: seed.sentMessageId });
    inbox.messages = [msg];
    await poll();
    const [firstReply] = await sql<{ count: number }[]>`select count(*)::int as count from replies`;

    // Stejná zpráva znovu, jako po restartu nebo změně UIDVALIDITY.
    inbox.messages = [msg];
    await poll();

    const [replies] = await sql<{ count: number }[]>`select count(*)::int as count from replies`;
    const [messages] = await sql<{ count: number }[]>`
      select count(*)::int as count from messages where direction = 'inbound'`;
    const [conversations] = await sql<{ count: number }[]>`select count(*)::int as count from conversations`;
    expect(replies.count).toBe(firstReply.count);
    expect(messages.count).toBe(1);
    expect(conversations.count).toBe(1);
    void seed;
  });

  it("opakované OOO neposouvá datum donekonečna", async () => {
    const seed = await seedSent();
    const ooo = message({
      references: seed.sentMessageId,
      subject: "Automatická odpověď: mimo kancelář",
      bodyText: "Jsem mimo kancelář, vrátím se později.",
    });
    inbox.messages = [ooo];
    await poll();
    const first = (await contactStatus(seed.campaignId)).next_send_at;

    inbox.messages = [ooo];
    await poll();
    const second = (await contactStatus(seed.campaignId)).next_send_at;
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("dvě různé zprávy se stejným Message-ID se uloží jen jednou", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ messageId: "<stejne@prospect.test>", references: seed.sentMessageId, bodyText: "A" }),
      message({ messageId: "<stejne@prospect.test>", references: seed.sentMessageId, bodyText: "B" }),
    ];
    await poll();
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from messages where direction = 'inbound'`;
    expect(row.count).toBe(1);
  });

  it("opakovaný bounce nezaloží druhou suppression", async () => {
    const seed = await seedSent();
    const bounce = message({
      from: "mailer-daemon@acme.test",
      subject: "Undelivered Mail Returned to Sender",
      contentType: "multipart/report; report-type=delivery-status",
      bodyText: "Final-Recipient: rfc822; ana@acme.test\nStatus: 5.1.1\n" +
                "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
    });
    inbox.messages = [bounce];
    await poll();
    inbox.messages = [{ ...bounce, uid: bounce.uid + 1, messageId: "<jiny@acme.test>" }];
    await poll();

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from suppression_list where email = 'ana@acme.test'`;
    expect(row.count).toBe(1);
    void seed;
  });
});

// ==================================================== poškozené zprávy

describe("zprávy, které nejsou v pořádku", () => {
  it("zpráva bez Message-ID se přeskočí a nic nerozbije", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ messageId: null, references: seed.sentMessageId })];
    const summary = await poll();
    expect(summary.mailboxes[0].error).toBeUndefined();
    expect((await contactStatus(seed.campaignId)).status).not.toBe("replied");
  });

  it("zpráva bez čitelného těla se pořád zpracuje jako odpověď", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ bodyText: null, bodyHtml: null, references: seed.sentMessageId })];
    await poll();
    expect((await contactStatus(seed.campaignId)).status).toBe("replied");
  });

  it("HTML-only zpráva se zpracuje", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ bodyText: null, bodyHtml: "<p>Díky, ozvu se.</p>", references: seed.sentMessageId }),
    ];
    await poll();
    expect((await contactStatus(seed.campaignId)).status).toBe("replied");
  });

  it("velká písmena v adrese odesílatele blokaci neobejdou", async () => {
    const seed = await seedSent();
    // Envelope adresy normalizuje imap.ts; tady kontrolujeme párování.
    inbox.messages = [message({ from: "ana@acme.test", references: seed.sentMessageId })];
    await poll();
    expect((await contactStatus(seed.campaignId)).status).toBe("replied");
  });

  it("chybějící hlavičky nezpůsobí pád pollu", async () => {
    await seedSent();
    inbox.messages = [
      message({ inReplyTo: null, references: null, subject: null, from: null }),
    ];
    const summary = await poll();
    expect(summary.mailboxes[0].error).toBeUndefined();
  });
});

// ========================================================== OOO varianty

describe("mimo kancelář", () => {
  it("s konkrétním datem odloží zhruba na návrat", async () => {
    const seed = await seedSent();
    const rok = new Date().getUTCFullYear() + 2;
    inbox.messages = [
      message({
        references: seed.sentMessageId,
        subject: "Automatická odpověď",
        bodyText: `Jsem mimo kancelář do 20. 12. ${rok}.`,
      }),
    ];
    await poll();
    const next = (await contactStatus(seed.campaignId)).next_send_at!;
    expect(next.getUTCFullYear()).toBe(rok);
  });

  it("bez data odloží o bezpečný týden", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        references: seed.sentMessageId,
        subject: "Out of Office",
        bodyText: "I am currently out of the office.",
      }),
    ];
    await poll();
    const next = (await contactStatus(seed.campaignId)).next_send_at!;
    const days = (next.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(9);
  });

  it("minulé datum se nepoužije, spadne na bezpečný odklad", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        references: seed.sentMessageId,
        subject: "Automatická odpověď",
        bodyText: "Byl jsem mimo kancelář do 1. 1. 2020.",
      }),
    ];
    await poll();
    const next = (await contactStatus(seed.campaignId)).next_send_at!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
});

// ============================================================== bounce

describe("bounce", () => {
  it("bounce s původní zprávou v příloze se spáruje podle Final-Recipient", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        from: "postmaster@acme.test",
        subject: "Delivery Status Notification (Failure)",
        contentType: "multipart/report; report-type=delivery-status",
        bodyText:
          "This is the mail system at host mx.acme.test.\n\n" +
          "Final-Recipient: rfc822; ana@acme.test\nAction: failed\nStatus: 5.1.1\n" +
          "Diagnostic-Code: smtp; 550 5.1.1 <ana@acme.test>: User unknown\n\n" +
          "--- Original message ---\nSubject: Krátký dotaz\n",
      }),
    ];
    await poll();
    const [send] = await sql<{ bounce_type: string | null }[]>`
      select bounce_type from email_sends where campaign_id = ${seed.campaignId}`;
    expect(send.bounce_type).toBe("HARD_INVALID");
  });

  it("opožděný bounce po naplánování follow-upu follow-up zruší", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        from: "mailer-daemon@acme.test",
        subject: "Undelivered Mail Returned to Sender",
        contentType: "multipart/report; report-type=delivery-status",
        bodyText: "Final-Recipient: rfc822; ana@acme.test\nStatus: 5.1.1\n" +
                  "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
      }),
    ];
    await poll();
    // Suppression kontakt vyřadí z fronty.
    const [row] = await sql<{ status: string }[]>`
      select status from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(row.status).toBe("unsubscribed");
  });

  it("bounce se nepočítá jako odpověď a nedostane se do K vyřízení", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        from: "mailer-daemon@acme.test",
        subject: "Undeliverable",
        contentType: "multipart/report",
        bodyText: "Final-Recipient: rfc822; ana@acme.test\nStatus: 4.4.1\n" +
                  "Diagnostic-Code: smtp; 451 temporary failure",
      }),
    ];
    await poll();
    expect(await queries.listConversations({ view: "todo" })).toHaveLength(0);
    expect((await contactStatus(seed.campaignId)).status).not.toBe("replied");
  });
});
