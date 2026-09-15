"use client";

import { useCalling } from "./call-provider";

/**
 * Tlačítko Zavolat.
 *
 * Vždycky je to tlačítko, nikdy odkaz `tel:`. Kliknutí zvedne hovor přes
 * Twilio a otevře cockpit - i když telefonie zrovna není nastavená. V tom
 * případě cockpit rovnou ukáže, co na serveru chybí.
 *
 * Odkaz `tel:` tu dřív byl jako "poctivá náhrada", ale ve skutečnosti to
 * byla tichá díra: hovor se předal systémovému telefonu, aplikace o něm
 * nevěděla, nevznikl pokus, nešel zapsat výsledek a nikdo se nedozvěděl,
 * že telefonie není zapnutá. Lepší je jedna cesta, která umí i selhat
 * nahlas.
 */
export function CallButton({
  phone,
  contactId,
  campaignContactId,
  browserCalling,
  disabled,
  disabledReason,
  className = "btn-go",
  children,
}: {
  phone: string | null;
  contactId?: string;
  campaignContactId?: string;
  /** Je Twilio nastavené? Zjišťuje server, klient si to nevymýšlí. */
  browserCalling: boolean;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const { start, state } = useCalling();
  const label = children ?? (phone ? `Zavolat ${phone}` : "Zavolat");

  if (disabled || !phone) {
    return (
      <span
        title={disabledReason}
        className={`btn cursor-not-allowed border border-zinc-200 bg-zinc-100 text-zinc-400 ${
          className.includes("!py") ? "!py-1.5 text-sm" : ""
        }`}
      >
        {children ?? "Zavolat"}
      </span>
    );
  }

  const busy =
    state === "permission" || state === "connecting" || state === "ringing" || state === "active";

  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      data-call-button="twilio"
      title={
        browserCalling
          ? undefined
          : "Volání přes Twilio zatím není na serveru nastavené. Po kliknutí se dozvíte, co chybí."
      }
      onClick={() => start(campaignContactId ? { campaignContactId } : { contactId })}
      className={`${className} ${busy ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {/* Vlastní popisek (telefonní číslo v tabulce) zůstává i během hovoru -
          jinak by se řádek přejmenoval na "Probíhá hovor…" a nešlo by
          poznat, komu patří. Stav hovoru je vidět v liště dole. */}
      {busy && children === undefined ? "Probíhá hovor…" : label}
    </button>
  );
}
