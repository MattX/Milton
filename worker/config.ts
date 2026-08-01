/** Worker vars and secrets are always plain strings, so lists are comma separated. */
export function splitConfig(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
