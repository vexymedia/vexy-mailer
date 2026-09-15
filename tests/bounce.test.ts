import { describe, expect, it } from "vitest";
import { blamedDomain, classifyBounce, extractResponseCode, extractStatus } from "@/lib/bounce";
import { classifyInbound, parseReturnDate } from "@/lib/inbound";

/**
 * Klasifikace nedoručení a příchozí pošty.
 *
 * Tenhle soubor existuje kvůli jedné konkrétní chybě: 554 "poor
 * reputation of a domain used in message transfer" se statusem 5.0.0 se
 * dá snadno přečíst jako "adresa neexistuje" a platný lead skončí
 * natrvalo zablokovaný kvůli problému na NAŠÍ straně.
 */

describe("bounce: co smí zablokovat příjemce", () => {
  it("5.1.1 user unknown je neexistující adresa", () => {
    const verdict = classifyBounce({
      status: "5.1.1",
      diagnosticCode: "smtp; 550 5.1.1 <ana@acme.cz>: Recipient address rejected: User unknown",
    });
    expect(verdict.type).toBe("HARD_INVALID");
    expect(verdict.suppressRecipient).toBe(true);
    expect(verdict.retryable).toBe(false);
  });

  it("KONKRÉTNÍ PŘÍPAD: 554 poor reputation je reputace, ne neexistující adresa", () => {
    const verdict = classifyBounce({
      status: "5.0.0",
      responseCode: 554,
      diagnosticCode:
        "smtp; 554 Your access to this mail system has been rejected due to poor " +
        "reputation of a domain used in message transfer",
    });
    expect(verdict.type).toBe("REPUTATION_BLOCK");
    // Tohle je to, o co tu jde.
    expect(verdict.suppressRecipient).toBe(false);
    expect(verdict.senderProblem).toBe(true);
  });

  it("5.0.0 samo o sobě neznamená nic - zůstane neurčeno", () => {
    const verdict = classifyBounce({ status: "5.0.0", diagnosticCode: "smtp; 550 failed" });
    expect(verdict.type).toBe("UNKNOWN");
    expect(verdict.suppressRecipient).toBe(false);
  });

  it("4.x je dočasné", () => {
    expect(classifyBounce({ status: "4.3.2", diagnosticCode: "smtp; 452 try later" }).type)
      .toBe("SOFT_TEMPORARY");
    expect(classifyBounce({ responseCode: 451, diagnosticCode: "smtp; 451 deferred" }).type)
      .toBe("SOFT_TEMPORARY");
  });

  it("plná schránka není neexistující adresa", () => {
    const verdict = classifyBounce({
      status: "5.2.2",
      diagnosticCode: "smtp; 552 5.2.2 Mailbox full",
    });
    expect(verdict.type).toBe("MAILBOX_FULL");
    expect(verdict.suppressRecipient).toBe(false);
    expect(verdict.retryable).toBe(true);
  });

  it("rate limit se pozná a smí se zkusit znovu", () => {
    const verdict = classifyBounce({
      diagnosticCode: "smtp; 421 4.7.0 Too many messages from this sender, try again later",
    });
    expect(verdict.type).toBe("RATE_LIMIT");
    expect(verdict.suppressRecipient).toBe(false);
    expect(verdict.retryable).toBe(true);
  });

  it("policy rejection je blok politikou, ne vada příjemce", () => {
    const verdict = classifyBounce({
      status: "5.7.1",
      diagnosticCode: "smtp; 550 5.7.1 Message rejected due to policy reasons",
    });
    expect(verdict.type).toBe("POLICY_BLOCK");
    expect(verdict.suppressRecipient).toBe(false);
    expect(verdict.senderProblem).toBe(true);
  });

  it("spam rejection je náš problém, ne příjemcův", () => {
    const verdict = classifyBounce({
      diagnosticCode: "smtp; 550 Message rejected as spam by the receiving server",
    });
    expect(["SPAM_REJECTION", "POLICY_BLOCK"]).toContain(verdict.type);
    expect(verdict.suppressRecipient).toBe(false);
    expect(verdict.senderProblem).toBe(true);
  });

  it("DNS a síť se nepletou s adresou", () => {
    expect(classifyBounce({ diagnosticCode: "smtp; 550 Host not found" }).type).toBe("NETWORK_ERROR");
    expect(classifyBounce({ diagnosticCode: "connection timed out" }).suppressRecipient).toBe(false);
  });

  it("neznámý diagnostic zůstane neznámý a nic neblokuje", () => {
    const verdict = classifyBounce({ diagnosticCode: "smtp; 550 nope" });
    expect(verdict.type).toBe("UNKNOWN");
    expect(verdict.suppressRecipient).toBe(false);
  });

  it("dočasný status přebije trvale znějící text", () => {
    // Některé servery pošlou 4.x s textem, který zní definitivně.
    const verdict = classifyBounce({
      status: "4.2.1",
      diagnosticCode: "smtp; 450 4.2.1 mailbox unavailable, try later",
    });
    expect(verdict.suppressRecipient).toBe(false);
  });

  it("jediný typ, který smí blokovat příjemce, je HARD_INVALID", () => {
    const types = [
      "smtp; 550 5.1.1 user unknown",
      "smtp; 554 poor reputation of a domain",
      "smtp; 452 mailbox full",
      "smtp; 421 rate limit",
      "smtp; 550 policy reasons",
      "smtp; 550 spam content",
      "smtp; 550 host not found",
      "smtp; 550 nope",
    ].map((diagnosticCode) => classifyBounce({ diagnosticCode }));
    expect(types.filter((v) => v.suppressRecipient).map((v) => v.type)).toEqual(["HARD_INVALID"]);
  });
});

describe("bounce: parsování", () => {
  it("vytáhne enhanced status i SMTP kód z volného textu", () => {
    expect(extractStatus("smtp; 550 5.1.1 User unknown")).toBe("5.1.1");
    expect(extractStatus("nic tady není")).toBeNull();
    expect(extractResponseCode("smtp; 554 rejected")).toBe(554);
  });

  it("vinnou doménu určí jen když je jednoznačná", () => {
    expect(
      blamedDomain({ diagnosticCode: 'rejected due to poor reputation of domain "vexy-mail.cz"' }),
    ).toEqual({ domain: "vexy-mail.cz", source: "uvedeno serverem" });

    // Tři různé domény = nedá se říct která. Nehádá se.
    expect(
      blamedDomain({
        diagnosticCode: "554 poor reputation",
        fromDomain: "vexy.cz",
        returnPathDomain: "bounces.sendgrid.net",
        dkimDomain: "mail.vexy.cz",
      }),
    ).toBeNull();

    // Jedna doména všude = dá.
    expect(
      blamedDomain({ diagnosticCode: "554 poor reputation", fromDomain: "vexy.cz", dkimDomain: "vexy.cz" })
        ?.domain,
    ).toBe("vexy.cz");
  });
});

describe("příchozí pošta: co je odpověď a co technický šum", () => {
  it("odpověď od člověka je odpověď", () => {
    const verdict = classifyInbound({
      from: "ana@acme.cz",
      subject: "Re: Krátký dotaz",
      bodyText: "Dobrý den, zní to zajímavě. Můžeme se spojit ve čtvrtek?",
    });
    expect(verdict.class).toBe("human");
    expect(verdict.needsHuman).toBe(true);
    expect(verdict.stopsSequence).toBe(true);
  });

  it("postmaster není prospekt", () => {
    const verdict = classifyInbound({
      from: "MAILER-DAEMON@acme.cz",
      subject: "Undelivered Mail Returned to Sender",
      bodyText: "smtp; 550 5.1.1 user unknown",
      contentType: "multipart/report; report-type=delivery-status",
    });
    expect(verdict.class).toBe("bounce");
    expect(verdict.needsHuman).toBe(false);
    expect(verdict.stopsSequence).toBe(false);
  });

  it("bounce bez DSN hlavičky se pozná podle předmětu a statusu", () => {
    const verdict = classifyInbound({
      from: "postmaster@acme.cz",
      subject: "Delivery Status Notification (Failure)",
      bodyText: "Your message could not be delivered. 550 5.1.1 unknown",
    });
    expect(verdict.class).toBe("bounce");
  });

  it("mimo kancelář je oddělené a NEZASTAVÍ sekvenci", () => {
    const verdict = classifyInbound({
      from: "ana@acme.cz",
      subject: "Automatická odpověď: mimo kancelář",
      bodyText: "Jsem mimo kancelář do 15. 8. V naléhavých případech volejte kolegu.",
    });
    expect(verdict.class).toBe("ooo");
    expect(verdict.stopsSequence).toBe(false);
    expect(verdict.needsHuman).toBe(false);
  });

  it("anglické out of office taky", () => {
    expect(
      classifyInbound({
        from: "john@acme.com",
        subject: "Out of Office: Re: Quick question",
        bodyText: "I am currently out of the office and will return on Monday.",
      }).class,
    ).toBe("ooo");
  });

  it("automatická odpověď se pozná z hlaviček", () => {
    const verdict = classifyInbound({
      from: "ticket@acme.cz",
      subject: "Vaše žádost byla přijata",
      bodyText: "Děkujeme, ozveme se.",
      headers: { "auto-submitted": "auto-replied" },
    });
    expect(verdict.class).toBe("auto");
    expect(verdict.needsHuman).toBe(false);
  });

  it("žádost o odhlášení je odhlášení, ne běžná odpověď", () => {
    const verdict = classifyInbound({
      from: "ana@acme.cz",
      subject: "Re: nabídka",
      bodyText: "Prosím odhlaste mě ze seznamu, nepřejeme si další e-maily.",
    });
    expect(verdict.class).toBe("unsubscribe");
    expect(verdict.stopsSequence).toBe(true);
    expect(verdict.needsHuman).toBe(true);
  });

  it("odhlášení přebije i hlavičku automatické odpovědi", () => {
    expect(
      classifyInbound({
        from: "ana@acme.cz",
        subject: "unsubscribe",
        bodyText: "remove me",
        headers: { precedence: "bulk" },
      }).class,
    ).toBe("unsubscribe");
  });

  it("no-reply adresa není člověk", () => {
    expect(
      classifyInbound({ from: "no-reply@acme.cz", subject: "Potvrzení", bodyText: "Díky." }).class,
    ).toBe("auto");
  });
});

describe("datum návratu z OOO", () => {
  const now = new Date("2026-07-01T00:00:00Z");

  it("přečte české datum", () => {
    expect(parseReturnDate("Jsem mimo kancelář do 15. 8. 2026.", now)?.toISOString())
      .toBe("2026-08-15T00:00:00.000Z");
  });

  it("bez roku bere nejbližší budoucí", () => {
    expect(parseReturnDate("Vrátím se 3. 2.", now)?.toISOString())
      .toBe("2027-02-03T00:00:00.000Z");
  });

  it("přečte ISO datum", () => {
    expect(parseReturnDate("I am away until 2026-09-01.", now)?.toISOString())
      .toBe("2026-09-01T00:00:00.000Z");
  });

  it("když datum není, nehádá", () => {
    expect(parseReturnDate("I am out of the office for a while.", now)).toBeNull();
    expect(parseReturnDate(null, now)).toBeNull();
  });
});
