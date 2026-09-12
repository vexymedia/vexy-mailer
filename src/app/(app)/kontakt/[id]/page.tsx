import Link from "next/link";
import { notFound } from "next/navigation";
import { getCallContact, getContactTimeline } from "@/lib/queries/calling";
import { MEETING_OUTCOME_LABELS, callOutcomeLabel, callStatusLabel, formatCzk } from "@/lib/calling";
import { PageHeader, Stat, StatusBadge, DateTime } from "@/components/ui";
import { MeetingActions } from "@/components/meeting-actions";

export const dynamic = "force-dynamic";

/**
 * One prospect's whole history in one campaign: every call and every e-mail in
 * a single list, plus the follow-up actions on a booked meeting.
 */
export default async function ContactTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contact = await getCallContact(id);
  if (!contact) notFound();
  const timeline = await getContactTimeline(id);

  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email;

  return (
    <>
      <PageHeader
        title={name}
        description={
          <>
            {contact.company ?? "—"} · {contact.email}
            {contact.phone ? ` · ${contact.phone}` : ""} ·{" "}
            <Link href={`/campaigns/${contact.campaign_id}?tab=volani`} className="underline">
              {contact.campaign_name}
            </Link>
          </>
        }
        actions={
          contact.phone ? (
            <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="btn-go">
              VOLAT {contact.phone}
            </a>
          ) : null
        }
      />

      <div className="card mb-6 grid grid-cols-2 gap-6 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Stav volání" value={<span className="text-base">{callStatusLabel(contact.call_status)}</span>} />
        <Stat label="Pokusy" value={`${contact.call_attempts} / ${contact.max_call_attempts}`} />
        <Stat label="Dovolané hovory" value={contact.connected_calls} />
        <Stat
          label="Poslední výsledek"
          value={<span className="text-base">{callOutcomeLabel(contact.last_call_outcome)}</span>}
        />
        <Stat label="Další akce" value={<span className="text-base"><DateTime value={contact.next_call_at} /></span>} />
        <Stat label="Stav e-mailu" value={<StatusBadge status={contact.email_status} />} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          {timeline.length === 0 ? (
            <p className="card px-6 py-10 text-center text-sm text-zinc-500">Zatím se nic nestalo.</p>
          ) : (
            timeline.map((entry) => (
              <article
                key={`${entry.kind}-${entry.id}`}
                className={`card border-l-4 p-4 ${
                  entry.kind === "call"
                    ? "border-l-sky-500"
                    : entry.kind === "reply"
                      ? "border-l-emerald-500"
                      : "border-l-zinc-300"
                }`}
              >
                <header className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-900">
                    {entry.kind === "call" ? "Hovor" : entry.kind === "reply" ? "Odpověď" : "E-mail"}
                    <span className="ml-2 font-normal text-zinc-700">
                      {entry.kind === "call" ? callOutcomeLabel(entry.title) : entry.title}
                    </span>
                  </span>
                  <span className="text-xs text-zinc-500"><DateTime value={entry.occurred_at} /></span>
                </header>
                {entry.detail ? <p className="text-xs text-zinc-500">{entry.detail}</p> : null}
                {entry.note ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{entry.note}</p>
                ) : null}
              </article>
            ))
          )}
        </div>

        <aside className="space-y-4">
          {contact.meeting_booked ? (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900">Schůzka</h2>
              <dl className="mb-4 space-y-2 text-xs">
                <div>
                  <dt className="text-zinc-500">Termín</dt>
                  <dd className="text-zinc-900"><DateTime value={contact.meeting_at} /></dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Kvalifikace</dt>
                  <dd className="text-zinc-900">
                    {contact.meeting_qualified === null
                      ? "zatím neposouzeno"
                      : contact.meeting_qualified
                        ? "kvalifikovaná"
                        : "nekvalifikovaná"}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Stav</dt>
                  <dd className="text-zinc-900">{MEETING_OUTCOME_LABELS[contact.meeting_outcome]}</dd>
                </div>
                {contact.deal_value !== null ? (
                  <div>
                    <dt className="text-zinc-500">Hodnota obchodu</dt>
                    <dd className="text-zinc-900">{formatCzk(contact.deal_value)}</dd>
                  </div>
                ) : null}
              </dl>
              {contact.qualification_criteria ? (
                <p className="mb-3 whitespace-pre-wrap rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                  {contact.qualification_criteria}
                </p>
              ) : null}
              <MeetingActions
                campaignContactId={contact.id}
                qualified={contact.meeting_qualified}
                outcome={contact.meeting_outcome}
              />
            </div>
          ) : (
            <p className="card px-4 py-6 text-center text-xs text-zinc-500">
              Schůzka zatím není domluvená. Domlouvá se zápisem výsledku hovoru ve workspace callera.
            </p>
          )}

          <div className="card p-4 text-xs">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">Přiřazení</h2>
            <p className="text-zinc-600">
              Caller: <span className="text-zinc-900">{contact.assigned_caller_name ?? "nepřiřazeno"}</span>
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
