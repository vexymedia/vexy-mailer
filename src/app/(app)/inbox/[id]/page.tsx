import Link from "next/link";
import { notFound } from "next/navigation";
import { getConversation, listMessages, markConversationRead } from "@/lib/queries/inbox";
import { PageHeader, DateTime, StatusBadge } from "@/components/ui";
import { ClassificationBadge } from "@/components/inbox-bits";
import { ClassificationPicker, DeleteConversationButton, ReplyComposer } from "@/components/conversation-actions";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) notFound();

  // Opening a conversation is what marks it read.
  if (conversation.unread_count > 0) await markConversationRead(id);
  const messages = await listMessages(id);

  return (
    <>
      <PageHeader
        title={conversation.contact_name?.trim() || conversation.contact_email}
        description={
          <>
            {conversation.contact_email}
            {conversation.company ? ` · ${conversation.company}` : ""}
            {conversation.campaign_name ? ` · ${conversation.campaign_name}` : " · no campaign"}
            {" · "}
            <span className="text-zinc-500">sent from {conversation.mailbox_email}</span>
          </>
        }
        actions={
          <>
            <ClassificationBadge value={conversation.classification} />
            {conversation.contact_status ? <StatusBadge status={conversation.contact_status} /> : null}
            <Link href="/inbox" className="btn-secondary">Back to inbox</Link>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          {messages.length === 0 ? (
            <p className="card px-6 py-10 text-center text-sm text-zinc-500">No messages yet.</p>
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
                        <span className="badge ml-2 bg-blue-50 text-blue-700 ring-blue-200">manual reply</span>
                      ) : null}
                      {message.kind === "campaign" ? (
                        <span className="badge ml-2 bg-zinc-50 text-zinc-600 ring-zinc-200">campaign</span>
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
                    {message.body_text?.trim() || <span className="text-zinc-400">(no text content)</span>}
                  </pre>
                </article>
              );
            })
          )}

          <ReplyComposer
            conversationId={id}
            fromEmail={conversation.mailbox_email}
            toEmail={conversation.contact_email}
            disabled={!conversation.mailbox_enabled}
          />
        </div>

        <aside className="space-y-4">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">Status</h2>
            <ClassificationPicker conversationId={id} value={conversation.classification} />
          </div>
          <div className="card p-4 text-sm">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">Details</h2>
            <dl className="space-y-2 text-xs">
              <div><dt className="text-zinc-500">Contact</dt><dd className="text-zinc-900">{conversation.contact_email}</dd></div>
              {conversation.company ? (
                <div><dt className="text-zinc-500">Company</dt><dd className="text-zinc-900">{conversation.company}</dd></div>
              ) : null}
              {conversation.website ? (
                <div><dt className="text-zinc-500">Website</dt><dd className="text-zinc-900">{conversation.website}</dd></div>
              ) : null}
              <div><dt className="text-zinc-500">Sender mailbox</dt><dd className="text-zinc-900">{conversation.mailbox_email}</dd></div>
              {conversation.campaign_name ? (
                <div>
                  <dt className="text-zinc-500">Campaign</dt>
                  <dd>
                    <Link href={`/campaigns/${conversation.campaign_id}`} className="text-zinc-900 hover:underline">
                      {conversation.campaign_name}
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
          <p className="px-1 text-xs text-zinc-500">
            This prospect has replied, so automated follow-ups have stopped. Answering here does not
            put them back into the sequence.
          </p>

          <div className="card p-4">
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">Remove</h2>
            <p className="mb-3 text-xs text-zinc-500">
              Clears this thread from the Inbox. Send history and contact records are kept.
            </p>
            <DeleteConversationButton conversationId={id} />
          </div>
        </aside>
      </div>
    </>
  );
}
