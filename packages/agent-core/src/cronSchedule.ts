type Field = { values: Set<number>; wildcard: boolean };
type ParsedCron = { minute: Field; hour: Field; day: Field; month: Field; weekday: Field };

function parseField(source: string, min: number, max: number, label: string, dow = false): Field {
  if (!source) throw new Error(`Cron ${label} field is empty`);
  const values = new Set<number>();
  const wildcard = source === "*";
  for (const part of source.split(",")) {
    if (!part) throw new Error(`Invalid empty item in cron ${label} field`);
    const [rangeText, stepText, extra] = part.split("/");
    if (rangeText === undefined) throw new Error(`Invalid cron ${label} value`);
    if (extra !== undefined) throw new Error(`Invalid step in cron ${label} field`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`Cron ${label} step must be a positive integer`);
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (rangeText === "*") { start = min; end = max; }
    else if (/^\d+$/.test(rangeText)) {
      start = Number(rangeText);
      if (stepText !== undefined) end = max;
      else end = start;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!match) throw new Error(`Invalid cron ${label} value "${rangeText}"`);
      start = Number(match[1]); end = Number(match[2]);
    }
    const allowedMax = dow ? 7 : max;
    if (start < min || start > allowedMax || end < min || end > allowedMax || end < start) {
      throw new Error(`Cron ${label} values must be between ${min} and ${allowedMax} in ascending order`);
    }
    for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n);
  }
  return { values, wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must contain exactly five fields: minute hour day-of-month month day-of-week");
  return {
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    day: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month"),
    weekday: parseField(fields[4]!, 0, 6, "day-of-week", true),
  };
}

function matchesDate(cron: ParsedCron, date: Date): boolean {
  const dayMatches = cron.day.values.has(date.getDate());
  const weekdayMatches = cron.weekday.values.has(date.getDay());
  const calendarMatches = cron.day.wildcard || cron.weekday.wildcard
    ? dayMatches && weekdayMatches
    : dayMatches || weekdayMatches;
  return cron.month.values.has(date.getMonth() + 1) && calendarMatches;
}

/** Return the first matching local wall-clock time strictly after `after`. */
export function nextOccurrence(expression: string, after: Date): Date {
  const cron = parseCron(expression);
  if (!Number.isFinite(after.getTime())) throw new Error("Cannot find a cron occurrence after an invalid date");
  const start = new Date(after.getTime());
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  const horizon = new Date(day.getFullYear() + 5, day.getMonth(), day.getDate(), 12);
  while (day <= horizon) {
    if (matchesDate(cron, day)) {
      for (const hour of [...cron.hour.values].sort((a, b) => a - b)) {
        for (const minute of [...cron.minute.values].sort((a, b) => a - b)) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
          // Date normalizes spring-forward gaps; skip normalized wall times. Its
          // constructor selects the first instance of an ambiguous fall-back time.
          if (candidate.getFullYear() !== day.getFullYear() || candidate.getMonth() !== day.getMonth() ||
              candidate.getDate() !== day.getDate() || candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
          if (candidate.getTime() > start.getTime()) return candidate;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  throw new Error(`Cron expression "${expression}" has no occurrence within five years`);
}
