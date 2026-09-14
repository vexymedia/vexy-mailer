import { sql } from "../db";
import { callOutcomeLabel } from "../calling";

/**
 * Co caller potřebuje vědět, než vytočí číslo.
 *
 * Jedno místo, které sesbírá skutečné události kolem jednoho kontaktu:
 * co jsme poslali, jestli prospekt odpověděl, jak dopadl minulý hovor.
 * Z toho se teprve skládá věta "proč volám právě teď".
 *
 * Nic se tu nevymýšlí. Když Loom nebyl, sekce Loom není. Když nikdo
 * neodpověděl, neřekne se "odpověděl". Caller na ten kontext navazuje
 * první větou hovoru a nepravdivá věta ho na lince shodí.
 */

export interface LoomContext {
  url: string;
  title: string | null;
  sent_at: Date | null;
  note: string | null;
}

export interface EmailSnippet {
  conversation_id: string;
  subject: string | null;
  /** Zkrácené tělo. Celá konverzace je na jeden klik ve Schránce. */
  snippet: string | null;
  occurred_at: Date;
  from_email: string;
}

export interface LeadContext {
  contact_id: string;
  loom: LoomContext | null;
  last_outbound: EmailSnippet | null;
  last_inbound: EmailSnippet | null;
  /** Kolikátý telefonický pokus tohle bude. */
  attempt: number;
  last_call_at: Date | null;
  last_call_outcome: string | null;
  /** Naplánovaný termín, pokud si ho prospekt vyžádal. */
  callback_at: Date | null;
  /** Vlastní úvodní věta pro tenhle kontakt, pokud ji někdo napsal. */
  opener: string | null;
}

const SNIPPET_CHARS = 400;

/** Tělo zprávy zkrácené na to, co se dá přečíst mezi zazvoněním a zvednutím. */
function snippet(body: string | null): string | null {
  if (!body) return null;
  const text = body.replace(/\r/g, "").split(/\n>|\n--\s*\n/)[0].trim();
  if (!text) return null;
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…` : text;
}

export async function getLeadContext(input: {
  contactId: string;
  campaignContactId?: string | null;
}): Promise<LeadContext> {
  const campaignContactId = input.campaignContactId ?? null;

  const [[contact], messages, [callInfo]] = await Promise.all([
    sql<
      {
        loom_url: string | null;
        loom_title: string | null;
        loom_sent_at: Date | null;
        loom_note: string | null;
        call_opener: string | null;
      }[]
    >`
      select loom_url, loom_title, loom_sent_at, loom_note, call_opener
        from contacts where id = ${input.contactId}
    `,
    // Poslední zpráva každým směrem. Jeden dotaz - konverzací může být
    // u jednoho kontaktu víc (různé kampaně, různé schránky).
    sql<
      {
        direction: string;
        conversation_id: string;
        subject: string | null;
        body_text: string | null;
        occurred_at: Date;
        from_email: string;
      }[]
    >`
      select distinct on (m.direction)
             m.direction, m.conversation_id, m.subject, m.body_text, m.occurred_at, m.from_email
        from messages m
        join conversations cv on cv.id = m.conversation_id
       where cv.contact_id = ${input.contactId}
       order by m.direction, m.occurred_at desc
    `,
    sql<
      { attempts: number; last_call_at: Date | null; last_outcome: string | null; callback_at: Date | null }[]
    >`
      select
        (select count(*)::int from call_activities ca where ca.contact_id = ${input.contactId}) as attempts,
        (select ca.called_at from call_activities ca
          where ca.contact_id = ${input.contactId}
          order by ca.called_at desc limit 1) as last_call_at,
        (select ca.outcome from call_activities ca
          where ca.contact_id = ${input.contactId}
          order by ca.called_at desc limit 1) as last_outcome,
        (select cc.next_call_at from campaign_contacts cc
          where cc.id = ${campaignContactId}::uuid
            and cc.call_status = 'callback') as callback_at
    `,
  ]);

  const pick = (direction: string): EmailSnippet | null => {
    const row = messages.find((m) => m.direction === direction);
    if (!row) return null;
    return {
      conversation_id: row.conversation_id,
      subject: row.subject,
      snippet: snippet(row.body_text),
      occurred_at: row.occurred_at,
      from_email: row.from_email,
    };
  };

  return {
    contact_id: input.contactId,
    loom: contact?.loom_url
      ? {
          url: contact.loom_url,
          title: contact.loom_title,
          sent_at: contact.loom_sent_at,
          note: contact.loom_note,
        }
      : null,
    last_outbound: pick("outbound"),
    last_inbound: pick("inbound"),
    attempt: (callInfo?.attempts ?? 0) + 1,
    last_call_at: callInfo?.last_call_at ?? null,
    last_call_outcome: callInfo?.last_outcome ?? null,
    callback_at: callInfo?.callback_at ?? null,
    opener: contact?.call_opener ?? null,
  };
}

/** Celé dny mezi dneškem a událostí. Záporné hodnoty nevrací. */
function daysAgo(when: Date | null | undefined): number | null {
  if (!when) return null;
  const ms = Date.now() - new Date(when).getTime();
  return ms < 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** "dnes" / "včera" / "před 4 dny" - tak, jak to člověk řekne. */
function agoLabel(days: number): string {
  if (days === 0) return "dnes";
  if (days === 1) return "včera";
  if (days < 5) return `před ${days} dny`;
  return `před ${days} dny`;
}

/**
 * "Proč volám právě teď" jako posloupnost skutečných kroků.
 *
 * Ne šablona s doplněnými hodnotami: každá položka odpovídá události,
 * která se opravdu stala a je v databázi. Když se nestalo nic, vrátí se
 * prázdné pole a UI sekci nevykreslí - lepší než vymyšlená historie.
 */
export function buildWhyNow(context: LeadContext): string[] {
  const steps: string[] = [];

  const loomDays = daysAgo(context.loom?.sent_at);
  if (context.loom && loomDays !== null) {
    steps.push(`Loom odeslán ${agoLabel(loomDays)}`);
  }

  const outboundDays = daysAgo(context.last_outbound?.occurred_at);
  if (outboundDays !== null) {
    steps.push(`E-mail odeslán ${agoLabel(outboundDays)}`);
  }

  const inboundDays = daysAgo(context.last_inbound?.occurred_at);
  if (inboundDays !== null) {
    steps.push(`Prospekt odpověděl ${agoLabel(inboundDays)}`);
  } else if (outboundDays !== null) {
    steps.push("Bez odpovědi");
  }

  // Callback má přednost před obecným follow-upem: je to slib, ne kadence.
  if (context.callback_at) {
    const due = new Date(context.callback_at);
    const overdue = due.getTime() < Date.now();
    steps.push(
      overdue
        ? "Slíbený termín hovoru už je po čase"
        : "Prospekt si vyžádal hovor na tento termín",
    );
  } else if (context.last_call_outcome) {
    const callDays = daysAgo(context.last_call_at);
    steps.push(
      `Minulý hovor ${callDays === null ? "" : agoLabel(callDays) + " "}— ${callOutcomeLabel(
        context.last_call_outcome,
      )}`.replace("  ", " "),
    );
    steps.push(`Dnes telefonický follow-up #${context.attempt}`);
  } else if (steps.length > 0) {
    steps.push(`Dnes telefonický follow-up #${context.attempt}`);
  }

  return steps;
}

/**
 * Úvodní věta hovoru.
 *
 * Pořadí je dané: vlastní opener u kontaktu, pak scénář kampaně, a teprve
 * když není ani jedno, bezpečná šablona ze jmen a z toho, co prospekt
 * skutečně dostal. Šablona nikdy netvrdí nic, co v datech není.
 */
export function buildOpener(input: {
  context: LeadContext;
  contactName: string | null;
  companyName: string | null;
  callerName: string | null;
  campaignOpening: string | null;
}): string | null {
  if (input.context.opener?.trim()) return input.context.opener.trim();
  if (input.campaignOpening?.trim()) return input.campaignOpening.trim();

  const greeting = input.contactName
    ? `Dobrý den, ${input.contactName.split(" ").slice(-1)[0]},`
    : "Dobrý den,";
  const who = input.callerName ? ` tady ${input.callerName} z VEXY.` : " tady VEXY.";

  // Na co navázat: Loom má přednost, pak e-mail. Bez obojího se nedá
  // slíbit "navazuji na" - tak se to ani neřekne.
  if (input.context.loom) {
    return `${greeting}${who} Navazuji na krátké video, které jsme vám posílali${
      input.context.loom.title ? ` — ${input.context.loom.title}` : ""
    }. Máte dvě minuty?`;
  }
  if (input.context.last_outbound) {
    return `${greeting}${who} Navazuji na e-mail, který jsme vám posílali${
      input.context.last_outbound.subject ? ` — „${input.context.last_outbound.subject}“` : ""
    }. Máte dvě minuty?`;
  }
  if (input.companyName) {
    return `${greeting}${who} Volám kvůli ${input.companyName} — máte dvě minuty?`;
  }
  return `${greeting}${who} Máte dvě minuty?`;
}
