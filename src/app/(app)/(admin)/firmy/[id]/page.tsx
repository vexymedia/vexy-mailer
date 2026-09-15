import { requireUuid } from "@/lib/route-params";
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
import { ActivityTimeline } from "@/components/activity-timeline";
import { requireUser } from "@/lib/auth";
import { OutreachForm } from "@/components/outreach-form";
import { CompanyExclusions } from "@/components/company-exclusions";
import { listClientExclusions } from "@/lib/queries/suppression";
import { listClients } from "@/lib/queries/clients";

export const dynamic = "force-dynamic";

/**
 * Detail firmy jako pracovní pult. Shora dolů odpovídá na pět otázek:
 * co je to za firmu, proč ji řešíme, co je další krok, koho kontaktovat
 * a co se už stalo. Kontext, který se mění zřídka, je v pravém panelu.
 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Nesmyslné id z adresy je 404, ne pád na chybě typu v Postgresu.
  requireUuid(id);
  const company = await getCompany(id);
  if (!company) notFound();

  const [user, contacts, timeline, team, nextStep, callRecords, exclusions, clients] =
    await Promise.all([
      requireUser(),
      listCompanyContacts(id),
      getCompanyTimeline(id),
      listCallers({ activeOnly: true }),
      getCompanyNextStep(id),
      listCallsForCompany(id, 20),
      listClientExclusions({ companyId: id }),
      listClients(),
    ]);
  // Jestli jde volat z prohlížeče, ví server. Klient si to nevymýšlí.
  const browserCalling = isTwilioConfigured();
  const isAdmin = user.role === "admin";

  // Primární CTA jen tam, kde volání skutečně dává smysl. Zavádějící
  // "Zavolat" u člověka na do-not-call listu je horší než žádné tlačítko.
  //
  // Vytočit ale jde každý kontakt s číslem, který není na seznamu
  // „nevolat“ - kampaň rozhoduje jen o tom, jestli hovor posune i
  // e-mailovou kadenci a jestli má smysl otevírat frontu. Kdyby se hlavička
  // ptala na `callable`, chyběla by u firmy mimo kampaň, zatímco tlačítko
  // u kontaktu o řádek níž by bylo aktivní.
  const queued = contacts.find((c) => c.callable && c.phone);
  // Hlavičkové CTA nesmí vybrat kontakt, jehož klient firmu vyloučil:
  // server by takový hovor odmítl a tlačítko by lhalo.
  const dialable = queued ?? contacts.find((c) => c.phone && !c.do_not_call && !c.client_excluded);
  // Naplánovat další krok jde jen tomu, komu se vůbec smí ozvat. Kontakt
  // v kampani vyloučeného klienta by dostal termín, na který by ho fronta
  // stejně nepustila.
  const openContacts = contacts
    .filter((c) => c.campaign_contact_id && !c.do_not_call && !c.client_excluded && c.call_status &&
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
            {queued && isAdmin ? (
              <Link href="/osloveni" className="btn-secondary">Otevřít v oslovení</Link>
            ) : null}
            <Link href="/firmy" className="btn-secondary">Zpět na firmy</Link>
          </>
        }
      />

      {/* Vyloučení nahoru, hned pod název firmy.
          Je to stav, ve kterém se část akcí na téhle stránce chová jinak -
          kdyby byl schovaný v pravém panelu, člověk by nejdřív klikl na
          Zavolat a teprve pak se dozvěděl, proč to nejde. Schválně to
          NEVYPADÁ jako globální blokace: firma je dál k oslovení pro
          ostatní klienty a text to musí říct. */}
      {exclusions.length > 0 ? (
        <div
          className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3"
          role="status"
        >
          <p className="text-sm font-medium text-amber-900">
            {exclusions.length === 1
              ? `Nekontaktovat pro ${exclusions[0].client_name}`
              : `Nekontaktovat pro ${exclusions.length} klienty: ${exclusions.map((e) => e.client_name).join(", ")}`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {exclusions.map((exclusion) => (
              <li key={exclusion.id} className="text-xs text-amber-900">
                <span className="font-medium">{exclusion.client_name}</span>
                {" — "}
                {exclusion.reason ?? "bez uvedení důvodu"}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-amber-800/80">
            Netýká se ostatních klientů — pro ně zůstává firma normálně k oslovení.
          </p>
        </div>
      ) : null}

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
                  // Vyloučení se vyhodnocuje na dvojici klient+firma, takže
                  // je vždycky vlastností KONKRÉTNÍHO kontaktu: člověk
                  // v kampani VEXY je vyloučený, kolega ve vedlejší kampani
                  // ASN Plus ne. Proto se počítá tady, ne pro celou firmu.
                  const excludedFor = contact.client_excluded ? contact.client_name : null;
                  const excludedReason = excludedFor
                    ? `Firma je vyloučená pro klienta ${excludedFor}.`
                    : null;
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
                            disabled={contact.do_not_call || !contact.phone || Boolean(excludedFor)}
                            disabledReason={
                              excludedReason ??
                              (contact.do_not_call
                                ? "Tento člověk je na seznamu „nevolat“."
                                : "Kontakt nemá telefonní číslo.")
                            }
                            className="btn-go !py-1.5 text-sm"
                          >
                            Zavolat
                          </CallButton>
                          {contact.suppressed || excludedFor ? (
                            <span
                              title={excludedReason ?? "Adresa je na seznamu Nekontaktovat."}
                              className="btn !py-1.5 cursor-not-allowed border border-zinc-200 bg-zinc-100 text-sm text-zinc-400"
                            >
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
                        {excludedFor ? (
                          <span className="badge bg-amber-50 text-amber-800 ring-amber-300">
                            nekontaktovat pro {excludedFor}
                          </span>
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
                      {excludedFor ? (
                        <p className="mt-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                          Firma je vyloučená pro klienta <strong>{excludedFor}</strong>, do jehož
                          kampaně tenhle kontakt patří. Volání i e-maily jsou zastavené — pro jiné
                          klienty ho ale oslovit jde.
                        </p>
                      ) : null}

                      {/* Co prospekt dostal. Caller to čte v Oslovení; vyplňuje
                          to ten, kdo oslovení připravuje, tedy administrátor. */}
                      <div className="mt-3">
                        {contact.loom_url ? (
                          <p className="mb-2 text-xs text-zinc-500">
                            Loom:{" "}
                            <a
                              href={contact.loom_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-zinc-700 underline underline-offset-2"
                            >
                              {contact.loom_title ?? "video"}
                            </a>
                            {contact.loom_sent_at ? (
                              <> · odesláno <DateTime value={contact.loom_sent_at} /></>
                            ) : null}
                          </p>
                        ) : null}
                        {isAdmin ? (
                        <OutreachForm
                          contactId={contact.id}
                          companyId={company.id}
                          contactLabel={
                            [contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
                            contact.email
                          }
                          loomUrl={contact.loom_url ?? ""}
                          loomTitle={contact.loom_title ?? ""}
                          loomSentAt={
                            contact.loom_sent_at
                              ? new Date(contact.loom_sent_at).toISOString().slice(0, 10)
                              : ""
                          }
                          loomNote={contact.loom_note ?? ""}
                          opener={contact.call_opener ?? ""}
                        />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <CallHistory calls={callRecords} />

          <section>
            <h2 className="section-title mb-3">Historie aktivit</h2>
            {timeline.length === 0 ? (
              <p className="card px-5 py-8 text-center text-sm text-zinc-500">
                S touto firmou jsme zatím nekomunikovali.
              </p>
            ) : (
              <ActivityTimeline entries={timeline} />
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <div>
            <h2 className="section-title mb-3">Kontext firmy</h2>
            <CompanyForm
              companyId={company.id}
              reason={company.reason ?? ""}
              ico={company.ico ?? ""}
              priority={company.priority}
              status={company.status}
              ownerId={company.owner_id ?? ""}
              note={company.note ?? ""}
              team={team.map((c) => ({ id: c.id, name: c.name }))}
            />
          </div>

          {/* Vyloučení pro klienta: užší než globální stav firmy výš.
              Patří sem, k firmě, ne do Nastavení - rozhoduje se o tom
              nad konkrétní firmou. */}
          {isAdmin ? (
            <CompanyExclusions
              companyId={company.id}
              companyName={company.name}
              clients={clients.map((c) => ({ id: c.id, name: c.name }))}
              exclusions={exclusions.map((e) => ({
                id: e.id,
                client_id: e.client_id,
                client_name: e.client_name,
                reason: e.reason,
                created_at: e.created_at,
                created_by_name: e.created_by_name,
              }))}
            />
          ) : null}
        </aside>
      </div>
    </>
  );
}
