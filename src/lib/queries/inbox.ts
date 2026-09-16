import type { Sql, TransactionSql } from "postgres";
import { sql } from "../db";
import type { Classification, ConversationRow, MessageRow, ConversationDetail } from "../types";

type Db = Sql | TransactionSql;

/**
 * The unified inbox: one conversation per (mailbox, contact) pair, holding
 * every message in both directions.
 *
 * Keyed on the pair rather than on the campaign because that is what the
 * prospect experiences - one exchange with one person - even when we happen to
 * have them enrolled in more than one campaign.
 */

/** Finds or creates the conversation a message belongs to. */
export async function ensureConversation(
  db: Db,
  input: {
    mailboxId: string;
    contactId: string;
    campaignId?: string | null;
    campaignContactId?: string | null;
    subject?: string | null;
  },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id, subject)
    values (${input.mailboxId}, ${input.contactId}, ${input.campaignId ?? null},
            ${input.campaignContactId ?? null}, ${input.subject ?? null})
    on conflict (mailbox_id, contact_id) do update
       set campaign_id = coalesce(conversations.campaign_id, excluded.campaign_id),
           campaign_contact_id = coalesce(conversations.campaign_contact_id, excluded.campaign_contact_id),
           subject = coalesce(conversations.subject, excluded.subject),
           updated_at = now()
    returning id
  `;
  return row.id;
}

export interface OutboundMessageInput {
  mailboxId: string;
  contactId: string;
  campaignId?: string | null;
  campaignContactId?: string | null;
  kind: "campaign" | "manual_reply";
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  emailSendId?: string | null;
  occurredAt?: Date;
}

/**
 * Mirrors an email we sent into the conversation thread.
 *
 * Never throws: a bookkeeping failure must not be able to unwind a send that
 * already left the building.
 */
export async function recordOutboundMessage(input: OutboundMessageInput): Promise<void> {
  try {
    const conversationId = await ensureConversation(sql, {
      mailboxId: input.mailboxId,
      contactId: input.contactId,
      campaignId: input.campaignId,
      campaignContactId: input.campaignContactId,
      subject: input.subject,
    });
    const occurredAt = input.occurredAt ?? new Date();
    await sql`
      insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                            body_text, message_id, in_reply_to, message_references,
                            email_send_id, occurred_at, is_read)
      values (${conversationId}, 'outbound', ${input.kind}, ${input.fromEmail}, ${input.toEmail},
              ${input.subject}, ${input.bodyText}, ${input.messageId}, ${input.inReplyTo ?? null},
              ${input.references ?? null}, ${input.emailSendId ?? null}, ${occurredAt}, true)
      on conflict do nothing
    `;
    await sql`
      update conversations
         set last_message_at = greatest(last_message_at, ${occurredAt}), updated_at = now()
       where id = ${conversationId}
    `;
  } catch (error) {
    console.error("[inbox] could not record outbound message", error);
  }
}

export interface InboundMessageInput {
  mailboxId: string;
  contactId: string;
  campaignId?: string | null;
  campaignContactId?: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  replyId?: string | null;
  receivedAt: Date;
  /** Druh zprávy podle `src/lib/inbound.ts`. Řídí, co se objeví v inboxu. */
  messageClass?: import("../inbound").MessageClass;
}

/** Stores an incoming reply and marks the conversation unread. */
export async function recordInboundMessage(input: InboundMessageInput): Promise<void> {
  const conversationId = await ensureConversation(sql, {
    mailboxId: input.mailboxId,
    contactId: input.contactId,
    campaignId: input.campaignId,
    campaignContactId: input.campaignContactId,
    subject: input.subject,
  });
  const inserted = await sql<{ id: string }[]>`
    insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                          body_text, body_html, message_id, in_reply_to, message_references,
                          reply_id, occurred_at, is_read, message_class)
    values (${conversationId}, 'inbound', 'incoming', ${input.fromEmail}, ${input.toEmail},
            ${input.subject}, ${input.bodyText}, ${input.bodyHtml}, ${input.messageId},
            ${input.inReplyTo ?? null}, ${input.references ?? null}, ${input.replyId ?? null},
            ${input.receivedAt}, false, ${input.messageClass ?? "human"})
    on conflict (conversation_id, message_id) where message_id is not null do nothing
    returning id
  `;
  if (inserted.length === 0) return; // already stored

  // Nepřečtené se počítá jen u toho, co má člověk skutečně číst.
  // Automatická odpověď nemá rozsvítit "1 nepřečtená" v sales inboxu.
  const countsAsUnread = (input.messageClass ?? "human") === "human" ||
    input.messageClass === "unsubscribe";
  await sql`
    update conversations
       set last_message_at = greatest(last_message_at, ${input.receivedAt}),
           last_inbound_at = greatest(coalesce(last_inbound_at, ${input.receivedAt}), ${input.receivedAt}),
           unread_count = unread_count + ${countsAsUnread ? 1 : 0},
           classification = case
             when ${input.messageClass ?? "human"} = 'ooo' and classification = 'unclassified'
               then 'ooo'
             else classification
           end,
           updated_at = now()
     where id = ${conversationId}
  `;
}

/**
 * Pohledy na Komunikaci.
 *
 * Výchozí je "todo" - K vYŘÍZENÍ. Sto padesát vláken, kde jsme jen něco
 * poslali a nikdo neodpověděl, není pracovní inbox; je to seznam, který
 * nikdo neprojde. Co vyžaduje člověka, je úzká množina: skutečné lidské
 * odpovědi, které ještě nikdo nezařadil.
 */
export type InboxView = "todo" | "positive" | "later" | "resolved" | "all" | "unread";

export const INBOX_VIEWS: { key: InboxView; label: string }[] = [
  { key: "todo", label: "K vyřízení" },
  { key: "positive", label: "Pozitivní" },
  { key: "later", label: "Později / mimo kancelář" },
  { key: "resolved", label: "Vyřešené" },
  { key: "all", label: "Vše" },
];

export interface InboxFilters {
  view?: InboxView;
  campaignId?: string | null;
  mailboxId?: string | null;
  search?: string | null;
  /**
   * Co se má vypsat.
   *
   * "replies" je triage odpovědí - jen vlákna, kde prospekt něco napsal.
   * "all" je schránka: i vlákna, kde jsme zatím jen odeslali. Redesign
   * nechal v aplikaci jen první variantu, takže odeslaná pošta v UI
   * neexistovala a celá Schránka se jevila jako ztracená.
   */
  scope?: "replies" | "all";
  /** Jen konverzace jednoho kontaktu. Pro pohled z detailu firmy. */
  contactId?: string | null;
}

/**
 * Podmínka pohledu. Jeden fragment, který se používá i pro počty, aby se
 * číslo na záložce nemohlo rozejít s tím, co je pod ní.
 *
 * "K vyřízení" stojí na DVOU věcech současně: přišla lidská zpráva
 * (`message_class = 'human'`), a nikdo ji ještě nezařadil. Bounce, OOO
 * ani automatické potvrzení tuhle podmínku nesplní, takže se do sales
 * inboxu nedostanou vůbec - a odeslaná pošta bez odpovědi taky ne.
 */
function viewCondition(db: Db, view: InboxView) {
  const humanInbound = db`exists (
    select 1 from messages m
     where m.conversation_id = cv.id
       and m.direction = 'inbound'
       and m.message_class in ('human', 'unsubscribe')
  )`;
  switch (view) {
    case "todo":
      return db`${humanInbound} and cv.classification = 'unclassified'`;
    case "positive":
      return db`cv.classification = 'positive'`;
    case "later":
      return db`cv.classification in ('later', 'ooo')`;
    case "resolved":
      return db`cv.classification in ('not_interested', 'wrong_person', 'unsubscribe', 'other')`;
    case "unread":
      return db`cv.unread_count > 0`;
    case "all":
    default:
      return db`true`;
  }
}

/** The inbox list. One row per conversation, newest activity first. */
export async function listConversations(filters: InboxFilters = {}): Promise<ConversationRow[]> {
  const search = filters.search?.trim() ? `%${filters.search.trim().toLowerCase()}%` : null;
  const scope = filters.scope ?? "replies";
  // Výchozí pohled závisí na rozsahu. Schránka (`scope: "all"`) ukazuje
  // i vlákna, kde jsme jen odeslali - tam "K vyřízení" nedává smysl,
  // protože ta podmínka vyžaduje lidskou zprávu.
  const view = filters.view ?? (scope === "all" ? "all" : "todo");
  return sql<ConversationRow[]>`
    select cv.id, cv.unread_count, cv.classification, cv.last_message_at, cv.last_inbound_at,
           cv.subject,
           c.email as contact_email,
           trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as contact_name,
           c.company,
           cp.name as campaign_name,
           cv.campaign_id,
           mb.from_email as mailbox_email,
           mb.id as mailbox_id,
           c.company_id,
           (select m.to_email from messages m
             where m.conversation_id = cv.id and m.direction = 'inbound'
             order by m.occurred_at desc limit 1) as replied_to_email,
           (select count(*)::int from messages m where m.conversation_id = cv.id) as message_count,
           exists (select 1 from messages m
                    where m.conversation_id = cv.id and m.direction = 'inbound') as has_inbound
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes mb on mb.id = cv.mailbox_id
      left join campaigns cp on cp.id = cv.campaign_id
     -- Visibility is derived from the messages that actually exist, not from
     -- last_inbound_at. Nothing recomputes that column when messages or the
     -- replies behind them are deleted, so trusting it left conversations with
     -- no inbound message at all sitting in the inbox.
     where (${scope} = 'all' or exists (
             select 1 from messages m
              where m.conversation_id = cv.id and m.direction = 'inbound'
           ))
       and (${filters.contactId ?? null}::uuid is null
            or cv.contact_id = ${filters.contactId ?? null}::uuid)
       and (${viewCondition(sql, view)})
       and (${filters.campaignId ?? null}::uuid is null or cv.campaign_id = ${filters.campaignId ?? null}::uuid)
       and (${filters.mailboxId ?? null}::uuid is null or cv.mailbox_id = ${filters.mailboxId ?? null}::uuid)
       and (${search}::text is null
            or lower(c.email) like ${search}
            or lower(coalesce(c.company, '')) like ${search}
            or lower(coalesce(c.first_name, '')) like ${search}
            or lower(coalesce(c.last_name, '')) like ${search})
     order by cv.last_message_at desc
     limit 300
  `;
}

export async function getConversation(id: string): Promise<ConversationDetail | null> {
  const [conversation] = await sql<ConversationDetail[]>`
    select cv.id, cv.classification, cv.unread_count, cv.subject, cv.campaign_id,
           cv.campaign_contact_id, cv.contact_id, cv.mailbox_id,
           c.email as contact_email,
           trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as contact_name,
           c.company, c.company_id, c.website, c.phone,
           cc.call_status,
           cc.next_call_at,
           cp.name as campaign_name,
           mb.from_email as mailbox_email, mb.from_name as mailbox_from_name, mb.enabled as mailbox_enabled,
           cc.status as contact_status,
           -- Vyloučení je vlastnost dvojice klient+firma, takže ho určuje
           -- kampaň tohoto vlákna, ne kontakt sám. Stejné pravidlo jako
           -- na detailu firmy; server ho vyhodnocuje znovu při startCall.
           (cl.id is not null and exists (
              select 1 from client_company_exclusions x
               where x.company_id = c.company_id and x.client_id = cl.id
            )) as client_excluded,
           case when cl.id is not null and exists (
              select 1 from client_company_exclusions x
               where x.company_id = c.company_id and x.client_id = cl.id
            ) then cl.name end as excluded_for_client
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes mb on mb.id = cv.mailbox_id
      left join campaigns cp on cp.id = cv.campaign_id
      left join clients cl on cl.id = cp.client_id
      left join campaign_contacts cc on cc.id = cv.campaign_contact_id
     where cv.id = ${id}
  `;
  return conversation ?? null;
}

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  return sql<MessageRow[]>`
    select id, direction, kind, from_email, to_email, subject, body_text,
           message_id, in_reply_to, occurred_at, is_read
      from messages
     where conversation_id = ${conversationId}
     order by occurred_at asc, created_at asc
  `;
}

export async function markConversationRead(id: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update messages set is_read = true where conversation_id = ${id} and is_read = false`;
    await tx`update conversations set unread_count = 0, updated_at = now() where id = ${id}`;
  });
}

/**
 * Removes a conversation from the inbox, deliberately.
 *
 * Deletes the conversation and its messages and nothing else. Contacts,
 * campaign contacts, email_sends and replies are all left intact: email_sends
 * in particular is the ledger that stops a contact being emailed the same step
 * twice, so tidying the inbox must never touch it.
 *
 * This exists because no other deletion reaches a conversation. Removing a
 * reply detaches the ledger link but keeps the history (by design), and
 * removing a campaign only nulls the campaign columns - so without an explicit
 * action an operator has no safe way to clear a stale thread.
 */
export async function deleteConversation(id: string): Promise<void> {
  const [conversation] = await sql<{ contact_email: string; mailbox_email: string }[]>`
    select c.email as contact_email, m.from_email as mailbox_email
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes m on m.id = cv.mailbox_id
     where cv.id = ${id}
  `;
  // messages cascade from conversations.
  await sql`delete from conversations where id = ${id}`;
  if (conversation) {
    const { logActivity } = await import("../activity");
    await logActivity({
      level: "warn",
      action: "Konverzace smazána",
      detail:
        `Removed the inbox thread between ${conversation.mailbox_email} and ` +
        `${conversation.contact_email}. Send history and contact records were not affected.`,
    });
  }
}

export async function setClassification(id: string, classification: Classification): Promise<void> {
  await sql`
    update conversations set classification = ${classification}, updated_at = now() where id = ${id}
  `;
}

/**
 * The headers a reply needs to land in the same thread in the recipient's mail
 * client. In-Reply-To points at the message being answered; References carries
 * the whole chain, which is what Gmail and Outlook actually group on.
 */
export interface ThreadHeaders {
  inReplyTo: string | null;
  references: string | null;
  subject: string;
}

export async function buildReplyHeaders(conversationId: string): Promise<ThreadHeaders> {
  const messages = await sql<
    { message_id: string | null; message_references: string | null; subject: string | null; direction: string }[]
  >`
    select message_id, message_references, subject, direction
      from messages where conversation_id = ${conversationId}
     order by occurred_at asc, created_at asc
  `;

  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const target = lastInbound ?? [...messages].reverse()[0];

  // References is the accumulated chain: everything we know, in order, deduped.
  const chain: string[] = [];
  for (const message of messages) {
    for (const id of (message.message_references ?? "").split(/\s+/)) {
      if (id && !chain.includes(id)) chain.push(id);
    }
    if (message.message_id && !chain.includes(message.message_id)) chain.push(message.message_id);
  }

  const baseSubject = (target?.subject ?? "").replace(/^((re|fwd?|odp)\s*:\s*)+/i, "").trim();
  return {
    inReplyTo: target?.message_id ?? null,
    references: chain.length > 0 ? chain.join(" ") : null,
    subject: baseSubject ? `Re: ${baseSubject}` : "Re:",
  };
}

export type InboxCounts = Record<InboxView, number>;

/**
 * Počty na záložkách. Počítají se stejnými podmínkami jako samotné
 * výpisy - jinak by záložka slibovala tři položky a otevřela jednu.
 */
export async function getInboxCounts(): Promise<InboxCounts> {
  const [row] = await sql<InboxCounts[]>`
    select count(*) filter (where ${viewCondition(sql, "todo")})::int as todo,
           count(*) filter (where ${viewCondition(sql, "positive")})::int as positive,
           count(*) filter (where ${viewCondition(sql, "later")})::int as later,
           count(*) filter (where ${viewCondition(sql, "resolved")})::int as resolved,
           count(*) filter (where ${viewCondition(sql, "unread")})::int as unread,
           count(*)::int as all
      from conversations cv
     where exists (
             select 1 from messages m
              where m.conversation_id = cv.id and m.direction = 'inbound'
           )
  `;
  return row;
}

/**
 * Sends a human reply from inside a conversation.
 *
 * Three rules this enforces:
 *
 *   1. It goes out from the conversation's own mailbox, using that mailbox's
 *      stored credentials. Answering from a different address would break the
 *      thread and confuse the prospect about who they are talking to.
 *   2. It carries In-Reply-To and References, so Gmail, Outlook and Seznam all
 *      file it under the existing thread rather than starting a new one.
 *   3. It is NOT written to email_sends. That table is the campaign ledger and
 *      the thing the daily cap counts; a human answering a human must never be
 *      blocked because a cold-email quota ran out.
 *
 * Test mode still applies - a manual reply is a real email, and development
 * must not be able to reach a real prospect.
 */
export async function sendManualReply(
  conversationId: string,
  bodyText: string,
): Promise<{ ok: boolean; error?: string }> {
  const { getSettings } = await import("../settings");
  const { sendMail, generateMessageId } = await import("../smtp");
  const { textToHtml } = await import("../template");
  const { logActivity } = await import("../activity");

  const conversation = await getConversation(conversationId);
  if (!conversation) return { ok: false, error: "Konverzace nebyla nalezena." };

  const [mailbox] = await sql<import("../types").Mailbox[]>`
    select * from mailboxes where id = ${conversation.mailbox_id}
  `;
  if (!mailbox) return { ok: false, error: "Odesílací schránka už neexistuje." };
  if (!mailbox.enabled) return { ok: false, error: "Odesílací schránka je vypnutá." };

  const settings = await getSettings();
  let to = conversation.contact_email;
  let subjectPrefix = "";
  if (settings.test_mode) {
    if (settings.test_behavior === "simulate") {
      return { ok: false, error: "Testovací režim je nastavený na simulaci, takže odpověď nelze skutečně odeslat." };
    }
    if (!settings.test_email) {
      return { ok: false, error: "Testovací režim je zapnutý, ale není nastavená testovací adresa." };
    }
    to = settings.test_email;
    subjectPrefix = `[TEST -> ${conversation.contact_email}] `;
  }

  const headers = await buildReplyHeaders(conversationId);
  const messageId = generateMessageId(mailbox.from_email);
  const subject = subjectPrefix + headers.subject;

  const result = await sendMail(mailbox, {
    to,
    subject,
    text: bodyText,
    html: textToHtml(bodyText),
    messageId,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });

  if (!result.ok) {
    await logActivity({
      level: "error",
      action: "Ruční odpověď selhala",
      detail: `${mailbox.from_email} -> ${conversation.contact_email}: ${result.message}`,
      campaignId: conversation.campaign_id,
      contactId: conversation.contact_id,
    });
    return { ok: false, error: result.message };
  }

  await recordOutboundMessage({
    mailboxId: mailbox.id,
    contactId: conversation.contact_id,
    campaignId: conversation.campaign_id,
    campaignContactId: conversation.campaign_contact_id,
    kind: "manual_reply",
    fromEmail: mailbox.from_email,
    toEmail: conversation.contact_email,
    subject,
    bodyText,
    messageId: result.messageId,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });

  await sql`update mailboxes set last_send_at = now() where id = ${mailbox.id}`;
  await logActivity({
    action: "Ruční odpověď odeslána",
    detail: `${mailbox.from_email} -> ${conversation.contact_email} - "${subject}"`,
    campaignId: conversation.campaign_id,
    contactId: conversation.contact_id,
    campaignContactId: conversation.campaign_contact_id,
  });

  return { ok: true };
}

// ------------------------------------------- odpověď od jiné adresy

/**
 * Nevyřízená odpověď, která do vlákna patří podle hlaviček, ale nepřišla
 * od prospekta.
 *
 * Vzniká přeposláním nebo odpovědí z Gmailu či jiné firemní domény.
 * Dokud ji někdo neposoudí, stojí sekvence kontaktu - proto to musí být
 * v konverzaci vidět a proto k tomu patří rozhodnutí, ne jen štítek.
 */
export interface PendingReview {
  reply_id: string;
  from_email: string;
  subject: string | null;
  received_at: Date;
  campaign_contact_id: string;
  contact_email: string;
  /** Termín, který čeká na rozhodnutí. Null = kontakt žádný krok neměl. */
  paused_next_send_at: Date | null;
}

export async function getPendingReview(conversationId: string): Promise<PendingReview | null> {
  const [row] = await sql<PendingReview[]>`
    select r.id as reply_id, r.from_email, r.subject, r.received_at,
           r.campaign_contact_id, c.email as contact_email,
           cc.paused_next_send_at
      from conversations cv
      join replies r on r.contact_id = cv.contact_id and r.mailbox_id = cv.mailbox_id
      join campaign_contacts cc on cc.id = r.campaign_contact_id
      join contacts c on c.id = cc.contact_id
     where cv.id = ${conversationId}
       and r.needs_review
     order by r.received_at desc
     limit 1
  `;
  return row ?? null;
}

/** Konverzace, které čekají na posouzení. Kvůli odznaku ve výpisu. */
export async function listConversationsNeedingReview(): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`
    select distinct cv.id
      from conversations cv
      join replies r on r.contact_id = cv.contact_id and r.mailbox_id = cv.mailbox_id
     where r.needs_review
  `;
  return new Set(rows.map((r) => r.id));
}

export type ReviewVerdict = "relevant" | "unrelated";

/**
 * Uzavře posouzení odpovědi od nejisté adresy.
 *
 *   relevant  → psal prospekt, jen z jiné adresy. Kontakt je "replied"
 *               a sekvence končí - ve všech kampaních TOHOTO klienta,
 *               v žádné cizí (viz engine/replies.ts).
 *   unrelated → zpráva s prospektem nesouvisí. Zavře se posouzení
 *               a sekvence se vrátí tam, kde stála.
 *
 * Obnovení je schválně opatrné. Vrací se jen to, co pozastavil TENHLE
 * případ, a jen pokud mezitím nenastalo něco, co má přednost:
 *
 *   * kontakt už není v běžícím stavu (odpověděl, odhlásil se, dokončil),
 *   * čeká na něj ještě jiné neuzavřené posouzení,
 *   * uschovaný termín chybí, protože nebylo co pozastavit.
 *
 * Když původní termín mezitím uplynul, nevrací se do minulosti - to by
 * znamenalo odeslání v nejbližším ticku, klidně o třetí ráno. Použije se
 * nejbližší otevření odesílacího okna kampaně.
 *
 * Odsud se NIKDY neodesílá. Jen se nastaví termín; zbytek je práce
 * dispatcheru, který si znovu ověří kampaň, kontakt i odesílatele.
 */
export async function resolveReview(
  replyId: string,
  verdict: ReviewVerdict,
): Promise<{ ok: boolean; contactEmail?: string; resumed?: boolean }> {
  const { logActivity } = await import("../activity");
  const { nextWindowOpen } = await import("../schedule");

  const [reply] = await sql<
    { campaign_contact_id: string | null; from_email: string; contact_id: string | null }[]
  >`
    select campaign_contact_id, from_email, contact_id from replies
     where id = ${replyId} and needs_review
  `;
  if (!reply || !reply.campaign_contact_id) return { ok: false };

  const [contact] = await sql<
    {
      email: string;
      campaign_id: string;
      status: string;
      paused_next_send_at: Date | null;
      send_days: number[];
      send_start_minute: number;
      send_end_minute: number;
      timezone: string;
    }[]
  >`
    select c.email, cc.campaign_id, cc.status, cc.paused_next_send_at,
           cp.send_days, cp.send_start_minute, cp.send_end_minute, cp.timezone
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
      join campaigns cp on cp.id = cc.campaign_id
     where cc.id = ${reply.campaign_contact_id}
  `;

  let resumed = false;

  await sql.begin(async (tx) => {
    await tx`update replies set needs_review = false where id = ${replyId}`;

    if (verdict === "relevant") {
      // Teprve TEĎHLE se sekvence ukončuje - ručním potvrzením člověka,
      // ne příchodem nejisté zprávy. Dosah je klient, ne celá databáze.
      await tx`
        update campaign_contacts cc
           set status = 'replied', replied_at = coalesce(cc.replied_at, now()),
               next_send_at = null, paused_next_send_at = null, updated_at = now()
          from campaigns cp
         where cc.campaign_id = cp.id
           and cc.contact_id = ${reply.contact_id}
           and cc.status in ('pending', 'scheduled', 'sent', 'failed')
           and cp.client_id is not distinct from (
                 select owner.client_id
                   from campaign_contacts matched
                   join campaigns owner on owner.id = matched.campaign_id
                  where matched.id = ${reply.campaign_contact_id})
      `;
      return;
    }

    // --- nesouvisí: obnovit, ale jen když se to smí -------------------
    //
    // Další neuzavřené posouzení téhož kontaktu má přednost: dokud visí,
    // sekvence stojí dál. Jinak by druhá cizí zpráva zůstala viset
    // a kontakt by se mezitím rozjel.
    const [{ pending }] = await tx<{ pending: number }[]>`
      select count(*)::int as pending from replies
       where campaign_contact_id = ${reply.campaign_contact_id}
         and needs_review and id <> ${replyId}
    `;
    if (pending > 0) return;
    if (!contact?.paused_next_send_at) return;
    // Mezitím odpověděl, odhlásil se nebo dojel - to má přednost.
    if (!["scheduled", "sent"].includes(contact.status)) {
      await tx`update campaign_contacts set paused_next_send_at = null, updated_at = now()
                where id = ${reply.campaign_contact_id}`;
      return;
    }

    const original = contact.paused_next_send_at;
    const resumeAt =
      original.getTime() > Date.now()
        ? original
        : nextWindowOpen(
            {
              sendDays: contact.send_days,
              sendStartMinute: contact.send_start_minute,
              sendEndMinute: contact.send_end_minute,
              timezone: contact.timezone,
            },
            new Date(),
          );

    await tx`
      update campaign_contacts
         set next_send_at = ${resumeAt}, paused_next_send_at = null, updated_at = now()
       where id = ${reply.campaign_contact_id}
         and status in ('scheduled', 'sent')
    `;
    resumed = true;
  });

  await logActivity({
    level: "info",
    action: verdict === "relevant" ? "Odpověď potvrzena jako relevantní" : "Zpráva vyhodnocena jako nesouvisející",
    detail:
      verdict === "relevant"
        ? `${reply.from_email} je tentýž člověk jako ${contact?.email ?? "kontakt"} — sekvence ukončena.`
        : `${reply.from_email} s ${contact?.email ?? "kontaktem"} nesouvisí — ` +
          (resumed ? "sekvence pokračuje podle původního harmonogramu." : "sekvence zůstává zastavená."),
    campaignId: contact?.campaign_id ?? null,
    contactId: reply.contact_id,
    campaignContactId: reply.campaign_contact_id,
  });

  return { ok: true, contactEmail: contact?.email, resumed };
}
