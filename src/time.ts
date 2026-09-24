import { UserError } from './types.ts';

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; }
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
