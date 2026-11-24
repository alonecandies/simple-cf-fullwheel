/** Keep operational logs useful without forwarding exception messages or payloads. */
export function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";
}
