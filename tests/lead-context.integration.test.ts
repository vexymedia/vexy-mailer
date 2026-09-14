import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Kontext, který caller vidí před hovorem.
 *
 * Nejdůležitější vlastnost není úplnost, ale pravdivost: když Loom
 * neexistuje, sekce se nesmí objevit, a když prospekt neodpověděl, nesmí
 * tam stát, že odpověděl. Caller na to navazuje první větou a nepravdivá
 * věta ho na lince shodí.
 */

let sql: typeof import("@/lib/db").sql;
let leadContext: typeof import("@/lib/queries/lead-context");
let contacts: typeof import("@/lib/queries/contacts");
let calling: typeof import("@/lib/queries/calling");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  leadContext = await import("@/lib/queries/lead-context");
  contacts = await import("@/lib/queries/contacts");
  calling = await import("@/lib/queries/calling");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedContact() {
  const seeded = await seedCampaign({
    contacts: [{ email: "pavel@asnplus.test", first_name: "Pavel", company: "ASN Plus" }],
  });
  const [contact] = await sql<{ id: string; company_id: string }[]>`
    select id, company_id from contacts where email = 'pavel@asnplus.test'
  `;
  return { ...seeded, contactId: contact.id, companyId: contact.company_id };
}

/** Vlákno se zprávami, jak ho zakládá e-mailový engine. */
async function seedThread(
  contactId: string,
  mailboxId: string,
  messages: { direction: "inbound" | "outbound"; subject: string; body: string; daysAgo: number }[],
) {
  const [conversation] = await sql<{ id: string }[]>`
    insert into conversations (contact_id, mailbox_id, subject)
    values (${contactId}, ${mailboxId}, 'Spolupráce')
    returning id
  `;
  for (const message of messages) {
    await sql`
      insert into messages (conversation_id, direction, kind, from_email, to_email,
                            subject, body_text, occurred_at)
      values (${conversation.id}, ${message.direction},
              ${message.direction === "inbound" ? "incoming" : "campaign"},
              ${message.direction === "inbound" ? "pavel@asnplus.test" : "sender@example.com"},
              ${message.direction === "inbound" ? "sender@example.com" : "pavel@asnplus.test"},
              ${message.subject}, ${message.body},
              now() - ${`${message.daysAgo} days`}::interval)
    `;
  }
  return conversation.id;
}

describe("Loom", () => {
  it("se zobrazí jen když existuje", async () => {
    const { contactId } = await seedContact();

    const without = await leadContext.getLeadContext({ contactId });
    expect(without.loom).toBeNull();
    expect(leadContext.buildWhyNow(without).some((s) => s.includes("Loom"))).toBe(false);

    await contacts.saveOutreachContext(contactId, {
      loomUrl: "https://www.loom.com/share/abc",
      loomTitle: "3 příležitosti pro ASN Plus",
      loomSentAt: new Date(Date.now() - 4 * 86_400_000),
      loomNote: "Vojtěch ve videu ukázal tři konkrétní příležitosti.",
    });

    const withLoom = await leadContext.getLeadContext({ contactId });
    expect(withLoom.loom?.url).toBe("https://www.loom.com/share/abc");
    expect(withLoom.loom?.title).toBe("3 příležitosti pro ASN Plus");
    expect(leadContext.buildWhyNow(withLoom)[0]).toBe("Loom odeslán před 4 dny");
  });

  it("odmítne odkaz, který není http(s)", async () => {
    const { contactId } = await seedContact();
    const result = await contacts.saveOutreachContext(contactId, {
      loomUrl: "javascript:alert(1)",
    });
    expect(result).toEqual({ ok: false, error: "invalid_url" });

    const context = await leadContext.getLeadContext({ contactId });
    expect(context.loom).toBeNull();
  });

  it("se dá odebrat", async () => {
    const { contactId } = await seedContact();
    await contacts.saveOutreachContext(contactId, {
      loomUrl: "https://www.loom.com/share/abc",
      loomSentAt: new Date(),
    });
    await contacts.saveOutreachContext(contactId, { loomUrl: "" });

    const context = await leadContext.getLeadContext({ contactId });
    expect(context.loom).toBeNull();
  });
});

describe("e-mailový kontext", () => {
  it("načte poslední zprávu každým směrem", async () => {
    const seeded = await seedContact();
    await seedThread(seeded.contactId, seeded.mailboxId, [
      { direction: "outbound", subject: "První oslovení", body: "Dobrý den, posíláme…", daysAgo: 6 },
      { direction: "outbound", subject: "Follow-up", body: "Ještě jednou k videu.", daysAgo: 2 },
      { direction: "inbound", subject: "Re: Follow-up", body: "Pošlete mi prosím více informací.", daysAgo: 1 },
    ]);

    const context = await leadContext.getLeadContext({ contactId: seeded.contactId });
    expect(context.last_outbound?.subject).toBe("Follow-up");
    expect(context.last_inbound?.subject).toBe("Re: Follow-up");
    expect(context.last_inbound?.snippet).toBe("Pošlete mi prosím více informací.");
  });

  it("bez odpovědi to řekne rovnou, nevymýšlí si", async () => {
    const seeded = await seedContact();
    await seedThread(seeded.contactId, seeded.mailboxId, [
      { direction: "outbound", subject: "První oslovení", body: "Dobrý den…", daysAgo: 2 },
    ]);

    const context = await leadContext.getLeadContext({ contactId: seeded.contactId });
    expect(context.last_inbound).toBeNull();

    const why = leadContext.buildWhyNow(context);
    expect(why).toContain("E-mail odeslán před 2 dny");
    expect(why).toContain("Bez odpovědi");
    expect(why.some((s) => s.includes("odpověděl"))).toBe(false);
  });

  it("bez jakékoli komunikace nevrací žádné kroky", async () => {
    const { contactId } = await seedContact();
    const context = await leadContext.getLeadContext({ contactId });
    expect(leadContext.buildWhyNow(context)).toEqual([]);
  });
});

describe("proč volám právě teď", () => {
  it("poskládá řetěz z Loomu, e-mailu a minulého hovoru", async () => {
    const seeded = await seedContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    await contacts.saveOutreachContext(seeded.contactId, {
      loomUrl: "https://www.loom.com/share/abc",
      loomSentAt: new Date(Date.now() - 4 * 86_400_000),
    });
    await seedThread(seeded.contactId, seeded.mailboxId, [
      { direction: "outbound", subject: "Navazuji na video", body: "…", daysAgo: 2 },
    ]);
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "no_answer",
      callerId,
    });

    const context = await leadContext.getLeadContext({
      contactId: seeded.contactId,
      campaignContactId: seeded.campaignContactIds[0],
    });
    const why = leadContext.buildWhyNow(context);

    expect(why[0]).toBe("Loom odeslán před 4 dny");
    expect(why[1]).toBe("E-mail odeslán před 2 dny");
    expect(why).toContain("Bez odpovědi");
    expect(why.some((s) => s.includes("Nezastižen"))).toBe(true);
    expect(why[why.length - 1]).toBe("Dnes telefonický follow-up #2");
  });

  it("vyžádaný termín má přednost před obecným follow-upem", async () => {
    const seeded = await seedContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "callback",
      callerId,
      callbackAt: new Date(Date.now() + 3 * 3_600_000),
    });

    const context = await leadContext.getLeadContext({
      contactId: seeded.contactId,
      campaignContactId: seeded.campaignContactIds[0],
    });
    expect(context.callback_at).not.toBeNull();
    expect(leadContext.buildWhyNow(context)).toContain("Prospekt si vyžádal hovor na tento termín");
  });

  it("propadlý callback je vidět jako propadlý", async () => {
    const seeded = await seedContact();
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await calling.logCall({
      campaignContactId: seeded.campaignContactIds[0],
      outcome: "callback",
      callerId,
      callbackAt: new Date(Date.now() + 3_600_000),
    });
    // Posuneme termín do minulosti, jak by to udělal čas.
    await sql`
      update campaign_contacts set next_call_at = now() - interval '2 hours'
       where id = ${seeded.campaignContactIds[0]}
    `;

    const context = await leadContext.getLeadContext({
      contactId: seeded.contactId,
      campaignContactId: seeded.campaignContactIds[0],
    });
    expect(leadContext.buildWhyNow(context)).toContain("Slíbený termín hovoru už je po čase");
  });
});

describe("úvodní věta", () => {
  it("vlastní opener má přednost přede vším", async () => {
    const { contactId } = await seedContact();
    await contacts.saveOutreachContext(contactId, { opener: "Pane Nováku, jedna konkrétní věc." });
    const context = await leadContext.getLeadContext({ contactId });

    expect(
      leadContext.buildOpener({
        context,
        contactName: "Pavel Novák",
        companyName: "ASN Plus",
        callerName: "Jan",
        campaignOpening: "Scénář kampaně",
      }),
    ).toBe("Pane Nováku, jedna konkrétní věc.");
  });

  it("bez vlastního openeru se vezme scénář kampaně", async () => {
    const { contactId } = await seedContact();
    const context = await leadContext.getLeadContext({ contactId });

    expect(
      leadContext.buildOpener({
        context,
        contactName: "Pavel Novák",
        companyName: "ASN Plus",
        callerName: "Jan",
        campaignOpening: "Scénář kampaně",
      }),
    ).toBe("Scénář kampaně");
  });

  it("bez obojího navazuje jen na to, co prospekt opravdu dostal", async () => {
    const { contactId } = await seedContact();
    await contacts.saveOutreachContext(contactId, {
      loomUrl: "https://www.loom.com/share/abc",
      loomTitle: "3 příležitosti",
      loomSentAt: new Date(),
    });
    const context = await leadContext.getLeadContext({ contactId });

    const opener = leadContext.buildOpener({
      context,
      contactName: "Pavel Novák",
      companyName: "ASN Plus",
      callerName: "Jan",
      campaignOpening: null,
    });
    expect(opener).toContain("Novák");
    expect(opener).toContain("Jan");
    expect(opener).toContain("video");
  });

  it("bez Loomu a bez e-mailu neslíbí, že na něco navazuje", async () => {
    const { contactId } = await seedContact();
    const context = await leadContext.getLeadContext({ contactId });

    const opener = leadContext.buildOpener({
      context,
      contactName: "Pavel Novák",
      companyName: "ASN Plus",
      callerName: "Jan",
      campaignOpening: null,
    });
    expect(opener).not.toContain("Navazuji");
    expect(opener).toContain("ASN Plus");
  });
});
