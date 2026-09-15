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
 * Označit prospekta za toho, kdo odpověděl, by ho utnulo kvůli cizí
 * zprávě. Zpráva se proto uloží jako `needs_review` a rozhodne člověk.
 *
 * `needs_review` je ale POUZE příznak příchozí zprávy, NE pauza kampaně.
 * Kdyby uměl zastavit odesílání, stačilo by komukoli zvenčí napsat do
 * vlákna - přeposláním, automatickou odpovědí, spoofnutými hlavičkami -
 * a naše oslovení by stálo. Nejistý inbound nesmí mít vliv na outbound
 * harmonogram, a přesně to tenhle soubor hlídá.
 *
 * Cena je zvolená vědomě: než někdo zprávu posoudí, může odejít další
 * naplánovaný krok.
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

  const messageId = `<krok1-${seed.campaignId}@example.com>`;
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
  const [row] = await sql<{ status: string; next_send_at: Date | null }[]>`
    select status, next_send_at from campaign_contacts where campaign_id = ${campaignId}`;
  return row;
}

/** Kolik kroků kampaň odeslala. Jediný spolehlivý důkaz, že sekvence běží. */
async function sentCount(campaignId: string) {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int from email_sends where campaign_id = ${campaignId}`;
  return row.count;
}

/** Popožene dispatcher, jako by uplynul čas. */
async function drain(times = 5) {
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  for (let i = 0; i < times; i++) {
    await sql`update campaigns set next_slot_at = null`;
    await dispatchTick();
  }
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
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("jiná adresa na STEJNÉ doméně → tentýž člověk, sekvence končí", async () => {
    const seed = await seedSent("jan.novak@acme.test");
    inbox.messages = [message({ from: "j.novak@acme.test", references: seed.sentMessageId })];
    await poll();
    const contact = await contactRow(seed.campaignId);
    expect(contact.status).toBe("replied");
    expect(contact.next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("úplně jiná doména → posouzení, ale harmonogram BEZE ZMĚNY", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ from: "kolega@jina-firma.test", references: seed.sentMessageId }),
    ];
    await poll();

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    // Tohle je jádro věci: termín zůstal na milisekundu stejný.
    expect(contact.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("Gmail nebo jiná osobní adresa → taky posouzení, taky beze změny termínu", async () => {
    const seed = await seedSent();
    inbox.messages = [
      message({ from: "ana.novakova@gmail.com", references: seed.sentMessageId }),
    ];
    await poll();
    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("podvržené hlavičky cizí zprávy sekvenci neutnou ani neposunou", async () => {
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
    expect(contact.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });
});

// ================================ nejistý inbound NESMÍ zastavit outbound

describe("sekvence běží dál", () => {
  it("cizí zpráva nezabrání dispatcheru poslat další splatný krok", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    expect(await sentCount(seed.campaignId)).toBe(1);

    // Termín dozrál. Posouzení pořád visí neuzavřené - a přesto se pošle.
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    await drain(1);

    expect(await sentCount(seed.campaignId)).toBe(2);
    expect((await reviewRow()).needs_review).toBe(true); // review pořád čeká
  });

  it("dokud termín nedozrál, neposílá se nic navíc", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    await drain(6);
    // Termín je tři dny v budoucnu; cizí zpráva ho neposunula dopředu.
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("druhá cizí zpráva harmonogram nezmění", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    const first = await contactRow(seed.campaignId);

    inbox.messages = [message({ from: "dalsi@uplne-jina.test", references: seed.sentMessageId })];
    await poll();
    const second = await contactRow(seed.campaignId);

    expect(second.next_send_at?.getTime()).toBe(first.next_send_at?.getTime());
    expect(second.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
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
    // Obrazovka musí umět říct, kdy odejde další krok - protože odejde.
    expect(pending?.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
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
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("po „relevantní“ už dispatcher nic nepošle", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "relevant");
    await drain(5);
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("„nesouvisí“ harmonogram NEPŘEPÍŠE", async () => {
    const { seed, review } = await pending();
    const before = await contactRow(seed.campaignId);
    await queries.resolveReview(review.reply_id, "unrelated");

    const after = await contactRow(seed.campaignId);
    expect(after.status).toBe(before.status);
    expect(after.next_send_at?.getTime()).toBe(before.next_send_at?.getTime());
    expect(after.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("„nesouvisí“ po odeslaném follow-upu nic nevrací zpátky", async () => {
    const { seed, review } = await pending();
    // Krok odešel dřív, než to někdo stihl posoudit. To je očekávané.
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    await drain(1);
    expect(await sentCount(seed.campaignId)).toBe(2);
    const afterSend = await contactRow(seed.campaignId);

    await queries.resolveReview(review.reply_id, "unrelated");

    const afterReview = await contactRow(seed.campaignId);
    expect(afterReview.status).toBe(afterSend.status);
    expect(afterReview.next_send_at?.getTime()).toBe(afterSend.next_send_at?.getTime());
    expect(await sentCount(seed.campaignId)).toBe(2);
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
  it("stejná zpráva dvakrát nezaloží druhé posouzení ani nesáhne na termín", async () => {
    const seed = await seedSent();
    const msg = message({ from: "kolega@jina-firma.test", references: seed.sentMessageId });
    inbox.messages = [msg];
    await poll();
    const first = await contactRow(seed.campaignId);

    inbox.messages = [msg];
    await poll();
    const second = await contactRow(seed.campaignId);

    expect(second.next_send_at?.getTime()).toBe(first.next_send_at?.getTime());
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from replies where needs_review`;
    expect(count).toBe(1);
  });
});

// ======================================= posouzení nepřetéká na ostatní

describe("posouzení je vždycky jen o jednom kontaktu", () => {
  /** Dvě firmy v jedné kampani; cizí zpráva dorazí jen na první z nich. */
  async function twoContacts() {
    const seed = await seedSent();
    const [second] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values ('kolegyne@acme.test', 'Petra', 'Acme') returning id`;
    const scheduled = new Date(Date.now() + 3 * 86_400_000);
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, next_send_at, current_step)
      values (${seed.campaignId}, ${second.id}, 'scheduled', ${scheduled}, 1)`;
    return { seed, otherId: second.id, otherScheduled: scheduled };
  }

  it("cizí zpráva u jednoho kontaktu nesáhne na kolegu ve stejné kampani", async () => {
    const { seed, otherId, otherScheduled } = await twoContacts();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const [other] = await sql<{ status: string; next_send_at: Date | null }[]>`
      select status, next_send_at from campaign_contacts where contact_id = ${otherId}`;
    expect(other.status).toBe("scheduled");
    expect(other.next_send_at?.getTime()).toBe(otherScheduled.getTime());
  });

  it("„relevantní“ u jednoho kontaktu neutne kolegu ve stejné firmě", async () => {
    const { seed, otherId, otherScheduled } = await twoContacts();
    inbox.messages = [message({ from: "ana@gmail.com", references: seed.sentMessageId })];
    await poll();
    const [conversation] = await queries.listConversations({ view: "todo" });
    const review = await queries.getPendingReview(conversation.id);
    await queries.resolveReview(review!.reply_id, "relevant");

    const [other] = await sql<{ status: string; next_send_at: Date | null }[]>`
      select status, next_send_at from campaign_contacts where contact_id = ${otherId}`;
    expect(other.status).toBe("scheduled");
    expect(other.next_send_at?.getTime()).toBe(otherScheduled.getTime());
    void seed;
  });

  it("posouzení u jednoho klienta nesáhne na kampaň druhého klienta", async () => {
    const first = await seedSent("ana@acme.test");
    // Druhý klient oslovuje tutéž firmu vlastní kampaní.
    const second = await seedSent("petr@acme.test");
    const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
    const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
    await sql`update campaigns set client_id = ${vexy.id} where id = ${first.campaignId}`;
    await sql`update campaigns set client_id = ${asn.id} where id = ${second.campaignId}`;

    inbox.messages = [message({ from: "kdosi@jina-firma.test", references: first.sentMessageId })];
    await poll();
    const [conversation] = await queries.listConversations({ view: "todo" });
    const review = await queries.getPendingReview(conversation.id);
    await queries.resolveReview(review!.reply_id, "relevant");

    // Kampaň druhého klienta pokračuje beze změny.
    const other = await contactRow(second.campaignId);
    expect(other.status).not.toBe("replied");
    expect(other.next_send_at?.getTime()).toBe(second.scheduled.getTime());
  });
});
