"use strict";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SearchMode = "smart" | "fuzzy" | "regex";
export type RoleFilter = "all" | "user" | "assistant" | "shell";
export type ScopeFilter = "all" | "project";
export type DatePreset = "all" | "today" | "yesterday" | "7d" | "30d";

export interface SearchEntry {
  id: string;
  role: "user" | "assistant" | "shell";
  kind: "message" | "tool" | "filepath";
  text: string;
  textLower: string;
  toolName?: string;
  filePath?: string;
  timeCreated: number;
}

export interface IndexedSession {
  id: string;
  title: string;
  titleLower: string;
  directory: string;
  directoryNorm: string;
  timeCreated: number;
  timeUpdated: number;
  tools: string[];
  files: string[];
  entries: SearchEntry[];
}

export interface SessionIndex {
  dbPath: string;
  loadedAt: number;
  sessions: IndexedSession[];
}

export interface SearchEntryMatch {
  role: "user" | "assistant" | "shell" | "title";
  kind: "title" | "message" | "tool" | "filepath" | "fuzzy";
  toolName?: string;
  filePath?: string;
  timeCreated: number;
  snippet: string;
  matchedTerm: string;
}

export interface SearchSessionMatch {
  session: IndexedSession;
  score: number;
  matchBadge: string;
  bestSnippet: string;
  bestRole: string;
  totalMatches: number;
  matches: SearchEntryMatch[];
}

export interface SearchOptions {
  scope?: ScopeFilter;
  currentDirectory?: string;
  role?: RoleFilter;
  datePreset?: DatePreset;
  mode?: SearchMode;
  limit?: number;
}

export interface ParsedQuery {
  raw: string;
  terms: string[];
  fuzzyTerms: string[];
  regex?: RegExp;
  regexError?: string;
  role: RoleFilter;
  scope?: ScopeFilter;
  fileFilter?: string;
  toolFilter?: string;
  inFilter?: "title" | "message" | "tool" | "file";
  dateRange?: { start?: number; end?: number; label: string };
  effectiveMode: SearchMode;
}

interface SqliteRowsDriver {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

let cachedIndex: SessionIndex | null = null;
const INDEX_TTL_MS = 6000; // Refresh at most every 6s unless forced

export function resolveDbPath(customPath?: string): string {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }
  if (process.env.OPENCODE_DB_PATH && existsSync(process.env.OPENCODE_DB_PATH)) {
    return process.env.OPENCODE_DB_PATH;
  }
  const home = homedir();
  const candidates: string[] = [];
  if (process.env.XDG_DATA_HOME) {
    candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"));
  }
  candidates.push(join(home, ".local", "share", "opencode", "opencode.db"));
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "opencode.db"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

async function openBunSqlite(dbPath: string): Promise<SqliteRowsDriver> {
  const bunSqlite = await import("bun:sqlite");
  let db: InstanceType<typeof bunSqlite.Database>;
  try {
    db = new bunSqlite.Database(dbPath, { readonly: true });
  } catch {
    db = new bunSqlite.Database(dbPath);
  }
  return {
    all(sql: string, ...params: unknown[]) {
      return db.query(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    close() {
      db.close();
    },
  };
}

async function openNodeSqlite(dbPath: string): Promise<SqliteRowsDriver> {
  const nodeSqlite = await import("node:sqlite");
  let db: InstanceType<typeof nodeSqlite.DatabaseSync>;
  try {
    db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    db = new nodeSqlite.DatabaseSync(dbPath);
  }
  return {
    all(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    close() {
      db.close();
    },
  };
}

async function openReadOnlyDb(dbPath: string): Promise<SqliteRowsDriver> {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) {
    try {
      return await openBunSqlite(dbPath);
    } catch {
      return await openNodeSqlite(dbPath);
    }
  }
  try {
    return await openNodeSqlite(dbPath);
  } catch {
    return await openBunSqlite(dbPath);
  }
}

export function normalizePath(p: string | undefined | null): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function extractFilePathsFromInput(input: unknown, out: Set<string>): void {
  if (!input) return;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      extractFilePathsFromInput(parsed, out);
    } catch {
      return;
    }
    return;
  }
  if (typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "filePath", "file", "file_path", "targetFile", "workdir", "directory"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) {
      out.add(val.trim());
    }
  }
  if (Array.isArray(record.files)) {
    for (const item of record.files) {
      if (typeof item === "string" && item.trim()) {
        out.add(item.trim());
      }
    }
  }
}

function stringifyToolInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" && v.trim()) {
      parts.push(`${k}: ${v.trim()}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join(" · ");
}

export async function loadSessionIndex(force = false, customDbPath?: string): Promise<SessionIndex> {
  const dbPath = resolveDbPath(customDbPath);
  if (!force && cachedIndex && cachedIndex.dbPath === dbPath && Date.now() - cachedIndex.loadedAt < INDEX_TTL_MS) {
    return cachedIndex;
  }
  if (!existsSync(dbPath)) {
    return { dbPath, loadedAt: Date.now(), sessions: [] };
  }

  const db = await openReadOnlyDb(dbPath);
  const sessionsMap = new Map<string, IndexedSession>();
  const sessionFiles = new Map<string, Set<string>>();
  const sessionTools = new Map<string, Set<string>>();

  try {
    const tables = new Set(
      db
        .all("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name || ""))
    );

    // 1. OpenCode V2 Schema (session_v2 + session_message)
    if (tables.has("session_v2")) {
      const v2Cols = new Set(
        db.all("PRAGMA table_info(session_v2)").map((col) => String(col.name || ""))
      );
      const dirExpr = v2Cols.has("directory")
        ? "directory"
        : v2Cols.has("workspace_directory")
          ? "COALESCE(workspace_directory, root_directory, '')"
          : "''";
      const whereClause = v2Cols.has("time_archived") ? "WHERE time_archived IS NULL" : "";

      const v2Sessions = db.all(`
        SELECT id, title, ${dirExpr} AS directory, time_created, time_updated
        FROM session_v2
        ${whereClause}
        ORDER BY time_updated DESC
        LIMIT 800
      `);

      for (const row of v2Sessions) {
        const id = String(row.id || "");
        if (!id) continue;
        const title = String(row.title || "(untitled session)");
        const directory = String(row.directory || "");
        sessionsMap.set(id, {
          id,
          title,
          titleLower: title.toLowerCase(),
          directory,
          directoryNorm: normalizePath(directory),
          timeCreated: Number(row.time_created || 0),
          timeUpdated: Number(row.time_updated || 0),
          tools: [],
          files: [],
          entries: [],
        });
        sessionFiles.set(id, new Set());
        sessionTools.set(id, new Set());
      }

      if (tables.has("session_message") && sessionsMap.size > 0) {
        const msgWhere = v2Cols.has("time_archived")
          ? "WHERE s.time_archived IS NULL AND m.type IN ('user', 'assistant', 'shell')"
          : "WHERE m.type IN ('user', 'assistant', 'shell')";
        let v2Messages: Record<string, unknown>[];
        try {
          v2Messages = db.all(`
            SELECT id, session_id, type, time_created, data
            FROM (
              SELECT m.id, m.session_id, m.type, m.time_created, m.data,
                     ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
              FROM session_message m
              JOIN session_v2 s ON s.id = m.session_id
              ${msgWhere}
            )
            WHERE rn <= 250
            ORDER BY time_created DESC
            LIMIT 30000
          `);
        } catch {
          v2Messages = db.all(`
            SELECT m.id, m.session_id, m.type, m.time_created, m.data
            FROM session_message m
            JOIN session_v2 s ON s.id = m.session_id
            ${msgWhere}
            ORDER BY m.time_created DESC
            LIMIT 18000
          `);
        }

        for (const row of v2Messages) {
          const sessionId = String(row.session_id || "");
          const session = sessionsMap.get(sessionId);
          if (!session) continue;
          const msgId = String(row.id || "");
          const timeCreated = Number(row.time_created || session.timeUpdated);
          const rawData = String(row.data || "");
          if (!rawData) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(rawData);
          } catch {
            continue;
          }

          const type = String(row.type || parsed.type || "");
          const filesSet = sessionFiles.get(sessionId)!;
          const toolsSet = sessionTools.get(sessionId)!;

          if (type === "user") {
            const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
            if (text) {
              session.entries.push({
                id: msgId,
                role: "user",
                kind: "message",
                text,
                textLower: text.toLowerCase(),
                timeCreated,
              });
            }
            if (Array.isArray(parsed.files)) {
              for (const f of parsed.files) {
                if (f && typeof f === "object") {
                  const fileObj = f as Record<string, unknown>;
                  const source = fileObj.source as Record<string, unknown> | undefined;
                  const filePath =
                    (typeof fileObj.name === "string" && fileObj.name) ||
                    (source && typeof source.uri === "string" && source.uri) ||
                    "";
                  if (filePath) {
                    filesSet.add(filePath);
                    session.entries.push({
                      id: `${msgId}:file:${filePath}`,
                      role: "user",
                      kind: "filepath",
                      text: filePath,
                      textLower: filePath.toLowerCase(),
                      filePath,
                      timeCreated,
                    });
                  }
                }
              }
            }
          } else if (type === "assistant" && Array.isArray(parsed.content)) {
            for (const item of parsed.content) {
              if (!item || typeof item !== "object") continue;
              const part = item as Record<string, unknown>;
              if (part.type === "text" && typeof part.text === "string") {
                const text = part.text.trim();
                if (text) {
                  session.entries.push({
                    id: msgId,
                    role: "assistant",
                    kind: "message",
                    text,
                    textLower: text.toLowerCase(),
                    timeCreated,
                  });
                }
              } else if (part.type === "tool" && typeof part.name === "string") {
                const toolName = part.name;
                toolsSet.add(toolName);
                const state = (part.state as Record<string, unknown>) || {};
                const localFiles = new Set<string>();
                extractFilePathsFromInput(state.input, localFiles);
                for (const fp of localFiles) {
                  filesSet.add(fp);
                  session.entries.push({
                    id: `${msgId}:file:${fp}`,
                    role: "assistant",
                    kind: "filepath",
                    text: `${toolName} -> ${fp}`,
                    textLower: `${toolName} ${fp}`.toLowerCase(),
                    toolName,
                    filePath: fp,
                    timeCreated,
                  });
                }
                const inputSummary = stringifyToolInput(state.input);
                if (inputSummary) {
                  const toolText = `[${toolName}] ${inputSummary}`;
                  session.entries.push({
                    id: `${msgId}:tool:${toolName}`,
                    role: "assistant",
                    kind: "tool",
                    text: toolText,
                    textLower: toolText.toLowerCase(),
                    toolName,
                    timeCreated,
                  });
                }
              }
            }
          } else if (type === "shell") {
            const cmd = typeof parsed.command === "string" ? parsed.command.trim() : "";
            const outObj = parsed.output as Record<string, unknown> | undefined;
            const outText = outObj && typeof outObj.output === "string" ? outObj.output.trim() : "";
            const combined = [cmd ? `$ ${cmd}` : "", outText].filter(Boolean).join("\n");
            if (combined) {
              toolsSet.add("shell");
              session.entries.push({
                id: msgId,
                role: "shell",
                kind: "tool",
                text: combined,
                textLower: combined.toLowerCase(),
                toolName: "shell",
                timeCreated,
              });
            }
          }
        }
      }
    }

    // 2. OpenCode V1 Fallback Schema (session + message + part)
    if (tables.has("session") && tables.has("message") && tables.has("part")) {
      const v1Sessions = db.all(`
        SELECT id, title, directory, time_created, time_updated
        FROM session
        ORDER BY time_updated DESC
        LIMIT 500
      `);

      for (const row of v1Sessions) {
        const id = String(row.id || "");
        if (!id || sessionsMap.has(id)) continue;
        const title = String(row.title || "(untitled session)");
        const directory = String(row.directory || "");
        sessionsMap.set(id, {
          id,
          title,
          titleLower: title.toLowerCase(),
          directory,
          directoryNorm: normalizePath(directory),
          timeCreated: Number(row.time_created || 0),
          timeUpdated: Number(row.time_updated || 0),
          tools: [],
          files: [],
          entries: [],
        });
        sessionFiles.set(id, new Set());
        sessionTools.set(id, new Set());
      }

      let v1Parts: Record<string, unknown>[];
      try {
        v1Parts = db.all(`
          SELECT id, session_id, time_created, part_data, role
          FROM (
            SELECT p.id, p.session_id, p.time_created, p.data AS part_data,
                   json_extract(m.data, '$.role') AS role,
                   ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_created DESC) AS rn
            FROM part p
            JOIN message m ON m.id = p.message_id
          )
          WHERE rn <= 250
          ORDER BY time_created DESC
          LIMIT 25000
        `);
      } catch {
        v1Parts = db.all(`
          SELECT p.id, p.session_id, p.time_created, p.data AS part_data,
                 json_extract(m.data, '$.role') AS role
          FROM part p
          JOIN message m ON m.id = p.message_id
          ORDER BY p.time_created DESC
          LIMIT 12000
        `);
      }

      for (const row of v1Parts) {
        const sessionId = String(row.session_id || "");
        const session = sessionsMap.get(sessionId);
        if (!session || session.entries.length > 0 && tables.has("session_v2")) continue;
        const role = row.role === "user" ? "user" : "assistant";
        const timeCreated = Number(row.time_created || session.timeUpdated);
        let part: Record<string, unknown>;
        try {
          part = JSON.parse(String(row.part_data || ""));
        } catch {
          continue;
        }
        const filesSet = sessionFiles.get(sessionId)!;
        const toolsSet = sessionTools.get(sessionId)!;

        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          const text = part.text.trim();
          session.entries.push({
            id: String(row.id || ""),
            role,
            kind: "message",
            text,
            textLower: text.toLowerCase(),
            timeCreated,
          });
        } else if (part.type === "tool" && typeof part.tool === "string") {
          const toolName = part.tool;
          toolsSet.add(toolName);
          const state = (part.state as Record<string, unknown>) || {};
          const localFiles = new Set<string>();
          extractFilePathsFromInput(state.input, localFiles);
          for (const fp of localFiles) {
            filesSet.add(fp);
          }
          const summary = stringifyToolInput(state.input);
          if (summary) {
            const toolText = `[${toolName}] ${summary}`;
            session.entries.push({
              id: String(row.id || ""),
              role,
              kind: "tool",
              text: toolText,
              textLower: toolText.toLowerCase(),
              toolName,
              timeCreated,
            });
          }
        } else if (part.type === "patch" && Array.isArray(part.files)) {
          for (const fp of part.files) {
            if (typeof fp === "string" && fp.trim()) {
              filesSet.add(fp.trim());
              session.entries.push({
                id: `${row.id}:patch:${fp}`,
                role,
                kind: "filepath",
                text: fp.trim(),
                textLower: fp.trim().toLowerCase(),
                filePath: fp.trim(),
                timeCreated,
              });
            }
          }
        }
      }
    }
  } finally {
    db.close();
  }

  for (const [id, session] of sessionsMap) {
    session.files = [...(sessionFiles.get(id) || [])];
    session.tools = [...(sessionTools.get(id) || [])];
  }

  const sessions = [...sessionsMap.values()].sort((a, b) => b.timeUpdated - a.timeUpdated);
  cachedIndex = {
    dbPath,
    loadedAt: Date.now(),
    sessions,
  };
  return cachedIndex;
}

function parseDateToken(value: string): { start?: number; end?: number; label: string } | undefined {
  const v = value.trim().toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;

  if (v === "today" || v === "1d") {
    return { start: startOfToday, label: "today" };
  }
  if (v === "yesterday") {
    return { start: startOfToday - dayMs, end: startOfToday, label: "yesterday" };
  }
  const daysMatch = v.match(/^(\d+)d$/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    return { start: Date.now() - days * dayMs, label: `${days}d` };
  }
  const weeksMatch = v.match(/^(\d+)w$/);
  if (weeksMatch) {
    const weeks = Number(weeksMatch[1]);
    return { start: Date.now() - weeks * 7 * dayMs, label: `${weeks}w` };
  }
  if (v.includes("..")) {
    const [fromStr, toStr] = v.split("..");
    const start = fromStr ? Date.parse(fromStr) : undefined;
    const endRaw = toStr ? Date.parse(toStr) : undefined;
    const end = endRaw && !Number.isNaN(endRaw) ? endRaw + dayMs : undefined;
    if ((start && !Number.isNaN(start)) || end) {
      return {
        start: start && !Number.isNaN(start) ? start : undefined,
        end,
        label: v,
      };
    }
  }
  if (/^\d{4}-\d{2}$/.test(v)) {
    const [year, month] = v.split("-").map(Number);
    const start = new Date(year, month - 1, 1).getTime();
    const end = new Date(year, month, 1).getTime();
    return { start, end, label: v };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const start = Date.parse(v);
    if (!Number.isNaN(start)) {
      return { start, end: start + dayMs, label: v };
    }
  }
  return undefined;
}

export function parseSearchQuery(rawQuery: string, options: SearchOptions = {}): ParsedQuery {
  const raw = rawQuery.trim();
  const terms: string[] = [];
  const fuzzyTerms: string[] = [];
  let role: RoleFilter = options.role ?? "all";
  let scope: ScopeFilter | undefined = options.scope;
  let fileFilter: string | undefined;
  let toolFilter: string | undefined;
  let inFilter: "title" | "message" | "tool" | "file" | undefined;
  let dateRange =
    options.datePreset && options.datePreset !== "all"
      ? parseDateToken(options.datePreset)
      : undefined;
  let effectiveMode: SearchMode = options.mode ?? "smart";
  let regex: RegExp | undefined;
  let regexError: string | undefined;

  // Check if entire query is a /regex/flags literal
  const slashRegex = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashRegex) {
    effectiveMode = "regex";
    try {
      regex = new RegExp(slashRegex[1], slashRegex[2] || "i");
    } catch (err) {
      regexError = err instanceof Error ? err.message : "Invalid regex";
    }
    return {
      raw,
      terms,
      fuzzyTerms,
      regex,
      regexError,
      role,
      scope,
      fileFilter,
      toolFilter,
      inFilter,
      dateRange,
      effectiveMode,
    };
  }

  // Tokenize respecting /regex/flags, key:"quoted value", "quoted phrase", or words
  const tokenPattern = /(\/[^/]+\/[gimsuy]*|[a-zA-Z]+:"[^"]+"|"[^"]+"|\S+)/g;
  const rawTokens = raw.match(tokenPattern) || [];

  for (const token of rawTokens) {
    const tokenSlashRegex = token.match(/^\/(.+)\/([gimsuy]*)$/);
    if (tokenSlashRegex) {
      effectiveMode = "regex";
      try {
        regex = new RegExp(tokenSlashRegex[1], tokenSlashRegex[2] || "i");
      } catch (err) {
        regexError = err instanceof Error ? err.message : "Invalid regex";
      }
      continue;
    }
    const lower = token.toLowerCase();
    if (lower.startsWith("role:") || lower.startsWith("from:")) {
      const val = lower.slice(lower.indexOf(":") + 1).replace(/^"|"$/g, "");
      if (val === "user" || val === "me" || val === "human") role = "user";
      else if (val === "assistant" || val === "ai" || val === "bot" || val === "model") role = "assistant";
      else if (val === "shell" || val === "cmd") role = "shell";
      else if (val === "all" || val === "any") role = "all";
      continue;
    }
    if (lower.startsWith("scope:")) {
      const val = lower.slice(6).replace(/^"|"$/g, "");
      if (val === "project" || val === "workspace" || val === "local" || val === "here") scope = "project";
      else if (val === "all" || val === "global") scope = "all";
      continue;
    }
    if (lower.startsWith("date:") || lower.startsWith("since:") || lower.startsWith("after:")) {
      const val = lower.slice(lower.indexOf(":") + 1).replace(/^"|"$/g, "");
      const parsedDate = parseDateToken(val);
      if (parsedDate) {
        dateRange = parsedDate;
        continue;
      }
    }
    if (lower.startsWith("file:") || lower.startsWith("path:")) {
      fileFilter = token.slice(token.indexOf(":") + 1).replace(/^"|"$/g, "").toLowerCase();
      continue;
    }
    if (lower.startsWith("tool:")) {
      toolFilter = token.slice(5).replace(/^"|"$/g, "").toLowerCase();
      continue;
    }
    if (lower.startsWith("in:")) {
      const val = lower.slice(3).replace(/^"|"$/g, "");
      if (val === "title" || val === "message" || val === "tool" || val === "file") {
        inFilter = val;
        continue;
      }
    }
    if (lower.startsWith("re:") || lower.startsWith("regex:")) {
      const pattern = token.slice(token.indexOf(":") + 1).replace(/^"|"$/g, "");
      effectiveMode = "regex";
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        regexError = err instanceof Error ? err.message : "Invalid regex";
      }
      continue;
    }
    if (token.startsWith("~") && token.length > 1) {
      fuzzyTerms.push(token.slice(1).replace(/^"|"$/g, "").toLowerCase());
      continue;
    }

    const cleaned = token.replace(/^"|"$/g, "").toLowerCase();
    if (cleaned) {
      terms.push(cleaned);
    }
  }

  if (effectiveMode === "regex" && !regex && terms.length > 0) {
    try {
      regex = new RegExp(terms.join(".*"), "i");
    } catch (err) {
      regexError = err instanceof Error ? err.message : "Invalid regex";
    }
  }

  return {
    raw,
    terms,
    fuzzyTerms,
    regex,
    regexError,
    role,
    scope,
    fileFilter,
    toolFilter,
    inFilter,
    dateRange,
    effectiveMode,
  };
}

// Bounded Levenshtein distance for fast zero-dependency typo tolerance
export function editDistanceBounded(a: string, b: string, maxDist: number): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  const prev = new Array<number>(lenB + 1);
  const curr = new Array<number>(lenB + 1);
  for (let j = 0; j <= lenB; j++) prev[j] = j;

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let minInRow = curr[0];
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= lenB; j++) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < minInRow) minInRow = val;
    }
    if (minInRow > maxDist) return maxDist + 1;
    for (let j = 0; j <= lenB; j++) prev[j] = curr[j];
  }
  return prev[lenB];
}

export function findFuzzyWordMatch(textLower: string, term: string): { matchedWord: string; distance: number } | null {
  if (term.length < 3) return null;
  if (textLower.includes(term)) {
    return { matchedWord: term, distance: 0 };
  }
  const maxDist = term.length <= 5 ? 1 : 2;
  const words = textLower.split(/[^a-z0-9_.-]+/);
  let bestWord = "";
  let bestDist = maxDist + 1;

  for (const w of words) {
    if (w.length < 3) continue;
    if (w.startsWith(term.slice(0, 2)) || Math.abs(w.length - term.length) <= maxDist) {
      const dist = editDistanceBounded(term, w, maxDist);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = w;
        if (dist === 1) break;
      }
    }
  }
  return bestDist <= maxDist ? { matchedWord: bestWord, distance: bestDist } : null;
}

export function buildSnippet(text: string, matchedTerm: string, maxLen = 110): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!matchedTerm) return clean.slice(0, maxLen);
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(matchedTerm.toLowerCase());
  if (idx === -1) return clean.slice(0, maxLen);
  const start = Math.max(0, idx - 32);
  const end = Math.min(clean.length, idx + matchedTerm.length + (maxLen - 32));
  return (start > 0 ? "..." : "") + clean.slice(start, end) + (end < clean.length ? "..." : "");
}

export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function searchSessionIndex(
  index: SessionIndex,
  rawQuery: string,
  options: SearchOptions = {}
): SearchSessionMatch[] {
  const parsed = parseSearchQuery(rawQuery, options);
  const limit = options.limit ?? 50;
  const scope = parsed.scope ?? options.scope ?? "all";
  const currentDirNorm = normalizePath(options.currentDirectory);

  const hasSearchTerms =
    parsed.terms.length > 0 ||
    parsed.fuzzyTerms.length > 0 ||
    Boolean(parsed.regex) ||
    Boolean(parsed.fileFilter) ||
    Boolean(parsed.toolFilter);

  const results: SearchSessionMatch[] = [];

  for (const session of index.sessions) {
    // 1. Project scope filter
    if (scope === "project" && currentDirNorm) {
      if (
        !session.directoryNorm ||
        (session.directoryNorm !== currentDirNorm &&
          !session.directoryNorm.startsWith(currentDirNorm + "/") &&
          !currentDirNorm.startsWith(session.directoryNorm + "/"))
      ) {
        continue;
      }
    }

    // 2. Date filter (session updated or entry created within range)
    if (parsed.dateRange) {
      const { start, end } = parsed.dateRange;
      if (start && session.timeUpdated < start) continue;
      if (end && session.timeCreated > end) continue;
    }

    // 3. File filter
    if (parsed.fileFilter) {
      const matchesFile = session.files.some((f) => f.toLowerCase().includes(parsed.fileFilter!));
      if (!matchesFile) continue;
    }

    // 4. Tool filter
    if (parsed.toolFilter) {
      const matchesTool = session.tools.some((t) => t.toLowerCase().includes(parsed.toolFilter!));
      if (!matchesTool) continue;
    }

    // If browsing with no search keywords (only filters or empty query)
    if (!hasSearchTerms) {
      const previewMatches: SearchEntryMatch[] = [];
      for (const entry of session.entries) {
        if (parsed.role !== "all" && entry.role !== parsed.role) continue;
        if (previewMatches.length < 6 && entry.kind === "message") {
          previewMatches.push({
            role: entry.role,
            kind: "message",
            timeCreated: entry.timeCreated,
            snippet: buildSnippet(entry.text, "", 140),
            matchedTerm: "",
          });
        }
      }
      const firstEntry = previewMatches[0];
      results.push({
        session,
        score: session.timeUpdated / 1e12,
        matchBadge: session.tools.length ? `${session.entries.length} msgs` : "recent",
        bestSnippet: firstEntry ? firstEntry.snippet : session.directory || "No messages",
        bestRole: firstEntry ? firstEntry.role : "title",
        totalMatches: previewMatches.length,
        matches: previewMatches,
      });
      continue;
    }

    // Active search matching across title and entries
    const matches: SearchEntryMatch[] = [];
    const matchedTermsInSession = new Set<string>();
    let score = 0;
    let totalMatches = 0;

    // A. Check Title
    if (!parsed.inFilter || parsed.inFilter === "title") {
      if (parsed.effectiveMode === "regex" && parsed.regex) {
        const m = session.title.match(parsed.regex);
        if (m && m[0]) {
          score += 120;
          totalMatches++;
          matches.push({
            role: "title",
            kind: "title",
            timeCreated: session.timeUpdated,
            snippet: session.title,
            matchedTerm: m[0],
          });
        }
      } else {
        for (const term of parsed.terms) {
          if (session.titleLower.includes(term)) {
            matchedTermsInSession.add(term);
            score += 90;
            totalMatches++;
            if (matches.length < 8) {
              matches.push({
                role: "title",
                kind: "title",
                timeCreated: session.timeUpdated,
                snippet: session.title,
                matchedTerm: term,
              });
            }
          } else if (parsed.effectiveMode === "fuzzy") {
            const fm = findFuzzyWordMatch(session.titleLower, term);
            if (fm) {
              matchedTermsInSession.add(term);
              score += 55 - fm.distance * 10;
              totalMatches++;
              if (matches.length < 8) {
                matches.push({
                  role: "title",
                  kind: "fuzzy",
                  timeCreated: session.timeUpdated,
                  snippet: session.title,
                  matchedTerm: fm.matchedWord,
                });
              }
            }
          }
        }
        for (const fTerm of parsed.fuzzyTerms) {
          const fm = findFuzzyWordMatch(session.titleLower, fTerm);
          if (fm) {
            matchedTermsInSession.add(`~${fTerm}`);
            score += 65 - fm.distance * 10;
            totalMatches++;
            if (matches.length < 8) {
              matches.push({
                role: "title",
                kind: "fuzzy",
                timeCreated: session.timeUpdated,
                snippet: session.title,
                matchedTerm: fm.matchedWord,
              });
            }
          }
        }
      }
    }

    // B. Check Entries (messages, tool calls, file paths)
    for (const entry of session.entries) {
      if (parsed.role !== "all" && entry.role !== parsed.role) continue;
      if (parsed.inFilter === "title") continue;
      if (parsed.inFilter === "message" && entry.kind !== "message") continue;
      if (parsed.inFilter === "tool" && entry.kind !== "tool") continue;
      if (parsed.inFilter === "file" && entry.kind !== "filepath") continue;
      if (
        parsed.toolFilter &&
        entry.kind === "tool" &&
        (!entry.toolName || !entry.toolName.toLowerCase().includes(parsed.toolFilter))
      ) {
        continue;
      }
      if (
        parsed.fileFilter &&
        entry.kind === "filepath" &&
        (!entry.filePath || !entry.filePath.toLowerCase().includes(parsed.fileFilter))
      ) {
        continue;
      }

      const matchesFilterTarget =
        Boolean(
          parsed.toolFilter &&
            entry.toolName &&
            entry.toolName.toLowerCase().includes(parsed.toolFilter)
        ) ||
        Boolean(
          parsed.fileFilter &&
            ((entry.filePath && entry.filePath.toLowerCase().includes(parsed.fileFilter)) ||
              (entry.kind === "tool" && entry.textLower.includes(parsed.fileFilter)))
        );

      if (parsed.dateRange) {
        const { start, end } = parsed.dateRange;
        if (start && entry.timeCreated < start) continue;
        if (end && entry.timeCreated > end) continue;
      }

      if (parsed.effectiveMode === "regex" && parsed.regex) {
        const m = entry.text.match(parsed.regex);
        if (m && m[0]) {
          score += entry.kind === "message" ? 50 : 35;
          totalMatches++;
          if (matches.length < 8) {
            matches.push({
              role: entry.role,
              kind: entry.kind,
              toolName: entry.toolName,
              filePath: entry.filePath,
              timeCreated: entry.timeCreated,
              snippet: buildSnippet(entry.text, m[0], 130),
              matchedTerm: m[0],
            });
          }
        }
        continue;
      }

      // Smart / Fuzzy term checks
      let entryMatchedTerms = 0;
      let firstMatchedSubstring = "";
      let isFuzzyEntryMatch = false;

      for (const term of parsed.terms) {
        if (entry.textLower.includes(term)) {
          matchedTermsInSession.add(term);
          entryMatchedTerms++;
          if (!firstMatchedSubstring) firstMatchedSubstring = term;
        } else if (parsed.effectiveMode === "fuzzy") {
          const fm = findFuzzyWordMatch(entry.textLower, term);
          if (fm) {
            matchedTermsInSession.add(term);
            entryMatchedTerms++;
            isFuzzyEntryMatch = true;
            if (!firstMatchedSubstring) firstMatchedSubstring = fm.matchedWord;
          }
        }
      }

      for (const fTerm of parsed.fuzzyTerms) {
        const fm = findFuzzyWordMatch(entry.textLower, fTerm);
        if (fm) {
          matchedTermsInSession.add(`~${fTerm}`);
          entryMatchedTerms++;
          isFuzzyEntryMatch = true;
          if (!firstMatchedSubstring) firstMatchedSubstring = fm.matchedWord;
        }
      }

      // Filter-only match (e.g. file:tui.ts or tool:edit with no extra keywords)
      if (
        parsed.terms.length === 0 &&
        parsed.fuzzyTerms.length === 0 &&
        matchesFilterTarget
      ) {
        entryMatchedTerms = 1;
        firstMatchedSubstring = parsed.fileFilter || parsed.toolFilter || "";
      }

      if (entryMatchedTerms > 0) {
        totalMatches++;
        // Bonus when a single message contains ALL query terms or directly matches active file:/tool: filter
        const allInSingleEntry = parsed.terms.length > 1 && entryMatchedTerms >= parsed.terms.length;
        const filterBonus = matchesFilterTarget ? 25 : 0;
        score +=
          (isFuzzyEntryMatch ? 20 : 35) * entryMatchedTerms +
          (allInSingleEntry ? 45 : 0) +
          filterBonus;

        if (matches.length < 8) {
          matches.push({
            role: entry.role,
            kind: isFuzzyEntryMatch ? "fuzzy" : entry.kind,
            toolName: entry.toolName,
            filePath: entry.filePath,
            timeCreated: entry.timeCreated,
            snippet: buildSnippet(entry.text, firstMatchedSubstring, 130),
            matchedTerm: firstMatchedSubstring,
          });
        }
      }
    }

    // Verify Session-Level Multi-Term AND requirement:
    // Every required term in parsed.terms and parsed.fuzzyTerms must appear somewhere in the session
    const requiredCount = parsed.terms.length + parsed.fuzzyTerms.length;
    if (parsed.effectiveMode !== "regex" && requiredCount > 0) {
      if (matchedTermsInSession.size < requiredCount) {
        // Automatic Fuzzy Fallback in "smart" mode if exact terms didn't all match!
        if (parsed.effectiveMode === "smart" && parsed.terms.length > 0) {
          for (const term of parsed.terms) {
            if (matchedTermsInSession.has(term)) continue;
            const titleFuzzy = findFuzzyWordMatch(session.titleLower, term);
            if (titleFuzzy) {
              matchedTermsInSession.add(term);
              score += 30;
              totalMatches++;
              if (matches.length < 8) {
                matches.push({
                  role: "title",
                  kind: "fuzzy",
                  timeCreated: session.timeUpdated,
                  snippet: session.title,
                  matchedTerm: titleFuzzy.matchedWord,
                });
              }
              continue;
            }
            for (const entry of session.entries) {
              if (parsed.role !== "all" && entry.role !== parsed.role) continue;
              const fm = findFuzzyWordMatch(entry.textLower, term);
              if (fm) {
                matchedTermsInSession.add(term);
                score += 22;
                totalMatches++;
                if (matches.length < 8) {
                  matches.push({
                    role: entry.role,
                    kind: "fuzzy",
                    toolName: entry.toolName,
                    filePath: entry.filePath,
                    timeCreated: entry.timeCreated,
                    snippet: buildSnippet(entry.text, fm.matchedWord, 130),
                    matchedTerm: fm.matchedWord,
                  });
                }
                break;
              }
            }
          }
        }
      }

      if (matchedTermsInSession.size < requiredCount) {
        continue;
      }
    }

    if (totalMatches === 0) continue;

    // Slight recency boost so recent relevant sessions surface above stale ones
    const recencyDays = Math.max(0, (Date.now() - session.timeUpdated) / 86_400_000);
    const recencyBoost = Math.max(0, 15 - recencyDays * 0.4);
    score += recencyBoost;

    const primary = matches[0];
    const badge =
      primary.kind === "title"
        ? "title"
        : primary.kind === "fuzzy"
          ? "fuzzy"
          : primary.kind === "filepath"
            ? "file"
            : primary.kind === "tool"
              ? `tool:${primary.toolName || "call"}`
              : primary.role === "user"
                ? "user"
                : "ai";

    results.push({
      session,
      score,
      matchBadge: badge,
      bestSnippet: primary.snippet,
      bestRole: primary.role,
      totalMatches,
      matches,
    });
  }

  results.sort((a, b) => b.score - a.score || b.session.timeUpdated - a.session.timeUpdated);
  return results.slice(0, limit);
}
