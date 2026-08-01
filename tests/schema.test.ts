import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("creates FTS tables and keeps the index synchronized", () => {
    const schema = readFileSync("migrations/0001_initial.sql", "utf8");
    const sql = `${schema}\n
      INSERT INTO articles (
        normalized_url, original_url, domain, title, body, excerpt,
        extraction_status, first_posted_at, last_posted_at, created_at, updated_at
      ) VALUES (
        'https://example.com/', 'https://example.com/', 'example.com',
        'Distributed systems', 'A searchable article body', '', 'indexed',
        datetime('now'), datetime('now'), datetime('now'), datetime('now')
      );
      SELECT title FROM articles_fts WHERE articles_fts MATCH 'searchable';
      UPDATE articles SET body = 'Replacement text' WHERE id = 1;
      SELECT count(*) FROM articles_fts WHERE articles_fts MATCH 'searchable';
      SELECT count(*) FROM articles_fts WHERE articles_fts MATCH 'replacement';
    `;
    const output = execFileSync("sqlite3", [":memory:"], { input: sql, encoding: "utf8" });
    expect(output.trim().split("\n")).toEqual(["Distributed systems", "0", "1"]);
  });
});
