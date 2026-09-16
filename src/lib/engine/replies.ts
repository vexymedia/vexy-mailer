import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { env } from "../env";
import { logActivity } from "../activity";
import { classifyImapError, fetchNewMessages, hasImapConfigured, type InboxMessage } from "../imap";
import { withLock } from "./locks";
import type { Mailbox } from "../types";
import { recordInboundMessage } from "../queries/inbox";
import { classifyInbound, parseReturnDate } from "../inbound";
import { recordBounce } from "../queries/deliverability";

/**
 * Reply detection.
 *
 * Matching is attempted in two passes, strongest signal first:
 *
 *   1. In-Reply-To against the Message-ID we minted for a specific send. This
 *      is exact: it identifies the campaign, the contact and the step.
 *   2. The sender's address against our contacts. Less precise but catches
 *      clients that drop threading headers, forwarded replies and replies sent
 *      from an alias-free "reply all".
 *
 * Co se s nálezem stane, ale záleží na tom, CO přišlo. Dřív se každá
 * příchozí zpráva zpracovala jako lidská odpověď - takže "jsem do 15. 8.
 * mimo kancelář" natrvalo ukončilo sekvenci a postmaster s bouncem seděl
 * v sales inboxu vedle skutečných odpovědí. Klasifikace je v
 * `src/lib/inbound.ts`, tady se z ní jen vyvozují důsledky:
 *
 *   human       → kontakt označen replied, sekvence končí, do inboxu
 *   unsubscribe → totéž + globální suppression
 *   ooo         → sekvence se ODLOŽÍ, nekončí; mimo "K vyřízení"
 *   bounce      → zpracuje se jako nedoručení, do inboxu vůbec nejde
 *   auto        → uloží se do vlákna, sekvencí ani inboxem nehne
 */

const REPLY_LOCK_TTL_MS = 120_000;

export interface ReplyPollSummary {
  ranAt: string;
  locked?: boolean;
  mailboxes: {
    mailboxId: string;
    name: string;
    scanned: number;
    matched: number;
    error?: string;
  }[];
}

interface MatchTarget {
  campaign_contact_id: string;
  contact_id: string;
  campaign_id: string;
  send_id: string | null;
  /** E-mail prospekta, na kterého jsme psali. Kvůli kontrole odesílatele. */
  contact_email: string;
}

/**
 * Napsal tu odpověď opravdu ten, komu jsme psali?
 *
 * Spárování přes References je silný signál o VLÁKNU, ne o ČLOVĚKU:
 * když prospekt náš e-mail přepošle kolegovi a odpoví kolega, nese jeho
 * zpráva pořád naše Message-ID. Bez téhle kontroly by se prospekt označil
 * za toho, kdo odpověděl, a jeho sekvence by se zastavila kvůli zprávě,
 * kterou nenapsal.
 *
 * Shoda na doméně se bere jako tentýž člověk. Odpovědi z aliasu
 * (`j.novak@` místo `jan.novak@`) jsou běžné a psát dál někomu, kdo nám
 * právě odpověděl, je horší chyba než opačný omyl.
 *
 * Cizí doména = nevíme. Zpráva se uloží a označí ke kontrole, ale
 * sekvenci nezastaví.
 */
function isSameCorrespondent(from: string | null, contactEmail: string): boolean {
  if (!from) return false;
  const sender = from.trim().toLowerCase();
  const contact = contactEmail.trim().toLowerCase();
  if (sender === contact) return true;
  const senderDomain = sender.split("@")[1];
  const contactDomain = contact.split("@")[1];
  return Boolean(senderDomain && contactDomain && senderDomain === contactDomain);
}

/**
 * Pass 1: the reply quotes a Message-ID we generated.
 *
 * Both In-Reply-To and the whole References chain are considered. Some clients
 * drop In-Reply-To but keep References, and a reply several messages deep in a
 * thread points at the most recent message rather than the first.
 */
async function matchByThread(message: InboxMessage): Promise<MatchTarget | null> {
  const raw = [message.inReplyTo, ...(message.references ?? "").split(/\s+/)].filter(Boolean) as string[];
  if (raw.length === 0) return null;

  // Normalise: some clients strip the angle brackets, some keep them.
  const candidates = [...new Set(raw.flatMap((id) => [id, `<${id.replace(/^<|>$/g, "")}>`]))];
  const [row] = await sql<MatchTarget[]>`
    select es.campaign_contact_id, es.campaign_id, es.id as send_id, cc.contact_id,
           c.email as contact_email
      from email_sends es
      join campaign_contacts cc on cc.id = es.campaign_contact_id
      join contacts c on c.id = cc.contact_id
     where es.message_id = any(${candidates})
     order by es.sent_at desc nulls last
     limit 1
  `;
  return row ?? null;
}

/**
 * Pass 2: the sender is a contact we have already written to from this mailbox.
 *
 * The link is the contact's sticky sender - the mailbox that actually sent
 * their emails - rather than anything on the campaign, because a campaign now
 * has a pool and its legacy single-mailbox column is no longer authoritative.
 * A send from this mailbox is accepted as evidence too, which covers rows that
 * predate sticky assignment.
 */
async function matchBySender(message: InboxMessage, mailboxId: string): Promise<MatchTarget | null> {
  if (!message.from) return null;
  const [row] = await sql<MatchTarget[]>`
    select cc.id as campaign_contact_id, cc.contact_id, cc.campaign_id, null::uuid as send_id,
           c.email as contact_email
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
     where c.email = ${message.from}
       and (
         cc.sender_mailbox_id = ${mailboxId}
         or exists (
           select 1 from email_sends es
            where es.campaign_contact_id = cc.id
              and es.mailbox_id = ${mailboxId}
              and es.status in ('sent', 'unknown')
         )
       )
       and exists (
         select 1 from email_sends es
          where es.campaign_contact_id = cc.id and es.status in ('sent', 'unknown')
       )
     order by cc.updated_at desc
     limit 1
  `;
  return row ?? null;
}

async function findContactId(email: string | null): Promise<string | null> {
  if (!email) return null;
  const [row] = await sql<{ id: string }[]>`select id from contacts where email = ${email}`;
  return row?.id ?? null;
}

async function processMailbox(mailbox: Mailbox): Promise<ReplyPollSummary["mailboxes"][number]> {
  const base = { mailboxId: mailbox.id, name: mailbox.name };
  try {
    const lastUid = mailbox.imap_last_uid != null ? Number(mailbox.imap_last_uid) : null;
    const { messages, uidNext, uidValidity } = await fetchNewMessages(mailbox, lastUid);

    let matched = 0;
    let highestUid = lastUid ?? 0;

    for (const message of messages) {
      highestUid = Math.max(highestUid, message.uid);

      // Ignore our own mail: sent copies, and any bounce addressed from us.
      if (message.from && message.from === mailbox.from_email) continue;
      if (!message.messageId) continue;

      const target = (await matchByThread(message)) ?? (await matchBySender(message, mailbox.id));
      const contactId = target?.contact_id ?? (await findContactId(message.from));

      // CO to je. Tohle rozhoduje o všem, co následuje.
      const verdict = classifyInbound({
        from: message.from,
        subject: message.subject,
        bodyText: message.bodyText,
        headers: message.headers,
        contentType: message.contentType,
      });

      // Spárováno na vlákno, ale psal to někdo jiný? Viz isSameCorrespondent.
      const fromStranger =
        target !== null && !isSameCorrespondent(message.from, target.contact_email);

      // Record the reply first. The unique (mailbox_id, imap_message_id) index
      // makes re-processing the same physical message a no-op.
      const inserted = await sql<{ id: string }[]>`
        insert into replies (mailbox_id, contact_id, campaign_contact_id, matched_send_id,
                             from_email, subject, imap_message_id, in_reply_to, imap_uid,
                             received_at, needs_review)
        values (${mailbox.id}, ${contactId}, ${target?.campaign_contact_id ?? null},
                ${target?.send_id ?? null}, ${message.from ?? "unknown"}, ${message.subject},
                ${message.messageId}, ${message.inReplyTo}, ${message.uid}, ${message.receivedAt},
                ${fromStranger && verdict.class !== "bounce"})
        on conflict (mailbox_id, imap_message_id) do nothing
        returning id
      `;
      if (inserted.length === 0) continue; // already seen

      // ------------------------------------------------------------ bounce
      //
      // Hlášení od poštovního serveru není konverzace. Nezakládá vlákno,
      // neobjeví se v sales inboxu a rozhodně neoznačí kontakt za toho,
      // kdo odpověděl. Jde do deliverability, kde se z něj dá něco
      // vyvodit o naší doméně.
      if (verdict.class === "bounce") {
        await recordBounce({
          mailboxId: mailbox.id,
          contactId,
          campaignContactId: target?.campaign_contact_id ?? null,
          subject: message.subject,
          bodyText: message.bodyText,
          headers: message.headers ?? {},
          fromEmail: mailbox.from_email,
          receivedAt: message.receivedAt,
        });
        continue;
      }

      // Persist into the unified inbox. Only possible when we know who wrote:
      // a conversation is keyed on (mailbox, contact).
      if (contactId) {
        await recordInboundMessage({
          mailboxId: mailbox.id,
          contactId,
          campaignId: target?.campaign_id ?? null,
          campaignContactId: target?.campaign_contact_id ?? null,
          fromEmail: message.from ?? "unknown",
          toEmail: message.to ?? mailbox.from_email,
          subject: message.subject,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          messageId: message.messageId,
          inReplyTo: message.inReplyTo,
          references: message.references,
          replyId: inserted[0].id,
          receivedAt: message.receivedAt,
          messageClass: verdict.class,
        });
      }

      if (!target) continue; // a reply from someone who is not in a campaign

      // ---------------------------------------- odpověď od jiné adresy
      //
      // Prospekt sám nic nenapsal, takže se za toho, kdo odpověděl,
      // NEOZNAČÍ - to by ho utnulo kvůli cizí zprávě. Sekvence se ale
      // ani nenechá běžet dál: kdyby to přece jen byl on z jiné adresy
      // (Gmail, jiná firemní doména), přišel by mu za hodinu další cold
      // e-mail hodinu poté, co odpověděl.
      //
      // Kroky se proto POZASTAVÍ a jejich termín se uschová. Rozhodne
      // člověk v Komunikaci → K vyřízení; do té doby se nic neodešle.
      if (fromStranger) {
        // Sekvence se POZASTAVÍ, dokud to někdo neposoudí.
        //
        // Nejde bezpečně určit, jestli píše prospekt z jiné adresy, nebo
        // někdo cizí. Obě unáhlené odpovědi jsou špatně: označit ho za
        // odpověděvšího by ho utnulo kvůli cizí zprávě, nechat sekvenci
        // běžet by mu poslalo cold e-mail hodinu poté, co nám odpověděl.
        //
        // Pozastavuje se JEN ten kontakt, na který se vlákno spárovalo -
        // ne všechny kontakty klienta. Kandidáta určuje thread, ne doména
        // odesílatele, takže dopad je přesně jeden enrollment.
        //
        // `coalesce` na uschovaném termínu: druhá cizí zpráva do téhož
        // vlákna nesmí přepsat uschovanou hodnotu nulou, kterou tam
        // nechala ta první.
        await sql`
          update campaign_contacts
             set paused_next_send_at = coalesce(paused_next_send_at, next_send_at),
                 next_send_at = null,
                 updated_at = now()
           where id = ${target.campaign_contact_id}
             and status in ('scheduled', 'sent')
        `;
        await logActivity({
          level: "warn",
          action: "Odpověď od jiné adresy",
          detail:
            `${message.from} odpověděl na vlákno s ${target.contact_email}. ` +
            "Další kroky jsou pozastavené, dokud zprávu někdo neposoudí.",
          campaignId: target.campaign_id,
          contactId: target.contact_id,
          campaignContactId: target.campaign_contact_id,
        });
        continue;
      }

      // --------------------------------------------------- mimo kancelář
      //
      // Není to odpověď a není to konec. Sekvence se ODLOŽÍ - na datum
      // návratu, když ho zpráva uvádí, jinak o bezpečný týden. Ukončit ji
      // kvůli automatické odpovědi znamená ztratit lead, který o nás
      // zatím vůbec nerozhodl.
      if (verdict.class === "ooo") {
        const returnDate = parseReturnDate(message.bodyText, message.receivedAt);
        const resumeAt = returnDate && returnDate.getTime() > message.receivedAt.getTime()
          ? new Date(returnDate.getTime() + 86_400_000)
          : new Date(message.receivedAt.getTime() + 7 * 86_400_000);
        await sql`
          update campaign_contacts
             set next_send_at = greatest(next_send_at, ${resumeAt}), updated_at = now()
           where id = ${target.campaign_contact_id}
             and status in ('scheduled', 'sent')
        `;
        await logActivity({
          action: "Automatická odpověď o nepřítomnosti",
          detail: `${message.from}: sekvence odložena na ${resumeAt.toISOString().slice(0, 10)}` +
                  (returnDate ? " (datum návratu ze zprávy)" : " (datum návratu nebylo uvedeno)"),
          campaignId: target.campaign_id,
          contactId: target.contact_id,
          campaignContactId: target.campaign_contact_id,
        });
        continue;
      }

      // ----------------------------------------------- automatická zpráva
      //
      // Potvrzení z ticketovacího systému, notifikace, no-reply. Uloží se
      // do vlákna kvůli historii, ale nic nespouští.
      if (verdict.class === "auto") continue;

      // ------------------------------------------------------- odhlášení
      if (verdict.class === "unsubscribe" && message.from) {
        const { suppressEmail } = await import("../queries/contacts");
        await suppressEmail(message.from, "unsubscribe", "Vyžádáno v odpovědi na e-mail.", {
          reasonCode: "unsubscribe",
          source: "reply",
        });
      }

      // ---------------------------------------------------- lidská odpověď
      //
      // Immediate removal from the sequence: next_send_at is cleared, so the
      // dispatcher's candidate query can never pick this contact up again.
      //
      // Dosah je KLIENT, ne jeden konkrétní běh a ne celá databáze.
      //
      // Uvnitř klienta se zastaví všechny jeho kampaně: kdo odpověděl, nesmí
      // od téhož odesílatele dostat za dva dny cold e-mail z jiné sekvence.
      //
      // Přes klienty se ale nesahá. VEXY dělá managed outbound pro víc
      // klientů naráz a tentýž člověk se běžně objeví u dvou z nich - každý
      // s jinou nabídkou a jiným odesílatelem. Odpověď patří tomu klientovi,
      // kterému člověk odpověděl; ukončit tím kampaň druhého klienta by
      // znamenalo tiše mu sebrat práci, kterou si zaplatil, a on by se o tom
      // nedozvěděl.
      //
      // `is not distinct from` kvůli kampaním bez klienta: NULL se páruje
      // s NULL, ne s konkrétním klientem.
      const updated = await sql<{ id: string }[]>`
        update campaign_contacts cc
           set status = 'replied', replied_at = now(), next_send_at = null, updated_at = now()
          from campaigns cp
         where cc.campaign_id = cp.id
           and cc.contact_id = ${target.contact_id}
           and cc.status in ('pending', 'scheduled', 'sent', 'failed')
           and cp.client_id is not distinct from (
                 select owner.client_id
                   from campaign_contacts matched
                   join campaigns owner on owner.id = matched.campaign_id
                  where matched.id = ${target.campaign_contact_id})
        returning cc.id
      `;
      if (updated.length > 0) {
        matched++;
        await logActivity({
          action: "Rozpoznána odpověď",
          detail: `${message.from} replied${message.subject ? `: "${message.subject}"` : ""}. Removed from the sequence.`,
          campaignId: target.campaign_id,
          contactId: target.contact_id,
          campaignContactId: target.campaign_contact_id,
        });
      }
    }

    await sql`
      update mailboxes
         set imap_last_uid = ${Math.max(highestUid, uidNext - 1)},
             imap_uidvalidity = ${uidValidity},
             imap_last_checked_at = now(),
             imap_last_error = null,
             updated_at = now()
       where id = ${mailbox.id}
    `;

    return { ...base, scanned: messages.length, matched };
  } catch (error) {
    // Same classifier as the manual test, so a scheduled failure is as
    // readable as a hand-run one instead of a bare "Command failed".
    const detail = classifyImapError(error).message;
    await sql`
      update mailboxes
         set imap_last_checked_at = now(), imap_last_error = ${detail.slice(0, 1000)}, updated_at = now()
       where id = ${mailbox.id}
    `;
    await logActivity({
      level: "error",
      action: "Chyba IMAP",
      detail: `${mailbox.name}: ${detail}`,
    });
    return { ...base, scanned: 0, matched: 0, error: detail };
  }
}

/**
 * Polls every configured mailbox whose last check is older than the interval.
 * Rate-limiting per mailbox rather than globally means one slow inbox does not
 * starve the others.
 */
export async function pollReplies(force = false): Promise<ReplyPollSummary> {
  const holder = randomUUID();
  const result = await withLock("replies", REPLY_LOCK_TTL_MS, holder, async () => {
    const mailboxes = await sql<Mailbox[]>`
      select * from mailboxes
       where imap_host is not null
         and (${force} or imap_last_checked_at is null
              or imap_last_checked_at < now() - ${`${Math.ceil(env.replyPollIntervalMs / 1000)} seconds`}::interval)
    `;
    const results: ReplyPollSummary["mailboxes"] = [];
    for (const mailbox of mailboxes) {
      if (!hasImapConfigured(mailbox)) continue;
      results.push(await processMailbox(mailbox));
    }
    return results;
  });

  if ("skipped" in result) {
    return { ranAt: new Date().toISOString(), locked: true, mailboxes: [] };
  }
  return { ranAt: new Date().toISOString(), mailboxes: result };
}
