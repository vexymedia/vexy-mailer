import Link from "next/link";
import { notFound } from "next/navigation";
import { getConversation, listMessages, markConversationRead } from "@/lib/queries/inbox";
import { requireUser } from "@/lib/auth";
import { callerMaySeeConversation } from "@/lib/queries/clients";
import { PageHeader, DateTime, StatusBadge } from "@/components/ui";
import { ClassificationBadge } from "@/components/inbox-bits";
import { ClassificationPicker, DeleteConversationButton, ReplyComposer } from "@/components/conversation-actions";
import { CallButton } from "@/components/call/call-button";
import { isTwilioConfigured } from "@/lib/telephony/twilio";
import { callStatusLabel } from "@/lib/calling";
import { formatWhen } from "@/lib/datetime";

export const dynamic = "force-dynamic";

/**
 * Jedno e-mailové vlákno.
 *
 * Caller sem chodí z Oslovení („Zobrazit celou konverzaci“) pro kontext
 * před hovorem, takže vlákno číst musí. Odpovídat, měnit klasifikaci,
 * mazat ani vidět, ze které schránky se odesílá, ale nepotřebuje - to je
 * správa pošty a ta patří administrátorovi. Proto je pro něj stránka
 * jen ke čtení; není to jiná stránka, jen míň věcí na ní.
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const canManage = user.role === "admin";
  // Jestli jde volat z prohlížeče, ví server. Klient si to nevymýšlí.
  const browserCalling = isTwilioConfigured();

  // Caller vidí jen konverzace kontaktů ze svých kampaní. Odkaz na vlákno
  // dostane z pracovní karty, ale id se dá napsat i ručně - a cizí klient
  // mu do pošty nepatří. Stejná odpověď jako u neexistujícího vlákna:
  // z chyby se nesmí dát vyčíst, že existuje.
  if (!canManage && (!user.caller_id || !(await callerMaySeeConversation(user.caller_id, id)))) {
    notFound();
  }

  const conversation = await getConversation(id);
  if (!conversation) notFound();

  // Opening a conversation is what marks it read.
  if (canManage && conversation.unread_count > 0) await markConversationRead(id);
  const messages = await listMessages(id);
  // Odeslané vlákno a vlákno s odpovědí se chovají jinak vůči kadenci,
  // takže si nemůžou nést stejnou poznámku.
  const hasInbound = messages.some((message) => message.direction === "inbound");

  return (
    <>
      <PageHeader
        title={conversation.contact_name?.trim() || conversation.contact_email}
        description={
          <>
            {conversation.contact_email}
            {conversation.company ? ` · ${conversation.company}` : ""}
            {canManage ? (
              <>
                {conversation.campaign_name ? ` · ${conversation.campaign_name}` : " · bez kampaně"}
                {" · "}
                <span className="text-zinc-500">odesláno z {conversation.mailbox_email}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {canManage ? <ClassificationBadge value={conversation.classification} /> : null}
            {conversation.contact_status ? <StatusBadge status={conversation.contact_status} /> : null}
            {/* Vazba na CRM jen tam, kde skutečně existuje. Dohadovat firmu
                podle jména by dřív nebo později spojilo špatné dvě. */}
            {conversation.company_id ? (
              <Link href={`/firmy/${conversation.company_id}`} className="btn-secondary">
                Zobrazit firmu
              </Link>
            ) : null}
            <Link href={canManage ? "/inbox/schranka" : "/osloveni"} className="btn-secondary">
              {canManage ? "Zpět do schránky" : "Zpět do práce"}
            </Link>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          {messages.length === 0 ? (
            <p className="card px-6 py-10 text-center text-sm text-zinc-500">Zatím žádné zprávy.</p>
          ) : (
            messages.map((message) => {
              const outbound = message.direction === "outbound";
              return (
                <article
                  key={message.id}
                  className={`card p-5 ${outbound ? "border-l-4 border-l-zinc-900" : "border-l-4 border-l-emerald-500"}`}
                >
                  <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 pb-3">
                    <div className="text-sm">
                      <span className="font-medium text-zinc-900">{message.from_email}</span>
                      <span className="text-zinc-400"> → </span>
                      <span className="text-zinc-700">{message.to_email}</span>
                      {message.kind === "manual_reply" ? (
                        <span className="badge ml-2 bg-blue-50 text-blue-700 ring-blue-200">ruční odpověď</span>
                      ) : null}
                      {message.kind === "campaign" ? (
                        <span className="badge ml-2 bg-zinc-50 text-zinc-600 ring-zinc-200">kampaň</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-zinc-500"><DateTime value={message.occurred_at} /></div>
                  </header>
                  {message.subject ? (
                    <p className="mb-2 text-sm font-medium text-zinc-900">{message.subject}</p>
                  ) : null}
                  {/*
                    Rendered as plain text on purpose. Incoming HTML is stored but
                    never injected into the page, so a hostile reply cannot execute
                    anything in this browser.
                  */}
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-zinc-700">
                    {message.body_text?.trim() || <span className="text-zinc-400">(bez textového obsahu)</span>}
                  </pre>
                </article>
              );
            })
          )}

          {canManage ? (
            <ReplyComposer
              conversationId={id}
              fromEmail={conversation.mailbox_email}
              toEmail={conversation.contact_email}
              disabled={!conversation.mailbox_enabled}
            />
          ) : null}
        </div>

        <aside className="space-y-4">
          {canManage ? (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900">Stav</h2>
              <ClassificationPicker conversationId={id} value={conversation.classification} />
            </div>
          ) : null}
          <div className="card p-4 text-sm">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">Detaily</h2>
            <dl className="space-y-2 text-xs">
              <div><dt className="text-zinc-500">Kontakt</dt><dd className="text-zinc-900">{conversation.contact_email}</dd></div>
              {/* Telefon je tu schválně: na část odpovědí se líp reaguje
                  hovorem než dalším e-mailem, a přepínat se kvůli tomu na
                  jinou obrazovku je zbytečné. */}
              {conversation.phone ? (
                <div>
                  <dt className="text-zinc-500">Telefon</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums text-zinc-900">{conversation.phone}</span>
                    <CallButton
                      phone={conversation.phone}
                      contactId={conversation.contact_id}
                      campaignContactId={conversation.campaign_contact_id ?? undefined}
                      browserCalling={browserCalling}
                      className="btn-go !px-2 !py-1 text-xs"
                    >
                      Zavolat
                    </CallButton>
                  </dd>
                </div>
              ) : null}
              {conversation.call_status ? (
                <div>
                  <dt className="text-zinc-500">Stav volání</dt>
                  <dd className="text-zinc-900">
                    {callStatusLabel(conversation.call_status)}
                    {conversation.next_call_at ? (
                      <span className="text-zinc-500"> · {formatWhen(conversation.next_call_at)}</span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {conversation.company ? (
                <div><dt className="text-zinc-500">Firma</dt><dd className="text-zinc-900">{conversation.company}</dd></div>
              ) : null}
              {conversation.website ? (
                <div><dt className="text-zinc-500">Web</dt><dd className="text-zinc-900">{conversation.website}</dd></div>
              ) : null}
              {canManage ? (
                <div><dt className="text-zinc-500">Odesílací schránka</dt><dd className="text-zinc-900">{conversation.mailbox_email}</dd></div>
              ) : null}
              {canManage && conversation.campaign_name ? (
                <div>
                  <dt className="text-zinc-500">Kampaň</dt>
                  <dd>
                    <Link href={`/campaigns/${conversation.campaign_id}`} className="text-zinc-900 hover:underline">
                      {conversation.campaign_name}
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
          {canManage && hasInbound ? (
            <p className="px-1 text-xs text-zinc-500">
              Tento prospekt odpověděl, takže automatické follow-upy se zastavily. Odpověď odsud ho
              do sekvence nevrátí.
            </p>
          ) : canManage ? (
            <p className="px-1 text-xs text-zinc-500">
              Zatím jsme jen psali — prospekt neodpověděl. Kampaňová sekvence běží dál; ruční
              odpověď odsud ji nezastaví.
            </p>
          ) : null}

          {canManage ? (
            <div className="card p-4">
              <h2 className="mb-1 text-sm font-semibold text-zinc-900">Odebrat</h2>
              <p className="mb-3 text-xs text-zinc-500">
                Odstraní vlákno z doručené pošty. Historie odeslání a záznam kontaktu zůstávají.
              </p>
              <DeleteConversationButton conversationId={id} />
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
