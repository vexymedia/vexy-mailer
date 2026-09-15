import { extractStatus, type BounceType } from "./bounce";

/**
 * Co vlastně přišlo do schránky.
 *
 * Dosud se každá příchozí zpráva zpracovala jako odpověď od prospekta.
 * Dva důsledky, oba špatné: „Jsem do 15. 8. mimo kancelář“ natrvalo
 * ukončilo sekvenci, a postmaster s bouncem seděl v sales inboxu vedle
 * skutečných odpovědí.
 *
 * Klasifikace je deterministická. Automatické odpovědi se poznávají
 * podle hlaviček, které pro to existují (RFC 3834 Auto-Submitted,
 * Precedence, X-Autoreply), a teprve pak podle textu. Hlavičky jsou
 * spolehlivější než jazyk - a jazyků je tu víc než jeden.
 */

export type MessageClass = "human" | "ooo" | "bounce" | "auto" | "unsubscribe";

export const MESSAGE_CLASS_LABELS: Record<MessageClass, string> = {
  human: "Odpověď",
  ooo: "Mimo kancelář",
  bounce: "Nedoručeno",
  auto: "Automatická zpráva",
  unsubscribe: "Odhlášení",
};

export interface InboundInput {
  from: string | null;
  subject: string | null;
  bodyText: string | null;
  /** Hlavičky, malými písmeny v klíči. */
  headers?: Record<string, string | undefined>;
  /** Content-Type zprávy - DSN chodí jako multipart/report. */
  contentType?: string | null;
}

export interface InboundVerdict {
  class: MessageClass;
  /** Zastaví tahle zpráva automatickou sekvenci natrvalo? */
  stopsSequence: boolean;
  /** Patří do sales inboxu „K vyřízení“? */
  needsHuman: boolean;
  /** Proč - do UI i do logu. */
  reason: string;
}

/**
 * Odesílatelé, kteří nikdy nejsou prospekt.
 *
 * Local part, ne doména: mailer-daemon@cokoli je pořád mailer-daemon.
 */
const SYSTEM_LOCAL_PARTS = [
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "donotreply",
  "do-not-reply",
  "bounce",
  "bounces",
  "mail-daemon",
  "abuse",
];

const OOO_SUBJECT = [
  /out of (?:the )?office/i,
  /auto(?:matic)?[- ]?(?:reply|response|antwort)/i,
  /away from (?:my|the) (?:desk|office)/i,
  /on (?:annual )?leave/i,
  /on holiday|on vacation/i,
  // česky a slovensky
  /mimo kancel/i,
  /nep[řr][íi]tomn/i,
  /dovolen[áa]/i,
  /automatick[áa] odpov/i,
  /odpov[ěe][ďd] mimo/i,
  /^re:\s*$/i,
];

const OOO_BODY = [
  /i am (?:currently )?out of (?:the )?office/i,
  /i(?:'| a)m (?:currently )?(?:away|on leave|on holiday|on vacation)/i,
  /will (?:be )?(?:back|return) (?:on|to the office)/i,
  /jsem mimo kancel/i,
  /jsem na dovolen/i,
  /vr[áa]t[íi]m se/i,
  /v dob[ěe] .{0,30}nejsem/i,
  /v pr[íi]pade s[úu]rn/i,
  /budem[e]? zp[ěe]t/i,
];

const BOUNCE_SUBJECT = [
  /undelivered mail returned to sender/i,
  /delivery status notification/i,
  /(?:mail )?delivery (?:has )?failed/i,
  /returned mail/i,
  /undeliverable/i,
  /failure notice/i,
  /message not delivered/i,
  /nedoru[čc]en/i,
  /nelze doru[čc]it/i,
];

const UNSUBSCRIBE_SUBJECT = [
  /unsubscribe/i,
  /\bremove me\b/i,
  /odhl[áa][sš]/i,
  /nekontaktujte/i,
  /vy[řr]a[ďd]te m[ěe]/i,
];

const UNSUBSCRIBE_BODY = [
  /please (?:remove|unsubscribe) me/i,
  /take me off (?:your|this) (?:list|mailing)/i,
  /stop (?:emailing|contacting) me/i,
  /odhla[sš]te m[ěe]/i,
  /nep[řr]ejeme? si .{0,25}(?:kontaktov|e-?mail)/i,
  /vy[řr]a[ďd]te m[ěe] ze seznamu/i,
];

function localPart(email: string | null): string {
  return (email ?? "").split("@")[0]?.toLowerCase() ?? "";
}

function anyMatch(patterns: RegExp[], ...texts: (string | null | undefined)[]): boolean {
  const haystack = texts.filter(Boolean).join("\n");
  if (!haystack) return false;
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Hlavní klasifikátor. Pořadí testů je záměrné, od nejtvrdšího signálu:
 * bounce → odhlášení → automatická odpověď → mimo kancelář → člověk.
 *
 * Odhlášení stojí nad automatickou odpovědí schválně: „unsubscribe“ ve
 * skutečné odpovědi je vážná věc, kterou nesmí přebít Precedence: bulk
 * u nějakého mailing listu.
 */
export function classifyInbound(input: InboundInput): InboundVerdict {
  const headers = input.headers ?? {};
  const from = (input.from ?? "").toLowerCase();
  const subject = input.subject ?? "";
  const body = (input.bodyText ?? "").slice(0, 4000);

  // ---------------------------------------------------------- bounce
  const isDsn = /multipart\/report/i.test(input.contentType ?? "") ||
    /delivery-status/i.test(input.contentType ?? "") ||
    Boolean(headers["x-failed-recipients"]);
  const fromSystem = SYSTEM_LOCAL_PARTS.includes(localPart(from));

  if (isDsn || (fromSystem && anyMatch(BOUNCE_SUBJECT, subject))) {
    return {
      class: "bounce",
      stopsSequence: false,
      needsHuman: false,
      reason: isDsn ? "Zpráva o stavu doručení (DSN)." : "Hlášení od poštovního serveru.",
    };
  }
  if (anyMatch(BOUNCE_SUBJECT, subject) && extractStatus(body)) {
    return {
      class: "bounce",
      stopsSequence: false,
      needsHuman: false,
      reason: "Hlášení o nedoručení.",
    };
  }

  // ----------------------------------------------------- odhlášení
  if (anyMatch(UNSUBSCRIBE_SUBJECT, subject) || anyMatch(UNSUBSCRIBE_BODY, body)) {
    return {
      class: "unsubscribe",
      stopsSequence: true,
      needsHuman: true,
      reason: "Prospekt si vyžádal odhlášení.",
    };
  }

  // --------------------------------------- automatická odpověď (hlavičky)
  //
  // RFC 3834: auto-generated / auto-replied. `Precedence: bulk|auto_reply`
  // a X-Autoreply jsou starší, ale pořád nejrozšířenější signál.
  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  const precedence = (headers["precedence"] ?? "").toLowerCase();
  const autoHeader =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    ["bulk", "auto_reply", "junk", "list"].includes(precedence) ||
    Boolean(headers["x-autoreply"]) ||
    Boolean(headers["x-autorespond"]) ||
    Boolean(headers["x-auto-response-suppress"]);

  const oooText = anyMatch(OOO_SUBJECT, subject) || anyMatch(OOO_BODY, body);

  if (oooText) {
    // Mimo kancelář je automatická odpověď, ale ne technický šum:
    // někdo se ozve, jen později. Sekvenci to nesmí ukončit natrvalo.
    return {
      class: "ooo",
      stopsSequence: false,
      needsHuman: false,
      reason: "Automatická odpověď o nepřítomnosti.",
    };
  }
  if (autoHeader || fromSystem) {
    return {
      class: "auto",
      stopsSequence: false,
      needsHuman: false,
      reason: fromSystem
        ? "Odesílatel je systémová adresa, ne člověk."
        : "Zpráva je označená jako automatická.",
    };
  }

  // ----------------------------------------------------------- člověk
  return {
    class: "human",
    stopsSequence: true,
    needsHuman: true,
    reason: "Odpověď od člověka.",
  };
}

/**
 * Do kdy je prospekt mimo kancelář, pokud to ze zprávy jde přečíst.
 *
 * Bere jen datum, které je jednoznačné. Když ho nenajde, vrací null a
 * volající použije svůj bezpečný odklad - hádat datum návratu znamená
 * buď obtěžovat člověka na dovolené, nebo na něj zapomenout na měsíc.
 */
export function parseReturnDate(text: string | null, now: Date = new Date()): Date | null {
  if (!text) return null;
  const haystack = text.slice(0, 2000);

  // "do 15. 8." / "do 15.8.2026" / "vrátím se 3. 9. 2026"
  const czech = /(?:do|od|vr[áa]t[íi]m se|zp[ěe]t)\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/i.exec(haystack);
  if (czech) {
    const day = Number(czech[1]);
    const month = Number(czech[2]);
    const year = czech[3] ? Number(czech[3]) : now.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // Bez roku: když datum vyšlo do minulosti, myslí se příští rok.
      if (!czech[3] && candidate.getTime() < now.getTime()) {
        return new Date(Date.UTC(year + 1, month - 1, day));
      }
      return candidate;
    }
  }

  // ISO: "until 2026-08-15"
  const iso = /(?:until|till|back on|returning)\s+(\d{4})-(\d{2})-(\d{2})/i.exec(haystack);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }

  return null;
}

/** Bounce typy, které jsou problémem odesílatele, ne příjemce. */
export function isSenderSideBounce(type: BounceType): boolean {
  return type === "REPUTATION_BLOCK" || type === "POLICY_BLOCK" || type === "SPAM_REJECTION";
}
