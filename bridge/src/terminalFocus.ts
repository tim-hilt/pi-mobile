/** Asks the terminal to report focus changes as input (xterm focus reporting). */
export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

/**
 * The focus change a chunk of terminal input reports: `true` for focus-in,
 * `false` for focus-out, `undefined` for anything else, which belongs to pi.
 * pi hands over one key sequence at a time, so only a whole chunk matches.
 */
export function focusChange(data: string): boolean | undefined {
  if (data === "\x1b[I") return true;
  if (data === "\x1b[O") return false;
}
