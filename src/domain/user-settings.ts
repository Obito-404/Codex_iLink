export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;
export const DEFAULT_AWAY_TIMEOUT_MINUTES = 5;

export const SESSION_TIMEOUT_MINUTES_RANGE = { min: 5, max: 24 * 60 } as const;
export const AWAY_TIMEOUT_MINUTES_RANGE = { min: 1, max: 60 } as const;

export type UserTimingSettings = {
  awayTimeoutMinutes: number;
  sessionTimeoutMinutes: number;
};

export function parseMinuteDuration(value: string): number | null {
  const match = /^(\d+)m$/u.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isSafeInteger(minutes) ? minutes : null;
}

export function isInMinuteRange(
  minutes: number,
  range: { readonly max: number; readonly min: number },
): boolean {
  return Number.isSafeInteger(minutes) && minutes >= range.min && minutes <= range.max;
}
