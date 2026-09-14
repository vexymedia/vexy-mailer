import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Pracovní režim callera a to, co se stane po každém výsledku.
 *
 * Pravidlo, na kterém celý produkt stojí: po každém hovoru má lead buď
 * terminální stav, nebo naplánovaný další krok. Třetí možnost - lead,
 * který nikam nepatří a na nikoho nečeká - je tichá ztráta peněz.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");
let calls: typeof import("@/lib/queries/calls");
let inbox: typeof import("@/lib/queries/inbox");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
  calls = await import("@/lib/queries/calls");
  inbox = await import("@/lib/queries/inbox");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedQueue(count = 2) {
  const seeded = await seedCampaign({
    contacts: Array.from({ length: count }, (_, i) => ({
      email: `lead${i}@test.test`,
      first_name: `Lead${i}`,
      company: `Firma ${i}`,
    })),
  });
  await sql`update campaigns set calling_enabled = true where id = ${seeded.campaignId}`;
  await sql`update contacts set phone = '+42077712300' || substr(email, 5, 1)`;
  const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  return { ...seeded, callerId };
}

/** Stav kontaktu v kampani - to, co rozhoduje o dalším kroku. */
async function contactState(campaignContactId: string) {
  const [row] = await sql<
    { call_status: string; next_call_at: Date | null; meeting_booked: boolean; meeting_at: Date | null }[]
  >`
    select call_status, next_call_at, meeting_booked, meeting_at
      from campaign_contacts where id = ${campaignContactId}
  `;
  return row;
}

describe("callback", () => {
  it("bez data a času se neuloží", async () => {
    const seeded = await seedQueue(1);
    const result = await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "callback",
      callerId: seeded.callerId,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("datum");

    // A nesmí po sobě nechat poloviční zápis.
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from call_activities`;
    expect(row.count).toBe(0);
  });

  it("s datem a časem pošle kontakt do budoucí fronty", async () => {
    const seeded = await seedQueue(1);
    const when = new Date(Date.now() + 2 * 86_400_000);
    const result = await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "callback",
      callerId: seeded.callerId,
      callbackAt: when,
    });
    expect(result.ok).toBe(true);

    const state = await contactState(seeded.campaignContactIds[0]);
    expect(state.call_status).toBe("callback");
    expect(state.next_call_at?.getTime()).toBe(when.getTime());

    // Dneska ve frontě být nesmí - je to na pozítří.
    const queue = await calling.listCallQueue(null, { callerId: seeded.callerId });
    expect(queue.some((row) => row.id === seeded.campaignContactIds[0])).toBe(false);
  });

  it("propadlý callback se ve frontě objeví a je vepředu", async () => {
    const seeded = await seedQueue(2);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[1],
      outcome: "callback",
      callerId: seeded.callerId,
      callbackAt: new Date(Date.now() + 3_600_000),
    });
    await sql`
      update campaign_contacts set next_call_at = now() - interval '1 day'
       where id = ${seeded.campaignContactIds[1]}
    `;

    const queue = await calling.listCallQueue(null, { callerId: seeded.callerId });
    // Slib daný prospektovi má přednost před studeným leadem.
    expect(queue[0].id).toBe(seeded.campaignContactIds[1]);
  });
});

describe("po každém výsledku existuje další krok nebo konec", () => {
  it("nedovoláno naplánuje další pokus", async () => {
    const seeded = await seedQueue(1);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "no_answer",
      callerId: seeded.callerId,
    });

    const state = await contactState(seeded.campaignContactIds[0]);
    expect(state.call_status).toBe("in_progress");
    expect(state.next_call_at).not.toBeNull();
  });

  it("poslat informace vytvoří další krok", async () => {
    const seeded = await seedQueue(1);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "send_info",
      callerId: seeded.callerId,
    });

    const state = await contactState(seeded.campaignContactIds[0]);
    // Lead nesmí zmizet: někdo musí ty informace poslat a pak se ozvat.
    expect(state.next_call_at).not.toBeNull();
    const [company] = await sql<{ status: string }[]>`
      select co.status from companies co
       join contacts c on c.company_id = co.id
       where c.email = 'lead0@test.test'
    `;
    expect(company.status).toBe("interested");
  });

  it("schůzka uloží termín a je vidět všude stejně", async () => {
    const seeded = await seedQueue(1);
    const when = new Date(Date.now() + 5 * 86_400_000);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "meeting_booked",
      callerId: seeded.callerId,
      meetingAt: when,
    });

    const state = await contactState(seeded.campaignContactIds[0]);
    expect(state.meeting_booked).toBe(true);
    expect(state.meeting_at?.getTime()).toBe(when.getTime());

    const reporting = await import("@/lib/queries/reporting");
    expect((await reporting.getCallMetrics()).meetings).toBe(1);
    const team = await calling.listCallersWithTotals();
    expect(team.find((m) => m.id === seeded.callerId)?.meetings_booked).toBe(1);
  });

  it("nemá zájem lead uzavře a žádný další follow-up nenaplánuje", async () => {
    const seeded = await seedQueue(1);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "not_interested",
      callerId: seeded.callerId,
    });

    const state = await contactState(seeded.campaignContactIds[0]);
    expect(state.call_status).toBe("lost");
    expect(state.next_call_at).toBeNull();

    const queue = await calling.listCallQueue(null, { callerId: seeded.callerId });
    expect(queue.some((row) => row.id === seeded.campaignContactIds[0])).toBe(false);
  });

  it("špatný kontakt vyřadí člověka, ale firmu nezabije", async () => {
    const seeded = await seedQueue(1);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "wrong_number",
      callerId: seeded.callerId,
    });

    const state = await contactState(seeded.campaignContactIds[0]);
    expect(state.call_status).toBe("lost");

    const queue = await calling.listCallQueue(null, { callerId: seeded.callerId });
    expect(queue.some((row) => row.id === seeded.campaignContactIds[0])).toBe(false);

    // Firma zůstává otevřená - může tam být jiný rozhodovatel.
    const [company] = await sql<{ status: string }[]>`
      select co.status from companies co
       join contacts c on c.company_id = co.id
       where c.email = 'lead0@test.test'
    `;
    expect(company.status).toBe("in_progress");
    expect(["won", "lost", "excluded"]).not.toContain(company.status);
  });
});

describe("uložit a další", () => {
  it("zavře aktuální lead a načte jiný", async () => {
    const seeded = await seedQueue(2);

    const first = await calling.claimNextCall(null, seeded.callerId);
    expect(first).not.toBeNull();

    await calling.logCall({
      campaignContactId: first as string,
      outcome: "not_interested",
      callerId: seeded.callerId,
    });

    const next = await calling.claimNextCall(null, seeded.callerId);
    expect(next).not.toBeNull();
    // Nesmí to skočit na lead, který je právě hotový.
    expect(next).not.toBe(first);
  });

  it("neposkočí na už hotový lead ani po dalším kole", async () => {
    const seeded = await seedQueue(2);
    const done: string[] = [];

    for (let i = 0; i < 2; i++) {
      const id = await calling.claimNextCall(null, seeded.callerId);
      if (!id) break;
      expect(done).not.toContain(id);
      done.push(id);
      await calling.logCall({
        campaignContactId: id,
        outcome: "not_interested",
        callerId: seeded.callerId,
      });
    }

    expect(done).toHaveLength(2);
    // A pak už není co dělat.
    expect(await calling.claimNextCall(null, seeded.callerId)).toBeNull();
  });

  it("hovor bez zapsaného výsledku drží lead stranou, aby se nevytočil podruhé", async () => {
    const seeded = await seedQueue(1);
    const [contact] = await sql<{ id: string }[]>`
      select id from contacts where email = 'lead0@test.test'
    `;

    const started = await calls.startCall({
      campaignContactId: seeded.campaignContactIds[0],
      callerId: seeded.callerId,
    });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-open", null);
    await calls.recordCallStatus({
      providerCallSid: "CA-open",
      status: "completed",
      durationSeconds: 35,
    });

    const queue = await calling.listCallQueue(null, { callerId: seeded.callerId });
    expect(queue.some((row) => row.contact_id === contact.id)).toBe(false);

    // A nabídne se k dopsání.
    const pending = await calls.getUnloggedCall({ callerId: seeded.callerId });
    expect(pending?.id).toBe(started.call.callId);
  });
});

describe("schránka", () => {
  async function seedThread(options: { withReply: boolean }) {
    const seeded = await seedCampaign({
      contacts: [{ email: "pavel@asnplus.test", first_name: "Pavel", company: "ASN Plus" }],
    });
    const [contact] = await sql<{ id: string }[]>`
      select id from contacts where email = 'pavel@asnplus.test'
    `;
    const [conversation] = await sql<{ id: string }[]>`
      insert into conversations (contact_id, mailbox_id, subject, campaign_id)
      values (${contact.id}, ${seeded.mailboxId}, 'Spolupráce', ${seeded.campaignId})
      returning id
    `;
    await sql`
      insert into messages (conversation_id, direction, kind, from_email, to_email, subject, body_text, occurred_at)
      values (${conversation.id}, 'outbound', 'campaign', 'sender@example.com',
              'pavel@asnplus.test', 'Spolupráce', 'Dobrý den…', now() - interval '2 days')
    `;
    if (options.withReply) {
      await sql`
        insert into messages (conversation_id, direction, kind, from_email, to_email, subject, body_text, occurred_at)
        values (${conversation.id}, 'inbound', 'incoming', 'pavel@asnplus.test',
                'sender@example.com', 'Re: Spolupráce', 'Pošlete informace.', now() - interval '1 day')
      `;
      await sql`update conversations set unread_count = 1 where id = ${conversation.id}`;
    }
    return { ...seeded, conversationId: conversation.id, contactId: contact.id };
  }

  it("ukáže i vlákno, kde jsme zatím jen psali", async () => {
    await seedThread({ withReply: false });

    // Odpovědi jsou triage: bez odpovědi tam vlákno nepatří.
    expect(await inbox.listConversations()).toHaveLength(0);

    // Schránka je poštovní klient: odeslaná pošta v něm být musí. Přesně
    // tohle po redesignu chybělo a působilo to jako ztracená funkce.
    const mailbox = await inbox.listConversations({ scope: "all" });
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].has_inbound).toBe(false);
  });

  it("vlákno s odpovědí je v obou pohledech", async () => {
    await seedThread({ withReply: true });

    expect(await inbox.listConversations()).toHaveLength(1);
    const mailbox = await inbox.listConversations({ scope: "all" });
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].has_inbound).toBe(true);
  });

  it("jde filtrovat podle schránky", async () => {
    const seeded = await seedThread({ withReply: false });

    const matching = await inbox.listConversations({ scope: "all", mailboxId: seeded.mailboxId });
    expect(matching).toHaveLength(1);

    const [other] = await sql<{ id: string }[]>`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                             smtp_password_enc, smtp_secure)
      values ('Druhá', 'Druhá', 'other@example.com', 'smtp.example.com', 465,
              'other@example.com', 'x', true)
      returning id
    `;
    expect(await inbox.listConversations({ scope: "all", mailboxId: other.id })).toHaveLength(0);
  });

  it("vlákno se otevře celé a chronologicky", async () => {
    const seeded = await seedThread({ withReply: true });

    const conversation = await inbox.getConversation(seeded.conversationId);
    expect(conversation?.contact_email).toBe("pavel@asnplus.test");
    // Vazba na firmu je z kontaktu, ne z dohadování podle jména.
    expect(conversation?.company_id).not.toBeNull();

    const messages = await inbox.listMessages(seeded.conversationId);
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
  });

  it("nepřečtené se po otevření vynuluje", async () => {
    const seeded = await seedThread({ withReply: true });

    expect((await inbox.listConversations({ scope: "all" }))[0].unread_count).toBe(1);
    await inbox.markConversationRead(seeded.conversationId);
    expect((await inbox.listConversations({ scope: "all" }))[0].unread_count).toBe(0);
  });

  it("caller dostane odkaz na správné vlákno", async () => {
    const seeded = await seedThread({ withReply: true });
    const leadContext = await import("@/lib/queries/lead-context");

    const context = await leadContext.getLeadContext({ contactId: seeded.contactId });
    expect(context.last_inbound?.conversation_id).toBe(seeded.conversationId);
    expect(context.last_outbound?.conversation_id).toBe(seeded.conversationId);
  });

  it("odpovědi a kampaně zůstávají funkční", async () => {
    await seedThread({ withReply: true });

    const counts = await inbox.getInboxCounts();
    expect(counts.all).toBe(1);
    expect(counts.unread).toBe(1);

    const dashboard = await import("@/lib/queries/dashboard");
    expect((await dashboard.listCampaignStats()).length).toBeGreaterThan(0);
  });
});
