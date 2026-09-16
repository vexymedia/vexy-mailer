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
 * Dokud to někdo neposoudí, sekvence toho kontaktu STOJÍ. Kdyby běžela,
 * mohl by prospektovi přijít cold e-mail hodinu poté, co nám z jiné
 * adresy odpověděl - a to je horší než krok o den později.
 *
 * Pozastavuje se jen kandidát, na kterého se vlákno spárovalo. Ne všechny
 * kontakty klienta a nikdy nic u klienta jiného.
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
  const [row] = await sql<
    { status: string; next_send_at: Date | null; paused_next_send_at: Date | null }[]
  >`select status, next_send_at, paused_next_send_at from campaign_contacts
      where campaign_id = ${campaignId}`;
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

  it("úplně jiná doména → posouzení a POZASTAVENÍ", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.next_send_at).toBeNull();
    // Termín se neztratil, jen se uschoval.
    expect(contact.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("Gmail nebo jiná osobní adresa → taky posouzení a pozastavení", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "ana.novakova@gmail.com", references: seed.sentMessageId })];
    await poll();
    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("podvržené hlavičky cizí zprávy sekvenci neutnou, jen pozastaví", async () => {
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
    expect(contact.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());
  });
});

// ============================== dokud se nerozhodne, scheduler nepošle

describe("pozastavení je skutečné", () => {
  it("během posouzení neodejde žádný další krok, ani když je splatný", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    expect(await sentCount(seed.campaignId)).toBe(1);

    // Kdyby pauza byla jen kosmetická, tohle by krok odeslalo.
    await drain(5);
    expect(await sentCount(seed.campaignId)).toBe(1);
    expect((await reviewRow()).needs_review).toBe(true);
  });

  it("dispatcher kontakt vůbec nevybere — next_send_at je null", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int from campaign_contacts
       where campaign_id = ${seed.campaignId} and next_send_at is not null`;
    expect(row.count).toBe(0);
  });

  it("je vidět v Komunikaci → K vyřízení, s uschovaným termínem", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const todo = await queries.listConversations({ view: "todo" });
    expect(todo).toHaveLength(1);
    expect((await queries.listConversationsNeedingReview()).has(todo[0].id)).toBe(true);

    const pending = await queries.getPendingReview(todo[0].id);
    expect(pending?.from_email).toBe("kolega@jina-firma.test");
    expect(pending?.contact_email).toBe("ana@acme.test");
    expect(pending?.paused_next_send_at?.getTime()).toBe(seed.scheduled.getTime());
  });
});

// ================================================== ruční vyhodnocení

describe("rozhodnutí člověka", () => {
  async function pending(from = "ana@gmail.com") {
    const seed = await seedSent();
    inbox.messages = [message({ from, references: seed.sentMessageId })];
    await poll();
    const [conversation] = await queries.listConversations({ view: "todo" });
    const review = await queries.getPendingReview(conversation.id);
    if (!review) throw new Error("posouzení nevzniklo");
    return { seed, conversationId: conversation.id, review };
  }

  it("„relevantní“ ukončí sekvenci a označí kontakt za odpověděvšího", async () => {
    const { seed, review } = await pending();
    expect((await queries.resolveReview(review.reply_id, "relevant")).ok).toBe(true);

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).toBe("replied");
    expect(contact.next_send_at).toBeNull();
    expect(contact.paused_next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("po „relevantní“ dispatcher už nic nepošle", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "relevant");
    await drain(5);
    expect(await sentCount(seed.campaignId)).toBe(1);
  });

  it("„relevantní“ nezaloží druhou zprávu ani druhé vlákno", async () => {
    const { conversationId, review } = await pending();
    const before = await sql<{ count: number }[]>`
      select count(*)::int from messages where conversation_id = ${conversationId}`;
    const convsBefore = await sql<{ count: number }[]>`select count(*)::int from conversations`;

    await queries.resolveReview(review.reply_id, "relevant");

    const after = await sql<{ count: number }[]>`
      select count(*)::int from messages where conversation_id = ${conversationId}`;
    const convsAfter = await sql<{ count: number }[]>`select count(*)::int from conversations`;
    expect(after[0].count).toBe(before[0].count);
    expect(convsAfter[0].count).toBe(convsBefore[0].count);
  });

  it("„nesouvisí“ vrátí PŮVODNÍ termín, ne „hned teď“", async () => {
    const { seed, review } = await pending();
    const result = await queries.resolveReview(review.reply_id, "unrelated");
    expect(result.resumed).toBe(true);

    const contact = await contactRow(seed.campaignId);
    expect(contact.status).not.toBe("replied");
    expect(contact.next_send_at?.getTime()).toBe(seed.scheduled.getTime());
    expect(contact.paused_next_send_at).toBeNull();
    expect((await reviewRow()).needs_review).toBe(false);
  });

  it("„nesouvisí“ sama o sobě nic neodešle", async () => {
    // Obnovení jen nastaví termín. Odesílá dispatcher, který si všechno
    // znovu ověří - akce v UI e-mail nikdy neposílá přímo.
    const { seed, review } = await pending();
    const before = await sentCount(seed.campaignId);
    await queries.resolveReview(review.reply_id, "unrelated");
    expect(await sentCount(seed.campaignId)).toBe(before);
  });

  it("propadlý termín se nevrátí do minulosti, ale do okna kampaně", async () => {
    const { seed, review } = await pending();
    // Posouzení trvalo dlouho a původní termín mezitím uplynul.
    await sql`update campaign_contacts set paused_next_send_at = now() - interval '2 days'
               where campaign_id = ${seed.campaignId}`;
    await queries.resolveReview(review.reply_id, "unrelated");

    const contact = await contactRow(seed.campaignId);
    expect(contact.next_send_at).not.toBeNull();
    expect(contact.next_send_at!.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it("po „nesouvisí“ sekvence v původním termínu normálně pokračuje", async () => {
    const { seed, review } = await pending();
    await queries.resolveReview(review.reply_id, "unrelated");

    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    await drain(1);
    expect(await sentCount(seed.campaignId)).toBe(2);
  });

  it("uzavřené posouzení zmizí z K vyřízení i z odznaků", async () => {
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

// ====================================== obnovení se smí jen když se smí

describe("obnovení má přednosti", () => {
  async function twoReviews() {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    inbox.messages = [message({ from: "asistentka@dalsi-firma.test", references: seed.sentMessageId })];
    await poll();
    const reviews = await sql<{ id: string }[]>`
      select id from replies where needs_review order by received_at`;
    return { seed, reviews };
  }

  it("dvě současná posouzení: první rozhodnutí sekvenci NEobnoví", async () => {
    const { seed, reviews } = await twoReviews();
    expect(reviews).toHaveLength(2);

    const first = await queries.resolveReview(reviews[0].id, "unrelated");
    expect(first.resumed).toBe(false);
    expect((await contactRow(seed.campaignId)).next_send_at).toBeNull();
  });

  it("dvě současná posouzení: až druhé rozhodnutí obnoví", async () => {
    const { seed, reviews } = await twoReviews();
    await queries.resolveReview(reviews[0].id, "unrelated");
    const second = await queries.resolveReview(reviews[1].id, "unrelated");
    expect(second.resumed).toBe(true);
    expect((await contactRow(seed.campaignId)).next_send_at?.getTime())
      .toBe(seed.scheduled.getTime());
  });

  it("kontakt, který mezitím odpověděl, se neobnoví", async () => {
    const { seed, review } = await (async () => {
      const seed = await seedSent();
      inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
      await poll();
      const [r] = await sql<{ id: string }[]>`select id from replies where needs_review`;
      return { seed, review: r };
    })();

    // Mezitím dorazila skutečná odpověď ze správné adresy.
    await sql`update campaign_contacts set status = 'replied', replied_at = now()
               where campaign_id = ${seed.campaignId}`;

    const result = await queries.resolveReview(review.id, "unrelated");
    expect(result.resumed).toBe(false);
    const contact = await contactRow(seed.campaignId);
    expect(contact.status).toBe("replied");
    expect(contact.next_send_at).toBeNull();
    expect(contact.paused_next_send_at).toBeNull();
  });

  it("kontakt po „nevolat“ se neobnoví", async () => {
    const seed = await seedSent();
    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    const [review] = await sql<{ id: string }[]>`select id from replies where needs_review`;
    await sql`update campaign_contacts set status = 'unsubscribed'
               where campaign_id = ${seed.campaignId}`;

    expect((await queries.resolveReview(review.id, "unrelated")).resumed).toBe(false);
    expect((await contactRow(seed.campaignId)).next_send_at).toBeNull();
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
    expect((await contactRow(seed.campaignId)).paused_next_send_at?.getTime())
      .toBe(seed.scheduled.getTime());

    // next_send_at je teď null; coalesce nesmí uschovaný termín zahodit.
    inbox.messages = [message({ from: "dalsi@jina-firma.test", references: seed.sentMessageId })];
    await poll();
    expect((await contactRow(seed.campaignId)).paused_next_send_at?.getTime())
      .toBe(seed.scheduled.getTime());
  });

  it("opakovaný příjem nezaloží duplicitní zprávu ve vlákně", async () => {
    const seed = await seedSent();
    const msg = message({ from: "kolega@jina-firma.test", references: seed.sentMessageId });
    inbox.messages = [msg];
    await poll();
    const [before] = await sql<{ count: number }[]>`select count(*)::int from messages`;
    inbox.messages = [msg];
    await poll();
    const [after] = await sql<{ count: number }[]>`select count(*)::int from messages`;
    expect(after.count).toBe(before.count);
    void seed;
  });
});

// ======================================= posouzení nepřetéká na ostatní

describe("dopad je přesně jeden enrollment", () => {
  it("kolega ve stejné kampani se nepozastaví", async () => {
    const seed = await seedSent();
    const [second] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values ('kolegyne@acme.test', 'Petra', 'Acme') returning id`;
    const scheduled = new Date(Date.now() + 3 * 86_400_000);
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, next_send_at, current_step)
      values (${seed.campaignId}, ${second.id}, 'scheduled', ${scheduled}, 1)`;

    inbox.messages = [message({ from: "kolega@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const [other] = await sql<{ next_send_at: Date | null; paused_next_send_at: Date | null }[]>`
      select next_send_at, paused_next_send_at from campaign_contacts
       where contact_id = ${second.id}`;
    expect(other.next_send_at?.getTime()).toBe(scheduled.getTime());
    expect(other.paused_next_send_at).toBeNull();
  });

  it("dva kontakty na téže doméně se navzájem neovlivní", async () => {
    // Doména nesmí být kritériem: kandidáta určuje vlákno.
    const seed = await seedSent("ana@acme.test");
    const [second] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values ('petr@acme.test', 'Petr', 'Acme') returning id`;
    const scheduled = new Date(Date.now() + 3 * 86_400_000);
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, next_send_at, current_step)
      values (${seed.campaignId}, ${second.id}, 'scheduled', ${scheduled}, 1)`;

    inbox.messages = [message({ from: "nekdo@jina-firma.test", references: seed.sentMessageId })];
    await poll();

    const [other] = await sql<{ next_send_at: Date | null }[]>`
      select next_send_at from campaign_contacts where contact_id = ${second.id}`;
    expect(other.next_send_at?.getTime()).toBe(scheduled.getTime());
  });

  it("stejný kontakt u DVOU klientů: pozastaví se jen ten spárovaný", async () => {
    const first = await seedSent("ana@acme.test");
    const second = await seedSent("petr@acme.test");
    const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
    const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
    await sql`update campaigns set client_id = ${vexy.id} where id = ${first.campaignId}`;
    await sql`update campaigns set client_id = ${asn.id} where id = ${second.campaignId}`;

    inbox.messages = [message({ from: "kdosi@jina-firma.test", references: first.sentMessageId })];
    await poll();

    const other = await contactRow(second.campaignId);
    expect(other.next_send_at?.getTime()).toBe(second.scheduled.getTime());
    expect(other.paused_next_send_at).toBeNull();
  });

  it("„relevantní“ u jednoho klienta neukončí kampaň druhého", async () => {
    const first = await seedSent("ana@acme.test");
    const second = await seedSent("petr@acme.test");
    const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
    const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
    await sql`update campaigns set client_id = ${vexy.id} where id = ${first.campaignId}`;
    await sql`update campaigns set client_id = ${asn.id} where id = ${second.campaignId}`;

    inbox.messages = [message({ from: "kdosi@jina-firma.test", references: first.sentMessageId })];
    await poll();
    const [review] = await sql<{ id: string }[]>`select id from replies where needs_review`;
    await queries.resolveReview(review.id, "relevant");

    const other = await contactRow(second.campaignId);
    expect(other.status).not.toBe("replied");
    expect(other.next_send_at?.getTime()).toBe(second.scheduled.getTime());
  });
});
