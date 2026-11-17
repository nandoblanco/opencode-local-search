import type { JsonSchema } from "@opencode/plugin/rpc"
import type {
  DatePreset,
  RoleFilter,
  ScopeFilter,
  SearchEntryMatch,
  SearchMode,
  SearchSort,
} from "./search.ts"

export interface RpcPreviewEntry {
  id: string
  messageId?: string
  role: "user" | "assistant" | "shell"
  kind: "message" | "tool" | "filepath"
  text: string
  toolName?: string
  filePath?: string
  timeCreated: number
}

export interface RpcSessionMatch {
  id: string
  title: string
  directory: string
  directoryNorm: string
  timeCreated: number
  timeUpdated: number
  archived?: boolean
  contextTokens?: number
  totalTokens?: number
  tools: string[]
  files: string[]
  entryCount: number
  score: number
  matchBadge: string
  bestSnippet: string
  bestRole: "user" | "assistant" | "shell" | "title"
  bestMessageId?: string
  totalMatches: number
  matches: SearchEntryMatch[]
  recentEntries: RpcPreviewEntry[]
}

export interface RpcParsedQueryInfo {
  raw: string
  terms: string[]
  fuzzyTerms: string[]
  regexPattern?: string
  regexFlags?: string
  regexError?: string
  role: RoleFilter
  scope?: ScopeFilter
  fileFilter?: string
  toolFilter?: string
  inFilter?: "title" | "message" | "tool" | "file"
  dateLabel?: string
  effectiveMode: SearchMode
}

export interface SearchQueryInput {
  sort?: SearchSort
  query: string
  scope?: ScopeFilter
  currentDirectory?: string
  role?: RoleFilter
  datePreset?: DatePreset
  mode?: SearchMode
  limit?: number
  forceReload?: boolean
}

export interface SearchQueryOutput {
  totalSessions: number
  loadedAt: number
  parsed: RpcParsedQueryInfo
  results: RpcSessionMatch[]
}

const searchInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    query: { type: "string" },
    sort: { type: "string", enum: ["updated", "relevance", "newest", "oldest", "title", "context", "tokens"] },
    scope: { type: "string", enum: ["all", "project"] },
    currentDirectory: { type: "string" },
    role: { type: "string", enum: ["all", "user", "assistant", "shell"] },
    datePreset: { type: "string", enum: ["all", "today", "yesterday", "7d", "30d"] },
    mode: { type: "string", enum: ["smart", "fuzzy", "regex"] },
    limit: { type: "number" },
    forceReload: { type: "boolean" },
  },
  required: ["query"],
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema<SearchQueryInput>

const searchOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
} as unknown as JsonSchema.JsonSchema<SearchQueryOutput>

export const SearchRpc = {
  id: "opencode-local-search",
  methods: {
    query: {
      input: searchInputSchema,
      output: searchOutputSchema,
    },
  },
  events: {},
} as const
