/**
 * All sending-window and pacing arithmetic.
 *
 * Timezone handling uses Intl only - no date library. The one subtle piece is
 * converting a local wall-clock time in an IANA zone to a UTC instant, which
 * needs a two-pass offset resolution to be correct across DST transitions.
 */

export interface SendingWindow {
  /** ISO weekday numbers, 1 = Monday .. 7 = Sunday */
  sendDays: number[];
  /** Minutes from local midnight */
  sendStartMinute: number;
  sendEndMinute: number;
  timezone: string;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday .. 7 = Sunday */
  weekday: number;
  /** Minutes elapsed since local midnight */
  minuteOfDay: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

/** Throws if the timezone is not a valid IANA identifier. */
export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function getZonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(instant);
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = lookup;
  // Weekday derived arithmetically from the local calendar date, which avoids
  // depending on locale-specific weekday names.
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: jsDay === 0 ? 7 : jsDay,
    minuteOfDay: hour * 60 + minute,
  };
}

/** Offset of `timezone` at `instant`, in ms (local wall clock minus UTC). */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const p = getZonedParts(instant, timezone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to the second: formatToParts has no sub-second precision.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Converts a local wall-clock time in `timezone` to the corresponding UTC
 * instant. Two passes so that times near a DST change resolve correctly.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minuteOfDay * 60_000;
  let offset = zoneOffsetMs(new Date(naive), timezone);
  let resolved = naive - offset;
  offset = zoneOffsetMs(new Date(resolved), timezone);
  resolved = naive - offset;
  return new Date(resolved);
}

export function isSendDay(window: SendingWindow, instant: Date): boolean {
  return window.sendDays.includes(getZonedParts(instant, window.timezone).weekday);
}

/** True when `instant` falls on a sending day and inside the daily hours. */
export function isWithinWindow(window: SendingWindow, instant: Date): boolean {
  const parts = getZonedParts(instant, window.timezone);
  if (!window.sendDays.includes(parts.weekday)) return false;
  return parts.minuteOfDay >= window.sendStartMinute && parts.minuteOfDay < window.sendEndMinute;
}

/**
 * The next instant at or after `from` when the window is open.
 * Returns `from` itself when the window is already open.
 * Looks ahead at most 14 days, which covers any legal sendDays combination.
 */
export function nextWindowOpen(window: SendingWindow, from: Date): Date {
  if (isWithinWindow(window, from)) return from;

  const parts = getZonedParts(from, window.timezone);
  for (let offset = 0; offset <= 14; offset++) {
    const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + offset * 86_400_000);
    const probeParts = getZonedParts(probe, "UTC");
    const candidate = zonedTimeToUtc(
      probeParts.year,
      probeParts.month,
      probeParts.day,
      window.sendStartMinute,
      window.timezone,
    );
    // Confirm against the real local calendar: DST can shift which local day
    // this instant lands on.
    const candidateParts = getZonedParts(candidate, window.timezone);
    if (!window.sendDays.includes(candidateParts.weekday)) continue;
    if (candidate.getTime() >= from.getTime()) return candidate;
  }
  throw new Error("Could not find an open sending window within 14 days");
}

/** UTC instant of local midnight for the local day containing `instant`. */
export function localDayStartUtc(instant: Date, timezone: string): Date {
  const p = getZonedParts(instant, timezone);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, timezone);
}

export function windowLengthSeconds(window: SendingWindow): number {
  return (window.sendEndMinute - window.sendStartMinute) * 60;
}

/**
 * Average seconds between two sends needed to spread `dailyLimit` messages
 * across the window. Floored at 30s so a pathological config can never
 * produce a burst.
 */
export function baseGapSeconds(window: SendingWindow, dailyLimit: number): number {
  if (dailyLimit <= 0) return windowLengthSeconds(window);
  return Math.max(30, Math.floor(windowLengthSeconds(window) / dailyLimit));
}

/**
 * Randomised gap between consecutive sends: the base gap scaled by 0.6-1.4.
 * `random` is injectable so the behaviour is testable.
 */
export function jitteredGapSeconds(
  window: SendingWindow,
  dailyLimit: number,
  random: () => number = Math.random,
): number {
  const base = baseGapSeconds(window, dailyLimit);
  const scaled = Math.round(base * (0.6 + random() * 0.8));
  return Math.max(30, scaled);
}

/**
 * When the campaign may send again after a send at `sentAt`.
 * If the jittered slot lands past the end of today's window it rolls to the
 * next open window rather than firing at the boundary.
 */
export function nextSlotAfter(
  window: SendingWindow,
  dailyLimit: number,
  sentAt: Date,
  random: () => number = Math.random,
): Date {
  const gapMs = jitteredGapSeconds(window, dailyLimit, random) * 1000;
  const candidate = new Date(sentAt.getTime() + gapMs);
  return nextWindowOpen(window, candidate);
}

/**
 * Due time for a follow-up: `delayDays` after the previous send, pulled
 * forward/pushed back into the nearest open window.
 */
export function followUpDueAt(window: SendingWindow, previousSentAt: Date, delayDays: number): Date {
  const target = new Date(previousSentAt.getTime() + delayDays * 86_400_000);
  return nextWindowOpen(window, target);
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function hhmmToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time, expected HH:MM: ${value}`);
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59 || hours * 60 + mins > 1440) {
    throw new Error(`Time out of range: ${value}`);
  }
  return hours * 60 + mins;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function formatSendDays(days: number[]): string {
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d - 1]).join(", ");
}

/**
 * Explains, in one line, what the sending engine will do next for a campaign.
 *
 * Deliberately built from the same primitives the dispatcher uses - the same
 * window check, the same pacing cursor, the same daily counter - so the
 * dashboard cannot claim one thing while the worker does another. It also
 * renders times in the campaign's own timezone: the raw UTC instant is what
 * made a stale cursor so hard to recognise.
 */
export interface NextSendExplanation {
  state: "outside_window" | "paced" | "daily_limit_reached" | "ready" | "cursor_stale";
  message: string;
}

export function explainNextSend(
  window: SendingWindow,
  dailyLimit: number,
  sentToday: number,
  nextSlotAt: Date | null,
  now: Date = new Date(),
): NextSendExplanation {
  const local = (instant: Date) => {
    const p = getZonedParts(instant, window.timezone);
    const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    const sameDay =
      p.year === getZonedParts(now, window.timezone).year &&
      p.month === getZonedParts(now, window.timezone).month &&
      p.day === getZonedParts(now, window.timezone).day;
    const date = sameDay
      ? "today"
      : `${WEEKDAY_LABELS[p.weekday - 1]} ${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`;
    return `${date} ${time} ${window.timezone}`;
  };

  if (!isWithinWindow(window, now)) {
    return {
      state: "outside_window",
      message: `Outside the sending window. Opens ${local(nextWindowOpen(window, now))}.`,
    };
  }

  if (sentToday >= dailyLimit) {
    // The quota resets at local midnight, so the campaign resumes at the next
    // window OPENING after that - not 24 hours from now, which would land at
    // whatever time of day it happens to be.
    const today = getZonedParts(now, window.timezone);
    const tomorrow = getZonedParts(
      new Date(Date.UTC(today.year, today.month - 1, today.day) + 86_400_000),
      "UTC",
    );
    const resumesAt = nextWindowOpen(
      window,
      zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, window.timezone),
    );
    return {
      state: "daily_limit_reached",
      message: `Daily limit reached (${sentToday}/${dailyLimit}). Resumes ${local(resumesAt)}.`,
    };
  }

  if (nextSlotAt && nextSlotAt.getTime() > now.getTime()) {
    // nextSlotAfter can only ever produce an instant that is inside a sending
    // window, or exactly at a window opening. Anything else was computed from a
    // schedule that no longer applies - which is precisely how a campaign ends
    // up parked past its own window with quota and contacts to spare.
    const legitimate = nextWindowOpen(window, nextSlotAt).getTime() === nextSlotAt.getTime();
    if (!legitimate) {
      return {
        state: "cursor_stale",
        message:
          `Paced until ${local(nextSlotAt)}, which is not a valid time under the current schedule. ` +
          "The pacing cursor predates the current settings - save the campaign settings to clear it.",
      };
    }
    return { state: "paced", message: `Inside the window. Next send no earlier than ${local(nextSlotAt)}.` };
  }

  return {
    state: "ready",
    message: `Inside the window and ready to send (${sentToday}/${dailyLimit} used today).`,
  };
}
