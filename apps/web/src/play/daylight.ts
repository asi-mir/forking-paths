/**
 * Daylight from a position and a time, with no network call: the sun's elevation from the
 * NOAA approximation (good to about a minute for sunset). It is dark once the sun's centre is
 * below -0.833°, the usual sunset line.
 */

const RAD = Math.PI / 180;

/** The sun's elevation above the horizon, in degrees, at this place and moment. */
export function sunElevation(lat: number, lng: number, at: Date): number {
  const start = Date.UTC(at.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((at.getTime() - start) / 86_400_000) + 1;
  const hours = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const trueSolarMin = hours * 60 + eqTime + 4 * lng;
  const hourAngle = (trueSolarMin / 4 - 180) * RAD;
  const cosZenith = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(hourAngle);
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD;
}

/** True between sunset and sunrise at this place. */
export function isDark(lat: number, lng: number, at: Date = new Date()): boolean {
  return sunElevation(lat, lng, at) < -0.833;
}
