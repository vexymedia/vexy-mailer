"use client";

import Link from "next/link";
import { saveCampaignAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { WEEKDAY_LABELS } from "@/lib/schedule";

export interface CampaignFormValues {
  id?: string;
  name: string;
  mailbox_id: string;
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

export function CampaignForm({
  values,
  mailboxes,
}: {
  values: CampaignFormValues;
  mailboxes: { id: string; name: string; from_email: string }[];
}) {
  return (
    <ActionForm action={saveCampaignAction} className="card p-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="space-y-5">
        <div>
          <label className="label" htmlFor="name">Campaign name</label>
          <input id="name" name="name" defaultValue={values.name} required className="input" placeholder="Q3 agencies — Prague" />
        </div>

        <div>
          <label className="label" htmlFor="mailbox_id">Sender mailbox</label>
          <select id="mailbox_id" name="mailbox_id" defaultValue={values.mailbox_id} required className="input">
            <option value="">Choose a mailbox…</option>
            {mailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.name} — {mailbox.from_email}
              </option>
            ))}
          </select>
          {mailboxes.length === 0 ? (
            <p className="hint text-amber-700">
              No mailboxes yet. <Link href="/mailboxes/new" className="underline">Add one first.</Link>
            </p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="daily_limit">Daily send limit</label>
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
            Emails are spread evenly across the sending window with random gaps, never in bursts.
          </p>
        </div>

        <fieldset>
          <legend className="label">Sending days</legend>
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
            <label className="label" htmlFor="send_start">Window starts</label>
            <input id="send_start" name="send_start" defaultValue={values.send_start} required className="input" placeholder="08:00" />
          </div>
          <div>
            <label className="label" htmlFor="send_end">Window ends</label>
            <input id="send_end" name="send_end" defaultValue={values.send_end} required className="input" placeholder="16:00" />
          </div>
          <div>
            <label className="label" htmlFor="timezone">Timezone</label>
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
        <SubmitButton pendingLabel="Saving…">
          {values.id ? "Save changes" : "Create campaign"}
        </SubmitButton>
        <Link href={values.id ? `/campaigns/${values.id}` : "/campaigns"} className="btn-secondary">
          Cancel
        </Link>
        {!values.id ? (
          <p className="text-xs text-zinc-500">
            The campaign is created as a draft. Nothing is sent until you start it.
          </p>
        ) : null}
      </div>
    </ActionForm>
  );
}
