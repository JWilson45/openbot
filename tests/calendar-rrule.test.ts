import { describe, expect, test } from "bun:test";
import {
  CAL_HORIZON_MS,
  CAL_MAX_INSTANCES_HORIZON,
  CAL_MIN_INTERVAL_MS,
  expandRrule,
  isValidTimeZone,
  materializeHorizon,
  parseRrule,
  RruleError,
} from "@openbot/calendar";

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error(`expected RruleError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(RruleError);
    expect((err as RruleError).code).toBe(code);
  }
}

describe("parseRrule", () => {
  test("rejects SECONDLY, BYSETPOS, and MINUTELY INTERVAL=1", () => {
    expectCode(() => parseRrule("FREQ=SECONDLY"), "unsupported_rrule");
    expectCode(() => parseRrule("FREQ=DAILY;BYSETPOS=1"), "unsupported_rrule");
    expectCode(() => parseRrule("FREQ=MINUTELY;INTERVAL=1"), "min_interval");
    expectCode(() => parseRrule("FREQ=MINUTELY"), "min_interval");
    expectCode(() => parseRrule("not-a-rule"), "invalid_rrule");
    expectCode(() => parseRrule("FREQ=YEARLY"), "unsupported_rrule");
    expectCode(() => parseRrule("FREQ=DAILY;WKST=SU"), "unsupported_rrule");
  });

  test("HOURLY INTERVAL=1 and MINUTELY INTERVAL=5 parse", () => {
    expect(parseRrule("FREQ=HOURLY;INTERVAL=1").freq).toBe("HOURLY");
    expect(parseRrule("FREQ=HOURLY;INTERVAL=1").interval).toBe(1);
    const five = parseRrule("FREQ=MINUTELY;INTERVAL=5");
    expect(five.freq).toBe("MINUTELY");
    expect(five.interval).toBe(5);
    expect(five.interval * 60_000).toBe(CAL_MIN_INTERVAL_MS);
    expect(parseRrule("FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0").byHour).toEqual([9]);
  });
});

describe("expandRrule timezone", () => {
  test("UTC daily 09:00", () => {
    const dtstart = Date.UTC(2026, 0, 1, 9, 0, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0",
      limit: 3,
    });
    expect(occs).toEqual([
      Date.UTC(2026, 0, 1, 9, 0, 0),
      Date.UTC(2026, 0, 2, 9, 0, 0),
      Date.UTC(2026, 0, 3, 9, 0, 0),
    ]);
  });

  test("NY DST spring-forward 2026-03-08 keeps 09:00 Eastern", () => {
    const dtstart = Date.UTC(2026, 2, 7, 14, 0, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "America/New_York",
      rrule: "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0",
      limit: 3,
    });
    expect(occs).toEqual([
      Date.UTC(2026, 2, 7, 14, 0, 0),
      Date.UTC(2026, 2, 8, 13, 0, 0),
      Date.UTC(2026, 2, 9, 13, 0, 0),
    ]);
  });

  test("NY DST spring-forward 02:30 is skipped", () => {
    const dtstart = Date.UTC(2026, 2, 7, 7, 30, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "America/New_York",
      rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      limit: 3,
    });
    expect(occs[0]).toBe(Date.UTC(2026, 2, 7, 7, 30, 0));
    expect(occs[1]).toBe(Date.UTC(2026, 2, 9, 6, 30, 0));
    expect(occs).toHaveLength(3);
  });

  test("NY DST fall-back 2026-11-01 keeps 09:00 Eastern", () => {
    const dtstart = Date.UTC(2026, 9, 31, 13, 0, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "America/New_York",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      limit: 3,
    });
    expect(occs).toEqual([
      Date.UTC(2026, 9, 31, 13, 0, 0),
      Date.UTC(2026, 10, 1, 14, 0, 0),
      Date.UTC(2026, 10, 2, 14, 0, 0),
    ]);
  });

  test("NY DST fall-back 01:30 fires at the first 01:30", () => {
    const dtstart = Date.UTC(2026, 9, 31, 5, 30, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "America/New_York",
      rrule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30",
      limit: 3,
    });
    expect(occs[0]).toBe(Date.UTC(2026, 9, 31, 5, 30, 0));
    expect(occs[1]).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    expect(occs[2]).toBe(Date.UTC(2026, 10, 2, 6, 30, 0));
  });

  test("HOURLY INTERVAL=1 and MINUTELY INTERVAL=5 expand", () => {
    const hourlyStart = Date.UTC(2026, 0, 1, 0, 0, 0);
    const hourly = expandRrule({
      dtstartUtc: hourlyStart,
      timezone: "UTC",
      rrule: "FREQ=HOURLY;INTERVAL=1",
      limit: 5,
    });
    expect(hourly).toEqual([
      Date.UTC(2026, 0, 1, 0, 0, 0),
      Date.UTC(2026, 0, 1, 1, 0, 0),
      Date.UTC(2026, 0, 1, 2, 0, 0),
      Date.UTC(2026, 0, 1, 3, 0, 0),
      Date.UTC(2026, 0, 1, 4, 0, 0),
    ]);
    const minStart = Date.UTC(2026, 0, 1, 12, 0, 0);
    const five = expandRrule({
      dtstartUtc: minStart,
      timezone: "UTC",
      rrule: "FREQ=MINUTELY;INTERVAL=5",
      limit: 4,
    });
    expect(five).toEqual([
      Date.UTC(2026, 0, 1, 12, 0, 0),
      Date.UTC(2026, 0, 1, 12, 5, 0),
      Date.UTC(2026, 0, 1, 12, 10, 0),
      Date.UTC(2026, 0, 1, 12, 15, 0),
    ]);
  });

  test("HOURLY INTERVAL=1 is not rejected for expanding past 64 in 14 days", () => {
    const dtstart = Date.UTC(2026, 0, 1, 0, 0, 0);
    parseRrule("FREQ=HOURLY;INTERVAL=1");
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: "FREQ=HOURLY;INTERVAL=1",
      limit: 70,
    });
    expect(occs).toHaveLength(70);
    expect(occs[69]).toBe(dtstart + 69 * 60 * 60 * 1000);
  });

  test("Jan 31 MONTHLY skips months with no 31st", () => {
    const dtstart = Date.UTC(2026, 0, 31, 12, 0, 0);
    const occs = expandRrule({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: "FREQ=MONTHLY",
      limit: 5,
    });
    expect(occs).toEqual([
      Date.UTC(2026, 0, 31, 12, 0, 0),
      Date.UTC(2026, 2, 31, 12, 0, 0),
      Date.UTC(2026, 4, 31, 12, 0, 0),
      Date.UTC(2026, 6, 31, 12, 0, 0),
      Date.UTC(2026, 7, 31, 12, 0, 0),
    ]);
  });

  test("one-shot rrule null is dtstart only", () => {
    const dtstart = Date.UTC(2026, 5, 1, 15, 0, 0);
    expect(
      expandRrule({ dtstartUtc: dtstart, timezone: "UTC", rrule: null, limit: 8 }),
    ).toEqual([dtstart]);
  });
});

describe("materializeHorizon", () => {
  test("returns one latest miss plus at most 64 future rows, not old misses", () => {
    const dtstart = Date.UTC(2026, 0, 1, 0, 0, 0);
    const nowMs = dtstart + 20 * 60 * 60 * 1000;
    const { catchup, future } = materializeHorizon({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: "FREQ=MINUTELY;INTERVAL=5",
      nowMs,
    });
    expect(catchup).toBe(nowMs);
    expect(future).toHaveLength(CAL_MAX_INSTANCES_HORIZON);
    expect(future[0]).toBe(nowMs + 5 * 60 * 1000);
    expect(future.every((t) => t > nowMs)).toBe(true);
    expect(future.at(-1)!).toBeLessThanOrEqual(nowMs + CAL_HORIZON_MS);
    expect(future.at(-1)!).toBe(nowMs + CAL_MAX_INSTANCES_HORIZON * 5 * 60 * 1000);
  });

  test("past one-shot is catchup only", () => {
    const dtstart = Date.UTC(2026, 0, 1, 9, 0, 0);
    const nowMs = dtstart + 10 * 60 * 1000;
    const { catchup, future } = materializeHorizon({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: null,
      nowMs,
    });
    expect(catchup).toBe(dtstart);
    expect(future).toEqual([]);
  });
});

test("isValidTimeZone", () => {
  expect(isValidTimeZone("UTC")).toBe(true);
  expect(isValidTimeZone("America/New_York")).toBe(true);
  expect(isValidTimeZone("Not/A_Zone")).toBe(false);
  expect(isValidTimeZone("")).toBe(false);
});
