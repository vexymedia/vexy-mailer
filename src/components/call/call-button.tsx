"use client";

import { useCalling } from "./call-provider";

/**
 * Tlačítko Zavolat.
 *
 * Když je nastavené volání z prohlížeče, zvedne hovor přes Twilio. Když
 * není, zůstane z něj poctivý odkaz tel: - stejné chování, jaké aplikace
 * měla předtím. Rozhodně z něj nedělá mrtvé tlačítko: člověk potřebuje
 * zavolat i ve chvíli, kdy telefonie ještě není zapnutá.
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

  if (!browserCalling) {
    return (
      <a href={`tel:${phone.replace(/\s+/g, "")}`} className={className}>
        {label}
      </a>
    );
  }

  const busy = state === "permission" || state === "connecting" || state === "ringing" || state === "active";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => start(campaignContactId ? { campaignContactId } : { contactId })}
      className={`${className} ${busy ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {busy ? "Probíhá hovor…" : label}
    </button>
  );
}
