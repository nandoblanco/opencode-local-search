import type { Plugin } from "@opencode/plugin"
import {
  loadSessionIndex,
  parseSearchQuery,
  searchSessionIndex,
} from "./search.ts"
import {
  SearchRpc,
  type RpcSessionMatch,
  type SearchQueryInput,
  type SearchQueryOutput,
} from "./rpc.ts"

export async function executeSearchQuery(
  input: SearchQueryInput,
  customDbPath?: string,
): Promise<SearchQueryOutput> {
  const query = input.query ?? ""
  const scope = input.scope ?? "project"
  const currentDirectory = input.currentDirectory ?? ""
  const role = input.role ?? "all"
  const datePreset = input.datePreset ?? "all"
  const mode = input.mode ?? "smart"
  const limit = input.limit ?? 60

  const index = await loadSessionIndex(Boolean(input.forceReload), customDbPath)
  const parsed = parseSearchQuery(query, {
    mode,
    role,
    scope,
    datePreset,
  })
  const matches = searchSessionIndex(index, query, {
    sort: input.sort,
    scope,
    currentDirectory,
    role,
    datePreset,
    mode,
    limit,
  })

  const results: RpcSessionMatch[] = matches.map((m) => ({
    id: m.session.id,
    title: m.session.title,
    directory: m.session.directory,
    directoryNorm: m.session.directoryNorm,
    timeCreated: m.session.timeCreated,
    timeUpdated: m.session.timeUpdated,
    archived: m.session.archived,
    contextTokens: m.session.contextTokens,
    totalTokens: m.session.totalTokens,
    tools: m.session.tools.slice(0, 12),
    files: m.session.files.slice(0, 16),
    entryCount: m.session.entries.length,
    score: m.score,
    matchBadge: m.matchBadge,
    bestSnippet: m.bestSnippet,
    bestRole: m.bestRole,
    bestMessageId: m.bestMatch?.messageId,
    totalMatches: m.totalMatches,
    matches: m.matches.slice(0, 24),
    recentEntries: m.session.entries.slice(-10).map((e) => ({
      id: e.id,
      messageId: e.messageId,
      role: e.role,
      kind: e.kind,
      text: e.text.length > 360 ? `${e.text.slice(0, 357)}...` : e.text,
      toolName: e.toolName,
      filePath: e.filePath,
      timeCreated: e.timeCreated,
    })),
  }))

  return JSON.parse(
    JSON.stringify({
      totalSessions: index.sessions.length,
      loadedAt: index.loadedAt,
      parsed: {
        raw: parsed.raw,
        terms: parsed.terms,
        fuzzyTerms: parsed.fuzzyTerms,
        regexPattern: parsed.regex?.source,
        regexFlags: parsed.regex?.flags,
        regexError: parsed.regexError,
        role: parsed.role,
        scope: parsed.scope,
        fileFilter: parsed.fileFilter,
        toolFilter: parsed.toolFilter,
        inFilter: parsed.inFilter,
        dateLabel: parsed.dateRange?.label,
        effectiveMode: parsed.effectiveMode,
      },
      results,
    }),
  ) as SearchQueryOutput
}

const server: Plugin.Definition = {
  id: "opencode-local-search",
  async setup(ctx) {
    if (ctx?.rpc?.register) {
      await ctx.rpc.register(SearchRpc, {
        async query(input) {
          return executeSearchQuery(input)
        },
      })
    }
  },
}

export default server
