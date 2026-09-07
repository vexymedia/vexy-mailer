import { describe, expect, it } from "vitest";
import {
  baseGapSeconds,
  followUpDueAt,
  formatSendDays,
  getZonedParts,
  hhmmToMinutes,
  isWithinWindow,
  jitteredGapSeconds,
  localDayStartUtc,
  minutesToHHMM,
  nextSlotAfter,
  nextWindowOpen,
  zonedTimeToUtc,
  type SendingWindow,
} from "@/lib/schedule";

// Mon-Fri, 08:00-16:00, Europe/Prague
const WINDOW: SendingWindow = {
  sendDays: [1, 2, 3, 4, 5],
  sendStartMinute: 8 * 60,
  sendEndMinute: 16 * 60,
  timezone: "Europe/Prague",
};

describe("getZonedParts", () => {
  it("converts a UTC instant into Prague wall-clock time in summer (UTC+2)", () => {
    const parts = getZonedParts(new Date("2025-07-15T10:30:00Z"), "Europe/Prague");
    expect(parts).toMatchObject({ year: 2025, month: 7, day: 15, hour: 12, minute: 30 });
    expect(parts.minuteOfDay).toBe(12 * 60 + 30);
  });

  it("converts in winter (UTC+1)", () => {
    const parts = getZonedParts(new Date("2025-01-15T10:30:00Z"), "Europe/Prague");
    expect(parts.hour).toBe(11);
  });

  it("reports ISO weekdays with Monday = 1 and Sunday = 7", () => {
    // 2025-07-14 is a Monday, 2025-07-20 a Sunday.
    expect(getZonedParts(new Date("2025-07-14T10:00:00Z"), "Europe/Prague").weekday).toBe(1);
    expect(getZonedParts(new Date("2025-07-20T10:00:00Z"), "Europe/Prague").weekday).toBe(7);
  });

  it("handles midnight as hour 0, not 24", () => {
    // Guards against the en-US hourCycle quirk that yields "24" for midnight.
    expect(getZonedParts(new Date("2025-07-14T22:00:00Z"), "Europe/Prague").hour).toBe(0);
  });
});

describe("zonedTimeToUtc", () => {
  it("round-trips a summer local time", () => {
    const utc = zonedTimeToUtc(2025, 7, 15, 8 * 60, "Europe/Prague");
    expect(utc.toISOString()).toBe("2025-07-15T06:00:00.000Z"); // UTC+2
  });

  it("round-trips a winter local time", () => {
    const utc = zonedTimeToUtc(2025, 1, 15, 8 * 60, "Europe/Prague");
    expect(utc.toISOString()).toBe("2025-01-15T07:00:00.000Z"); // UTC+1
  });

  it("resolves correctly on the spring-forward DST day", () => {
    // Prague switches 02:00 -> 03:00 on 2025-03-30. 08:00 local is UTC+2 already.
    const utc = zonedTimeToUtc(2025, 3, 30, 8 * 60, "Europe/Prague");
    expect(utc.toISOString()).toBe("2025-03-30T06:00:00.000Z");
    expect(getZonedParts(utc, "Europe/Prague").hour).toBe(8);
  });

  it("resolves correctly on the autumn fall-back DST day", () => {
    const utc = zonedTimeToUtc(2025, 10, 26, 8 * 60, "Europe/Prague");
    expect(getZonedParts(utc, "Europe/Prague").hour).toBe(8);
  });
});

describe("isWithinWindow", () => {
  it("accepts a Tuesday at noon local", () => {
    expect(isWithinWindow(WINDOW, new Date("2025-07-15T10:00:00Z"))).toBe(true); // 12:00 Prague
  });

  it("rejects before the window opens", () => {
    expect(isWithinWindow(WINDOW, new Date("2025-07-15T05:30:00Z"))).toBe(false); // 07:30
  });

  it("rejects at and after the closing minute", () => {
    expect(isWithinWindow(WINDOW, new Date("2025-07-15T14:00:00Z"))).toBe(false); // 16:00 exactly
    expect(isWithinWindow(WINDOW, new Date("2025-07-15T13:59:00Z"))).toBe(true); // 15:59
  });

  it("rejects weekends", () => {
    expect(isWithinWindow(WINDOW, new Date("2025-07-19T10:00:00Z"))).toBe(false); // Saturday
    expect(isWithinWindow(WINDOW, new Date("2025-07-20T10:00:00Z"))).toBe(false); // Sunday
  });
});

describe("nextWindowOpen", () => {
  it("returns the same instant when the window is already open", () => {
    const now = new Date("2025-07-15T10:00:00Z");
    expect(nextWindowOpen(WINDOW, now).getTime()).toBe(now.getTime());
  });

  it("jumps to this morning's opening when called before it", () => {
    const result = nextWindowOpen(WINDOW, new Date("2025-07-15T03:00:00Z")); // 05:00 Tue
    expect(result.toISOString()).toBe("2025-07-15T06:00:00.000Z"); // 08:00 Tue
  });

  it("jumps to tomorrow when called after the window closes", () => {
    const result = nextWindowOpen(WINDOW, new Date("2025-07-15T18:00:00Z")); // 20:00 Tue
    expect(result.toISOString()).toBe("2025-07-16T06:00:00.000Z"); // 08:00 Wed
  });

  it("skips the weekend from a Friday evening to Monday morning", () => {
    const result = nextWindowOpen(WINDOW, new Date("2025-07-18T18:00:00Z")); // Fri 20:00
    expect(result.toISOString()).toBe("2025-07-21T06:00:00.000Z"); // Mon 08:00
    expect(getZonedParts(result, "Europe/Prague").weekday).toBe(1);
  });

  it("finds the single permitted day when only one is configured", () => {
    const wednesdayOnly: SendingWindow = { ...WINDOW, sendDays: [3] };
    const result = nextWindowOpen(wednesdayOnly, new Date("2025-07-17T09:00:00Z")); // Thursday
    expect(getZonedParts(result, "Europe/Prague").weekday).toBe(3);
    expect(result.toISOString()).toBe("2025-07-23T06:00:00.000Z");
  });

  it("crosses a DST boundary without drifting the local opening hour", () => {
    // Friday 2025-10-24 evening -> Monday 2025-10-27, after the Oct 26 change.
    const result = nextWindowOpen(WINDOW, new Date("2025-10-24T18:00:00Z"));
    expect(getZonedParts(result, "Europe/Prague").hour).toBe(8);
    expect(result.toISOString()).toBe("2025-10-27T07:00:00.000Z"); // now UTC+1
  });
});

describe("pacing", () => {
  it("spreads the daily limit across the window", () => {
    // 8h window, 50 emails/day -> 576s average gap.
    expect(baseGapSeconds(WINDOW, 50)).toBe(576);
  });

  it("never returns a gap under 30 seconds even at an absurd limit", () => {
    expect(baseGapSeconds(WINDOW, 100000)).toBe(30);
    expect(jitteredGapSeconds(WINDOW, 100000, () => 0)).toBeGreaterThanOrEqual(30);
  });

  it("scales the gap between 0.6x and 1.4x of the base", () => {
    expect(jitteredGapSeconds(WINDOW, 50, () => 0)).toBe(346); // 576 * 0.6
    expect(jitteredGapSeconds(WINDOW, 50, () => 1)).toBe(806); // 576 * 1.4
    expect(jitteredGapSeconds(WINDOW, 50, () => 0.5)).toBe(576);
  });

  it("produces varied gaps across many draws, so sends never bunch up", () => {
    const gaps = new Set<number>();
    for (let i = 0; i < 200; i++) gaps.add(jitteredGapSeconds(WINDOW, 50));
    expect(gaps.size).toBeGreaterThan(50);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(346);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(806);
  });

  it("rolls the next slot into tomorrow's window when it would land after hours", () => {
    const lastSend = new Date("2025-07-15T13:58:00Z"); // 15:58 Prague, 2 min before close
    const slot = nextSlotAfter(WINDOW, 50, lastSend, () => 1); // +806s lands past 16:00
    expect(slot.toISOString()).toBe("2025-07-16T06:00:00.000Z");
  });

  it("keeps the next slot inside the same day when there is room", () => {
    const lastSend = new Date("2025-07-15T08:00:00Z"); // 10:00 Prague
    const slot = nextSlotAfter(WINDOW, 50, lastSend, () => 0.5);
    expect(slot.toISOString()).toBe("2025-07-15T08:09:36.000Z");
  });
});

describe("followUpDueAt", () => {
  it("adds the delay and keeps the time when it lands inside the window", () => {
    const previous = new Date("2025-07-15T10:00:00Z"); // Tue 12:00
    const due = followUpDueAt(WINDOW, previous, 3); // Fri 12:00
    expect(due.toISOString()).toBe("2025-07-18T10:00:00.000Z");
  });

  it("pushes a follow-up that lands on a weekend to Monday morning", () => {
    const previous = new Date("2025-07-16T10:00:00Z"); // Wed 12:00
    const due = followUpDueAt(WINDOW, previous, 3); // Sat 12:00 -> Mon 08:00
    expect(due.toISOString()).toBe("2025-07-21T06:00:00.000Z");
  });

  it("treats delay 0 as immediately due, snapped into the window", () => {
    const previous = new Date("2025-07-15T03:00:00Z"); // Tue 05:00, before open
    expect(followUpDueAt(WINDOW, previous, 0).toISOString()).toBe("2025-07-15T06:00:00.000Z");
  });
});

describe("localDayStartUtc", () => {
  it("returns local midnight, not UTC midnight", () => {
    const start = localDayStartUtc(new Date("2025-07-15T10:00:00Z"), "Europe/Prague");
    expect(start.toISOString()).toBe("2025-07-14T22:00:00.000Z");
  });

  it("keeps an early-morning UTC instant on the correct local day", () => {
    // 00:30 UTC on the 15th is already 02:30 on the 15th in Prague.
    const start = localDayStartUtc(new Date("2025-07-15T00:30:00Z"), "Europe/Prague");
    expect(start.toISOString()).toBe("2025-07-14T22:00:00.000Z");
  });
});

describe("time helpers", () => {
  it("formats and parses HH:MM symmetrically", () => {
    expect(minutesToHHMM(480)).toBe("08:00");
    expect(minutesToHHMM(960)).toBe("16:00");
    expect(hhmmToMinutes("08:00")).toBe(480);
    expect(hhmmToMinutes("16:30")).toBe(990);
  });

  it("rejects malformed times", () => {
    expect(() => hhmmToMinutes("8am")).toThrow();
    expect(() => hhmmToMinutes("25:00")).toThrow();
  });

  it("formats send days in weekday order", () => {
    expect(formatSendDays([5, 1, 3])).toBe("Mon, Wed, Fri");
  });
});
