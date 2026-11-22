// Calendar days and dates in the app's time zone, not the server's (Vercel and most hosts run in UTC).
export const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Jakarta';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

/** Offset of TIME_ZONE from UTC at that moment, in ms (Asia/Jakarta → +7 h). */
export function tzOffsetMs(ts = Date.now()) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ts)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Days since 1970-01-01 in TIME_ZONE, so "every 2 days" and streaks follow the users' calendar days. */
export function localDayNumber(ts = Date.now()) {
  return Math.floor((ts + tzOffsetMs(ts)) / 86_400_000);
}

/** "21 Nov 2026, 23:59" in TIME_ZONE, for notification texts. */
export function formatDateTime(ts) {
  return new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE });
}
