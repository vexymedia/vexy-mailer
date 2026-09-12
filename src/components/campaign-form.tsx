"use client";

import Link from "next/link";
import { saveCampaignAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { WEEKDAY_LABELS } from "@/lib/schedule";

export interface CampaignFormValues {
  id?: string;
  name: string;
  mailbox_ids: string[];
  daily_limit: number;
  send_days: number[];
  send_start: string;
  send_end: string;
  timezone: string;
}

const COMMON_TIMEZONES = [
  "Europe/Prague",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Warsaw",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

export interface SenderOption {
  id: string;
  name: string;
  from_email: string;
  enabled: boolean;
  daily_limit: number;
  used_today: number;
  /** True when a contact is already pinned to it and it cannot be removed. */
  pinned: boolean;
}

export function CampaignForm({
  values,
  mailboxes,
}: {
  values: CampaignFormValues;
  mailboxes: SenderOption[];
}) {
  return (
    <ActionForm action={saveCampaignAction} className="card p-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="space-y-5">
        <div>
          <label className="label" htmlFor="name">Název kampaně</label>
          <input id="name" name="name" defaultValue={values.name} required className="input" placeholder="Q3 agentury — Praha" />
        </div>

        <fieldset>
          <legend className="label">Odesílací schránky</legend>
          <p className="mb-2 text-xs text-zinc-500">
            E-maily se rozdělí mezi zaškrtnuté schránky — nový kontakt vždy dostane tu nejméně
            vytíženou. Jakmile se prospektovi jednou ozvete z nějaké adresy, všechny follow-upy
            chodí už jen z ní.
          </p>
          <div className="space-y-1.5">
            {mailboxes.map((mailbox) => (
              <label
                key={mailbox.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm has-checked:border-zinc-900 has-checked:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  name="mailbox_ids"
                  value={mailbox.id}
                  defaultChecked={values.mailbox_ids.includes(mailbox.id)}
                  className="size-4 rounded border-zinc-300"
                />
                <span className="flex-1">
                  <span className="font-medium text-zinc-900">{mailbox.from_email}</span>
                  <span className="ml-2 text-xs text-zinc-500">{mailbox.name}</span>
                  {!mailbox.enabled ? (
                    <span className="badge ml-2 bg-orange-50 text-orange-700 ring-orange-200">vypnutá</span>
                  ) : null}
                  {mailbox.pinned ? (
                    <span className="badge ml-2 bg-blue-50 text-blue-700 ring-blue-200">
                      kontakty připnuté
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums text-xs text-zinc-500">
                  {mailbox.used_today} / {mailbox.daily_limit} dnes
                </span>
              </label>
            ))}
          </div>
          {mailboxes.length === 0 ? (
            <p className="hint text-amber-700">
              Zatím žádné schránky. <Link href="/mailboxes/new" className="underline">Nejdřív jednu přidejte.</Link>
            </p>
          ) : null}
        </fieldset>

        <div>
          <label className="label" htmlFor="daily_limit">Denní limit odeslání</label>
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
          <p className="hint">
            Horní hranice jen pro tuto kampaň. Každá schránka má navíc vlastní globální limit
            napříč kampaněmi a vždy platí ten nižší z obou.
          </p>
        </div>

        <fieldset>
          <legend className="label">Dny odesílání</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_LABELS.map((label, index) => {
              const day = index + 1;
              return (
                <label
                  key={day}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm has-checked:border-zinc-900 has-checked:bg-zinc-900 has-checked:text-white"
                >
                  <input
                    type="checkbox"
                    name="send_days"
                    value={day}
                    defaultChecked={values.send_days.includes(day)}
                    className="sr-only"
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="send_start">Okno začíná</label>
            <input id="send_start" name="send_start" defaultValue={values.send_start} required className="input" placeholder="08:00" />
          </div>
          <div>
            <label className="label" htmlFor="send_end">Okno končí</label>
            <input id="send_end" name="send_end" defaultValue={values.send_end} required className="input" placeholder="16:00" />
          </div>
          <div>
            <label className="label" htmlFor="timezone">Časové pásmo</label>
            <input
              id="timezone"
              name="timezone"
              defaultValue={values.timezone}
              required
              list="timezones"
              className="input"
            />
            <datalist id="timezones">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-zinc-200 pt-5">
        <SubmitButton pendingLabel="Ukládám…">
          {values.id ? "Uložit změny" : "Vytvořit kampaň"}
        </SubmitButton>
        <Link href={values.id ? `/campaigns/${values.id}` : "/campaigns"} className="btn-secondary">
          Zrušit
        </Link>
        {!values.id ? (
          <p className="text-xs text-zinc-500">
            Kampaň se založí jako koncept. Dokud ji nespustíte, nic se neodešle.
          </p>
        ) : null}
      </div>
    </ActionForm>
  );
}
