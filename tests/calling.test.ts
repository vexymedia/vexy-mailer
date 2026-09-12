import { describe, expect, it } from "vitest";
import {
  applyCallOutcome,
  buildFunnel,
  computeEconomics,
  CALL_OUTCOMES,
  orderCallQueue,
  queuePriority,
  type CallCounts,
} from "@/lib/calling";

/**
 * The calling rules that decide persistence and money, tested without a
 * database: what an outcome does to a prospect, who gets dialled next, and
 * what the campaign earned.
 */

const NOW = new Date("2026-09-11T09:00:00Z");

describe("the twelve call outcomes", () => {
  it("has exactly twelve, each with a unique value", () => {
    expect(CALL_OUTCOMES).toHaveLength(12);
    expect(new Set(CALL_OUTCOMES.map((o) => o.value)).size).toBe(12);
  });

  it("only asks for a date on the two outcomes that schedule something", () => {
    const needDates = CALL_OUTCOMES.filter((o) => o.requires !== null).map((o) => o.value);
    expect(needDates.sort()).toEqual(["callback", "meeting_booked"]);
  });

  it("counts as connected exactly the outcomes where a human was reached", () => {
    const notConnected = CALL_OUTCOMES.filter((o) => !o.connected).map((o) => o.value).sort();
    expect(notConnected).toEqual(["busy", "gatekeeper", "no_answer", "wrong_number"]);
  });
});

describe("an attempt always counts", () => {
  it("increments the attempt counter whatever the outcome", () => {
    for (const outcome of CALL_OUTCOMES) {
      const result = applyCallOutcome({
        outcome: outcome.value,
        attemptsBefore: 2,
        maxAttempts: 4,
        callbackAt: NOW,
        meetingAt: NOW,
      });
      expect(result.attempts, outcome.value).toBe(3);
    }
  });
});

describe("the four-attempt limit", () => {
  it("keeps a prospect open below the limit and retires them at it", () => {
    const under = applyCallOutcome({ outcome: "no_answer", attemptsBefore: 2, maxAttempts: 4 });
    expect(under.status).toBe("in_progress");

    const at = applyCallOutcome({ outcome: "no_answer", attemptsBefore: 3, maxAttempts: 4 });
    expect(at.attempts).toBe(4);
    expect(at.status).toBe("max_attempts");
  });

  it("never retires a prospect whose outcome decided something", () => {
    // The fourth attempt books a meeting. That is a meeting, not a prospect
    // who ran out of attempts - conflating the two would lose a booking.
    const booked = applyCallOutcome({
      outcome: "meeting_booked",
      attemptsBefore: 3,
      maxAttempts: 4,
      meetingAt: new Date("2026-09-15T10:00:00Z"),
      meetingQualified: true,
    });
    expect(booked.status).toBe("meeting_booked");
    expect(booked.meetingBooked).toBe(true);
    expect(booked.meetingQualified).toBe(true);

    for (const outcome of ["won", "not_interested", "do_not_call"] as const) {
      expect(applyCallOutcome({ outcome, attemptsBefore: 9, maxAttempts: 4 }).status).not.toBe(
        "max_attempts",
      );
    }
  });
});

describe("callbacks", () => {
  it("stores the requested time as the next action", () => {
    const when = new Date("2026-09-12T10:00:00Z");
    const result = applyCallOutcome({
      outcome: "callback",
      attemptsBefore: 0,
      maxAttempts: 4,
      callbackAt: when,
    });
    expect(result.status).toBe("callback");
    expect(result.nextCallAt).toEqual(when);
  });

  it("does not leave a next action behind on any other outcome", () => {
    for (const outcome of CALL_OUTCOMES.filter((o) => o.value !== "callback")) {
      const result = applyCallOutcome({
        outcome: outcome.value,
        attemptsBefore: 0,
        maxAttempts: 4,
        callbackAt: new Date("2026-09-12T10:00:00Z"),
        meetingAt: new Date("2026-09-12T10:00:00Z"),
      });
      expect(result.nextCallAt, outcome.value).toBeNull();
    }
  });
});

describe("meetings and qualification", () => {
  it("records the meeting time and the qualification judgement", () => {
    const when = new Date("2026-09-20T08:30:00Z");
    const result = applyCallOutcome({
      outcome: "meeting_booked",
      attemptsBefore: 1,
      maxAttempts: 4,
      meetingAt: when,
      meetingQualified: false,
    });
    expect(result.meetingAt).toEqual(when);
    expect(result.meetingQualified).toBe(false);
  });

  it("leaves qualification unjudged when the caller did not say", () => {
    const result = applyCallOutcome({
      outcome: "meeting_booked",
      attemptsBefore: 0,
      maxAttempts: 4,
      meetingAt: new Date("2026-09-20T08:30:00Z"),
    });
    expect(result.meetingQualified).toBeNull();
  });
});

describe("the calling queue order", () => {
  const base = { created_at: new Date("2026-09-01T00:00:00Z") };

  it("puts a due callback first, then started prospects, then untouched ones", () => {
    const queue = orderCallQueue(
      [
        { ...base, id: "new", call_status: "new" as const, call_attempts: 0, next_call_at: null },
        { ...base, id: "started", call_status: "in_progress" as const, call_attempts: 2, next_call_at: null },
        {
          ...base,
          id: "callback-due",
          call_status: "callback" as const,
          call_attempts: 1,
          next_call_at: new Date("2026-09-11T08:00:00Z"),
        },
      ],
      NOW,
    );
    expect(queue.map((row) => row.id)).toEqual(["callback-due", "started", "new"]);
  });

  it("sends a callback that is not due yet to the back of the queue", () => {
    const future = {
      ...base,
      id: "later",
      call_status: "callback" as const,
      call_attempts: 1,
      next_call_at: new Date("2026-09-11T17:00:00Z"),
    };
    expect(queuePriority(future, NOW)).toBeGreaterThan(
      queuePriority({ ...base, id: "new", call_status: "new", call_attempts: 0, next_call_at: null }, NOW),
    );
  });

  it("settles a tie on id, so a batch sharing one timestamp has one order", () => {
    const same = { ...base, call_status: "new" as const, call_attempts: 0, next_call_at: null };
    const queue = orderCallQueue(
      [{ ...same, id: "ccc" }, { ...same, id: "aaa" }, { ...same, id: "bbb" }],
      NOW,
    );
    expect(queue.map((row) => row.id)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("dials the least-attempted prospect first within the same state", () => {
    const queue = orderCallQueue(
      [
        { ...base, id: "three", call_status: "in_progress" as const, call_attempts: 3, next_call_at: null },
        { ...base, id: "one", call_status: "in_progress" as const, call_attempts: 1, next_call_at: null },
      ],
      NOW,
    );
    expect(queue.map((row) => row.id)).toEqual(["one", "three"]);
  });
});

const COUNTS: CallCounts = {
  contacts: 300,
  called: 250,
  connected_contacts: 120,
  connected_calls: 125,
  meetings_booked: 20,
  meetings_qualified: 15,
  meetings_held: 12,
  meetings_no_show: 4,
  clients_won: 3,
};

describe("the funnel", () => {
  it("converts each stage against the one above it", () => {
    const funnel = buildFunnel(COUNTS);
    expect(funnel.map((s) => s.key)).toEqual([
      "contacts",
      "called",
      "connected",
      "meetings_booked",
      "meetings_qualified",
      "meetings_held",
      "clients_won",
    ]);
    expect(funnel[0].conversion).toBeNull();
    expect(funnel[1].conversion).toBeCloseTo(250 / 300);
    expect(funnel[2].conversion).toBeCloseTo(120 / 250);
    expect(funnel[4].conversion).toBeCloseTo(15 / 20);
  });

  it("reports 0 % rather than dividing by zero on an empty campaign", () => {
    const empty = buildFunnel({
      contacts: 0,
      called: 0,
      connected_contacts: 0,
      connected_calls: 0,
      meetings_booked: 0,
      meetings_qualified: 0,
      meetings_held: 0,
      meetings_no_show: 0,
      clients_won: 0,
    });
    expect(empty.every((s) => s.conversion === null || s.conversion === 0)).toBe(true);
  });
});

describe("campaign economics", () => {
  it("prices the VEXY acquisition campaign: 125 connected calls at 40 Kc", () => {
    const economics = computeEconomics({
      revenue_model: "deal_values",
      revenue_amount: 0,
      caller_cost_model: "per_connected_call",
      caller_cost_amount: 40,
      caller_hours: 0,
      additional_costs: 0,
      counts: COUNTS,
      revenue_won: 0,
    });
    expect(economics.caller_cost).toBe(5000);
    expect(economics.total_cost).toBe(5000);
    expect(economics.cost_per_connected_call).toBe(40);
    expect(economics.cost_per_booked_meeting).toBe(250);
    expect(economics.cost_per_qualified_meeting).toBeCloseTo(5000 / 15);
  });

  it("works out profit, margin, CAC and ROAS from the deal values won", () => {
    const economics = computeEconomics({
      revenue_model: "deal_values",
      revenue_amount: 0,
      caller_cost_model: "per_connected_call",
      caller_cost_amount: 40,
      caller_hours: 0,
      additional_costs: 1000,
      counts: COUNTS,
      revenue_won: 90_000,
    });
    expect(economics.revenue).toBe(90_000);
    expect(economics.total_cost).toBe(6000);
    expect(economics.gross_profit).toBe(84_000);
    expect(economics.gross_margin).toBeCloseTo(84_000 / 90_000);
    expect(economics.cac).toBe(2000); // 6000 / 3 clients
    expect(economics.roas).toBe(15); // 90 000 / 6 000
    expect(economics.revenue_per_connected_call).toBeCloseTo(720);
  });

  it("bills a client pilot per qualified meeting, not per booked one", () => {
    const economics = computeEconomics({
      revenue_model: "per_qualified_meeting",
      revenue_amount: 2500,
      caller_cost_model: "hourly",
      caller_cost_amount: 250,
      caller_hours: 40,
      additional_costs: 0,
      counts: COUNTS,
      revenue_won: 0,
    });
    expect(economics.revenue).toBe(15 * 2500);
    expect(economics.caller_cost).toBe(10_000);
    expect(economics.gross_profit).toBe(27_500);
  });

  it("returns null instead of Infinity when a denominator is zero", () => {
    const economics = computeEconomics({
      revenue_model: "fixed",
      revenue_amount: 0,
      caller_cost_model: "none",
      caller_cost_amount: 0,
      caller_hours: 0,
      additional_costs: 0,
      counts: {
        contacts: 10,
        called: 0,
        connected_contacts: 0,
        connected_calls: 0,
        meetings_booked: 0,
        meetings_qualified: 0,
        meetings_held: 0,
        meetings_no_show: 0,
        clients_won: 0,
      },
      revenue_won: 0,
    });
    expect(economics.cost_per_connected_call).toBeNull();
    expect(economics.cac).toBeNull();
    expect(economics.roas).toBeNull();
    expect(economics.gross_margin).toBeNull();
  });
});

describe("české skloňování v UI", () => {
  it("skloňuje počty podle českých pravidel, ne anglických", async () => {
    const { plural } = await import("@/lib/plan");
    expect(plural(0, "kontakt", "kontakty", "kontaktů")).toBe("0 kontaktů");
    expect(plural(1, "kontakt", "kontakty", "kontaktů")).toBe("1 kontakt");
    expect(plural(3, "kontakt", "kontakty", "kontaktů")).toBe("3 kontakty");
    expect(plural(5, "kontakt", "kontakty", "kontaktů")).toBe("5 kontaktů");
    expect(plural(21, "firma", "firmy", "firem")).toBe("21 firem");
  });
});
