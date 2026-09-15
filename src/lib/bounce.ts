/**
 * Klasifikace nedoručení.
 *
 * Proč to vůbec existuje: bez téhle vrstvy vypadá v datech
 *
 *     550 5.1.1 user unknown
 *
 * úplně stejně jako
 *
 *     554 5.0.0 Your access to this mail system has been rejected
 *               due to poor reputation of a domain used in message transfer
 *
 * První znamená "tahle adresa neexistuje" - konkrétní e-mail smí jít
 * natrvalo na seznam nekontaktovat. Druhé neříká o příjemci vůbec nic;
 * je to problém NAŠEHO odesílání. Zablokovat kvůli němu příjemce znamená
 * vyhodit platný lead kvůli vlastní chybě - a přesně to se dělo.
 *
 * Pravidla jsou deterministická, ne modelová. Bounce hlášky jsou
 * ustálené a konečné; model by na nich přidal jen nejistotu a náklad.
 *
 * Zdroje formátu: RFC 3463 (Enhanced Mail System Status Codes) pro
 * x.y.z, RFC 3464 (DSN) pro Action/Status/Diagnostic-Code.
 */

export type BounceType =
  | "HARD_INVALID"
  | "SOFT_TEMPORARY"
  | "MAILBOX_FULL"
  | "RATE_LIMIT"
  | "REPUTATION_BLOCK"
  | "POLICY_BLOCK"
  | "SPAM_REJECTION"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export const BOUNCE_LABELS: Record<BounceType, string> = {
  HARD_INVALID: "Adresa neexistuje",
  SOFT_TEMPORARY: "Dočasná chyba",
  MAILBOX_FULL: "Plná schránka",
  RATE_LIMIT: "Omezení rychlosti",
  REPUTATION_BLOCK: "Blokováno kvůli reputaci",
  POLICY_BLOCK: "Odmítnuto politikou serveru",
  SPAM_REJECTION: "Vyhodnoceno jako spam",
  NETWORK_ERROR: "Síťová chyba",
  UNKNOWN: "Neurčeno",
};

export interface BounceInput {
  /** Enhanced status z DSN, např. "5.1.1". */
  status?: string | null;
  /** Diagnostic-Code z DSN nebo odpověď SMTP serveru. */
  diagnosticCode?: string | null;
  /** Číselný SMTP kód, když je po ruce (550, 554, 452…). */
  responseCode?: number | null;
  /** Předmět zprávy - u DSN občas jediné, co něco říká. */
  subject?: string | null;
  /** Action z DSN: failed / delayed / delivered. */
  action?: string | null;
}

export interface BounceVerdict {
  type: BounceType;
  /**
   * Smí se kvůli tomuhle natrvalo zablokovat PŘÍJEMCE?
   *
   * True jen u HARD_INVALID. Všechno ostatní je buď dočasné, nebo je to
   * problém odesílatele - a v obou případech je příjemce nevinný.
   */
  suppressRecipient: boolean;
  /**
   * Je problém na naší straně (doména, IP, obsah)? Tyhle se řeší
   * u schránky, ne u kontaktu, a hlavně se NEzkouší hned jinou schránkou.
   */
  senderProblem: boolean;
  /** Smí se doručení zkusit znovu později? */
  retryable: boolean;
  /** Česky, do UI. */
  label: string;
}

/** Vytáhne x.y.z status odkudkoli z textu. */
export function extractStatus(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Vytáhne třímístný SMTP kód ze začátku odpovědi. */
export function extractResponseCode(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /(?:^|[\s(])([245]\d{2})(?:[\s-]|$)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Fráze, které rozhodují. Pořadí JE součást specifikace: čte se shora
 * dolů a vyhrává první shoda.
 *
 * Reputace a politika stojí schválně NAD "user unknown" a spol. Server,
 * který nás odmítne kvůli reputaci, často použije generický text i
 * generický status 5.0.0; kdyby se dřív chytlo cokoli jiného, skončil by
 * platný příjemce jako neexistující. Tohle je ta konkrétní chyba, kvůli
 * které tenhle soubor vznikl.
 */
const RULES: { type: BounceType; patterns: RegExp[] }[] = [
  {
    type: "REPUTATION_BLOCK",
    patterns: [
      /poor reputation/i,
      /bad reputation/i,
      /reputation of (?:a |the )?domain/i,
      /sender reputation/i,
      /domain reputation/i,
      /ip reputation/i,
      /listed (?:on|by|in) .{0,40}(?:blocklist|blacklist|dnsbl|spamhaus|barracuda|uceprotect)/i,
      /blocked using|blocked by .{0,40}(?:blocklist|blacklist|dnsbl)/i,
      /your (?:ip|server|host) .{0,40}(?:blacklist|blocklist|blocked)/i,
    ],
  },
  {
    type: "SPAM_REJECTION",
    patterns: [
      /message (?:looks like |considered |identified as )?spam/i,
      /spam (?:content|score|detected|message rejected)/i,
      /rejected as spam/i,
      /high (?:spam|probability of spam)/i,
      /bulk mail/i,
    ],
  },
  {
    type: "POLICY_BLOCK",
    patterns: [
      /access .{0,30}(?:has been )?(?:rejected|denied)/i,
      /policy (?:reasons?|rejection|violation|restrictions?)/i,
      /rejected (?:for|due to) policy/i,
      /not authori[sz]ed to send/i,
      /(?:spf|dkim|dmarc) (?:check )?(?:fail|failure|failed|does not pass)/i,
      /relay (?:access )?denied/i,
      /administrative prohibition/i,
      /message rejected by (?:the )?(?:recipient|receiving) (?:server|system)/i,
    ],
  },
  {
    type: "MAILBOX_FULL",
    patterns: [
      /mailbox (?:is )?full/i,
      /over ?quota/i,
      /quota exceeded/i,
      /insufficient (?:system )?storage/i,
      /doesn'?t have enough (?:disk|storage) space/i,
    ],
  },
  {
    type: "RATE_LIMIT",
    patterns: [
      /rate limit/i,
      /too many (?:messages|connections|recipients|emails)/i,
      /throttl/i,
      // "try again later" samo o sobě schválně NE: řekne to kdejaké
      // dočasné selhání, které s omezováním rychlosti nemá nic
      // společného. Bez kontextu by z každé 4xx chyby byl rate limit.
      /temporarily deferred/i,
      /greylist/i,
      /connection frequency/i,
    ],
  },
  {
    type: "HARD_INVALID",
    patterns: [
      /user unknown/i,
      /unknown user/i,
      /no such user/i,
      /user (?:does not|doesn'?t) exist/i,
      /recipient (?:address )?(?:rejected|unknown)/i,
      /mailbox (?:unavailable|not found|does not exist|doesn'?t exist)/i,
      /(?:address|recipient) (?:not found|unknown)/i,
      /invalid (?:recipient|mailbox|address)/i,
      /no mailbox (?:here )?by that name/i,
      /account (?:has been )?(?:disabled|closed|deactivated|terminated)/i,
    ],
  },
  {
    type: "NETWORK_ERROR",
    patterns: [
      /(?:host|domain) not found/i,
      /no route to host/i,
      /dns (?:error|failure|lookup failed)/i,
      /nxdomain/i,
      /connection (?:timed out|refused|reset)/i,
      /unable to (?:connect|look ?up)/i,
    ],
  },
];

/**
 * Enhanced status kódy, které samy o sobě něco jednoznačně znamenají.
 *
 * 5.0.0 tady SCHVÁLNĚ NENÍ. Je to "permanent failure, blíže neurčeno" -
 * server ho použije, když se mu nechce vybírat konkrétnější. Odvodit
 * z něj neexistující adresu je přesně ta chyba, která maže platné leady.
 */
const STATUS_MAP: Record<string, BounceType> = {
  "5.1.1": "HARD_INVALID", // Bad destination mailbox address
  "5.1.2": "NETWORK_ERROR", // Bad destination system address
  "5.1.3": "HARD_INVALID", // Bad destination mailbox address syntax
  "5.1.6": "HARD_INVALID", // Mailbox has moved, no forwarding
  "5.1.10": "HARD_INVALID", // Recipient address has null MX
  "5.2.1": "POLICY_BLOCK", // Mailbox disabled, not accepting messages
  "5.2.2": "MAILBOX_FULL",
  "5.2.3": "POLICY_BLOCK", // Message length exceeds limit
  "5.4.4": "NETWORK_ERROR", // Unable to route
  "5.5.0": "POLICY_BLOCK",
  "5.7.0": "POLICY_BLOCK", // Other or undefined security status
  "5.7.1": "POLICY_BLOCK", // Delivery not authorized
  "5.7.23": "POLICY_BLOCK", // SPF validation failed
  "5.7.26": "POLICY_BLOCK", // Multiple authentication checks failed
  "4.2.2": "MAILBOX_FULL",
  "4.4.1": "NETWORK_ERROR",
  "4.4.2": "NETWORK_ERROR",
  "4.7.0": "POLICY_BLOCK",
};

function verdict(type: BounceType): BounceVerdict {
  // Natrvalo blokovat příjemce smí JEDINÝ důvod: jeho adresa neexistuje.
  const suppressRecipient = type === "HARD_INVALID";
  const senderProblem =
    type === "REPUTATION_BLOCK" || type === "POLICY_BLOCK" || type === "SPAM_REJECTION";
  const retryable =
    type === "SOFT_TEMPORARY" ||
    type === "MAILBOX_FULL" ||
    type === "RATE_LIMIT" ||
    type === "NETWORK_ERROR";
  return { type, suppressRecipient, senderProblem, retryable, label: BOUNCE_LABELS[type] };
}

/**
 * Hlavní klasifikátor.
 *
 * Postup: nejdřív text (ten je konkrétní), pak enhanced status, pak
 * třída SMTP kódu. Když ani jedno nic neřekne, je to UNKNOWN - a to je
 * legitimní odpověď. Vymyslet si typ by tady stálo platné kontakty.
 */
export function classifyBounce(input: BounceInput): BounceVerdict {
  const haystack = [input.diagnosticCode, input.subject].filter(Boolean).join(" ");

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      const hit = verdict(rule.type);
      // 4xx u jinak trvale znějícího důvodu je pořád jen dočasné.
      const status = input.status ?? extractStatus(haystack);
      if (status?.startsWith("4.") && hit.type === "HARD_INVALID") {
        return verdict("SOFT_TEMPORARY");
      }
      return hit;
    }
  }

  const status = input.status ?? extractStatus(haystack);
  if (status && STATUS_MAP[status]) return verdict(STATUS_MAP[status]);

  const code = input.responseCode ?? extractResponseCode(haystack);

  // Dočasné selhání se pozná spolehlivě z třídy, i bez konkrétní hlášky.
  if (status?.startsWith("4.") || (code !== null && code >= 400 && code < 500)) {
    return verdict("SOFT_TEMPORARY");
  }

  // 5xx bez konkrétního důvodu: víme, že to neprošlo, a NEVÍME proč.
  // Zůstává UNKNOWN - příjemce se kvůli tomu neblokuje.
  return verdict("UNKNOWN");
}

/**
 * Která doména za to může, pokud to jde poznat.
 *
 * "poor reputation of a domain used in message transfer" nepojmenuje,
 * o kterou doménu jde - může to být odesílací doména, Return-Path,
 * DKIM d=, relay nebo doména odkazu v těle. Když to z dostupných dat
 * nejde určit, vrací se null a UI napíše "Neurčeno". Hádat by tady
 * znamenalo poslat člověka měnit špatnou DNS.
 */
export function blamedDomain(input: {
  diagnosticCode?: string | null;
  fromDomain?: string | null;
  returnPathDomain?: string | null;
  dkimDomain?: string | null;
}): { domain: string; source: string } | null {
  const text = input.diagnosticCode ?? "";
  // Server někdy doménu vyjmenuje sám.
  const named = /(?:domain|host)\s+[«"']?([a-z0-9.-]+\.[a-z]{2,})[»"']?/i.exec(text);
  if (named) return { domain: named[1].toLowerCase(), source: "uvedeno serverem" };

  // Jinak: jen když je jediný kandidát. Dvě různé domény znamenají, že
  // se nedá říct která - a tipovat se nebude.
  const candidates = [
    input.fromDomain ? { domain: input.fromDomain, source: "odesílací doména" } : null,
    input.returnPathDomain ? { domain: input.returnPathDomain, source: "Return-Path" } : null,
    input.dkimDomain ? { domain: input.dkimDomain, source: "DKIM d=" } : null,
  ].filter((c): c is { domain: string; source: string } => c !== null);

  const unique = [...new Set(candidates.map((c) => c.domain.toLowerCase()))];
  if (unique.length === 1) {
    return { domain: unique[0], source: candidates[0].source };
  }
  return null;
}
