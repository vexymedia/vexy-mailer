"use client";

import {
  classifyConversationAction,
  deleteConversationAction,
  resolveReviewAction,
  sendReplyAction,
} from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { CLASSIFICATIONS, type Classification } from "@/lib/types";
import { DateTime } from "./ui";

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

/**
 * Posouzení odpovědi, která přišla od jiné adresy.
 *
 * Ukazuje se jen když se na to čeká, a stojí nahoře nad vláknem: dokud
 * to někdo nerozhodne, stojí sekvence kontaktu a je lepší, aby o tom
 * člověk věděl hned, ne až se podiví, proč se nic neposílá.
 *
 * Dvě tlačítka a nic mezi tím. Třetí možnost („rozhodnu se potom")
 * existuje sama od sebe: stačí odejít.
 */
/**
 * Posouzení odpovědi od jiné adresy.
 *
 * Posouzení NIC nepozastavuje - sekvence běží celou dobu. Nejistá příchozí
 * zpráva nesmí umět zastavit naše oslovení, jinak by stačilo komukoli
 * zvenčí napsat do vlákna. Texty to musí říkat přesně tak, jak to je:
 * dřív tu stálo, že kroky stojí, a to by uživatele mátlo.
 */
export function ReviewDecision({
  conversationId,
  replyId,
  fromEmail,
  contactEmail,
  nextSendAt,
}: {
  conversationId: string;
  replyId: string;
  fromEmail: string;
  contactEmail: string;
  nextSendAt: Date | null;
}) {
  return (
    <ActionForm action={resolveReviewAction} className="card border-amber-300 bg-amber-50 p-4">
      <input type="hidden" name="reply_id" value={replyId} />
      <input type="hidden" name="conversation_id" value={conversationId} />

      <h2 className="text-sm font-semibold text-amber-900">Odpověď přišla z jiné adresy</h2>
      <p className="mt-1 text-sm text-amber-900">
        Psal <span className="font-medium">{fromEmail}</span>, ale oslovili jsme{" "}
        <span className="font-medium">{contactEmail}</span>. Podle hlaviček patří zpráva do tohoto
        vlákna — může jít o tutéž osobu z jiné adresy, nebo o přeposlání někomu jinému.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        Sekvence kontaktu běží dál.{" "}
        {nextSendAt ? (
          <>Další krok odejde <DateTime value={nextSendAt} />, pokud to teď neukončíte.</>
        ) : (
          "Další krok naplánovaný nemá."
        )}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <SubmitButton
          name="verdict"
          value="relevant"
          className="btn-primary !py-1.5 text-sm"
          pendingLabel="Ukládám…"
        >
          Odpověděl nám prospekt
        </SubmitButton>
        <SubmitButton
          name="verdict"
          value="unrelated"
          className="btn-secondary !py-1.5 text-sm"
          pendingLabel="Ukládám…"
        >
          Nesouvisí
        </SubmitButton>
      </div>
      <p className="mt-2 text-xs text-amber-800/80">
        „Odpověděl nám prospekt“ kontakt označí za odpověděvšího a sekvenci ukončí. „Nesouvisí“ jen
        zavře tohle posouzení — harmonogram zůstane, jaký je.
      </p>
    </ActionForm>
  );
}
