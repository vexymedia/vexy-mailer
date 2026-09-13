import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getCompanyTimeline, listCompanyContacts } from "@/lib/queries/companies";
import { getCompanyNextStep, listCallers } from "@/lib/queries/calling";
import { callOutcomeLabel, callStatusLabel } from "@/lib/calling";
import { formatWhen, isOverdue } from "@/lib/datetime";
import { plural } from "@/lib/plan";
import {
  PageHeader,
  DateTime,
  PriorityBadge,
  CompanyStatusBadge,
  StatusBadge,
} from "@/components/ui";
import { CompanyForm } from "@/components/company-form";
import { ScheduleNextStep } from "@/components/next-step-block";
import { CallButton } from "@/components/call/call-button";
import { isTwilioConfigured } from "@/lib/telephony/twilio";
import { listCallsForCompany } from "@/lib/queries/calls";
import { CallHistory } from "@/components/call/call-history";
import { ContactFormToggle } from "@/components/contact-form";

export const dynamic = "force-dynamic";

/**
 * Detail firmy jako pracovní pult. Shora dolů odpovídá na pět otázek:
 * co je to za firmu, proč ji řešíme, co je další krok, koho kontaktovat
 * a co se už stalo. Kontext, který se mění zřídka, je v pravém panelu.
 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await getCompany(id);
  if (!company) notFound();

  const [contacts, timeline, team, nextStep, callRecords] = await Promise.all([
    listCompanyContacts(id),
    getCompanyTimeline(id),
    listCallers({ activeOnly: true }),
    getCompanyNextStep(id),
    listCallsForCompany(id, 20),
  ]);
  // Jestli jde volat z prohlížeče, ví server. Klient si to nevymýšlí.
  const browserCalling = isTwilioConfigured();

  // Primární CTA jen tam, kde volání skutečně dává smysl. Zavádějící
  // "Zavolat" u člověka na do-not-call listu je horší než žádné tlačítko.
  //
  // Vytočit ale jde každý kontakt s číslem, který není na seznamu
  // „nevolat“ - kampaň rozhoduje jen o tom, jestli hovor posune i
  // e-mailovou kadenci a jestli má smysl otevírat frontu. Kdyby se hlavička
  // ptala na `callable`, chyběla by u firmy mimo kampaň, zatímco tlačítko
  // u kontaktu o řádek níž by bylo aktivní.
  const queued = contacts.find((c) => c.callable && c.phone);
  const dialable = queued ?? contacts.find((c) => c.phone && !c.do_not_call);
  const openContacts = contacts
    .filter((c) => c.campaign_contact_id && !c.do_not_call && c.call_status &&
                   !["meeting_booked", "won", "lost", "do_not_call", "max_attempts"].includes(c.call_status))
    .map((c) => ({
      id: c.campaign_contact_id as string,
      label: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email,
    }));

  return (
    <>
      <PageHeader
        title={company.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <PriorityBadge value={company.priority} />
            <CompanyStatusBadge value={company.status} />
            <span className="text-zinc-500">
              {plural(company.contacts_count, "kontakt", "kontakty", "kontaktů")}
            </span>
            <span className="text-zinc-500">
              {company.attempts === 0
                ? "zatím bez pokusu"
                : plural(company.attempts, "pokus", "pokusy", "pokusů")}
            </span>
            {company.website ? <span className="text-zinc-500">{company.website}</span> : null}
            {company.owner_name ? <span className="text-zinc-500">· {company.owner_name}</span> : null}
          </span>
        }
        actions={
          <>
            {dialable?.phone ? (
              <CallButton
                phone={dialable.phone}
                contactId={dialable.id}
                campaignContactId={dialable.campaign_contact_id ?? undefined}
                browserCalling={browserCalling}
              />
            ) : null}
            {queued ? (
              <Link href="/osloveni" className="btn-secondary">Otevřít v oslovení</Link>
            ) : null}
            <Link href="/firmy" className="btn-secondary">Zpět na firmy</Link>
          </>
        }
      />

      {/* Proč ji řešíme a co je dál - to nejdůležitější hned nahoře. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-5 sm:col-span-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Proč ji řešíme</h2>
          <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-zinc-900">
            {company.reason ?? (
              <span className="text-zinc-400">Zatím nevyplněno — doplňte v pravém panelu.</span>
            )}
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

        <div className={`card p-5 ${company.needs_attention ? "border-amber-300 bg-amber-50/60" : ""}`}>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Další krok</h2>
          {nextStep ? (
            <>
              <p className="mt-2 text-base font-semibold text-zinc-900">
                {nextStep.kind === "meeting" ? "Schůzka" : "Zavolat"}
              </p>
              <p
                className={`text-sm font-medium tabular-nums ${
                  isOverdue(nextStep.at) ? "text-red-600" : "text-zinc-900"
                }`}
              >
                {formatWhen(nextStep.at)}
              </p>
              <p className="text-sm text-zinc-600">{nextStep.contactName}</p>
            </>
          ) : company.needs_attention ? (
            <>
              <p className="mt-2 text-base font-semibold text-amber-800">⚠ Bez dalšího kroku</p>
              <p className="mt-1 text-xs text-amber-800">
                Firmu stále řešíme, ale nikdo nemá naplánováno, co se stane dál.
              </p>
              <ScheduleNextStep contacts={openContacts} hasCallableContact={Boolean(dialable)} />
            </>
          ) : (
            <p className="mt-2 text-base font-semibold text-zinc-500">Uzavřeno — nic dalšího neplánujeme</p>
          )}
          <p className="mt-3 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
            Poslední aktivita: <DateTime value={company.last_activity_at} fallback="zatím žádná" />
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Koho kontaktovat</h2>
              <ContactFormToggle
                companyId={company.id}
                label="Přidat kontakt"
                className="btn-secondary"
              />
            </div>
            {contacts.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">
                U této firmy zatím není žádný kontakt. Přidejte ho tlačítkem nahoře.
              </p>
            ) : (
              <ul className="card divide-y divide-zinc-100">
                {contacts.map((contact, index) => {
                  const name =
                    [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email;
                  const blocked = contact.do_not_call || !contact.phone;
                  return (
                    <li key={contact.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-900">{name}</p>
                          {contact.position ? (
                            <p className="truncate text-xs text-zinc-600">{contact.position}</p>
                          ) : null}
                          <p className="mt-1 text-sm tabular-nums text-zinc-800">
                            {contact.phone ?? <span className="text-zinc-400">bez telefonu</span>}
                          </p>
                          <p className="truncate text-xs text-zinc-500">{contact.email}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <CallButton
                            phone={contact.phone}
                            contactId={contact.id}
                            campaignContactId={contact.campaign_contact_id ?? undefined}
                            browserCalling={browserCalling}
                            disabled={contact.do_not_call || !contact.phone}
                            disabledReason={
                              contact.do_not_call
                                ? "Tento člověk je na seznamu „nevolat“."
                                : "Kontakt nemá telefonní číslo."
                            }
                            className="btn-go !py-1.5 text-sm"
                          >
                            Zavolat
                          </CallButton>
                          {contact.suppressed ? (
                            <span className="btn !py-1.5 cursor-not-allowed border border-zinc-200 bg-zinc-100 text-sm text-zinc-400">
                              E-mail
                            </span>
                          ) : (
                            <a href={`mailto:${contact.email}`} className="btn-secondary !py-1.5 text-sm">
                              E-mail
                            </a>
                          )}
                          {contact.campaign_contact_id ? (
                            <Link
                              href={`/kontakt/${contact.campaign_contact_id}`}
                              className="btn-secondary !py-1.5 text-sm"
                            >
                              Historie
                            </Link>
                          ) : null}
                          <ContactFormToggle
                            companyId={company.id}
                            className="btn-secondary !py-1.5 text-sm"
                            label="Upravit"
                            contact={{
                              id: contact.id,
                              firstName: contact.first_name,
                              lastName: contact.last_name,
                              position: contact.position,
                              email: contact.email,
                              phone: contact.phone,
                              isPrimary: contact.is_primary,
                            }}
                          />
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {contact.is_primary || index === 0 ? (
                          <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">hlavní kontakt</span>
                        ) : null}
                        {contact.call_status ? (
                          <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">
                            {callStatusLabel(contact.call_status)}
                            {contact.call_attempts ? ` · ${contact.call_attempts}×` : ""}
                          </span>
                        ) : null}
                        {contact.last_call_outcome ? (
                          <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">
                            {callOutcomeLabel(contact.last_call_outcome)}
                          </span>
                        ) : null}
                        {contact.email_status ? <StatusBadge status={contact.email_status} /> : null}
                        {contact.suppressed ? (
                          <span className="badge bg-orange-50 text-orange-700 ring-orange-200">
                            odhlášen z e-mailů
                          </span>
                        ) : null}
                        {contact.do_not_call ? (
                          <span className="badge bg-orange-50 text-orange-700 ring-orange-200">nevolat</span>
                        ) : null}
                        {contact.campaign_name ? (
                          <span className="text-xs text-zinc-400">{contact.campaign_name}</span>
                        ) : null}
                      </div>

                      {blocked && contact.do_not_call ? (
                        <p className="mt-2 rounded-md bg-orange-50 px-3 py-1.5 text-xs text-orange-800">
                          Tento člověk je na seznamu „nevolat“. Volat mu nelze a nedostane se do fronty.
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <CallHistory calls={callRecords} />

          <section>
            <h2 className="section-title mb-3">Co se stalo</h2>
            {timeline.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">
                {/* Hovor bez zapsaného výsledku žádnou aktivitu nezaloží. Tvrdit
                    pod seznamem telefonátů, že jsme nekomunikovali, by ale byl
                    zjevný nesmysl - ta věta platí jen tehdy, když opravdu nic
                    nebylo. */}
                {callRecords.length > 0
                  ? "Telefonáty jsou výše, ale žádný z nich nemá zapsaný výsledek. Dopište ho v Oslovení > Dnes."
                  : "S touto firmou jsme zatím nekomunikovali."}
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
