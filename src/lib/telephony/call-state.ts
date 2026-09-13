/**
 * Stav telefonátu, bez databáze a bez Reactu.
 *
 * Sdílí se mezi prohlížečem (cockpit a lišta hovoru) a serverem (webhooky),
 * takže tady nesmí být nic, co by do klientského bundlu přitáhlo postgres.
 *
 * Záměrně je to JINÝ pojem než `CallStatus` v lib/calling.ts: ten říká, kde
 * je firma v procesu ("callback", "meeting_booked"), tenhle říká, co právě
 * dělá telefon. Splynutím obojího by vznikl stav, kterému nerozumí ani
 * jedna strana.
 */

import { CALL_OUTCOMES, isCallOutcome } from "../calling";

export type CallLifecycle =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "canceled";

export const CALL_LIFECYCLE_LABELS: Record<CallLifecycle, string> = {
  queued: "Vytáčím",
  ringing: "Vyzvání",
  in_progress: "Hovor",
  completed: "Ukončeno",
  busy: "Obsazeno",
  no_answer: "Nezvedá",
  failed: "Nepodařilo se",
  canceled: "Zrušeno",
};

/** Stavy, po kterých už se nic dalšího nestane. */
export const FINAL_CALL_LIFECYCLES: CallLifecycle[] = [
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
];

export function isFinalLifecycle(status: string): boolean {
  return FINAL_CALL_LIFECYCLES.includes(status as CallLifecycle);
}

export function isCallLifecycle(value: string): value is CallLifecycle {
  return value in CALL_LIFECYCLE_LABELS;
}

export function callLifecycleLabel(value: string | null): string {
  if (!value) return "—";
  return CALL_LIFECYCLE_LABELS[value as CallLifecycle] ?? value;
}

/**
 * Převod stavu od Twilia na náš. Twilio posílá `initiated`, `answered`
 * a další, co se do naší sady nemapují jedna ku jedné.
 */
export function lifecycleFromTwilio(status: string): CallLifecycle | null {
  switch (status.toLowerCase()) {
    case "queued":
    case "initiated":
      return "queued";
    case "ringing":
      return "ringing";
    case "answered":
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return null;
  }
}

/**
 * Pořadí, ve kterém hovor postupuje. Webhooky chodí i mimo pořadí (Twilio
 * negarantuje doručení v pořadí), takže se stav nikdy nesmí vrátit zpátky
 * z "ukončeno" na "vyzvání".
 */
const LIFECYCLE_RANK: Record<CallLifecycle, number> = {
  queued: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  busy: 3,
  no_answer: 3,
  failed: 3,
  canceled: 3,
};

export function shouldAdvanceLifecycle(current: string, next: CallLifecycle): boolean {
  const currentRank = LIFECYCLE_RANK[current as CallLifecycle] ?? 0;
  // Konečný stav se nepřepisuje jiným konečným: první, který dorazí,
  // je ten, co hovor opravdu ukončil.
  if (currentRank >= 3) return false;
  return LIFECYCLE_RANK[next] >= currentRank;
}

// ------------------------------------------------------- zpracování záznamu

export type PipelineStatus = "pending" | "processing" | "done" | "failed" | "skipped";
export type RecordingStatus = "pending" | "available" | "failed" | "disabled";

export const RECORDING_STATUS_LABELS: Record<RecordingStatus, string> = {
  pending: "Nahrávka se zpracovává…",
  available: "Nahrávka k dispozici",
  failed: "Nahrávku se nepodařilo získat",
  disabled: "Nahrávání je vypnuté",
};

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  pending: "Čeká na zpracování",
  processing: "Zpracovává se…",
  done: "Hotovo",
  failed: "Nepodařilo se",
  skipped: "Přeskočeno",
};

/**
 * Výsledek hovoru, jak ho navrhuje AI. Je to jen NÁVRH: zapsat výsledek
 * musí člověk, aby v datech bylo vždy poznat, co tvrdí model a co potvrdil
 * caller.
 */
export type CallAnalysis = {
  summary: string | null;
  outcome: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  pains: string[];
  needs: string[];
  objections: string[];
  buyingSignals: string[];
  competitorsMentioned: string[];
  timing: string | null;
  budgetMentioned: boolean | null;
  authoritySignal: string | null;
  nextStep: string | null;
  followUpAt: string | null;
  recommendedFollowUp: string | null;
  importantQuotes: string[];
};

export const EMPTY_ANALYSIS: CallAnalysis = {
  summary: null,
  outcome: null,
  sentiment: null,
  pains: [],
  needs: [],
  objections: [],
  buyingSignals: [],
  competitorsMentioned: [],
  timing: null,
  budgetMentioned: null,
  authoritySignal: null,
  nextStep: null,
  followUpAt: null,
  recommendedFollowUp: null,
  importantQuotes: [],
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 10);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Model vrací JSON, ale ne nutně ten, o který jsme si řekli. Tenhle parser
 * bere jen to, čemu rozumí, a zbytek zahodí - rozbitá analýza nesmí shodit
 * zápis hovoru, který už proběhl.
 */
export function parseAnalysis(raw: unknown): CallAnalysis {
  if (!raw || typeof raw !== "object") return { ...EMPTY_ANALYSIS };
  const data = raw as Record<string, unknown>;
  const sentiment = asString(data.sentiment)?.toLowerCase();
  return {
    summary: asString(data.summary),
    outcome: asString(data.outcome),
    sentiment:
      sentiment === "positive" || sentiment === "neutral" || sentiment === "negative"
        ? sentiment
        : null,
    pains: asStringArray(data.pains),
    needs: asStringArray(data.needs),
    objections: asStringArray(data.objections),
    buyingSignals: asStringArray(data.buyingSignals),
    competitorsMentioned: asStringArray(data.competitorsMentioned),
    timing: asString(data.timing),
    budgetMentioned: typeof data.budgetMentioned === "boolean" ? data.budgetMentioned : null,
    authoritySignal: asString(data.authoritySignal),
    nextStep: asString(data.nextStep),
    followUpAt: asString(data.followUpAt),
    recommendedFollowUp: asString(data.recommendedFollowUp),
    importantQuotes: asStringArray(data.importantQuotes),
  };
}

/**
 * Návrh výsledku z analýzy. Bere se jen hodnota, kterou doména zná -
 * model si nesmí vymyslet outcome, který v aplikaci neexistuje, jinak by
 * rozbil kadenci i frontu.
 */
export function suggestedOutcomeFrom(analysis: { outcome: string | null }): string | null {
  const value = analysis.outcome?.trim();
  if (!value) return null;
  if (isCallOutcome(value)) return value;
  // Model občas vrátí český štítek místo hodnoty. Přijmout ho je lepší
  // než zahodit celý návrh.
  const byLabel = CALL_OUTCOMES.find((outcome) => outcome.label.toLowerCase() === value.toLowerCase());
  return byLabel?.value ?? null;
}

/**
 * Chyby telefonie česky.
 *
 * Twilio hlásí věci jako "ConnectionError (31005)". To je dobré do logu,
 * ne na obrazovku člověku, který chce zavolat. Kód se drží vedle jako
 * doplněk, aby se dalo dohledat, co se stalo.
 */
const CALL_ERROR_MESSAGES: Record<number, string> = {
  // Token a oprávnění
  20101: "Přístup k telefonii vypršel. Načtěte stránku znovu.",
  20104: "Přístup k telefonii vypršel. Načtěte stránku znovu.",
  20151: "Telefonie odmítla přihlášení. Zkontrolujte nastavení Twilia.",
  // Mikrofon
  31401: "Mikrofon je zakázaný. Povolte ho v adresním řádku prohlížeče.",
  31402: "Nenašel jsem mikrofon. Připojte headset a zkuste to znovu.",
  31208: "Mikrofon je zakázaný. Povolte ho v adresním řádku prohlížeče.",
  // Spojení
  31000: "Spojení se nepodařilo navázat. Zkontrolujte připojení k internetu.",
  31003: "Spojení vypršelo. Zkuste to prosím znovu.",
  31005: "Spojení se nepodařilo navázat. Zkontrolujte připojení k internetu a zkuste to znovu.",
  31009: "Spojení se přerušilo. Zkuste to prosím znovu.",
  53000: "Spojení se přerušilo. Zkuste to prosím znovu.",
  53405: "Zvuk se nepodařilo přenést. Zkontrolujte headset a síť.",
  // Vytáčení
  13223: "Na tohle číslo nejde z vašeho Twilio účtu volat.",
  21215: "Volání do téhle země není na Twilio účtu povolené.",
  21219: "Číslo není ověřené. Na zkušebním Twilio účtu jde volat jen na ověřená čísla.",
};

/** Vytáhne číselný kód z toho, co Twilio SDK pošle. */
export function callErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = message.match(/\((\d{4,5})\)/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function callErrorMessage(error: unknown): string {
  const code = callErrorCode(error);
  if (code && CALL_ERROR_MESSAGES[code]) return CALL_ERROR_MESSAGES[code];
  return "Hovor se nepodařilo spojit. Zkuste to prosím znovu.";
}

/** Vteřiny jako 03:42. Používá se v liště i v historii. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Telefonní číslo do podoby, kterou Twilio vytočí.
 *
 * Česká čísla se zadávají různě ("777 123 456", "+420 777 123 456",
 * "00420777123456"). Vrací null, když z toho nejde udělat něco, co dává
 * smysl vytáčet - to je lepší než vytočit nesmysl.
 */
export function toE164(raw: string | null, defaultCountry = "+420"): string | null {
  if (!raw) return null;
  let value = raw.replace(/[\s ().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (!value.startsWith("+")) {
    if (/^\d{9}$/.test(value)) value = `${defaultCountry}${value}`;
    else if (/^\d{10,15}$/.test(value)) value = `+${value}`;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}
