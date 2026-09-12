import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getCompanyTimeline, listCompanyContacts } from "@/lib/queries/companies";
import { listCallers } from "@/lib/queries/calling";
import { callOutcomeLabel, callStatusLabel } from "@/lib/calling";
import { plural } from "@/lib/plan";
import {
  PageHeader,
  DateTime,
  PriorityBadge,
  CompanyStatusBadge,
  StatusBadge,
} from "@/components/ui";
import { CompanyForm } from "@/components/company-form";

export const dynamic = "force-dynamic";

/**
 * Detail firmy odpovídá shora dolů na pět otázek: co je to za firmu, proč
 * ji řešíme, koho kontaktovat, co se už stalo a co udělat dál. Nejdůležitější
 * je nahoře; kontext, který se mění zřídka, je až pod tím.
 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await getCompany(id);
  if (!company) notFound();

  const [contacts, timeline, team] = await Promise.all([
    listCompanyContacts(id),
    getCompanyTimeline(id),
    listCallers({ activeOnly: true }),
  ]);

  const callable = contacts.find((c) => c.phone && c.campaign_contact_id);

  return (
    <>
      <PageHeader
        title={company.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <PriorityBadge value={company.priority} />
            <CompanyStatusBadge value={company.status} />
            {company.website ? <span className="text-zinc-500">{company.website}</span> : null}
            <span className="text-zinc-500">
              {plural(company.contacts_count, "kontakt", "kontakty", "kontaktů")}
            </span>
            {company.owner_name ? <span className="text-zinc-500">· {company.owner_name}</span> : null}
          </span>
        }
        actions={
          <>
            {company.main_contact_phone ? (
              <a href={`tel:${company.main_contact_phone.replace(/\s+/g, "")}`} className="btn-go">
                Zavolat {company.main_contact_phone}
              </a>
            ) : null}
            <Link href="/firmy" className="btn-secondary">Zpět na firmy</Link>
          </>
        }
      />

      {/* Proč ji řešíme a co je dál - to nejdůležitější hned nahoře. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-5 sm:col-span-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Proč ji řešíme</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
            {company.reason ?? <span className="text-zinc-400">Zatím nevyplněno — doplňte níže.</span>}
          </p>
          {company.qualification.length > 0 ? (
            <div className="mt-4 border-t border-zinc-100 pt-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Kritéria kampaně</h3>
              {company.qualification.map((text, index) => (
                <p key={index} className="mt-1.5 whitespace-pre-wrap text-xs text-zinc-600">{text}</p>
              ))}
            </div>
          ) : null}
        </div>
        <div className="card p-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Další krok</h2>
          <p className="mt-2 text-lg font-semibold text-zinc-900">
            {company.next_action_at ? <DateTime value={company.next_action_at} /> : "—"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Poslední aktivita: <DateTime value={company.last_activity_at} fallback="zatím žádná" />
          </p>
          {callable ? (
            <Link href="/osloveni" className="btn-secondary mt-4 w-full">
              Otevřít v oslovení
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section>
            <h2 className="section-title mb-3">Koho kontaktovat</h2>
            {contacts.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">
                U této firmy zatím není žádný kontakt.
              </p>
            ) : (
              <ul className="card divide-y divide-zinc-100">
                {contacts.map((contact) => (
                  <li key={contact.id} className="flex flex-wrap items-start gap-4 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {contact.email}
                        {contact.campaign_name ? ` · ${contact.campaign_name}` : ""}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {contact.call_status ? (
                          <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">
                            {callStatusLabel(contact.call_status)}
                            {contact.call_attempts ? ` · ${contact.call_attempts}×` : ""}
                          </span>
                        ) : null}
                        {contact.email_status ? <StatusBadge status={contact.email_status} /> : null}
                        {contact.suppressed ? (
                          <span className="badge bg-orange-50 text-orange-700 ring-orange-200">nekontaktovat</span>
                        ) : null}
                        {contact.do_not_call ? (
                          <span className="badge bg-orange-50 text-orange-700 ring-orange-200">nevolat</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {contact.phone ? (
                        <a
                          href={`tel:${contact.phone.replace(/\s+/g, "")}`}
                          className="text-sm text-zinc-900 hover:underline"
                        >
                          {contact.phone}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-400">bez telefonu</span>
                      )}
                      {contact.campaign_contact_id ? (
                        <Link href={`/kontakt/${contact.campaign_contact_id}`} className="btn-secondary !px-2 !py-1 text-xs">
                          Historie
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="section-title mb-3">Co se stalo</h2>
            {timeline.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">
                S touto firmou jsme zatím nekomunikovali.
              </p>
            ) : (
              <ol className="space-y-2">
                {timeline.map((entry) => (
                  <li
                    key={`${entry.kind}-${entry.id}`}
                    className={`card border-l-4 p-4 ${
                      entry.kind === "call"
                        ? "border-l-sky-500"
                        : entry.kind === "reply"
                          ? "border-l-emerald-500"
                          : "border-l-zinc-300"
                    }`}
                  >
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900">
                        {entry.kind === "call" ? "Hovor" : entry.kind === "reply" ? "Odpověď" : "E-mail"}
                        <span className="ml-2 font-normal text-zinc-700">
                          {entry.kind === "call" ? callOutcomeLabel(entry.title) : entry.title}
                        </span>
                      </span>
                      <span className="text-xs text-zinc-500"><DateTime value={entry.occurred_at} /></span>
                    </div>
                    {entry.detail ? <p className="text-xs text-zinc-500">{entry.detail}</p> : null}
                    {entry.note ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{entry.note}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside>
          <h2 className="section-title mb-3">Kontext firmy</h2>
          <CompanyForm
            companyId={company.id}
            reason={company.reason ?? ""}
            priority={company.priority}
            status={company.status}
            ownerId={company.owner_id ?? ""}
            note={company.note ?? ""}
            team={team.map((c) => ({ id: c.id, name: c.name }))}
          />
        </aside>
      </div>
    </>
  );
}
