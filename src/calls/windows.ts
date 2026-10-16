/**
 * Is a call open? Window names as OBS lists them ("[App] Title"): a Meet tab in any browser
 * ("Meet - abc-defg-hij", "Google Meet"), a Zoom meeting or webinar, a Teams call. The desk
 * runs under launchd without Screen Recording, so it can't read titles itself; OBS can.
 */
const CALL_TITLES: RegExp[] = [
  /\bMeet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i,
  /\bGoogle Meet\b/,
  /^\[zoom\.us\]\s*Zoom (Meeting|Webinar)\b/i,
  /^\[zoom\.us\].*\bMeeting\b/i,
  /^\[Microsoft Teams[^\]]*\].*\b(Meeting|Call)\b/i,
];

/** The first window that looks like a call, or null. */
export function callWindow(windows: string[]): string | null {
  return windows.find((w) => CALL_TITLES.some((re) => re.test(w))) ?? null;
}
