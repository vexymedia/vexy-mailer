/**
 * Cold calling domain rules, with no database and no React.
 *
 * Everything here is pure so the parts that decide money and persistence -
 * what a call outcome does to a prospect, who the caller phones next, and what
 * the campaign earned - can be tested directly rather than through the UI.
 *
 * Enum values are English identifiers because they are stored in the database
 * and checked by constraints. Only the labels are Czech.
 */

import type { CompanyStatus } from "./companies";

export type CallOutcome =
  | "no_answer"
  | "busy"
  | "wrong_number"
  | "gatekeeper"
  | "callback"
  | "not_interested"
  | "no_budget"
  | "not_decision_maker"
  | "send_info"
  | "meeting_booked"
  | "won"
  | "do_not_call"
  | "not_icp"
  | "existing_customer";

/**
 * What became of a booked meeting. A boolean could not tell "not yet" from
 * "they never turned up", and a pilot billed on held meetings has to know
 * which of the two it is looking at.
 */
export type MeetingOutcome = "scheduled" | "held" | "no_show" | "cancelled";

export const MEETING_OUTCOME_LABELS: Record<MeetingOutcome, string> = {
  scheduled: "Naplánovaná",
  held: "Uskutečněná",
  no_show: "Nedorazil",
  cancelled: "Zrušená",
};

export type CallStatus =
  | "new"
  | "in_progress"
  | "callback"
  | "meeting_booked"
  | "won"
  | "lost"
  | "do_not_call"
  | "max_attempts";

/** What extra input the caller must give before the outcome can be saved. */
export type OutcomeRequirement = "callback_at" | "meeting_at" | null;

export interface CallOutcomeDefinition {
  value: CallOutcome;
  /**
   * Zobrazuje se jako hlavní tlačítko. Pět nejčastějších výsledků pokrývá
   * drtivou většinu hovorů; zbytek je schválně o klik dál, aby caller
   * nevybíral z dvanácti možností při každém hovoru.
   */
  primary?: boolean;
  /**
   * Za kolik pracovních dní zkusit znovu, pokud výsledek nechal firmu
   * otevřenou. Bez toho by "nezvedá" skončilo jako aktivní firma bez
   * dalšího kroku - přesně ta díra, kterou tenhle produkt řeší.
   */
  retryWorkingDays?: number;
  /** Stav, který výsledek propisuje do firmy. */
  companyStatus: CompanyStatus;
  /** Czech label shown on the button in the caller's workspace. */
  label: string;
  /** Did we actually speak to the person? This is the billable unit. */
  connected: boolean;
  requires: OutcomeRequirement;
  /**
   * The call_status this outcome puts the prospect in. `null` means "keep
   * working it": the prospect goes back into the queue as in_progress, unless
   * the attempt limit has been reached.
   */
  status: CallStatus | null;
}

/**
 * The outcomes, ordered as the caller thinks about them: could not reach,
 * reached but this is not the person, reached and it leads somewhere,
 * reached and it is over.
 */
export const CALL_OUTCOMES: CallOutcomeDefinition[] = [
  // Nedovoláno - firma zůstává otevřená a dostane další pokus.
  { value: "no_answer", label: "Nezastižen", connected: false, requires: null, primary: true,
    status: null, retryWorkingDays: 1, companyStatus: "in_progress" },
  { value: "busy", label: "Nebere telefon", connected: false, requires: null, primary: true,
    status: null, retryWorkingDays: 1, companyStatus: "in_progress" },
  { value: "gatekeeper", label: "Nepustili mě dál", connected: false, requires: null,
    status: null, retryWorkingDays: 2, companyStatus: "in_progress" },

  // Dovoláno, ale tenhle člověk to není.
  { value: "wrong_number", label: "Špatný kontakt", connected: false, requires: null,
    status: "lost", companyStatus: "in_progress" },
  { value: "not_decision_maker", label: "Není rozhodovatel", connected: true, requires: null,
    status: null, retryWorkingDays: 2, companyStatus: "in_progress" },

  // Dovoláno a někam to vede.
  { value: "send_info", label: "Zájem — poslat informace", connected: true, requires: null,
    primary: true, status: null, retryWorkingDays: 3, companyStatus: "interested" },
  { value: "callback", label: "Volat jindy", connected: true, requires: "callback_at",
    primary: true, status: "callback", companyStatus: "in_progress" },
  { value: "meeting_booked", label: "Schůzka sjednána", connected: true, requires: "meeting_at",
    primary: true, status: "meeting_booked", companyStatus: "meeting" },
  { value: "won", label: "Získaný klient", connected: true, requires: null,
    status: "won", companyStatus: "won" },

  // Uzavřeno negativně - další krok se neplánuje.
  { value: "not_interested", label: "Nemá zájem", connected: true, requires: null,
    status: "lost", companyStatus: "lost" },
  { value: "no_budget", label: "Nemá rozpočet", connected: true, requires: null,
    status: "lost", companyStatus: "lost" },
  { value: "not_icp", label: "Není ICP", connected: true, requires: null,
    status: "lost", companyStatus: "lost" },
  { value: "existing_customer", label: "Již zákazník", connected: true, requires: null,
    status: "lost", companyStatus: "won" },
  { value: "do_not_call", label: "Nekontaktovat", connected: true, requires: null,
    status: "do_not_call", companyStatus: "excluded" },
];

const OUTCOME_BY_VALUE = new Map(CALL_OUTCOMES.map((o) => [o.value, o]));

/** Výsledky na hlavních tlačítkách. */
export const PRIMARY_CALL_OUTCOMES = CALL_OUTCOMES.filter((o) => o.primary);
/** Zbytek, schovaný pod "Další výsledky". */
export const SECONDARY_CALL_OUTCOMES = CALL_OUTCOMES.filter((o) => !o.primary);

export function isMeetingOutcome(value: string): value is MeetingOutcome {
  return value in MEETING_OUTCOME_LABELS;
}

export function isCallOutcome(value: string): value is CallOutcome {
  return OUTCOME_BY_VALUE.has(value as CallOutcome);
}

export function callOutcome(value: CallOutcome): CallOutcomeDefinition {
  const found = OUTCOME_BY_VALUE.get(value);
  if (!found) throw new Error(`Unknown call outcome: ${value}`);
  return found;
}

export function callOutcomeLabel(value: string | null): string {
  if (!value) return "—";
  return OUTCOME_BY_VALUE.get(value as CallOutcome)?.label ?? value;
}

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  new: "Nevolaný",
  in_progress: "Rozvolaný",
  callback: "Callback",
  meeting_booked: "Schůzka domluvena",
  won: "Získaný klient",
  lost: "Ztracený",
  do_not_call: "Nevolat",
  max_attempts: "Vyčerpané pokusy",
};

export function callStatusLabel(value: string | null): string {
  if (!value) return "—";
  return CALL_STATUS_LABELS[value as CallStatus] ?? value;
}

/**
 * Statuses that take a prospect out of the calling queue for good. A caller
 * never sees these again, whatever their attempt count says.
 */
export const CLOSED_CALL_STATUSES: CallStatus[] = [
  "meeting_booked",
  "won",
  "lost",
  "do_not_call",
  "max_attempts",
];

export function isClosedCallStatus(status: CallStatus): boolean {
  return CLOSED_CALL_STATUSES.includes(status);
}

// ------------------------------------------------------- applying an outcome

const MS_PER_DAY = 86_400_000;

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Kdy zkusit znovu, počítáno v pracovních dnech.
 *
 * Vrací půlnoc cílového dne, ne "za 24 hodin". Hovor v 16:00 s odkladem
 * jeden pracovní den má být ve frontě hned ráno druhý den, ne až odpoledne -
 * jinak by callerovi ráno fronta vypadala prázdně a odpoledne by mu naskočilo
 * třicet firem naráz.
 */
export function nextAttemptAt(from: Date, workingDays: number): Date {
  const date = new Date(from.getTime());
  date.setHours(0, 0, 0, 0);
  let remaining = Math.max(1, Math.round(workingDays));
  while (remaining > 0) {
    date.setTime(date.getTime() + MS_PER_DAY);
    date.setHours(0, 0, 0, 0); // přechod letního času nesmí posunout půlnoc
    if (!isWeekend(date)) remaining -= 1;
  }
  return date;
}

export interface CallResultInput {
  outcome: CallOutcome;
  /** Attempts made BEFORE this call. */
  attemptsBefore: number;
  maxAttempts: number;
  callbackAt?: Date | null;
  meetingAt?: Date | null;
  /** Whether the booked meeting meets the campaign's qualification criteria. */
  meetingQualified?: boolean | null;
  /** Kdy hovor proběhl. Injektované kvůli testovatelnosti kadence. */
  now?: Date;
}

export interface CallResult {
  attempts: number;
  status: CallStatus;
  connected: boolean;
  nextCallAt: Date | null;
  meetingBooked: boolean;
  meetingAt: Date | null;
  meetingQualified: boolean | null;
  /** Stav, který se má propsat do firmy (přes nextCompanyStatus). */
  companyStatus: CompanyStatus;
}

/**
 * The one place that decides what a logged call does to a prospect.
 *
 * Two rules matter more than the rest:
 *
 * 1. Výsledek, který nechá firmu otevřenou, VŽDY nastaví další krok.
 *    "Nezastižen" bez data dalšího pokusu je přesně ta díra, kvůli které
 *    firmy tiše vypadnou z procesu - a kterou tenhle produkt řeší.
 * 2. The attempt limit only ever applies to outcomes that leave the prospect
 *    open. A booked meeting on the fifth attempt is a booked meeting, not a
 *    prospect who ran out of attempts.
 */
export function applyCallOutcome(input: CallResultInput): CallResult {
  const definition = callOutcome(input.outcome);
  const attempts = input.attemptsBefore + 1;
  const now = input.now ?? new Date();

  if (definition.status !== null) {
    return {
      attempts,
      status: definition.status,
      connected: definition.connected,
      nextCallAt: definition.status === "callback" ? (input.callbackAt ?? null) : null,
      meetingBooked: definition.status === "meeting_booked",
      meetingAt: definition.status === "meeting_booked" ? (input.meetingAt ?? null) : null,
      meetingQualified:
        definition.status === "meeting_booked" ? (input.meetingQualified ?? null) : null,
      companyStatus: definition.companyStatus,
    };
  }

  // Still open. Either keep it in the queue with a concrete next attempt, or
  // retire it because the campaign says this many attempts is enough.
  const exhausted = attempts >= input.maxAttempts;
  if (exhausted) {
    return {
      attempts,
      status: "max_attempts",
      connected: definition.connected,
      nextCallAt: null,
      meetingBooked: false,
      meetingAt: null,
      meetingQualified: null,
      // Vyčerpané pokusy znamenají, že další krok nikdo neplánuje. Firma se
      // proto zavírá - s výjimkou zájmu, který si zaslouží člověka, ne
      // automatické odepsání.
      companyStatus: definition.companyStatus === "interested" ? "interested" : "lost",
    };
  }

  return {
    attempts,
    status: "in_progress",
    connected: definition.connected,
    nextCallAt: nextAttemptAt(now, definition.retryWorkingDays ?? 1),
    meetingBooked: false,
    meetingAt: null,
    meetingQualified: null,
    companyStatus: definition.companyStatus,
  };
}

// ----------------------------------------------------------------- the queue

export interface QueueCandidate {
  id: string;
  call_status: CallStatus;
  call_attempts: number;
  next_call_at: Date | null;
  created_at: Date;
}

/**
 * Je kontakt splatný? Další krok v budoucnu znamená "ještě to není práce",
 * a to bez ohledu na stav - od zavedení kadence má datum i `in_progress`.
 */
export function isCallDue(candidate: QueueCandidate, now: Date): boolean {
  return !candidate.next_call_at || candidate.next_call_at.getTime() <= now.getTime();
}

/** Lower is dialled first. Matches the ORDER BY used by the queue query. */
export function queuePriority(candidate: QueueCandidate, now: Date): number {
  // Naplánováno na později = dnes se nevolá. Dřív to platilo jen pro
  // callbacky, protože jen ty měly datum; teď ho má každý otevřený kontakt.
  if (!isCallDue(candidate, now)) return 3;
  if (candidate.call_status === "callback") return 0;
  if (candidate.call_status === "in_progress") return 1;
  if (candidate.call_status === "new") return 2;
  return 4;
}

/**
 * Orders a calling queue: callbacks due now, then prospects still under the
 * attempt limit (fewest attempts first, so nobody is dialled a fourth time
 * while others wait for their first), then untouched contacts.
 */
export function orderCallQueue<T extends QueueCandidate>(candidates: T[], now: Date): T[] {
  return [...candidates].sort((a, b) => {
    const byPriority = queuePriority(a, now) - queuePriority(b, now);
    if (byPriority !== 0) return byPriority;
    if (a.call_attempts !== b.call_attempts) return a.call_attempts - b.call_attempts;
    const aDue = a.next_call_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.next_call_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;
    const byAge = a.created_at.getTime() - b.created_at.getTime();
    if (byAge !== 0) return byAge;
    // The unique tiebreak, matching the ORDER BY in listCallQueue. A batch
    // added by one INSERT ... SELECT shares a created_at, so without this the
    // order of those rows is whatever the storage engine feels like.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ------------------------------------------------------------------ funnel

export interface CallCounts {
  contacts: number;
  called: number;
  connected_contacts: number;
  connected_calls: number;
  meetings_booked: number;
  /** Booked meetings the caller judged to meet the campaign's criteria. */
  meetings_qualified: number;
  meetings_held: number;
  /** Booked, the date passed, nobody turned up. Not a held meeting. */
  meetings_no_show: number;
  clients_won: number;
}

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  /** Share of the previous stage, 0-1. Null for the first stage. */
  conversion: number | null;
}

/**
 * Contacts -> called -> connected -> meeting booked -> meeting held -> client.
 * Each rate is against the stage above it, which is the only reading that
 * tells a caller where the campaign is actually leaking.
 */
export function buildFunnel(counts: CallCounts): FunnelStage[] {
  const stages: { key: string; label: string; value: number }[] = [
    { key: "contacts", label: "Kontakty", value: counts.contacts },
    { key: "called", label: "Volané", value: counts.called },
    { key: "connected", label: "Dovolané", value: counts.connected_contacts },
    { key: "meetings_booked", label: "Domluvené schůzky", value: counts.meetings_booked },
    { key: "meetings_qualified", label: "Kvalifikované schůzky", value: counts.meetings_qualified },
    { key: "meetings_held", label: "Uskutečněné schůzky", value: counts.meetings_held },
    { key: "clients_won", label: "Získaní klienti", value: counts.clients_won },
  ];
  return stages.map((stage, index) => {
    const previous = index === 0 ? null : stages[index - 1].value;
    return {
      ...stage,
      conversion: previous === null ? null : previous > 0 ? stage.value / previous : 0,
    };
  });
}

// --------------------------------------------------------------- economics

export type RevenueModel =
  | "deal_values"
  | "fixed"
  | "per_meeting_booked"
  | "per_qualified_meeting"
  | "per_meeting_held"
  | "per_client";

export type CallerCostModel = "none" | "fixed" | "hourly" | "per_connected_call";

export const REVENUE_MODEL_LABELS: Record<RevenueModel, string> = {
  deal_values: "Součet hodnot uzavřených obchodů",
  fixed: "Pevná částka za kampaň",
  per_meeting_booked: "Za domluvenou schůzku",
  per_qualified_meeting: "Za kvalifikovanou schůzku",
  per_meeting_held: "Za uskutečněnou schůzku",
  per_client: "Za získaného klienta",
};

export const CALLER_COST_MODEL_LABELS: Record<CallerCostModel, string> = {
  none: "Žádný náklad na callera",
  fixed: "Pevná částka za kampaň",
  hourly: "Hodinová sazba",
  per_connected_call: "Za dovolaný hovor",
};

export interface EconomicsConfig {
  revenue_model: RevenueModel;
  revenue_amount: number;
  caller_cost_model: CallerCostModel;
  caller_cost_amount: number;
  caller_hours: number;
  additional_costs: number;
}

export interface EconomicsInput extends EconomicsConfig {
  counts: CallCounts;
  /** Sum of deal_value across won prospects. */
  revenue_won: number;
}

export interface Economics {
  revenue: number;
  caller_cost: number;
  total_cost: number;
  gross_profit: number;
  /** 0-1, or null when there is no revenue to take a margin of. */
  gross_margin: number | null;
  cost_per_connected_call: number | null;
  cost_per_booked_meeting: number | null;
  /** The number VEXY bills on: cost of producing one qualified meeting. */
  cost_per_qualified_meeting: number | null;
  cost_per_held_meeting: number | null;
  clients_won: number;
  revenue_won: number;
  /** Customer acquisition cost. */
  cac: number | null;
  /** Return on ad spend: revenue per koruna spent. */
  roas: number | null;
  revenue_per_connected_call: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Rounds money to halers so repeated division cannot drift. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeEconomics(input: EconomicsInput): Economics {
  const c = input.counts;

  const revenue = money(
    input.revenue_model === "fixed"
      ? input.revenue_amount
      : input.revenue_model === "per_meeting_booked"
        ? input.revenue_amount * c.meetings_booked
        : input.revenue_model === "per_qualified_meeting"
          ? input.revenue_amount * c.meetings_qualified
          : input.revenue_model === "per_meeting_held"
            ? input.revenue_amount * c.meetings_held
            : input.revenue_model === "per_client"
              ? input.revenue_amount * c.clients_won
              : input.revenue_won,
  );

  const callerCost = money(
    input.caller_cost_model === "fixed"
      ? input.caller_cost_amount
      : input.caller_cost_model === "hourly"
        ? input.caller_cost_amount * input.caller_hours
        : input.caller_cost_model === "per_connected_call"
          ? input.caller_cost_amount * c.connected_calls
          : 0,
  );

  const totalCost = money(callerCost + input.additional_costs);
  const grossProfit = money(revenue - totalCost);

  return {
    revenue,
    caller_cost: callerCost,
    total_cost: totalCost,
    gross_profit: grossProfit,
    gross_margin: ratio(grossProfit, revenue),
    cost_per_connected_call: ratio(totalCost, c.connected_calls),
    cost_per_booked_meeting: ratio(totalCost, c.meetings_booked),
    cost_per_qualified_meeting: ratio(totalCost, c.meetings_qualified),
    cost_per_held_meeting: ratio(totalCost, c.meetings_held),
    clients_won: c.clients_won,
    revenue_won: money(input.revenue_won),
    cac: ratio(totalCost, c.clients_won),
    roas: ratio(revenue, totalCost),
    revenue_per_connected_call: ratio(revenue, c.connected_calls),
  };
}

// ------------------------------------------------------------- formatting

/** Czech money formatting, used everywhere a koruna amount is shown. */
export function formatCzk(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 }).format(Math.round(value))} Kč`;
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)} %`;
}

export function formatRatio(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}
