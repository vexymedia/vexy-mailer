"use client";

import Link from "next/link";
import { saveMailboxAction, testMailboxAction, testMailboxImapAction, deleteMailboxAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

export interface MailboxFormValues {
  id?: string;
  name: string;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_secure: boolean;
  imap_host: string;
  imap_port: number | "";
  imap_username: string;
  imap_secure: boolean;
  daily_limit: number;
  mailbox_timezone: string;
  enabled: boolean;
}

export function MailboxForm({ values }: { values: MailboxFormValues }) {
  const editing = Boolean(values.id);

  return (
    <div className="space-y-5">
      <ActionForm action={saveMailboxAction} className="card p-6">
        {editing ? <input type="hidden" name="id" value={values.id} /> : null}

        <section>
          <h2 className="mb-4 text-sm font-semibold text-zinc-900">Identita</h2>
          <div className="grid gap-5 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="name">Označení</label>
              <input id="name" name="name" defaultValue={values.name} required className="input" placeholder="Hlavní outreach" />
              <p className="hint">Zobrazuje se jen uvnitř aplikace.</p>
            </div>
            <div>
              <label className="label" htmlFor="from_name">Jméno odesílatele</label>
              <input id="from_name" name="from_name" defaultValue={values.from_name} required className="input" placeholder="Vojtěch Šustal" />
            </div>
            <div>
              <label className="label" htmlFor="from_email">E-mail odesílatele</label>
              <input id="from_email" name="from_email" type="email" defaultValue={values.from_email} required className="input" />
            </div>
          </div>
        </section>

        <section className="mt-8 border-t border-zinc-200 pt-6">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900">Pravidla odesílání</h2>
          <p className="mb-4 text-xs text-zinc-500">
            Denní limit je globální: platí napříč všemi kampaněmi, které schránku používají, takže
            ho dvě kampaně nemohou utratit každá zvlášť.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="daily_limit">Denní limit automatického odesílání</label>
              <input
                id="daily_limit"
                name="daily_limit"
                type="number"
                min={1}
                max={2000}
                defaultValue={values.daily_limit}
                required
                className="input"
              />
              <p className="hint">Ruční odpovědi z doručené pošty se do limitu nepočítají.</p>
            </div>
            <div>
              <label className="label" htmlFor="mailbox_timezone">Časové pásmo pro denní reset</label>
              <input
                id="mailbox_timezone"
                name="mailbox_timezone"
                defaultValue={values.mailbox_timezone}
                required
                list="mailbox-timezones"
                className="input"
              />
              <datalist id="mailbox-timezones">
                {["Europe/Prague", "Europe/Bratislava", "Europe/London", "Europe/Berlin", "UTC"].map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <p className="hint">Určuje, kdy pro tuto schránku začíná nový den.</p>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="enabled" defaultChecked={values.enabled} className="size-4 rounded border-zinc-300" />
            Zapnuto — k dispozici pro automatické odesílání
          </label>
        </section>

        <section className="mt-8 border-t border-zinc-200 pt-6">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900">SMTP — odesílání</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="smtp_host">SMTP server</label>
              <input id="smtp_host" name="smtp_host" defaultValue={values.smtp_host} required className="input" placeholder="smtp.forpsi.com" />
            </div>
            <div>
              <label className="label" htmlFor="smtp_port">SMTP port</label>
              <input id="smtp_port" name="smtp_port" type="number" defaultValue={values.smtp_port} required className="input" />
              <p className="hint">465 pro implicitní TLS, 587 pro STARTTLS.</p>
            </div>
            <div>
              <label className="label" htmlFor="smtp_username">SMTP uživatel</label>
              <input id="smtp_username" name="smtp_username" defaultValue={values.smtp_username} required className="input" />
            </div>
            <div>
              <label className="label" htmlFor="smtp_password">SMTP heslo</label>
              <input
                id="smtp_password"
                name="smtp_password"
                type="password"
                autoComplete="new-password"
                required={!editing}
                className="input"
                placeholder={editing ? "Nechte prázdné pro zachování uloženého hesla" : ""}
              />
              <p className="hint">Před uložením se zašifruje algoritmem AES-256-GCM a nikdy se neposílá zpět do prohlížeče.</p>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="smtp_secure" defaultChecked={values.smtp_secure} className="size-4 rounded border-zinc-300" />
            Vyžadovat TLS
          </label>
        </section>

        <section className="mt-8 border-t border-zinc-200 pt-6">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900">IMAP — detekce odpovědí</h2>
          <p className="mb-4 text-xs text-zinc-500">
            Nepovinné, ale bez toho se odpovědi nerozpoznají a follow-upy chodí dál.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="imap_host">IMAP server</label>
              <input id="imap_host" name="imap_host" defaultValue={values.imap_host} className="input" placeholder="imap.forpsi.com" />
            </div>
            <div>
              <label className="label" htmlFor="imap_port">IMAP port</label>
              <input id="imap_port" name="imap_port" type="number" defaultValue={values.imap_port} className="input" placeholder="993" />
            </div>
            <div>
              <label className="label" htmlFor="imap_username">IMAP uživatel</label>
              <input id="imap_username" name="imap_username" defaultValue={values.imap_username} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="imap_password">IMAP heslo</label>
              <input
                id="imap_password"
                name="imap_password"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder={editing ? "Nechte prázdné pro zachování uloženého hesla" : ""}
              />
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="imap_secure" defaultChecked={values.imap_secure} className="size-4 rounded border-zinc-300" />
            Vyžadovat TLS
          </label>
        </section>

        <div className="mt-8 flex items-center gap-3 border-t border-zinc-200 pt-6">
          <SubmitButton pendingLabel="Ukládám…">{editing ? "Uložit změny" : "Přidat schránku"}</SubmitButton>
          <Link href="/mailboxes" className="btn-secondary">Zrušit</Link>
        </div>
      </ActionForm>

      {editing ? (
        <>
          <ActionForm action={testMailboxAction} className="card p-6">
            <input type="hidden" name="id" value={values.id} />
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">Test připojení</h2>
            <p className="mb-4 text-xs text-zinc-500">
              Ověří SMTP přihlášení a otevře IMAP schránku. Nic se neodesílá. Kampaň nepůjde spustit,
              dokud test alespoň jednou neprojde.
            </p>
            <SubmitButton className="btn-secondary" pendingLabel="Testuji…">Otestovat připojení</SubmitButton>
          </ActionForm>

          <ActionForm action={testMailboxImapAction} className="card p-6">
            <input type="hidden" name="id" value={values.id} />
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">Test jen IMAP</h2>
            <p className="mb-4 text-xs text-zinc-500">
              Přihlásí se přes IMAP a otevře INBOX, aniž by sáhl na SMTP. Použijte, když odesílání
              funguje a selhává jen detekce odpovědí. Neodešle se žádný e-mail a nic se nečte.
            </p>
            <SubmitButton className="btn-secondary" pendingLabel="Testuji IMAP…">Otestovat IMAP</SubmitButton>
          </ActionForm>

          <ActionForm action={deleteMailboxAction} className="card p-6">
            <h2 className="mb-4 text-sm font-semibold text-red-700">Smazat schránku</h2>
            <input type="hidden" name="id" value={values.id} />
            <SubmitButton className="btn-danger" confirm="Smazat tuto schránku?">Smazat</SubmitButton>
          </ActionForm>
        </>
      ) : null}
    </div>
  );
}
