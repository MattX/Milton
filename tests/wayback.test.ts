import { describe, expect, it } from "vitest";
import { waybackUrl } from "../src/wayback";

describe("Wayback links", () => {
  it("targets the capture nearest the article submission time", () => {
    expect(waybackUrl(
      "https://example.com/story?chapter=2",
      "2024-05-06T12:34:56.000Z",
    )).toBe(
      "https://web.archive.org/web/20240506123456/https://example.com/story?chapter=2",
    );
  });

  it("falls back to the capture calendar when the submission time is invalid", () => {
    expect(waybackUrl("https://example.com/story", "invalid"))
      .toBe("https://web.archive.org/web/*/https://example.com/story");
  });
});
