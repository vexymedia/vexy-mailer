import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { InboxMessage } from "@/lib/imap";

/**
 * Odpověď z jiné adresy na naše vlákno.
 *
 * Threading headers identifikují VLÁKNO, ne ČLOVĚKA. Přeposlaný e-mail
 * nese naše Message-ID dál, takže odpověď kolegy vypadá jako odpověď
 * prospekta.
 *
 * Dvě chyby, mezi kterými se to pohybuje:
 *   * označit prospekta za toho, kdo odpověděl → utneme ho kvůli cizí
 *     zprávě,
 *   * nechat sekvenci běžet dál → když to JE on z Gmailu, přijde mu
 *     další cold e-mail hodinu poté, co nám odpověděl.
 *
 * Řešení je pauza a rozhodnutí člověka. Tenhle soubor hlídá obojí.
 */

const inbox = vi.hoisted(() => ({ messages: [] as InboxMessage[], uidNext: 1, uidValidity: 1 }));

vi.mock("@/lib/imap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/imap")>();
  return {
    ...actual,
    fetchNewMessages: vi.fn(async () => ({
      messages: inbox.messages, uidNext: inbox.uidNext, uidValidity: inbox.uidValidity,
    })),
  };
});

let uid = 900;
function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  uid += 1;
  return {
    uid,
    messageId: `<in-${uid}@odesilatel.test>`,
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

/** Kampaň s odeslaným krokem 1, naplánovaným krokem 2 a zapnutým IMAPem. */
async function seedSent(email = "ana@acme.test") {
  const seed = await seedCampaign({ contacts: [{ email, first_name: "Ana" }] });
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
    mailboxId: seed.mailboxId, contactId: seed.contactIds[0], campaignId: seed.campaignId,
    campaignContactId: send.campaign_contact_id, kind: "campaign",
    fromEmail: "sender@example.com", toEmail: email, subject: "Krátký dotaz",
    bodyText: "Dobrý den…", messageId, emailSendId: send.id,
  });
  // Pevný termín dalšího kroku, ať jde ověřit, že se vrátí beze změny.
  const scheduled = new Date(Date.now() + 3 * 86_400_000);
  await sql`update campaign_contacts set next_send_at = ${scheduled}
             where campaign_id = ${seed.campaignId}`;
  return { ...seed, sentMessageId: messageId, scheduled };
}

async function contactRow(campaignId: string) {
  const [row] = await sql<
    { status: string; next_send_at: Date | null; paused_next_send_at: Date | null }[]
  >`select status, next_send_at, paused_next_send_at from campaign_contacts
      where campaign_id = ${campaignId}`;
  return row;
}

async function reviewRow() {
  const [row] = await sql<{ id: string; needs_review: boolean; from_email: string }[]>`
    select id, needs_review, from_email from replies order by received_at desc limit 1`;
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  queries = await import("@/lib/queries/inbox");
  inbox.messages = [];
  inbox.uidNext = 9000;
  inbox.uidValidity = 1;
  uid = 900;
});

afterAll(async () => {
  await closeDatabase();
});

// ================================================= kdo to vlastně napsal

describe("odesílatel versus kontakt", () => {
  it("přesně stejná adresa → odpověď prospekta, sekvence končí", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "ana@acme.test", references: seed.sentMessageId })];
    await poll();

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).toBe("replied");
    expect(contact.next_send_at).toBeNull();
    expect(contact.paused_next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("jiná adresa na STEJNÉ doméně → tentýž člověk, sekvence končí", async () => {
    const seed = await seedSent("jan.novak@acme.test");
    inbox.messages = [message({ from: "j.novak@acme.test", references: seed.sentMessageId })];
    await poll();
    expect((await contactRow(seed.campaignId)).status).toBe("replied");
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("úplně jiná doména → posouzení, sekvence POZASTAVENA", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ from: "kolega@jina-firma.test", references: seed.sentMessageId }),
    ];
    await poll();

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    // Pozastaveno: termín je uschovaný, ne ztracený.
    expect(contact.next_send_at).toBeNull();
    expect(contact.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("Gmail nebo jiná osobní adresa → taky posouzení", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ from: "ana.novakova@gmail.com", references: seed.sentMessageId }),
    ];
    await poll();
    expect((await contactRow(seed.campaignId)).status).not.toBe("replied");
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("podvržené hlavičky cizí zprávy sekvenci neutnou, jen ji pozastaví", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({
        from: "newsletter@uplne-nesouvisejici.test",
        references: seed.sentMessageId,
        subject: "Novinky z našeho e-shopu",
        bodyText: "Tento týden sleva 20 %.",
      }),
    ];
    await poll();
    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect((await reviewRow()).needs_review).toBe(true);
  });
});

// ============================================ dokud se nerozhodne, stojí

describe("pozastavená sekvence", () => {
  it("během posouzení neodejde žádný další krok", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const { dispatchTick } = await import("@/lib/engine/dispatch");
    // I kdyby byl krok dávno splatný: bez rozhodnutí se nic neposílá.
    for (let i = 0; i < 5; i++) {
      await sql`update campaigns set next_slot_at = null`;
      await dispatchTick();
    }
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId}`;
    expect(count).toBe(1); // jen původní krok 1
  });

  it("je vidět v Komunikaci → K vyřízení", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const todo = await queries.listConversations({ view: "todo" });
    expect(todo).toHaveLength(1);
    const flagged = await queries.listConversationsNeedingReview();
    expect(flagged.has(todo[0].id)).toBe(true);

    // A s vysvětlením, kdo psal a komu jsme psali.
    const pending = await queries.getPendingReview(todo[0].id);
    expect(pending?.from_email).toBe("kolega@jina-firma.test");
    expect(pending?.contact_email).toBe("ana@acme.test");
    void seed;
  });
});

// ================================================== ruční vyhodnocení

describe("rozhodnutí člověka", () => {
  async function pending() {
    const seed = await seedSent();
    inbox.messages = [message({ from: "ana@gmail.com", references: seed.sentMessageId })];
    await poll();
    const [conversation] = await queries.listConversations({ view: "todo" });
    const review = await queries.getPendingReview(conversation.id);
    if (!review) throw new Error("posouzení nevzniklo");
    return { seed, conversationId: conversation.id, review };
  }

  it("„relevantní“ ukončí sekvenci a označí kontakt za odpověděvšího", async () => {
    const { seed, review } = await pending();
    const result = await queries.resolveReview(review.reply_id, "relevant");
    expect(result.ok).toBe(true);

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).toBe("replied");
    expect(contact.next_send_at).toBeNull();
    expect(contact.paused_next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("„nesouvisí“ vrátí PŮVODNÍ termín, ne „hned teď“", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect(contact.paused_next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("po „nesouvisí“ se neodešle nic nahromaděného naráz", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");

    const { dispatchTick } = await import("@/lib/engine/dispatch");
    for (let i = 0; i < 6; i++) {
      await sql`update campaigns set next_slot_at = null`;
      await dispatchTick();
    }
    // Termín je v budoucnu, takže pořád jen původní krok 1.
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId}`;
    expect(count).toBe(1);
  });

  it("po „nesouvisí“ sekvence v původním termínu normálně pokračuje", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");

    // Přeskočíme čas na původní termín.
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    await sql`update campaigns set next_slot_at = null`;
    await dispatchTick();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId}`;
    expect(count).toBe(2);
  });

  it("uzavřené posouzení už zmizí z K vyřízení i z odznaků", async () => {
    const { conversationId, review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");
    expect(await queries.getPendingReview(conversationId)).toBeNull();
    expect((await queries.listConversationsNeedingReview()).has(conversationId)).toBe(false);
  });

  it("druhé rozhodnutí o téže zprávě neprojde", async () => {
    const { review } = await pending();
    expect((await queries.resolveReview(review.reply_id, "relevant")).ok).toBe(true);
    expect((await queries.resolveReview(review.reply_id, "unrelated")).ok).toBe(false);
  });

  it("rozhodnutí se zapíše do aktivity", async () => {
    const { review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");
    const rows = await sql<{ action: string }[]>`select action from activity_logs`;
    expect(rows.some((r) => r.action.includes("nesouvisející"))).toBe(true);
  });
});

// ==================================================== idempotence

describe("opakovaný příjem", () => {
  it("stejná zpráva dvakrát nezaloží druhé posouzení ani nepřepíše termín", async () => {
    const seed = await seedSent();
    const msg = message({ from: "kolega@jina-firma.test", references: seed.sentMessageId });
    inbox.messages = [msg];
    await poll();
    const first = await contactRow(seed.campaignId);

    inbox.messages = [msg];
    await poll();
    const second = await contactRow(seed.campaignId);

    expect(second.paused_next_send_at?.getTime()).toBe(first.paused_next_send_at?.getTime());
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from replies where needs_review`;
    expect(count).toBe(1);
  });

  it("druhá cizí zpráva nepřepíše uschovaný termín nulou", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    const after = await contactRow(seed.campaignId);
    expect(after.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());

    inbox.messages = [message({ from: "dalsi@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    // next_send_at je teď null; coalesce nesmí uschovaný termín zahodit.
    expect((await contactRow(seed.campaignId)).paused_next_send_at?.getTime())
      .toBe(seed.scheduled.getTime());
  });
});
