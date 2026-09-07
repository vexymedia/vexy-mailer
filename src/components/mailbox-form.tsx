"use client";

import Link from "next/link";
import { saveMailboxAction, testMailboxAction, deleteMailboxAction } from "@/lib/actions";
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
}

export function MailboxForm({ values }: { values: MailboxFormValues }) {
  const editing = Boolean(values.id);

  return (
    <div className="space-y-5">
      <ActionForm action={saveMailboxAction} className="card p-6">
        {editing ? <input type="hidden" name="id" value={values.id} /> : null}

        <section>
          <h2 className="mb-4 text-sm font-semibold text-zinc-900">Identity</h2>
          <div className="grid gap-5 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="name">Label</label>
              <input id="name" name="name" defaultValue={values.name} required className="input" placeholder="Main outreach" />
              <p className="hint">Only shown inside this app.</p>
            </div>
            <div>
              <label className="label" htmlFor="from_name">From name</label>
              <input id="from_name" name="from_name" defaultValue={values.from_name} required className="input" placeholder="Vojtěch Šustal" />
            </div>
            <div>
              <label className="label" htmlFor="from_email">From email</label>
              <input id="from_email" name="from_email" type="email" defaultValue={values.from_email} required className="input" />
            </div>
          </div>
        </section>

        <section className="mt-8 border-t border-zinc-200 pt-6">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900">SMTP — sending</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="smtp_host">SMTP host</label>
              <input id="smtp_host" name="smtp_host" defaultValue={values.smtp_host} required className="input" placeholder="smtp.forpsi.com" />
            </div>
            <div>
              <label className="label" htmlFor="smtp_port">SMTP port</label>
              <input id="smtp_port" name="smtp_port" type="number" defaultValue={values.smtp_port} required className="input" />
              <p className="hint">465 for implicit TLS, 587 for STARTTLS.</p>
            </div>
            <div>
              <label className="label" htmlFor="smtp_username">SMTP username</label>
              <input id="smtp_username" name="smtp_username" defaultValue={values.smtp_username} required className="input" />
            </div>
            <div>
              <label className="label" htmlFor="smtp_password">SMTP password</label>
              <input
                id="smtp_password"
                name="smtp_password"
                type="password"
                autoComplete="new-password"
                required={!editing}
                className="input"
                placeholder={editing ? "Leave blank to keep the stored password" : ""}
              />
              <p className="hint">Encrypted with AES-256-GCM before it is stored, and never sent back to the browser.</p>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="smtp_secure" defaultChecked={values.smtp_secure} className="size-4 rounded border-zinc-300" />
            Require TLS
          </label>
        </section>

        <section className="mt-8 border-t border-zinc-200 pt-6">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900">IMAP — reply detection</h2>
          <p className="mb-4 text-xs text-zinc-500">
            Optional, but without it replies are not detected and follow-ups keep going out.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="imap_host">IMAP host</label>
              <input id="imap_host" name="imap_host" defaultValue={values.imap_host} className="input" placeholder="imap.forpsi.com" />
            </div>
            <div>
              <label className="label" htmlFor="imap_port">IMAP port</label>
              <input id="imap_port" name="imap_port" type="number" defaultValue={values.imap_port} className="input" placeholder="993" />
            </div>
            <div>
              <label className="label" htmlFor="imap_username">IMAP username</label>
              <input id="imap_username" name="imap_username" defaultValue={values.imap_username} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="imap_password">IMAP password</label>
              <input
                id="imap_password"
                name="imap_password"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder={editing ? "Leave blank to keep the stored password" : ""}
              />
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="imap_secure" defaultChecked={values.imap_secure} className="size-4 rounded border-zinc-300" />
            Require TLS
          </label>
        </section>

        <div className="mt-8 flex items-center gap-3 border-t border-zinc-200 pt-6">
          <SubmitButton pendingLabel="Saving…">{editing ? "Save changes" : "Add mailbox"}</SubmitButton>
          <Link href="/mailboxes" className="btn-secondary">Cancel</Link>
        </div>
      </ActionForm>

      {editing ? (
        <>
          <ActionForm action={testMailboxAction} className="card p-6">
            <input type="hidden" name="id" value={values.id} />
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">Test connection</h2>
            <p className="mb-4 text-xs text-zinc-500">
              Verifies SMTP login and opens the IMAP inbox. Nothing is sent. A campaign will not
              start until this has passed at least once.
            </p>
            <SubmitButton className="btn-secondary" pendingLabel="Testing…">Test connection</SubmitButton>
          </ActionForm>

          <ActionForm action={deleteMailboxAction} className="card p-6">
            <h2 className="mb-4 text-sm font-semibold text-red-700">Delete mailbox</h2>
            <input type="hidden" name="id" value={values.id} />
            <SubmitButton className="btn-danger" confirm="Delete this mailbox?">Delete</SubmitButton>
          </ActionForm>
        </>
      ) : null}
    </div>
  );
}
