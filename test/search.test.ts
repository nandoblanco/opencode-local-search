"use strict";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  buildSnippet,
  editDistanceBounded,
  findFuzzyWordMatch,
  loadSessionIndex,
  parseSearchQuery,
  type SessionIndex,
  searchSessionIndex,
} from "../src/search.ts";

describe("parseSearchQuery", () => {
  it("parses multi-word terms and quoted phrases", () => {
    const parsed = parseSearchQuery('auth "session cookie" login');
    assert.deepEqual(parsed.terms, ["auth", "session cookie", "login"]);
    assert.equal(parsed.effectiveMode, "smart");
  });

  it("parses regex literals and re: prefix", () => {
    const slashRegex = parseSearchQuery("/session_v[12]/i role:user");
    assert.equal(slashRegex.effectiveMode, "regex");
    assert.equal(slashRegex.role, "user");
    assert.ok(slashRegex.regex);
    assert.ok(slashRegex.regex.test("SESSION_V2"));

    const prefixRegex = parseSearchQuery("re:err_\\d+");
    assert.equal(prefixRegex.effectiveMode, "regex");
    assert.ok(prefixRegex.regex?.test("err_404"));
  });

  it("parses ~fuzzy terms and inline filters", () => {
    const parsed = parseSearchQuery(
      "~playwrigth role:ai scope:project date:7d file:tui.ts tool:edit in:tool"
    );
    assert.deepEqual(parsed.fuzzyTerms, ["playwrigth"]);
    assert.equal(parsed.role, "assistant");
    assert.equal(parsed.scope, "project");
    assert.equal(parsed.dateRange?.label, "7d");
    assert.equal(parsed.fileFilter, "tui.ts");
    assert.equal(parsed.toolFilter, "edit");
    assert.equal(parsed.inFilter, "tool");
  });

  it("parses explicit YYYY-MM and YYYY-MM-DD..YYYY-MM-DD date ranges", () => {
    const month = parseSearchQuery("date:2026-10 bug");
    assert.equal(month.dateRange?.label, "2026-10");
    assert.ok((month.dateRange?.start ?? 0) > 0);
    assert.ok((month.dateRange?.end ?? 0) > (month.dateRange?.start ?? 0));

    const range = parseSearchQuery("date:2026-10-01..2026-10-25");
    assert.equal(range.dateRange?.label, "2026-10-01..2026-10-25");
  });
});

describe("editDistanceBounded & findFuzzyWordMatch", () => {
  it("computes bounded edit distance accurately", () => {
    assert.equal(editDistanceBounded("playwright", "playwright", 2), 0);
    assert.equal(editDistanceBounded("playwright", "playwrigth", 2), 2);
    assert.ok(editDistanceBounded("playwright", "completelydifferent", 2) > 2);
  });

  it("finds typo-tolerant word matches in text", () => {
    const match = findFuzzyWordMatch("we verified rendering with playwright yesterday", "playwrigth");
    assert.ok(match);
    assert.equal(match.matchedWord, "playwright");
    assert.ok(match.distance <= 2);
  });
});

describe("searchSessionIndex", () => {
  const now = Date.now();
  const mockIndex: SessionIndex = {
    dbPath: ":memory:",
    loadedAt: now,
    sessions: [
      {
        id: "ses_1",
        title: "Playwright Dialog Width Fix",
        titleLower: "playwright dialog width fix",
        directory: "/workspace/app",
        directoryNorm: "/workspace/app",
        timeCreated: now - 3600_000,
        timeUpdated: now - 1800_000,
        tools: ["edit", "shell"],
        files: ["src/tui.ts", "README.md"],
        entries: [
          {
            id: "m1",
            role: "user",
            kind: "message",
            text: "can the popup be wider? make it 70% width",
            textLower: "can the popup be wider? make it 70% width",
            timeCreated: now - 3500_000,
          },
          {
            id: "m2",
            role: "assistant",
            kind: "tool",
            toolName: "edit",
            text: "[edit] path: src/tui.ts · newString: dialogBox.width = '70%'",
            textLower: "[edit] path: src/tui.ts · newstring: dialogbox.width = '70%'",
            timeCreated: now - 3400_000,
          },
          {
            id: "m3",
            role: "assistant",
            kind: "filepath",
            filePath: "src/tui.ts",
            text: "src/tui.ts",
            textLower: "src/tui.ts",
            timeCreated: now - 3400_000,
          },
        ],
      },
      {
        id: "ses_2",
        title: "Database Migration Setup",
        titleLower: "database migration setup",
        directory: "/workspace/backend",
        directoryNorm: "/workspace/backend",
        timeCreated: now - 86_400_000 * 10,
        timeUpdated: now - 86_400_000 * 10,
        tools: ["read"],
        files: ["schema.sql"],
        entries: [
          {
            id: "m4",
            role: "user",
            kind: "message",
            text: "add index on session_v2 time_updated column",
            textLower: "add index on session_v2 time_updated column",
            timeCreated: now - 86_400_000 * 10,
          },
        ],
      },
    ],
  };

  it("matches multi-term session-level AND across title and messages", () => {
    const hits = searchSessionIndex(mockIndex, "playwright 70%");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session.id, "ses_1");
  });

  it("falls back to fuzzy matching in smart mode when exact term has a typo", () => {
    const hits = searchSessionIndex(mockIndex, "playwrigth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session.id, "ses_1");
  });

  it("filters by file:, tool:, role:, date:, and scope:project", () => {
    const fileHits = searchSessionIndex(mockIndex, "file:tui.ts width");
    assert.equal(fileHits.length, 1);
    assert.equal(fileHits[0].session.id, "ses_1");

    const projectHits = searchSessionIndex(mockIndex, "scope:project", {
      currentDirectory: "/workspace/backend",
    });
    assert.equal(projectHits.length, 1);
    assert.equal(projectHits[0].session.id, "ses_2");

    const recentHits = searchSessionIndex(mockIndex, "date:7d");
    assert.equal(recentHits.length, 1);
    assert.equal(recentHits[0].session.id, "ses_1");
  });

  it("builds centered snippets cleanly", () => {
    const snippet = buildSnippet(
      "This is a long message that mentions playwright right in the middle of the sentence.",
      "playwright",
      50
    );
    assert.ok(snippet.includes("playwright"));
  });

  it("guards against catastrophic backtracking regexes and enforces entry filters in smart fuzzy fallback", () => {
    const evilQuery = parseSearchQuery("/(a+)+b/");
    assert.equal(evilQuery.effectiveMode, "regex");
    assert.equal(evilQuery.regex, undefined);
    assert.ok(evilQuery.regexError);

    // Smart-mode fuzzy fallback must not match an entry filtered out by in:file
    const filteredHits = searchSessionIndex(mockIndex, "in:file playwright databse");
    assert.equal(filteredHits.length, 0);
  });
});

describe("loadSessionIndex (SQLite V2 schema)", () => {
  it("loads and indexes a temporary OpenCode V2 SQLite database", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "opencode-local-search-test-"));
    const dbPath = join(tempDir, "opencode.db");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_directory TEXT,
          root_directory TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_archived INTEGER
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const now = Date.now();
      db.prepare(
        "INSERT INTO session_v2 (id, title, workspace_directory, root_directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ses_test", "SQLite Loader Test", "/tmp/proj", "/tmp/proj", now, now);

      db.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)"
      ).run(
        "msg_1",
        "ses_test",
        "user",
        now,
        JSON.stringify({ type: "user", text: "verify zero token sqlite search" })
      );
      db.close();

      const index = await loadSessionIndex(true, dbPath);
      assert.equal(index.sessions.length, 1);
      assert.equal(index.sessions[0].title, "SQLite Loader Test");

      const matches = searchSessionIndex(index, "zero token");
      assert.equal(matches.length, 1);
      assert.equal(matches[0].session.id, "ses_test");
      assert.equal(matches[0].bestMatch?.messageId, "msg_1");
      assert.equal(matches[0].matches[0]?.messageId, "msg_1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
