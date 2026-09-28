import { UserError } from './types.ts';

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; }
}

export function resolveZone(input: string): string | null {
  const aliases: Record<string, string> = { eastern: 'America/New_York', 'eastern time': 'America/New_York', et: 'America/New_York', central: 'America/Chicago', 'central time': 'America/Chicago', ct: 'America/Chicago', mountain: 'America/Denver', 'mountain time': 'America/Denver', mt: 'America/Denver', pacific: 'America/Los_Angeles', 'pacific time': 'America/Los_Angeles', pt: 'America/Los_Angeles', utc: 'UTC' };
  const value = aliases[input.trim().toLowerCase()] ?? input.trim();
  // Abbreviations such as EST/CST can mean fixed offsets or different regions.
  if (value !== 'UTC' && !value.includes('/')) return null;
  return validZone(value) ? new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone : null;
}

export function formatDate(date: string): string {
  if (!validDate(date)) throw new UserError('That calendar date is invalid.');
  const day = Number(date.slice(-2));
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', year: 'numeric' }).formatToParts(new Date(date + 'T12:00:00Z'));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('weekday')}, ${part('month')} ${day}${suffix}, ${part('year')}`;
}

export function formatClock(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
}

function instantClock(instant: number, zone: string): string {
  const abbreviation = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(instant).find(p => p.type === 'timeZoneName')!.value;
  return `${formatClock(localParts(instant, zone).time)} ${abbreviation}`;
}

export function formatInstant(instant: number, zone: string): string {
  return `${formatDate(localParts(instant, zone).date)} at ${instantClock(instant, zone)}`;
}

export function formatInterval(start: number, end: number, zone: string): string {
  return `${formatInstant(start, zone)} – ${localParts(start, zone).date === localParts(end, zone).date ? instantClock(end, zone) : formatInstant(end, zone)}`;
}

export function formatDeadline(date: string, time: string | null, sourceZone: string, displayZone = sourceZone): string {
  return time ? formatInstant(localInstant(date, time, sourceZone), displayZone) : `${formatDate(date)} (all day)`;
}

export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const instant = new Date(date + 'T12:00:00Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date;
}

export function localParts(now: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const value = (name: string) => parts.find(p => p.type === name)!.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolve wall-clock time against an IANA zone. Reject missing or repeated DST times.
export function localInstant(date: string, time: string, zone: string): number {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !validZone(zone)) throw new UserError('That date, time, or timezone is invalid.');
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const probe = wall + delta * 3600000;
    const p = localParts(probe, zone);
    offsets.add(Date.parse(`${p.date}T${p.time}:00Z`) - probe);
  }
  const matches = [...offsets].map(offset => wall - offset).filter(candidate => {
    const p = localParts(candidate, zone);
    return p.date === date && p.time === time;
  });
  if (matches.length !== 1) throw new UserError('That local time is skipped or repeated by daylight saving time. Please choose a different time.');
  return matches[0];
}

export async function stableId(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
