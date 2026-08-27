export const CAL_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const CAL_MAX_SERIES = 32;
export const CAL_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
export const CAL_MAX_INSTANCES_HORIZON = 64;
export const CAL_CATCHUP_MS = 24 * 60 * 60 * 1000;
export const CAL_MAX_FIRES_PER_TICK = 8;
export const CAL_CREATE_PER_TURN = 3;
export const CAL_CREATE_PER_HOUR = 20;

const MAX_EXPAND_STEPS = 500_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const ALLOWED_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYHOUR",
  "BYMINUTE",
  "BYMONTHDAY",
  "COUNT",
  "UNTIL",
]);

export class RruleError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RruleError";
  }
}

export type RruleFreq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export type ParsedRrule = {
  freq: RruleFreq;
  interval: number;
  byDay: number[] | null;
  byHour: number[] | null;
  byMinute: number[] | null;
  byMonthDay: number[] | null;
  count: number | null;
  untilRaw: string | null;
};

export type CivilDt = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type ExpandRruleOpts = {
  dtstartUtc: number;
  timezone: string;
  rrule: string | null;
  afterUtc?: number;
  untilUtc?: number;
  limit: number;
};

export type MaterializeHorizonOpts = {
  dtstartUtc: number;
  timezone: string;
  rrule: string | null;
  nowMs: number;
};

export type MaterializeHorizonResult = {
  catchup: number | null;
  future: number[];
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    if (!isValidTimeZone(timeZone)) throw new RruleError("invalid_timezone");
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "iso8601",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

export function utcToCivil(utcMs: number, timeZone: string): CivilDt {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

function civilMatches(
  c: CivilDt,
  want: { year: number; month: number; day: number; hour: number; minute: number },
): boolean {
  return (
    c.year === want.year &&
    c.month === want.month &&
    c.day === want.day &&
    c.hour === want.hour &&
    c.minute === want.minute
  );
}

function offsetAt(utcMs: number, timeZone: string): number {
  const c = utcToCivil(utcMs, timeZone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - utcMs;
}

/** Local civil → UTC. Missing DST times return null; ambiguous times use the earlier instant. */
export function civilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const want = { year, month, day, hour, minute };
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let t = localAsUtc - offsetAt(localAsUtc, timeZone);
  t = localAsUtc - offsetAt(t, timeZone);
  if (!civilMatches(utcToCivil(t, timeZone), want)) return null;
  const earlier = t - 3600_000;
  if (civilMatches(utcToCivil(earlier, timeZone), want)) return Math.min(t, earlier);
  return t;
}

function civilFromParts(year: number, month: number, day: number, hour: number, minute: number): CivilDt {
  return { year, month, day, hour, minute, second: 0 };
}

function compareCivil(a: CivilDt, b: CivilDt): number {
  return (
    a.year - b.year ||
    a.month - b.month ||
    a.day - b.day ||
    a.hour - b.hour ||
    a.minute - b.minute ||
    a.second - b.second
  );
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function fromMonday(dow: number): number {
  return (dow + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(year: number, month: number, day: number, n: number): { year: number; month: number; day: number } {
  const t = Date.UTC(year, month - 1, day + n);
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addMinutes(c: CivilDt, n: number): CivilDt {
  const t = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute + n, 0);
  const d = new Date(t);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: 0,
  };
}

function addHours(c: CivilDt, n: number): CivilDt {
  return addMinutes(c, n * 60);
}

function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const t = Date.UTC(year, month - 1 + n, 1);
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function mondayOnOrBefore(year: number, month: number, day: number): { year: number; month: number; day: number } {
  return addDays(year, month, day, -fromMonday(weekday(year, month, day)));
}

function parsePositiveInt(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new RruleError("invalid_rrule");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RruleError("invalid_rrule");
  return n;
}

function parseIntList(raw: string, min: number, max: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) throw new RruleError("invalid_rrule");
    if (!/^-?[0-9]+$/.test(t)) throw new RruleError("invalid_rrule");
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) throw new RruleError("invalid_rrule");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (!out.length) throw new RruleError("invalid_rrule");
  out.sort((a, b) => a - b);
  return out;
}

function parseByDay(raw: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const t = part.trim().toUpperCase();
    if (!t) throw new RruleError("invalid_rrule");
    const idx = WEEKDAYS.indexOf(t as (typeof WEEKDAYS)[number]);
    if (idx < 0) throw new RruleError("unsupported_rrule");
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  if (!out.length) throw new RruleError("invalid_rrule");
  return out;
}

export function parseRrule(input: string): ParsedRrule {
  if (typeof input !== "string") throw new RruleError("invalid_rrule");
  const raw = input.trim().replace(/^RRULE:/i, "");
  if (!raw) throw new RruleError("invalid_rrule");
  const map = new Map<string, string>();
  for (const piece of raw.split(";")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) throw new RruleError("invalid_rrule");
    const key = piece.slice(0, eq).trim().toUpperCase();
    const value = piece.slice(eq + 1).trim();
    if (!key || !value) throw new RruleError("invalid_rrule");
    if (key === "BYSETPOS") throw new RruleError("unsupported_rrule");
    if (!ALLOWED_KEYS.has(key)) throw new RruleError("unsupported_rrule");
    if (map.has(key)) throw new RruleError("invalid_rrule");
    map.set(key, value);
  }
  const freqRaw = map.get("FREQ")?.toUpperCase();
  if (!freqRaw) throw new RruleError("invalid_rrule");
  if (freqRaw === "SECONDLY" || freqRaw === "YEARLY") throw new RruleError("unsupported_rrule");
  if (freqRaw !== "MINUTELY" && freqRaw !== "HOURLY" && freqRaw !== "DAILY" && freqRaw !== "WEEKLY" && freqRaw !== "MONTHLY") {
    throw new RruleError("unsupported_rrule");
  }
  const interval = map.has("INTERVAL") ? parsePositiveInt(map.get("INTERVAL")!) : 1;
  if (freqRaw === "MINUTELY" && interval * 60_000 < CAL_MIN_INTERVAL_MS) {
    throw new RruleError("min_interval");
  }
  const count = map.has("COUNT") ? parsePositiveInt(map.get("COUNT")!) : null;
  const untilRaw = map.get("UNTIL") ?? null;
  if (untilRaw && !/^\d{8}(T\d{6}Z?)?$/i.test(untilRaw)) throw new RruleError("invalid_rrule");
  if (map.has("BYDAY") && freqRaw !== "DAILY" && freqRaw !== "WEEKLY") {
    throw new RruleError("unsupported_rrule");
  }
  if (map.has("BYMONTHDAY") && freqRaw !== "MONTHLY") {
    throw new RruleError("unsupported_rrule");
  }
  return {
    freq: freqRaw,
    interval,
    byDay: map.has("BYDAY") ? parseByDay(map.get("BYDAY")!) : null,
    byHour: map.has("BYHOUR") ? parseIntList(map.get("BYHOUR")!, 0, 23) : null,
    byMinute: map.has("BYMINUTE") ? parseIntList(map.get("BYMINUTE")!, 0, 59) : null,
    byMonthDay: map.has("BYMONTHDAY") ? parseIntList(map.get("BYMONTHDAY")!, 1, 31) : null,
    count,
    untilRaw,
  };
}

function parseUntilUtc(raw: string, timeZone: string): number {
  const zulu = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(raw);
  if (zulu) {
    return Date.UTC(
      Number(zulu[1]),
      Number(zulu[2]) - 1,
      Number(zulu[3]),
      Number(zulu[4]),
      Number(zulu[5]),
      Number(zulu[6]),
    );
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (local) {
    const utc = civilToUtc(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      timeZone,
    );
    if (utc == null) throw new RruleError("invalid_rrule");
    return utc;
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (date) {
    const utc = civilToUtc(Number(date[1]), Number(date[2]), Number(date[3]), 23, 59, timeZone);
    if (utc == null) throw new RruleError("invalid_rrule");
    return utc + 59_000;
  }
  throw new RruleError("invalid_rrule");
}

function hoursOf(rule: ParsedRrule, seed: CivilDt): number[] {
  return rule.byHour ?? [seed.hour];
}

function minutesOf(rule: ParsedRrule, seed: CivilDt): number[] {
  return rule.byMinute ?? [seed.minute];
}

function* timesOnDate(
  year: number,
  month: number,
  day: number,
  hours: number[],
  minutes: number[],
): Generator<CivilDt> {
  for (const hour of hours) {
    for (const minute of minutes) {
      yield civilFromParts(year, month, day, hour, minute);
    }
  }
}

function packedMinutes(c: CivilDt): number {
  return Math.floor(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) / 60_000);
}

function fromPackedMinutes(min: number): CivilDt {
  const d = new Date(min * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: 0,
  };
}

function alignForward(seed: CivilDt, from: CivilDt, stepMinutes: number): CivilDt {
  const seedP = packedMinutes(seed);
  const fromP = packedMinutes(from);
  if (fromP <= seedP) return seed;
  const k = Math.ceil((fromP - seedP) / stepMinutes);
  return fromPackedMinutes(seedP + k * stepMinutes);
}

function* civilCandidates(seed: CivilDt, from: CivilDt, rule: ParsedRrule): Generator<CivilDt> {
  const hours = hoursOf(rule, seed);
  const minutes = minutesOf(rule, seed);
  if (rule.freq === "MINUTELY") {
    let cur = alignForward(seed, from, rule.interval);
    while (true) {
      if (!rule.byHour || rule.byHour.includes(cur.hour)) {
        if (!rule.byMinute || rule.byMinute.includes(cur.minute)) yield cur;
      }
      cur = addMinutes(cur, rule.interval);
    }
  }
  if (rule.freq === "HOURLY") {
    const seedHour = civilFromParts(seed.year, seed.month, seed.day, seed.hour, minutes[0] ?? seed.minute);
    let cur = alignForward(seedHour, from, rule.interval * 60);
    while (true) {
      if (!rule.byHour || rule.byHour.includes(cur.hour)) {
        for (const minute of minutes) {
          const cand = civilFromParts(cur.year, cur.month, cur.day, cur.hour, minute);
          if (compareCivil(cand, from) < 0) continue;
          yield cand;
        }
      }
      cur = addHours(cur, rule.interval);
    }
  }
  if (rule.freq === "DAILY") {
    let date = { year: from.year, month: from.month, day: from.day };
    const startDate = { year: seed.year, month: seed.month, day: seed.day };
    if (rule.interval > 1) {
      let cursor = startDate;
      while (
        cursor.year < date.year ||
        (cursor.year === date.year && cursor.month < date.month) ||
        (cursor.year === date.year && cursor.month === date.month && cursor.day < date.day)
      ) {
        cursor = addDays(cursor.year, cursor.month, cursor.day, rule.interval);
      }
      date = cursor;
    }
    while (true) {
      const dow = weekday(date.year, date.month, date.day);
      if (!rule.byDay || rule.byDay.includes(dow)) {
        for (const cand of timesOnDate(date.year, date.month, date.day, hours, minutes)) {
          if (compareCivil(cand, from) < 0) continue;
          yield cand;
        }
      }
      date = addDays(date.year, date.month, date.day, rule.interval);
    }
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byDay ?? [weekday(seed.year, seed.month, seed.day)];
    const ordered = [...days].sort((a, b) => fromMonday(a) - fromMonday(b));
    let week = mondayOnOrBefore(from.year, from.month, from.day);
    const seedWeek = mondayOnOrBefore(seed.year, seed.month, seed.day);
    if (rule.interval > 1) {
      let cursor = seedWeek;
      while (
        cursor.year < week.year ||
        (cursor.year === week.year && cursor.month < week.month) ||
        (cursor.year === week.year && cursor.month === week.month && cursor.day < week.day)
      ) {
        cursor = addDays(cursor.year, cursor.month, cursor.day, 7 * rule.interval);
      }
      week = cursor;
    }
    while (true) {
      for (const dow of ordered) {
        const date = addDays(week.year, week.month, week.day, fromMonday(dow));
        for (const cand of timesOnDate(date.year, date.month, date.day, hours, minutes)) {
          if (compareCivil(cand, from) < 0) continue;
          yield cand;
        }
      }
      week = addDays(week.year, week.month, week.day, 7 * rule.interval);
    }
  }
  if (rule.freq === "MONTHLY") {
    const monthDays = rule.byMonthDay ?? [seed.day];
    let ym = { year: from.year, month: from.month };
    const seedYm = { year: seed.year, month: seed.month };
    if (rule.interval > 1) {
      let cursor = seedYm;
      while (cursor.year < ym.year || (cursor.year === ym.year && cursor.month < ym.month)) {
        cursor = addMonths(cursor.year, cursor.month, rule.interval);
      }
      ym = cursor;
    }
    while (true) {
      for (const md of monthDays) {
        if (md > daysInMonth(ym.year, ym.month)) continue;
        for (const cand of timesOnDate(ym.year, ym.month, md, hours, minutes)) {
          if (compareCivil(cand, from) < 0) continue;
          yield cand;
        }
      }
      ym = addMonths(ym.year, ym.month, rule.interval);
    }
  }
}

function backupCivil(from: CivilDt, rule: ParsedRrule): CivilDt {
  if (rule.freq === "MINUTELY") return addMinutes(from, -Math.max(rule.interval * 2, 120));
  if (rule.freq === "HOURLY") return addHours(from, -Math.max(rule.interval * 2, 48));
  if (rule.freq === "DAILY") {
    const d = addDays(from.year, from.month, from.day, -Math.max(rule.interval * 2, 14));
    return civilFromParts(d.year, d.month, d.day, from.hour, from.minute);
  }
  if (rule.freq === "WEEKLY") {
    const d = addDays(from.year, from.month, from.day, -7 * Math.max(rule.interval * 2, 2));
    return civilFromParts(d.year, d.month, d.day, from.hour, from.minute);
  }
  const ym = addMonths(from.year, from.month, -Math.max(rule.interval * 2, 2));
  return civilFromParts(ym.year, ym.month, Math.min(from.day, 28), from.hour, from.minute);
}

function laterCivil(a: CivilDt, b: CivilDt): CivilDt {
  return compareCivil(a, b) >= 0 ? a : b;
}

type WalkOpts = {
  dtstartUtc: number;
  timezone: string;
  rrule: string | null;
  afterUtc?: number;
  untilUtc?: number;
  limit: number;
  keep: "all" | "last";
};

function walkOccurrences(opts: WalkOpts): number[] {
  const { dtstartUtc, timezone, rrule, afterUtc, untilUtc, limit, keep } = opts;
  if (!Number.isFinite(dtstartUtc)) throw new RruleError("invalid_rrule");
  if (!isValidTimeZone(timezone)) throw new RruleError("invalid_timezone");
  const windowAfter = afterUtc ?? null;
  const windowUntil = untilUtc ?? null;
  const out: number[] = [];
  const push = (utc: number): boolean => {
    if (windowAfter != null && utc <= windowAfter) return false;
    if (windowUntil != null && utc > windowUntil) return true;
    if (keep === "last") {
      out[0] = utc;
      return false;
    }
    out.push(utc);
    return out.length >= limit;
  };

  if (rrule == null || rrule === "") {
    if (windowUntil != null && dtstartUtc > windowUntil) return [];
    push(dtstartUtc);
    return out;
  }

  const parsed = parseRrule(rrule);
  const rruleUntil = parsed.untilRaw ? parseUntilUtc(parsed.untilRaw, timezone) : null;
  const seed = utcToCivil(dtstartUtc, timezone);
  seed.second = 0;
  let n = 0;
  const consider = (utc: number): "continue" | "break" => {
    if (rruleUntil != null && utc > rruleUntil) return "break";
    n += 1;
    if (parsed.count != null && n > parsed.count) return "break";
    if (windowUntil != null && utc > windowUntil) return "break";
    if (push(utc)) return "break";
    return "continue";
  };

  const startInWindow = windowAfter == null || dtstartUtc > windowAfter;
  const startBeforeUntil = windowUntil == null || dtstartUtc <= windowUntil;
  if (startInWindow && startBeforeUntil) {
    if (consider(dtstartUtc) === "break") return out;
  } else if (windowUntil != null && dtstartUtc > windowUntil) {
    return out;
  } else if (parsed.count != null) {
    n += 1;
  }

  let from = seed;
  if (parsed.count == null) {
    if (keep === "last") {
      from = laterCivil(seed, backupCivil(utcToCivil(windowUntil ?? dtstartUtc, timezone), parsed));
    } else if (windowAfter != null) {
      from = laterCivil(seed, utcToCivil(windowAfter, timezone));
    }
  }
  let steps = 0;
  for (const civil of civilCandidates(seed, from, parsed)) {
    steps += 1;
    if (steps > MAX_EXPAND_STEPS) break;
    const utc = civilToUtc(civil.year, civil.month, civil.day, civil.hour, civil.minute, timezone);
    if (utc == null) continue;
    if (utc <= dtstartUtc) continue;
    if (consider(utc) === "break") break;
    if (keep === "all" && out.length >= limit) break;
  }
  return out;
}

export function expandRrule(opts: ExpandRruleOpts): number[] {
  return walkOccurrences({ ...opts, keep: "all" });
}

export function materializeHorizon(opts: MaterializeHorizonOpts): MaterializeHorizonResult {
  const { dtstartUtc, timezone, rrule, nowMs } = opts;
  const catchupArr = walkOccurrences({
    dtstartUtc,
    timezone,
    rrule,
    untilUtc: nowMs,
    limit: 1,
    keep: "last",
  });
  const catchup = catchupArr.length ? catchupArr[0]! : null;
  const future = walkOccurrences({
    dtstartUtc,
    timezone,
    rrule,
    afterUtc: nowMs,
    untilUtc: nowMs + CAL_HORIZON_MS,
    limit: CAL_MAX_INSTANCES_HORIZON,
    keep: "all",
  });
  return { catchup, future };
}

export function parseCalendarDtstart(raw: string | number, timeZone: string): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new RruleError("invalid_dtstart");
    return Math.trunc(raw);
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new RruleError("invalid_dtstart");
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) throw new RruleError("invalid_dtstart");
    return n;
  }
  if (/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) throw new RruleError("invalid_dtstart");
    return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!m) throw new RruleError("invalid_dtstart");
  const utc = civilToUtc(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] != null ? Number(m[4]) : 0,
    m[5] != null ? Number(m[5]) : 0,
    timeZone,
  );
  if (utc == null) throw new RruleError("invalid_dtstart");
  return utc;
}

export function localNineTomorrow(timeZone: string, nowMs: number): number {
  const later = utcToCivil(nowMs + 24 * 60 * 60 * 1000, timeZone);
  for (const hour of [9, 10, 11, 8, 12]) {
    const utc = civilToUtc(later.year, later.month, later.day, hour, 0, timeZone);
    if (utc != null) return utc;
  }
  return nowMs + 24 * 60 * 60 * 1000;
}
