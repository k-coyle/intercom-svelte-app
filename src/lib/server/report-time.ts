const SECONDS_PER_DAY = 24 * 60 * 60;

export const REPORT_TIMEZONE = 'America/New_York';

export type MonthWindow = {
  monthYearLabel: string;
  year: number;
  month: number; // 1-12
  monthStartUnix: number; // inclusive
  monthEndUnix: number; // exclusive
  monthStartISO: string;
  monthEndISO: string;
};

export type ElapsedMonthWindow = {
  month: MonthWindow;
  elapsedDays: number;
  elapsedEndUnix: number; // exclusive
  elapsedEndISO: string;
};

export type MonthComparisonWindow = {
  timeZone: string;
  current: ElapsedMonthWindow;
  prior: ElapsedMonthWindow;
};

function getTzParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  };
}

function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const { year, month, day, hour, minute, second } = getTzParts(date, timeZone);
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

function zonedTimeToUtcUnix(
  year: number,
  monthIndex0: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  const guessUtcMs = Date.UTC(year, monthIndex0, day, hour, minute, second);
  const offsetMin = getTzOffsetMinutes(new Date(guessUtcMs), timeZone);
  const utcMs = guessUtcMs - offsetMin * 60_000;
  return Math.floor(utcMs / 1000);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toMonthYearLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parseMonthYearLabel(monthYearLabel: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthYearLabel);
  if (!m) throw new Error(`Invalid monthYearLabel: ${monthYearLabel} (expected YYYY-MM)`);

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month in monthYearLabel: ${monthYearLabel}`);

  return { year, month };
}

export function getCurrentMonthYearLabel(
  now: Date = new Date(),
  timeZone = REPORT_TIMEZONE
): string {
  const { year, month } = getTzParts(now, timeZone);
  return toMonthYearLabel(year, month);
}

export function coerceMonthYearLabel(
  monthYearLabel: string | null | undefined,
  now: Date = new Date(),
  timeZone = REPORT_TIMEZONE
): string {
  const raw = String(monthYearLabel ?? '').trim();
  if (!raw) return getCurrentMonthYearLabel(now, timeZone);
  parseMonthYearLabel(raw);
  return raw;
}

export function computeMonthWindow(
  monthYearLabel: string,
  timeZone = REPORT_TIMEZONE
): MonthWindow {
  const { year, month } = parseMonthYearLabel(monthYearLabel);
  const monthIndex0 = month - 1;

  const monthStartUnix = zonedTimeToUtcUnix(year, monthIndex0, 1, 0, 0, 0, timeZone);

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthIndex0 = month === 12 ? 0 : monthIndex0 + 1;
  const monthEndUnix = zonedTimeToUtcUnix(nextYear, nextMonthIndex0, 1, 0, 0, 0, timeZone);

  return {
    monthYearLabel,
    year,
    month,
    monthStartUnix,
    monthEndUnix,
    monthStartISO: new Date(monthStartUnix * 1000).toISOString(),
    monthEndISO: new Date(monthEndUnix * 1000).toISOString()
  };
}

function computePriorMonthYearLabel(monthYearLabel: string): string {
  const { year, month } = parseMonthYearLabel(monthYearLabel);
  if (month === 1) return toMonthYearLabel(year - 1, 12);
  return toMonthYearLabel(year, month - 1);
}

function computeElapsedDays(
  month: MonthWindow,
  now: Date,
  timeZone: string
): number {
  const currentLabel = getCurrentMonthYearLabel(now, timeZone);

  if (month.monthYearLabel < currentLabel) {
    return daysInMonth(month.year, month.month);
  }

  if (month.monthYearLabel > currentLabel) {
    return 0;
  }

  const parts = getTzParts(now, timeZone);
  return parts.day;
}

function computeElapsedEndUnix(
  year: number,
  month: number,
  elapsedDays: number,
  timeZone: string
): number {
  if (elapsedDays <= 0) {
    return zonedTimeToUtcUnix(year, month - 1, 1, 0, 0, 0, timeZone);
  }

  const dim = daysInMonth(year, month);
  if (elapsedDays >= dim) {
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonthIndex0 = month === 12 ? 0 : month;
    return zonedTimeToUtcUnix(nextYear, nextMonthIndex0, 1, 0, 0, 0, timeZone);
  }

  return zonedTimeToUtcUnix(year, month - 1, elapsedDays + 1, 0, 0, 0, timeZone);
}

export function computeMonthComparisonWindow(
  monthYearLabelInput: string | null | undefined,
  opts: { now?: Date; timeZone?: string } = {}
): MonthComparisonWindow {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? REPORT_TIMEZONE;

  const monthYearLabel = coerceMonthYearLabel(monthYearLabelInput, now, timeZone);
  const currentMonth = computeMonthWindow(monthYearLabel, timeZone);
  const priorMonth = computeMonthWindow(computePriorMonthYearLabel(monthYearLabel), timeZone);

  const currentElapsedDays = computeElapsedDays(currentMonth, now, timeZone);
  const priorElapsedDays = Math.min(currentElapsedDays, daysInMonth(priorMonth.year, priorMonth.month));

  const currentElapsedEndUnix = computeElapsedEndUnix(
    currentMonth.year,
    currentMonth.month,
    currentElapsedDays,
    timeZone
  );
  const priorElapsedEndUnix = computeElapsedEndUnix(
    priorMonth.year,
    priorMonth.month,
    priorElapsedDays,
    timeZone
  );

  return {
    timeZone,
    current: {
      month: currentMonth,
      elapsedDays: currentElapsedDays,
      elapsedEndUnix: currentElapsedEndUnix,
      elapsedEndISO: new Date(currentElapsedEndUnix * 1000).toISOString()
    },
    prior: {
      month: priorMonth,
      elapsedDays: priorElapsedDays,
      elapsedEndUnix: priorElapsedEndUnix,
      elapsedEndISO: new Date(priorElapsedEndUnix * 1000).toISOString()
    }
  };
}

export function unixDaysBetween(startUnix: number, endUnix: number): number {
  if (endUnix <= startUnix) return 0;
  return Math.ceil((endUnix - startUnix) / SECONDS_PER_DAY);
}
