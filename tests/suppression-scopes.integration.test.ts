import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Rozsah vyloučení.
 *
 * Kvůli čemu: "nemá zájem" u jedné nabídky se chovalo jako globální blok
 * a "firma je už klientem ASN Plus" schovalo firmu celé databázi. Jsou
 * to čtyři různě široké věci a pletly se do jedné.
 */

let sql: typeof import("@/lib/db").sql;
let suppression: typeof import("@/lib/queries/suppression");
let contacts: typeof import("@/lib/queries/contacts");
let deliverability: typeof import("@/lib/queries/deliverability");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  suppression = await import("@/lib/queries/suppression");
  contacts = await import("@/lib/queries/contacts");
  deliverability = await import("@/lib/queries/deliverability");
});

afterAll(async () => {
  await closeDatabase();
});

async function reasonCodeOf(email: string): Promise<string | null> {
  const [row] = await sql<{ reason_code: string }[]>`
    select reason_code from suppression_list where email = ${email}
  `;
  return row?.reason_code ?? null;
}

// ================================================= co je globální blok

describe("globální blokace e-mailu", () => {
  it("odhlášení je globální", async () => {
    await contacts.suppressEmail("a@acme.cz", "unsubscribe", undefined, {
      reasonCode: "unsubscribe",
      source: "unsubscribe_link",
    });
    expect(await reasonCodeOf("a@acme.cz")).toBe("unsubscribe");
  });

  it("stížnost na spam je globální", async () => {
    await contacts.suppressEmail("b@acme.cz", "spam", undefined, {
      reasonCode: "spam_complaint",
      source: "fbl",
    });
    expect(await reasonCodeOf("b@acme.cz")).toBe("spam_complaint");
  });

  it("ruční blokace je globální", async () => {
    await contacts.suppressEmail("c@acme.cz", "manual");
    expect(await reasonCodeOf("c@acme.cz")).toBe("manual_dnc");
  });

  it("5.1.1 zablokuje konkrétní adresu natrvalo", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "x@acme.cz" }] });
    const [mailbox] = await sql<{ from_email: string }[]>`
      select from_email from mailboxes where id = ${seed.mailboxId}
    `;
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, sent_at)
      values (${seed.campaignId}, ${seed.campaignContactIds[0]}, ${seed.stepIds[0]}, 1, 'sent',
              'x@acme.cz', 'x@acme.cz', 'Ahoj', 'text', ${seed.mailboxId}, now())
    `;
    const result = await deliverability.recordBounce({
      mailboxId: seed.mailboxId,
      contactId: seed.contactIds[0],
      campaignContactId: seed.campaignContactIds[0],
      subject: "Undelivered Mail Returned to Sender",
      bodyText:
        "Final-Recipient: rfc822; x@acme.cz\nStatus: 5.1.1\n" +
        "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
      headers: {},
      fromEmail: mailbox.from_email,
      receivedAt: new Date(),
    });
    expect(result.type).toBe("HARD_INVALID");
    expect(result.suppressed).toBe(true);
    expect(await reasonCodeOf("x@acme.cz")).toBe("hard_invalid");
  });
});

// ============================================= co globální blok NENÍ

describe("technické chyby doručení neblokují příjemce", () => {
  async function bounceWith(diagnostic: string, status: string | null = null) {
    const seed = await seedCampaign({ contacts: [{ email: "y@acme.cz" }] });
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, sent_at)
      values (${seed.campaignId}, ${seed.campaignContactIds[0]}, ${seed.stepIds[0]}, 1, 'sent',
              'y@acme.cz', 'y@acme.cz', 'Ahoj', 'text', ${seed.mailboxId}, now())
    `;
    const body = `Final-Recipient: rfc822; y@acme.cz\n${status ? `Status: ${status}\n` : ""}Diagnostic-Code: ${diagnostic}`;
    const result = await deliverability.recordBounce({
      mailboxId: seed.mailboxId,
      contactId: seed.contactIds[0],
      campaignContactId: seed.campaignContactIds[0],
      subject: "Undeliverable",
      bodyText: body,
      headers: {},
      fromEmail: "sender@example.com",
      receivedAt: new Date(),
    });
    return { result, suppressed: await reasonCodeOf("y@acme.cz") };
  }

  it("KONKRÉTNÍ PŘÍPAD: 554 poor reputation neoznačí adresu za neexistující", async () => {
    const { result, suppressed } = await bounceWith(
      "smtp; 554 Your access to this mail system has been rejected due to poor reputation " +
      "of a domain used in message transfer",
      "5.0.0",
    );
    expect(result.type).toBe("REPUTATION_BLOCK");
    expect(result.suppressed).toBe(false);
    expect(suppressed).toBeNull();

    // A uloží se to k e-mailu, včetně surové diagnostiky.
    const [send] = await sql<{ bounce_type: string; bounce_code: string; bounce_detail: string }[]>`
      select bounce_type, bounce_code, bounce_detail from email_sends where bounce_type is not null
    `;
    expect(send.bounce_type).toBe("REPUTATION_BLOCK");
    expect(send.bounce_code).toBe("5.0.0");
    expect(send.bounce_detail).toContain("poor reputation");
  });

  it("dočasná chyba neblokuje", async () => {
    const { result, suppressed } = await bounceWith("smtp; 451 4.3.2 Try again later", "4.3.2");
    expect(result.type).toBe("SOFT_TEMPORARY");
    expect(suppressed).toBeNull();
  });

  it("plná schránka neblokuje", async () => {
    const { result, suppressed } = await bounceWith("smtp; 452 4.2.2 Mailbox full", "4.2.2");
    expect(result.type).toBe("MAILBOX_FULL");
    expect(suppressed).toBeNull();
  });

  it("rate limit neblokuje", async () => {
    const { suppressed } = await bounceWith("smtp; 421 Too many messages, try again later");
    expect(suppressed).toBeNull();
  });

  it("policy blok neblokuje příjemce", async () => {
    const { result, suppressed } = await bounceWith(
      "smtp; 550 5.7.1 Message rejected due to policy reasons", "5.7.1",
    );
    expect(result.type).toBe("POLICY_BLOCK");
    expect(suppressed).toBeNull();
  });
});

// =========================================== vyloučení v rozsahu klienta

describe("vyloučení firmy pro jednoho klienta", () => {
  async function twoClientsOneCompany() {
    const [a] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
    const [b] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
    const [company] = await sql<{ id: string }[]>`
      insert into companies (name, status) values ('Sdílená firma', 'ready') returning id
    `;
    return { clientA: a.id, clientB: b.id, companyId: company.id };
  }

  it("platí jen pro svého klienta", async () => {
    const { clientA, clientB, companyId } = await twoClientsOneCompany();
    await suppression.excludeCompanyForClient({
      clientId: clientA, companyId, reason: "Už je klientem ASN Plus.",
    });

    const [row] = await sql<{ a: number; b: number }[]>`
      select count(*) filter (where client_id = ${clientA})::int as a,
             count(*) filter (where client_id = ${clientB})::int as b
        from client_company_exclusions where company_id = ${companyId}
    `;
    expect(row.a).toBe(1);
    expect(row.b).toBe(0);
  });

  it("kampaň vyloučeného klienta firmu neosloví, kampaň druhého ano", async () => {
    const { clientA, clientB, companyId } = await twoClientsOneCompany();
    const { dispatchTick } = await import("@/lib/engine/dispatch");

    const campaigns: Record<string, string> = {};
    for (const [label, clientId] of [["A", clientA], ["B", clientB]] as const) {
      const seed = await seedCampaign({
        contacts: [{ email: `kontakt-${label.toLowerCase()}@sdilena.cz`, company: "Sdílená firma" }],
      });
      await sql`update campaigns set client_id = ${clientId}, status = 'active' where id = ${seed.campaignId}`;
      await sql`update contacts set company_id = ${companyId} where email = ${`kontakt-${label.toLowerCase()}@sdilena.cz`}`;
      await sql`update campaign_contacts set status = 'scheduled', next_send_at = now() - interval '1 minute'
                 where campaign_id = ${seed.campaignId}`;
      campaigns[label] = seed.campaignId;
    }

    await suppression.excludeCompanyForClient({ clientId: clientA, companyId });

    for (let i = 0; i < 4; i++) {
      await sql`update campaigns set next_slot_at = null`;
      await dispatchTick();
    }

    const [row] = await sql<{ a: number; b: number }[]>`
      select count(*) filter (where campaign_id = ${campaigns.A})::int as a,
             count(*) filter (where campaign_id = ${campaigns.B})::int as b
        from email_sends
    `;
    expect(row.a).toBe(0);
    expect(row.b).toBeGreaterThan(0);
  });

  it("nezaloží globální suppression", async () => {
    const { clientA, companyId } = await twoClientsOneCompany();
    await suppression.excludeCompanyForClient({ clientId: clientA, companyId });
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from suppression_list`;
    expect(row.count).toBe(0);
  });
});

// ================================================== audit a obnovení

describe("audit a bezpečné obnovení", () => {
  beforeEach(async () => {
    await sql`
      insert into suppression_list (email, reason, reason_code, source) values
        ('unsub@a.cz', 'unsubscribe', 'unsubscribe', 'unsubscribe_link'),
        ('spam@a.cz', 'spam', 'spam_complaint', 'fbl'),
        ('manual@a.cz', 'manual', 'manual_dnc', 'manual'),
        ('rep1@a.cz', 'reputation', 'bounce_technical', 'bounce'),
        ('rep2@a.cz', 'reputation', 'bounce_technical', 'bounce'),
        ('old@a.cz', 'kdo ví', 'legacy', null)
    `;
  });

  it("audit rozdělí položky podle důvodu a jen počítá", async () => {
    const groups = await suppression.auditSuppression();
    const byCode = Object.fromEntries(groups.map((g) => [g.reason_code, g]));
    expect(byCode.unsubscribe.disposition).toBe("keep");
    expect(byCode.spam_complaint.disposition).toBe("keep");
    expect(byCode.manual_dnc.disposition).toBe("keep");
    expect(byCode.bounce_technical.disposition).toBe("restorable");
    expect(byCode.bounce_technical.count).toBe(2);
    expect(byCode.legacy.disposition).toBe("review");

    // Dry run nic nezměnil.
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from suppression_list`;
    expect(row.count).toBe(6);
  });

  it("náhled ukáže adresy, ale nic nesmaže", async () => {
    const preview = await suppression.previewRestore("bounce_technical");
    expect(preview.emails.sort()).toEqual(["rep1@a.cz", "rep2@a.cz"]);
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from suppression_list`;
    expect(row.count).toBe(6);
  });

  it("technické bloky se vrátí do oběhu", async () => {
    const result = await suppression.restoreSuppressed("bounce_technical");
    expect(result.restored).toBe(2);
    expect(await reasonCodeOf("rep1@a.cz")).toBeNull();
  });

  it("odhlášení se NEVRÁTÍ, ani na přímý příkaz", async () => {
    const result = await suppression.restoreSuppressed("unsubscribe");
    expect(result.refused).toBe(true);
    expect(result.restored).toBe(0);
    expect(await reasonCodeOf("unsub@a.cz")).toBe("unsubscribe");
  });

  it("stížnost na spam se NEVRÁTÍ", async () => {
    expect((await suppression.restoreSuppressed("spam_complaint")).refused).toBe(true);
    expect(await reasonCodeOf("spam@a.cz")).toBe("spam_complaint");
  });

  it("neznámé starší položky se nevrací automaticky, jdou ke kontrole", async () => {
    const groups = await suppression.auditSuppression();
    expect(groups.find((g) => g.reason_code === "legacy")?.disposition).toBe("review");
    expect(await reasonCodeOf("old@a.cz")).toBe("legacy");

    const review = await suppression.listSuppression("review");
    expect(review.map((r) => r.email)).toEqual(["old@a.cz"]);
  });
});
