"use client";

import { selectCallerAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * Who is at this workstation. Asked once per shift rather than once per call:
 * the answer is what a leased prospect is held for, so the server has to know
 * it before the first number is handed out.
 */
export function CallerPicker({
  campaignId,
  callers,
}: {
  campaignId: string;
  callers: { id: string; name: string }[];
}) {
  return (
    <ActionForm action={selectCallerAction} className="card max-w-md p-6">
      <input type="hidden" name="campaign_id" value={campaignId} />
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Kdo dnes volá?</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Vybere se jednou na celou směnu. Podle toho se zapisují hovory a drží se
        kontakt, na který zrovna voláte, aby ho nedostal někdo druhý.
      </p>
      <div className="space-y-2">
        {callers.map((caller) => (
          <label
            key={caller.id}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm has-checked:border-zinc-900 has-checked:bg-zinc-50"
          >
            <input type="radio" name="caller_id" value={caller.id} className="size-4 border-zinc-300" required />
            <span className="font-medium text-zinc-900">{caller.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-5">
        <SubmitButton pendingLabel="Ukládám…">Začít volat</SubmitButton>
      </div>
    </ActionForm>
  );
}
