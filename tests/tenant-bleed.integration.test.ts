import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { InboxMessage } from "@/lib/imap";

/**
 * Obchodní stav jednoho klienta nesmí přetéct k druhému.
 *
 * VEXY provozuje managed outbound pro víc klientů naráz a tatáž firma
 * i tentýž člověk se běžně objeví u dvou z nich. Každý klient má vlastní
 * kampaň, vlastní odesílatele a vlastní nabídku.
 *
 * Když prospekt odpoví na kampaň klienta A, je to odpověď TOMU klientovi.
 * Kampaň klienta B tím skončit nesmí: ten za ni platí a o žádné odpovědi
 * neví. Totéž platí opačně pro „nevolat“ řečené jednomu klientovi.
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

let uid = 700;
function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  uid += 1;
  return {
    uid,
    messageId: `<in-${uid}@acme.test>`,
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

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  inbox.messages = [];
  inbox.uidNext = 7000;
  uid = 700;
});

afterAll(async () => {
  await closeDatabase();
});

/**
 * Tentýž člověk u dvou klientů.
 *
 * Kontakt je v databázi jeden (unikátní e-mail), ale je zapsaný ve dvou
 * kampaních dvou různých klientů - přesně jak to v managed provozu vypadá.
 */
async function twoClients(email = "ana@acme.test") {
  const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
  const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status) values ('Acme a.s.', 'ready') returning id`;

  const { startCampaign } = await import("@/lib/queries/campaigns");
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  const { encryptSecret } = await import("@/lib/crypto");
  const queries = await import("@/lib/queries/inbox");

  type Side = { campaignId: string; mailboxId: string; sentMessageId: string };
  const out: Record<"vexy" | "asn", Side> = {} as Record<"vexy" | "asn", Side>;
  let sharedContactId: string | null = null;

  for (const [label, clientId] of [["vexy", vexy.id], ["asn", asn.id]] as const) {
    // Kontakt je v databázi JEDEN (e-mail je unikátní globálně). Druhá
    // kampaň se proto naseeduje na zástupnou adresu a hned se přepojí na
    // ten už existující kontakt - přesně tak to vypadá v provozu, kdy
    // import u druhého klienta narazí na známého člověka.
    const seedEmail = sharedContactId ? `placeholder-${label}@acme.test` : email;
    const seed = await seedCampaign({ contacts: [{ email: seedEmail, first_name: "Ana" }] });
    await sql`update campaigns set client_id = ${clientId}, status = 'active', calling_enabled = true
               where id = ${seed.campaignId}`;

    let contactId = seed.contactIds[0];
    if (sharedContactId) {
      await sql`update campaign_contacts set contact_id = ${sharedContactId}
                 where campaign_id = ${seed.campaignId}`;
      await sql`delete from contacts where id = ${contactId}`;
      contactId = sharedContactId;
    } else {
      sharedContactId = contactId;
    }
    await sql`update contacts set company_id = ${company.id}, phone = '+420777123456'
               where id = ${contactId}`;

    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();
    await sql`
      update mailboxes set imap_host = 'imap.example.com', imap_port = 993,
                           imap_username = 'sender@example.com',
                           imap_password_enc = ${encryptSecret("x")}, imap_secure = true
       where id = ${seed.mailboxId}`;

    // Každá kampaň má vlastní Message-ID, jinak by si vlákna přebíraly.
    const messageId = `<krok1-${label}@example.com>`;
    const [send] = await sql<{ id: string; campaign_contact_id: string }[]>`
      update email_sends set status = 'sent', message_id = ${messageId}, sent_at = now()
       where campaign_id = ${seed.campaignId} returning id, campaign_contact_id`;
    await queries.recordOutboundMessage({
      mailboxId: seed.mailboxId, contactId, campaignId: seed.campaignId,
      campaignContactId: send.campaign_contact_id, kind: "campaign",
      fromEmail: "sender@example.com", toEmail: email, subject: "Krátký dotaz",
      bodyText: "Dobrý den…", messageId, emailSendId: send.id,
    });
    await sql`update campaign_contacts set next_send_at = now() + interval '3 days'
               where campaign_id = ${seed.campaignId}`;
    out[label] = { campaignId: seed.campaignId, mailboxId: seed.mailboxId, sentMessageId: messageId };
  }
  return { vexyId: vexy.id, asnId: asn.id, companyId: company.id, contactId: sharedContactId!, ...out };
}

async function state(campaignId: string) {
  const [row] = await sql<{ status: string; next_send_at: Date | null; call_status: string }[]>`
    select status, next_send_at, call_status from campaign_contacts
     where campaign_id = ${campaignId}`;
  return row;
}

// ===================================================== odpověď jednomu klientovi

describe("odpověď u jednoho klienta neukončí kampaň druhého", () => {
  it("prospekt odpoví VEXY — ASN Plus běží dál", async () => {
    const seed = await twoClients();
    const before = await state(seed.asn.campaignId);

    inbox.messages = [message({ references: seed.vexy.sentMessageId })];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    // Klient, kterému odpověděl: hotovo.
    expect((await state(seed.vexy.campaignId)).status).toBe("replied");
    // Klient, kterého se to netýká: beze změny, i co do termínu.
    const asn = await state(seed.asn.campaignId);
    expect(asn.status).not.toBe("replied");
    expect(asn.next_send_at?.getTime()).toBe(before.next_send_at?.getTime());
  });

  it("dvě kampaně TÉHOŽ klienta se ukončí obě", async () => {
    // Uvnitř jednoho klienta pravidlo platí dál: kdo odpověděl, nesmí
    // od téhož klienta dostat další cold e-mail z jiné sekvence.
    const seed = await twoClients();
    await sql`update campaigns set client_id = ${seed.vexyId}
               where id = ${seed.asn.campaignId}`;

    inbox.messages = [message({ references: seed.vexy.sentMessageId })];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    expect((await state(seed.vexy.campaignId)).status).toBe("replied");
    expect((await state(seed.asn.campaignId)).status).toBe("replied");
  });

  it("kampaň bez klienta se cizí odpovědí neukončí", async () => {
    const seed = await twoClients();
    await sql`update campaigns set client_id = null where id = ${seed.asn.campaignId}`;
    inbox.messages = [message({ references: seed.vexy.sentMessageId })];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);
    expect((await state(seed.asn.campaignId)).status).not.toBe("replied");
  });
});

// ================================================ ruční posouzení má stejný dosah

describe("ruční „odpověděl nám prospekt“ má stejný dosah", () => {
  it("potvrzení u VEXY neukončí kampaň ASN Plus", async () => {
    const seed = await twoClients();
    const before = await state(seed.asn.campaignId);

    // Odpověď z cizí domény → needs_review u kampaně VEXY.
    inbox.messages = [
      message({ from: "kolega@jina-firma.test", references: seed.vexy.sentMessageId }),
    ];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    const queries = await import("@/lib/queries/inbox");
    const [conversation] = await queries.listConversations({ view: "todo" });
    const review = await queries.getPendingReview(conversation.id);
    await queries.resolveReview(review!.reply_id, "relevant");

    expect((await state(seed.vexy.campaignId)).status).toBe("replied");
    const asn = await state(seed.asn.campaignId);
    expect(asn.status).not.toBe("replied");
    expect(asn.next_send_at?.getTime()).toBe(before.next_send_at?.getTime());
  });
});

// ======================================================= „nevolat“ a e-maily

describe("„nevolat“ zastaví i e-maily, ale jen u svého klienta", () => {
  async function sayDoNotCall(campaignId: string) {
    const calling = await import("@/lib/queries/calling");
    const [cc] = await sql<{ id: string }[]>`
      select id from campaign_contacts where campaign_id = ${campaignId}`;
    const [caller] = await sql<{ id: string }[]>`
      insert into callers (name, active) values ('Operátor', true) returning id`;
    await calling.logCall({
      campaignContactId: cc.id,
      callerId: caller.id,
      outcome: "do_not_call",
      note: "Ať už mi nikdo nepíše ani nevolá.",
    });
  }

  it("po „nevolat“ u VEXY neodejde další e-mail VEXY", async () => {
    const seed = await twoClients();
    await sayDoNotCall(seed.vexy.campaignId);

    const vexy = await state(seed.vexy.campaignId);
    // Tohle je jádro: samotný příznak nestačí, musí zmizet i termín.
    expect(vexy.next_send_at).toBeNull();

    // A dispatcher to musí respektovat i po dozrání času.
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.vexy.campaignId}
                 and next_send_at is not null`;
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    await sql`update campaigns set next_slot_at = null`;
    await dispatchTick();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.vexy.campaignId}`;
    expect(count).toBe(1); // jen původní krok 1
  });

  it("„nevolat“ u VEXY neshodí e-mailovou sekvenci ASN Plus", async () => {
    const seed = await twoClients();
    const before = await state(seed.asn.campaignId);
    await sayDoNotCall(seed.vexy.campaignId);

    const asn = await state(seed.asn.campaignId);
    expect(asn.status).not.toBe("do_not_call");
    expect(asn.next_send_at?.getTime()).toBe(before.next_send_at?.getTime());
  });

  it("telefonní blokace zůstává globální — to je bezpečný směr", async () => {
    // Nevolat je o člověku a jeho telefonu. Zúžit to na klienta by
    // znamenalo, že mu jiný klient zavolá znovu.
    const seed = await twoClients();
    await sayDoNotCall(seed.vexy.campaignId);
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int from call_suppression`;
    expect(row.count).toBe(1);
  });
});
