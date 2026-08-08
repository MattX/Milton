/** Builds a Wayback replay URL that resolves to the capture nearest the submission time. */
export function waybackUrl(originalUrl: string, submittedAt: string): string {
  const submittedDate = new Date(submittedAt);
  const timestamp = Number.isFinite(submittedDate.getTime())
    ? submittedDate.toISOString().replace(/[-:T]/g, "").slice(0, 14)
    : "*";

  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}
