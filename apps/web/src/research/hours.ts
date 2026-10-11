/**
 * Opening hours, used only for gated places (courtyards, gardens, parks with gates): such a
 * place is skipped when its hours say it is closed at play time. Hours that cannot be read
 * count as unknown, and an unknown place is kept.
 */

/** A weekday (0 = Sunday … 6 = Saturday) and minutes since local midnight. */
export type Clock = { weekday: number; minutes: number };

/** SerpApi's `operating_hours`: a day name → "9 AM–5 PM", "Open 24 hours", "Closed", … */
export type OperatingHours = Record<string, string>;

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  pazar: 0, pazartesi: 1, sali: 2, carsamba: 3, persembe: 4, cuma: 5, cumartesi: 6,
};

const WEEKDAY_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function foldDay(name: string): string {
  return name
    .toLocaleLowerCase("en")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]/g, "");
}

/** The local weekday and time at `at` in an IANA time zone ("Europe/Istanbul"). */
export function localClock(at: Date, timeZone: string): Clock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: WEEKDAY_SHORT[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** True when `timeZone` is a zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

type Range = [start: number, end: number];
type DayHours = "open24" | "closed" | Range[];

const TIME = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i;

function toMinutes(h: number, m: number, meridiem: string | undefined): number {
  if (!meridiem) return h * 60 + m;
  const pm = meridiem.toLowerCase() === "pm";
  return ((h % 12) + (pm ? 12 : 0)) * 60 + m;
}

/** Parses one day's hours. Null: not readable. */
export function parseDayHours(text: string): DayHours | null {
  // \s also matches the no-break and narrow spaces Google puts before AM/PM.
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return null;
  if (/open 24 hours|24 saat|^24 hours$|^00:00\s*[–—-]\s*(?:24:00|00:00)$/.test(t)) return "open24";
  if (/^(?:closed|kapali|kapalı)$/.test(t)) return "closed";
  const ranges: Range[] = [];
  for (const piece of t.split(/\s*,\s*/)) {
    const [a, b, ...rest] = piece.split(/\s*(?:[–—-]|\bto\b)\s*/);
    if (!a || !b || rest.length) return null;
    const ma = TIME.exec(a);
    const mb = TIME.exec(b);
    if (!ma || !mb) return null;
    const end = toMinutes(Number(mb[1]), Number(mb[2] ?? 0), mb[3]);
    let start = toMinutes(Number(ma[1]), Number(ma[2] ?? 0), ma[3] ?? mb[3]);
    // "11–2 PM" is 11 AM to 2 PM: a start without its own AM/PM never comes after the end.
    if (!ma[3] && mb[3] && start > end) start = toMinutes(Number(ma[1]), Number(ma[2] ?? 0), mb[3] === "pm" ? "am" : "pm");
    if (start > 24 * 60 || end > 24 * 60) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

/** Reads `operating_hours` into weekday → hours. Null when no day is readable. */
export function parseWeek(hours: OperatingHours | undefined): Map<number, DayHours> | null {
  if (!hours || typeof hours !== "object") return null;
  const week = new Map<number, DayHours>();
  for (const [day, text] of Object.entries(hours)) {
    const weekday = DAY_NAMES[foldDay(day)];
    if (weekday === undefined || typeof text !== "string") continue;
    const parsed = parseDayHours(text);
    if (parsed) week.set(weekday, parsed);
  }
  return week.size ? week : null;
}

/** Open at `clock`? Undefined when the week does not say. A range ending at or before its start runs past midnight. */
export function openAt(week: Map<number, DayHours>, clock: Clock): boolean | undefined {
  const today = week.get(clock.weekday);
  const yesterday = week.get((clock.weekday + 6) % 7);
  if (today === undefined) return undefined;
  if (today === "open24") return true;
  const m = clock.minutes;
  if (Array.isArray(yesterday)) {
    for (const [s, e] of yesterday) if (e <= s && m < e) return true;
  }
  if (today === "closed") return false;
  for (const [s, e] of today) {
    if (e <= s ? m >= s : m >= s && m < e) return true;
  }
  return false;
}

/** "Permanently closed" / "Temporarily closed" (any day). */
export function closedForGood(openState: string | undefined): boolean {
  return typeof openState === "string" && /permanently closed|temporarily closed|kalıcı olarak kapalı|geçici olarak kapalı/i.test(openState);
}

/**
 * Whether a place is open for the whole walk: at `start` and `minutes` later, in `timeZone`.
 * Undefined when the hours or the time zone are unknown.
 */
export function openForWalk(
  place: { operatingHours?: OperatingHours; openState?: string },
  start: Date,
  minutes: number,
  timeZone: string | undefined,
): boolean | undefined {
  if (closedForGood(place.openState)) return false;
  const week = parseWeek(place.operatingHours);
  if (!week || !timeZone || !isTimeZone(timeZone)) return undefined;
  const end = new Date(start.getTime() + minutes * 60_000);
  const a = openAt(week, localClock(start, timeZone));
  const b = openAt(week, localClock(end, timeZone));
  if (a === false || b === false) return false;
  if (a === undefined || b === undefined) return undefined;
  return true;
}
