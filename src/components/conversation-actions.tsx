"use client";

import { classifyConversationAction, deleteConversationAction, sendReplyAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { CLASSIFICATIONS, type Classification } from "@/lib/types";

/**
 * Reply composer. The sending mailbox is fixed to the one that opened the
 * conversation and is shown, not chosen - replying from a different address
 * would break the thread for the prospect.
 */
export function ReplyComposer({
  conversationId,
  fromEmail,
  toEmail,
  disabled,
}: {
  conversationId: string;
  fromEmail: string;
  toEmail: string;
  disabled: boolean;
}) {
  return (
    <ActionForm action={sendReplyAction} className="card p-5">
      <input type="hidden" name="conversation_id" value={conversationId} />
      <div className="mb-3 text-xs text-zinc-500">
        Odpovídáte jako <span className="font-medium text-zinc-900">{fromEmail}</span> na{" "}
        <span className="font-medium text-zinc-900">{toEmail}</span>
      </div>
      <textarea
        name="body"
        rows={7}
        required
        disabled={disabled}
        placeholder="Napište odpověď…"
        className="input font-sans text-sm leading-relaxed"
      />
      <div className="mt-3 flex items-center gap-3">
        <SubmitButton pendingLabel="Odesílám…" disabled={disabled}>Odeslat odpověď</SubmitButton>
        {disabled ? (
          <span className="text-xs text-amber-700">
            Tato schránka je vypnutá, takže z ní nelze nic odeslat.
          </span>
        ) : (
          <span className="text-xs text-zinc-500">
            Hlavičky vlákna se doplní automaticky. Ruční odpovědi se nepočítají do kampaňové kvóty
            schránky.
          </span>
        )}
      </div>
    </ActionForm>
  );
}

/**
 * Rychlé zařazení odpovědi.
 *
 * Tlačítka místo rozbalovacího seznamu s tlačítkem Uložit: triage
 * odpovědi je jedno rozhodnutí, ne formulář. Nejčastější volby jsou
 * napřed, zbytek zůstává v seznamu pod nimi.
 *
 * Kliknutí zároveň udělá to, co z rozhodnutí plyne - odhlásí, zastaví
 * sekvenci - takže se kvůli jedné odpovědi neotevírají další obrazovky.
 */
const QUICK: Classification[] = ["positive", "later", "not_interested", "wrong_person", "unsubscribe"];

export function ClassificationPicker({
  conversationId,
  value,
}: {
  conversationId: string;
  value: Classification;
}) {
  return (
    <ActionForm action={classifyConversationAction} hideMessages>
      <input type="hidden" name="conversation_id" value={conversationId} />
      <div className="mb-2 flex flex-wrap gap-1.5">
        {QUICK.map((key) => {
          const label = CLASSIFICATIONS.find((c) => c.value === key)?.label ?? key;
          return (
            <SubmitButton
              key={key}
              name="classification"
              value={key}
              className={`!px-2.5 !py-1 text-xs ${
                value === key
                  ? "btn-primary"
                  : "btn-secondary"
              }`}
              pendingLabel="…"
            >
              {label}
            </SubmitButton>
          );
        })}
      </div>
      <select name="classification" defaultValue={value} className="input text-sm">
        {CLASSIFICATIONS.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <SubmitButton className="btn-secondary mt-2 w-full" pendingLabel="Ukládám…">Uložit jiný stav</SubmitButton>
    </ActionForm>
  );
}

/**
 * Removes the thread from the inbox. Deliberately worded so the operator knows
 * what survives: this clears the conversation view only, never the send
 * history that keeps a contact from being emailed twice.
 */
export function DeleteConversationButton({ conversationId }: { conversationId: string }) {
  return (
    <ActionForm action={deleteConversationAction} hideMessages>
      <input type="hidden" name="conversation_id" value={conversationId} />
      <SubmitButton
        className="btn-danger w-full"
        pendingLabel="Mažu…"
        confirm={
          "Odebrat tuto konverzaci z doručené pošty?\n\n" +
          "Smažou se zobrazené zprávy. Kontakt, kampaň i záznam o tom, které e-maily už byly " +
          "odeslány, zůstávají — nikomu tedy nemůže přijít e-mail dvakrát."
        }
      >
        Smazat konverzaci
      </SubmitButton>
    </ActionForm>
  );
}
