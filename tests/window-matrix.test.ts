import { describe, expect, it } from "vitest";
import {
  explainNextSend,
  isWithinWindow,
  nextSlotAfter,
  nextWindowOpen,
  zonedTimeToUtc,
  type SendingWindow,
} from "@/lib/schedule";

/**
 * The window/DST matrix behind the production report.
 *
 * Central fact these pin down: 08:00 Europe/Prague is 06:00 UTC in summer and
 * 07:00 UTC in winter, and the conversion is done with real timezone rules
 * rather than a hard-coded offset. A value of 05:00 UTC for an 08:00 Prague
 * window is impossible, and its appearance in production meant the cursor came
 * from a different schedule - not from a DST error.
 */

const TZ = "Europe/Prague";
const WINDOW: SendingWindow = {
  sendDays: [1, 2, 3, 4, 5],
  sendStartMinute: 8 * 60,
  sendEndMinute: 16 * 60,
  timezone: TZ,
};
/** 2026-09-09 is a Wednesday, in CEST. */
const sept = (h: number, m: number) => zonedTimeToUtc(2026, 9, 9, h * 60 + m, TZ);
/** 2026-01-14 is a Wednesday, in CET. */
const jan = (h: number, m: number) => zonedTimeToUtc(2026, 1, 14, h * 60 + m, TZ);

describe("Europe/Prague during DST (CEST, UTC+2)", () => {
  it("puts the window open at 06:00 UTC, never 05:00", () => {
    expect(zonedTimeToUtc(2026, 9, 10, 8 * 60, TZ).toISOString()).toBe("2026-09-10T06:00:00.000Z");
    expect(zonedTimeToUtc(2026, 9, 10, 8 * 60, TZ).toISOString()).not.toBe("2026-09-10T05:00:00.000Z");
  });

  it("is inside the window at 15:45 local", () => {
    expect(isWithinWindow(WINDOW, sept(15, 45))).toBe(true);
    expect(nextWindowOpen(WINDOW, sept(15, 45)).getTime()).toBe(sept(15, 45).getTime());
  });

  it("rolls to the next day at 06:00 UTC once the window has closed", () => {
    expect(nextWindowOpen(WINDOW, sept(16, 30)).toISOString()).toBe("2026-09-10T06:00:00.000Z");
  });
});

describe("Europe/Prague outside DST (CET, UTC+1)", () => {
  it("puts the same 08:00 window open at 07:00 UTC", () => {
    expect(zonedTimeToUtc(2026, 1, 15, 8 * 60, TZ).toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });

  it("is inside the window at 15:45 local, exactly as in summer", () => {
    expect(isWithinWindow(WINDOW, jan(15, 45))).toBe(true);
  });

  it("rolls to the next day at 07:00 UTC once closed", () => {
    expect(nextWindowOpen(WINDOW, jan(16, 30)).toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });
});

describe("the boundary itself", () => {
  it("15:59 - one minute before close - is still inside", () => {
    expect(isWithinWindow(WINDOW, sept(15, 59))).toBe(true);
  });

  it("16:00 - exactly the end - is outside, and the end is exclusive", () => {
    expect(isWithinWindow(WINDOW, sept(16, 0))).toBe(false);
    expect(nextWindowOpen(WINDOW, sept(16, 0)).toISOString()).toBe("2026-09-10T06:00:00.000Z");
  });

  it("08:00 - exactly the start - is inside, and the start is inclusive", () => {
    expect(isWithinWindow(WINDOW, sept(8, 0))).toBe(true);
  });

  it("a send at 15:59 pushes the cursor to tomorrow, correctly converted", () => {
    // 8h / 100 per day = 288s base; even the shortest jitter passes 16:00.
    expect(nextSlotAfter(WINDOW, 100, sept(15, 59), () => 0).toISOString())
      .toBe("2026-09-10T06:00:00.000Z");
  });

  it("a send at 15:45 keeps the cursor inside today", () => {
    const slot = nextSlotAfter(WINDOW, 100, sept(15, 45), () => 1); // longest gap
    expect(slot.getTime()).toBeLessThan(sept(16, 0).getTime());
  });
});

describe("what the dashboard says matches what the worker will do", () => {
  it("reports ready when inside the window with quota and no cursor", () => {
    const result = explainNextSend(WINDOW, 100, 32, null, sept(15, 45));
    expect(result.state).toBe("ready");
    expect(result.message).toContain("32/100");
  });

  it("reports paced, in local time, for a cursor later today", () => {
    const result = explainNextSend(WINDOW, 100, 32, sept(15, 50), sept(15, 45));
    expect(result.state).toBe("paced");
    expect(result.message).toContain("15:50");
    expect(result.message).toContain(TZ);
  });

  it("partially used quota is not treated as exhausted", () => {
    expect(explainNextSend(WINDOW, 100, 32, null, sept(15, 45)).state).not.toBe("daily_limit_reached");
    expect(explainNextSend(WINDOW, 100, 99, null, sept(15, 45)).state).toBe("ready");
  });

  it("fully used quota is reported as the limiting condition", () => {
    const result = explainNextSend(WINDOW, 100, 100, null, sept(15, 45));
    expect(result.state).toBe("daily_limit_reached");
    expect(result.message).toContain("100/100");
    // The quota resets at local midnight, so it resumes at the next OPENING -
    // not at the same time of day tomorrow.
    expect(result.message).toContain("08:00");
    expect(result.message).not.toContain("15:45");
  });

  it("skips the weekend when reporting when the quota resumes", () => {
    // Friday 2026-09-11 with the limit spent: the next opening is Monday.
    const friday = zonedTimeToUtc(2026, 9, 11, 15 * 60, TZ);
    const result = explainNextSend(WINDOW, 100, 100, null, friday);
    expect(result.message).toContain("Po 14/09");
    expect(result.message).toContain("08:00");
  });

  it("names a cursor that cannot have come from the current schedule", () => {
    // The production symptom: parked past the next opening while inside the window.
    const stale = new Date("2026-09-10T05:00:00.000Z");
    const result = explainNextSend(WINDOW, 100, 32, stale, sept(15, 45));
    expect(result.state).toBe("cursor_stale");
    expect(result.message).toMatch(/pochází ze starého nastavení/i);
    // 05:00 UTC renders as 07:00 Prague - an opening from an older window,
    // which is what made the reported value look like a DST error.
    expect(result.message).toContain("07:00 Europe/Prague");
  });

  it("reports being outside the window with the next opening in local time", () => {
    const result = explainNextSend(WINDOW, 100, 0, null, sept(17, 0));
    expect(result.state).toBe("outside_window");
    expect(result.message).toContain("08:00");
  });

  it("does not flag a legitimate roll-over to tomorrow as stale", () => {
    // Sent at 15:58, cursor legitimately rolled to tomorrow's opening.
    const tomorrow = new Date("2026-09-10T06:00:00.000Z");
    const result = explainNextSend(WINDOW, 100, 40, tomorrow, sept(15, 59));
    expect(result.state).toBe("paced");
  });
});
