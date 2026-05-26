/**
 * Detects if an option button text represents a launch intent.
 * Used to auto-trigger handleLaunch() when the user clicks a launch-intent option
 * and the session is ready.
 */

const LAUNCH_INTENT_RE = /\b(launch|let'?s\s+go|ship\s+it|ready\s+to\s+launch|start\s+the\s+company)\b/i;

/**
 * Negative guard: options that should NEVER trigger auto-launch,
 * even if they accidentally contain a launch-intent keyword.
 */
const NON_LAUNCH_RE = /\b(tell\s+me\s+more|refine|add\s+details|go\s+narrower|more\s+info|explain|elaborate)\b/i;

export function isLaunchIntent(text: string): boolean {
  if (NON_LAUNCH_RE.test(text)) return false;
  return LAUNCH_INTENT_RE.test(text);
}
