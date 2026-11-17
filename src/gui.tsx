import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Style,
  type PanelTab,
  type PluginContext,
  type UiMenuEntry,
} from "@opencode/plugin/gui"
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js"
import css from "./gui.css?inline"
import {
  SearchRpc,
  type RpcParsedQueryInfo,
  type RpcSessionMatch,
} from "./rpc.ts"
import type {
  DatePreset,
  RoleFilter,
  ScopeFilter,
  SearchMode,
  SearchSort,
} from "./search.ts"
import { SEARCH_SORT_LABELS } from "./sort.ts"

const ROLE_ORDER: RoleFilter[] = ["all", "user", "assistant", "shell"]
const DATE_ORDER: DatePreset[] = ["all", "today", "yesterday", "7d", "30d"]
const MODE_ORDER: SearchMode[] = ["smart", "fuzzy", "regex"]

const DATE_LABELS: Record<DatePreset, string> = {
  all: "Any time",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
}

const MODE_LABELS: Record<SearchMode, string> = {
  smart: "Smart",
  fuzzy: "Fuzzy",
  regex: "Regex",
}

const ROLE_LABELS: Record<RoleFilter, string> = {
  all: "All roles",
  user: "User",
  assistant: "Assistant",
  shell: "Shell",
}

function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  if (!timestampMs || timestampMs <= 0) return ""
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (diffSec < 60) return "just now"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const d = new Date(timestampMs)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function formatDateFull(ts: number): string {
  if (!ts) return "unknown"
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

function shortFolder(dir: string): string {
  if (!dir) return "Global"
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length <= 2) return parts.join("/")
  return `${parts.slice(-2).join("/")}`
}

interface HighlightSegment {
  text: string
  match: boolean
}

function splitHighlightSegments(
  text: string,
  highlightTerms: string[],
  regexPattern?: string,
  regexFlags?: string,
): HighlightSegment[] {
  if (!text) return [{ text: "", match: false }]

  if (regexPattern) {
    try {
      const flags = regexFlags?.includes("g")
        ? regexFlags
        : `${regexFlags ?? "i"}g`
      const globalRe = new RegExp(regexPattern, flags)
      const segments: HighlightSegment[] = []
      let lastIdx = 0
      let m: RegExpExecArray | null
      let safety = 0
      while ((m = globalRe.exec(text)) !== null && safety++ < 40) {
        if (m[0].length === 0) {
          globalRe.lastIndex++
          continue
        }
        if (m.index > lastIdx) {
          segments.push({ text: text.slice(lastIdx, m.index), match: false })
        }
        segments.push({ text: m[0], match: true })
        lastIdx = m.index + m[0].length
      }
      if (lastIdx < text.length) {
        segments.push({ text: text.slice(lastIdx), match: false })
      }
      return segments.length > 0 ? segments : [{ text, match: false }]
    } catch {
      return [{ text, match: false }]
    }
  }

  const cleanTerms = highlightTerms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length)

  if (cleanTerms.length === 0) return [{ text, match: false }]

  const lower = text.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    let bestPos = -1
    let bestLen = 0
    for (const term of cleanTerms) {
      const idx = lower.indexOf(term, cursor)
      if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
        bestPos = idx
        bestLen = term.length
      }
    }
    if (bestPos === -1) {
      segments.push({ text: text.slice(cursor), match: false })
      break
    }
    if (bestPos > cursor) {
      segments.push({ text: text.slice(cursor, bestPos), match: false })
    }
    segments.push({
      text: text.slice(bestPos, bestPos + bestLen),
      match: true,
    })
    cursor = bestPos + bestLen
  }

  return segments.length > 0 ? segments : [{ text, match: false }]
}

function HighlightedText(props: {
  text: string
  terms: string[]
  regexPattern?: string
  regexFlags?: string
}) {
  const segments = createMemo(() =>
    splitHighlightSegments(
      props.text,
      props.terms,
      props.regexPattern,
      props.regexFlags,
    ),
  )
  return (
    <>
      <For each={segments()}>
        {(seg) =>
          seg.match ? <mark class="ols-mark">{seg.text}</mark> : seg.text
        }
      </For>
    </>
  )
}

function resolveServerId(ctx: PluginContext): string {
  const active = ctx.sessions.current()
  if (active?.server?.id) return active.server.id
  const list = ctx.servers.list()
  for (const id of list) {
    if (ctx.servers.get(id)?.builtin) return id
  }
  return list[0] ?? "sidecar"
}

function roleLabel(role: string): string {
  if (role === "user") return "You"
  if (role === "assistant") return "Assistant"
  if (role === "shell") return "Command"
  if (role === "title") return "Title"
  return role
}

// Module-level signal so commands/intercepted clicks can drive the shared
// search panel's query without re-mounting SearchSurface (no modals).
const [olsPanelQuery, setOlsPanelQuery] = createSignal("")

function SearchSurface(props: {
  ctx: PluginContext
  initialQuery?: string
  variant: "panel" | "modal"
  onClose?: () => void
}) {
  const ui = props.ctx.ui
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [scope, setScope] = createSignal<ScopeFilter>(
    props.ctx.sessions.current()?.directory ? "project" : "all",
  )
  const [role, setRole] = createSignal<RoleFilter>("all")
  const [datePreset, setDatePreset] = createSignal<DatePreset>("all")
  const [mode, setMode] = createSignal<SearchMode>("smart")
  const [sort, setSort] = createSignal<SearchSort>("updated")
  const [restoring, setRestoring] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [selectedMatchIdx, setSelectedMatchIdx] = createSignal(0)
  const [activePane, setActivePane] = createSignal<"sessions" | "matches">(
    "sessions",
  )
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null)
  const [totalSessions, setTotalSessions] = createSignal(0)
  const [results, setResults] = createSignal<RpcSessionMatch[]>([])
  const [parsedInfo, setParsedInfo] = createSignal<RpcParsedQueryInfo | null>(
    null,
  )

  // External openers (commands, intercepted clicks) push the query here.
  createEffect(() => {
    const q = olsPanelQuery()
    if (q) setQuery(q)
  })

  let reqSeq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const currentDirectory = createMemo(
    () => props.ctx.sessions.current()?.directory ?? "",
  )

  const colorScheme = createMemo(() => props.ctx.appearance.mode())

  async function runQuery(forceReload = false) {
    const seq = ++reqSeq
    if (forceReload) setRefreshing(true)
    setLoading(true)
    setErrorMsg(null)

    try {
      const client =
        props.ctx.sessions.current()?.server?.client ??
        props.ctx.servers.get(resolveServerId(props.ctx))?.client ??
        props.ctx.client
      const response = await client.rpc(SearchRpc).query({
        query: query(),
        scope: scope(),
        currentDirectory: currentDirectory(),
        role: role(),
        datePreset: datePreset(),
        mode: mode(),
        sort: sort(),
        limit: 60,
        forceReload,
      })
      if (seq !== reqSeq) return
      setTotalSessions(response.totalSessions)
      setResults(response.results)
      setParsedInfo(response.parsed)
      setSelectedIndex((prev) =>
        Math.max(0, Math.min(prev, Math.max(0, response.results.length - 1))),
      )
      setSelectedMatchIdx(0)
      if (forceReload) {
        props.ctx.toast.show({
          variant: "success",
          title: `Refreshed ${response.totalSessions} sessions`,
        })
      }
    } catch (err) {
      if (seq !== reqSeq) return
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to query session index",
      )
    } finally {
      if (seq === reqSeq) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  createEffect(() => {
    void query()
    void scope()
    void role()
    void datePreset()
    void mode()
    void sort()
    void currentDirectory()

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void runQuery(false)
    }, 16)
  })

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  const selectedSession = createMemo<RpcSessionMatch | undefined>(
    () => results()[selectedIndex()] ?? results()[0],
  )

  const highlightTerms = createMemo(() => {
    const p = parsedInfo()
    const base = p ? [...p.terms, ...p.fuzzyTerms] : []
    const matched = selectedSession()?.matches[selectedMatchIdx()]?.matchedTerm
    if (matched && !base.includes(matched)) base.push(matched)
    return base
  })

  const activeFilterCount = createMemo(() => {
    let count = 0
    if (role() !== "all") count++
    if (datePreset() !== "all") count++
    if (mode() !== "smart") count++
    return count
  })

  const filterMenuItems = createMemo<UiMenuEntry[]>(() => [
    {
      type: "group",
      label: "Search Mode",
      items: MODE_ORDER.map((m) => ({
        label: MODE_LABELS[m],
        icon: mode() === m ? "check-small" : undefined,
        onSelect: () => {
          setMode(m)
          setSelectedIndex(0)
        },
      })),
    },
    { type: "separator" },
    {
      type: "group",
      label: "Message Role",
      items: ROLE_ORDER.map((r) => ({
        label: ROLE_LABELS[r],
        icon: role() === r ? "check-small" : undefined,
        onSelect: () => {
          setRole(r)
          setSelectedIndex(0)
        },
      })),
    },
    { type: "separator" },
    {
      type: "group",
      label: "Time Range",
      items: DATE_ORDER.map((d) => ({
        label: DATE_LABELS[d],
        icon: datePreset() === d ? "check-small" : undefined,
        onSelect: () => {
          setDatePreset(d)
          setSelectedIndex(0)
        },
      })),
    },
    { type: "separator" },
    {
      label: "Reset filters",
      disabled: activeFilterCount() === 0,
      onSelect: () => {
        setMode("smart")
        setRole("all")
        setDatePreset("all")
        setSelectedIndex(0)
      },
    },
  ])

  function toggleScope() {
    setScope((prev) => (prev === "project" ? "all" : "project"))
    setSelectedIndex(0)
  }

  function cycleRole() {
    setRole((prev) => {
      const idx = ROLE_ORDER.indexOf(prev)
      return ROLE_ORDER[(idx + 1) % ROLE_ORDER.length] ?? "all"
    })
    setSelectedIndex(0)
  }

  function cycleDatePreset() {
    setDatePreset((prev) => {
      const idx = DATE_ORDER.indexOf(prev)
      return DATE_ORDER[(idx + 1) % DATE_ORDER.length] ?? "all"
    })
    setSelectedIndex(0)
  }

  function cycleMode() {
    setMode((prev) => {
      const idx = MODE_ORDER.indexOf(prev)
      return MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? "smart"
    })
    setSelectedIndex(0)
  }

  function openSession(session: RpcSessionMatch | undefined) {
    if (!session) return
    const serverId = resolveServerId(props.ctx)
    props.ctx.tabs.open({ server: serverId, id: session.id }, { focus: true })
    props.onClose?.()
  }

  async function copySessionId(session: RpcSessionMatch | undefined) {
    if (!session) return
    await props.ctx.system.copy(session.id)
    props.ctx.toast.show({
      variant: "success",
      title: "Copied session ID",
      description: session.id,
    })
  }

  async function unarchiveSession(session: RpcSessionMatch) {
    if (restoring()) return
    setRestoring(true)
    try {
      const client = props.ctx.sessions.current()?.server?.client ??
        props.ctx.servers.get(resolveServerId(props.ctx))?.client ?? props.ctx.client
      await client.session.update({ sessionID: session.id, archived: false })
      await runQuery(true)
    } catch (err) {
      props.ctx.toast.show({ variant: "error", title: "Unable to unarchive session", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setRestoring(false)
    }
  }

  function appendSyntaxToken(token: string) {
    const cur = query().trim()
    setQuery(cur ? `${cur} ${token}` : token)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.altKey) && !e.shiftKey) {
      const key = e.key.toLowerCase()
      if (key === "p") {
        e.preventDefault()
        toggleScope()
        return
      }
      if (key === "g") {
        e.preventDefault()
        cycleRole()
        return
      }
      if (key === "t") {
        e.preventDefault()
        cycleDatePreset()
        return
      }
      if (key === "r") {
        e.preventDefault()
        cycleMode()
        return
      }
      if (key === "l") {
        e.preventDefault()
        void runQuery(true)
        return
      }
    }

    if (e.key === "Tab") {
      e.preventDefault()
      setActivePane((prev) => (prev === "sessions" ? "matches" : "sessions"))
      return
    }

    const total = results().length
    const matchCount = selectedSession()?.matches.length ?? 0

    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (activePane() === "matches" && matchCount > 0) {
        setSelectedMatchIdx((i) => Math.min(matchCount - 1, i + 1))
      } else if (total > 0) {
        setSelectedIndex((i) => Math.min(total - 1, i + 1))
        setSelectedMatchIdx(0)
      }
      return
    }

    if (e.key === "ArrowUp") {
      e.preventDefault()
      if (activePane() === "matches" && matchCount > 0) {
        setSelectedMatchIdx((i) => Math.max(0, i - 1))
      } else if (total > 0) {
        setSelectedIndex((i) => Math.max(0, i - 1))
        setSelectedMatchIdx(0)
      }
      return
    }

    if (e.key === "PageDown") {
      e.preventDefault()
      if (total > 0) {
        setSelectedIndex((i) => Math.min(total - 1, i + 8))
        setSelectedMatchIdx(0)
      }
      return
    }

    if (e.key === "PageUp") {
      e.preventDefault()
      if (total > 0) {
        setSelectedIndex((i) => Math.max(0, i - 8))
        setSelectedMatchIdx(0)
      }
      return
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      openSession(selectedSession())
    }
  }

  return (
    <div
      class={`ols-root ols-root--${props.variant}`}
      data-scheme={colorScheme()}
      onKeyDown={handleKeyDown}
    >
      <div class="ols-header">
        <div class="ols-input-wrap">
          <ui.TextInput
            type="search"
            size="large"
            label="Search session history"
            value={query()}
            onInput={(val) => {
              setQuery(val)
              setSelectedIndex(0)
              setSelectedMatchIdx(0)
            }}
            onSubmit={() => openSession(selectedSession())}
            placeholder='Search conversations, "exact phrase", fuzzy~, /regex/i, role:user, tool:shell...'
            invalid={Boolean(parsedInfo()?.regexError)}
            autofocus
          />
        </div>

        <div class="ols-controls-bar">
          <div class="ols-controls-left">
            <div class="ols-segment" role="group" aria-label="Search scope">
              <button
                type="button"
                class={`ols-segment-btn ${
                  scope() === "project" ? "ols-segment-btn--active" : ""
                }`}
                onClick={() => {
                  setScope("project")
                  setSelectedIndex(0)
                }}
                title={
                  currentDirectory()
                    ? `Current project (${currentDirectory()})`
                    : "Current project"
                }
              >
                <ui.Icon name="folder" size="small" />
                <span>
                  {currentDirectory()
                    ? shortFolder(currentDirectory())
                    : "Project"}
                </span>
              </button>
              <button
                type="button"
                class={`ols-segment-btn ${
                  scope() === "all" ? "ols-segment-btn--active" : ""
                }`}
                onClick={() => {
                  setScope("all")
                  setSelectedIndex(0)
                }}
              >
                <span>All workspaces</span>
              </button>
            </div>

            <ui.Menu
              label={`Sort: ${SEARCH_SORT_LABELS[sort()]}`}
              trigger="button"
              items={(Object.entries(SEARCH_SORT_LABELS) as [SearchSort, string][]).map(([value, label]) => ({
                label,
                icon: sort() === value ? "check-small" : undefined,
                onSelect: () => { setSort(value); setSelectedIndex(0) },
              }))}
            />

            <ui.Menu
              label={
                activeFilterCount() > 0
                  ? `Filters (${activeFilterCount()})`
                  : "Filters"
              }
              icon="sliders"
              trigger="button"
              items={filterMenuItems()}
            />

            <Show when={mode() !== "smart"}>
              <button
                type="button"
                class="ols-active-pill"
                onClick={() => setMode("smart")}
                title="Click to reset search mode"
              >
                <span>{MODE_LABELS[mode()]}</span>
                <ui.Icon name="close-small" size="small" />
              </button>
            </Show>

            <Show when={role() !== "all"}>
              <button
                type="button"
                class="ols-active-pill"
                onClick={() => setRole("all")}
                title="Click to reset role filter"
              >
                <span>{ROLE_LABELS[role()]}</span>
                <ui.Icon name="close-small" size="small" />
              </button>
            </Show>

            <Show when={datePreset() !== "all"}>
              <button
                type="button"
                class="ols-active-pill"
                onClick={() => setDatePreset("all")}
                title="Click to reset time filter"
              >
                <span>{DATE_LABELS[datePreset()]}</span>
                <ui.Icon name="close-small" size="small" />
              </button>
            </Show>

            <Show when={parsedInfo()?.regexError}>
              {(err) => <span class="ols-error-pill">{err()}</span>}
            </Show>
          </div>

          <div class="ols-controls-right">
            <span class="ols-status-count">
              <Show when={!loading()} fallback={<ui.Loader size="small" />}>
                {results().length} of {totalSessions()} sessions
              </Show>
            </span>

            <ui.Tooltip value="Refresh index" keys={["Ctrl", "L"]}>
              <ui.IconButton
                icon="refresh"
                label="Refresh index"
                variant="ghost"
                size="small"
                busy={refreshing()}
                onClick={() => void runQuery(true)}
              />
            </ui.Tooltip>
          </div>
        </div>
      </div>

      <Show when={errorMsg()}>
        {(err) => (
          <div class="ols-empty">
            <div class="ols-empty-title">Unable to search sessions</div>
            <div class="ols-empty-sub">{err()}</div>
          </div>
        )}
      </Show>

      <Show when={!errorMsg()}>
        <div class="ols-split">
          <Show when={loading()}>
            <div class="ols-loading-center" role="status" aria-live="polite">
              <div class="ols-loading-pill">
                <span class="ols-spinner" aria-hidden="true" />
                <span>Searching...</span>
              </div>
            </div>
          </Show>
          <div
            class={`ols-column ols-column--list ${
              activePane() === "sessions" ? "ols-column--active" : ""
            }`}
            onClick={() => setActivePane("sessions")}
          >
            <div class="ols-list-scroll">
              <Show
                when={results().length > 0}
                fallback={
                  <Show when={!loading()}>
                    <div class="ols-empty">
                      <div class="ols-empty-title">No matching sessions</div>
                      <div class="ols-empty-sub">
                        <Show
                          when={scope() === "project"}
                          fallback="Try Fuzzy mode or fewer search terms."
                        >
                          No hits in this workspace. Switch to{" "}
                          <button
                            type="button"
                            class="ols-inline-link"
                            onClick={toggleScope}
                          >
                            All workspaces
                          </button>{" "}
                          to search everywhere.
                        </Show>
                      </div>
                    </div>
                  </Show>
                }
              >
                <For each={results()}>
                  {(item, idx) => {
                    const isSelected = () => idx() === selectedIndex()
                    return (
                      <button
                        type="button"
                        class={`ols-row ${
                          isSelected() ? "ols-row--selected" : ""
                        }`}
                        onClick={() => {
                          setSelectedIndex(idx())
                          setSelectedMatchIdx(0)
                          setActivePane("sessions")
                        }}
                        onDblClick={() => openSession(item)}
                      >
                        <div class="ols-row-top">
                          <span class="ols-row-title">
                            <HighlightedText
                              text={item.title || "Untitled session"}
                              terms={highlightTerms()}
                              regexPattern={parsedInfo()?.regexPattern}
                              regexFlags={parsedInfo()?.regexFlags}
                            />
                          </span>
                          <span class="ols-row-time">
                            {formatRelativeTime(item.timeUpdated)}
                          </span>
                        </div>

                        <Show when={item.bestSnippet}>
                          <div class="ols-row-snippet">
                            <HighlightedText
                              text={item.bestSnippet}
                              terms={highlightTerms()}
                              regexPattern={parsedInfo()?.regexPattern}
                              regexFlags={parsedInfo()?.regexFlags}
                            />
                          </div>
                        </Show>

                        <div class="ols-row-meta">
                          <Show when={item.archived}><span class="ols-row-hit-badge">Archived</span></Show>
                          <Show when={sort() === "context" || sort() === "tokens"}>
                            <span>{sort() === "context" ? "Context" : "Total"}: {(sort() === "context" ? item.contextTokens : item.totalTokens)?.toLocaleString() ?? "Not recorded"}</span>
                          </Show>
                          <Show when={query().trim().length > 0}>
                            <span class="ols-row-hit-badge">
                              {item.matchBadge}
                            </span>
                          </Show>
                          <Show when={scope() === "all" && item.directory}>
                            <span class="ols-row-folder">
                              {shortFolder(item.directory)}
                            </span>
                          </Show>
                          <span>{item.entryCount} messages</span>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>

          <div
            class={`ols-column ols-column--detail ${
              activePane() === "matches" ? "ols-column--active" : ""
            }`}
            onClick={() => setActivePane("matches")}
          >
            <Show
              when={selectedSession()}
              fallback={
                <div class="ols-empty">
                  <div class="ols-empty-sub">
                    Select a session to inspect conversation matches.
                  </div>
                </div>
              }
            >
              {(session) => (
                <>
                  <div class="ols-detail-header">
                    <div class="ols-detail-heading">
                      <div class="ols-detail-title">{session().title}</div>
                      <div class="ols-detail-meta">
                        <Show when={session().archived}><span>Archived</span></Show>
                        <span>{session().directory || "Global"}</span>
                        <span>·</span>
                        <span>{formatDateFull(session().timeUpdated)}</span>
                      </div>
                    </div>

                    <div class="ols-detail-actions">
                      <Show when={session().archived}>
                        <ui.Button size="small" busy={restoring()} onClick={() => void unarchiveSession(session())}>Unarchive</ui.Button>
                      </Show>
                      <ui.Tooltip value="Copy session ID">
                        <ui.IconButton
                          icon="copy"
                          label="Copy session ID"
                          variant="ghost"
                          size="small"
                          onClick={() => void copySessionId(session())}
                        />
                      </ui.Tooltip>
                      <ui.Button
                        variant="contrast"
                        size="small"
                        icon="square-arrow-top-right"
                        onClick={() => openSession(session())}
                      >
                        Open
                      </ui.Button>
                    </div>
                  </div>

                  <Show
                    when={
                      query().trim().length === 0 &&
                      props.variant === "modal"
                    }
                  >
                    <div class="ols-quick-bar">
                      <span class="ols-quick-label">Try:</span>
                      <button
                        type="button"
                        class="ols-quick-chip"
                        onClick={() => appendSyntaxToken("role:user")}
                      >
                        role:user
                      </button>
                      <button
                        type="button"
                        class="ols-quick-chip"
                        onClick={() => appendSyntaxToken("tool:shell")}
                      >
                        tool:shell
                      </button>
                      <button
                        type="button"
                        class="ols-quick-chip"
                        onClick={() => appendSyntaxToken("in:title")}
                      >
                        in:title
                      </button>
                      <button
                        type="button"
                        class="ols-quick-chip"
                        onClick={() => appendSyntaxToken("since:7d")}
                      >
                        since:7d
                      </button>
                    </div>
                  </Show>

                  <div class="ols-detail-scroll">
                    <Show
                      when={session().matches.length > 0}
                      fallback={
                        <div class="ols-timeline">
                          <For each={session().recentEntries}>
                            {(entry) => (
                              <div
                                class="ols-turn"
                                onClick={() => openSession(session())}
                              >
                                <div class="ols-turn-header">
                                  <span
                                    class={`ols-turn-author ols-turn-author--${entry.role}`}
                                  >
                                    {roleLabel(entry.role)}
                                  </span>
                                  <Show when={entry.toolName}>
                                    <span class="ols-turn-chip">
                                      {entry.toolName}
                                    </span>
                                  </Show>
                                  <span class="ols-turn-time">
                                    {formatRelativeTime(entry.timeCreated)}
                                  </span>
                                </div>
                                <div class="ols-turn-body">{entry.text}</div>
                              </div>
                            )}
                          </For>
                        </div>
                      }
                    >
                      <div class="ols-timeline">
                        <For each={session().matches}>
                          {(m, mIdx) => {
                            const isSelectedMatch = () =>
                              activePane() === "matches" &&
                              mIdx() === selectedMatchIdx()
                            return (
                              <div
                                class={`ols-turn ${
                                  isSelectedMatch() ? "ols-turn--selected" : ""
                                }`}
                                onClick={() => {
                                  setActivePane("matches")
                                  setSelectedMatchIdx(mIdx())
                                }}
                                onDblClick={() => openSession(session())}
                              >
                                <div class="ols-turn-header">
                                  <span
                                    class={`ols-turn-author ols-turn-author--${m.role}`}
                                  >
                                    {roleLabel(m.role)}
                                  </span>
                                  <Show when={m.kind === "tool" && m.toolName}>
                                    <span class="ols-turn-chip">
                                      {m.toolName}
                                    </span>
                                  </Show>
                                  <Show when={m.kind === "filepath"}>
                                    <span class="ols-turn-chip">file</span>
                                  </Show>
                                  <Show when={m.kind === "fuzzy"}>
                                    <span class="ols-turn-chip">
                                      ~{m.matchedTerm}
                                    </span>
                                  </Show>
                                  <span class="ols-turn-time">
                                    {formatRelativeTime(m.timeCreated)}
                                  </span>
                                </div>
                                <div class="ols-turn-body">
                                  <HighlightedText
                                    text={m.snippet}
                                    terms={highlightTerms()}
                                    regexPattern={parsedInfo()?.regexPattern}
                                    regexFlags={parsedInfo()?.regexFlags}
                                  />
                                </div>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      "search.title": "Search",
      "search.command": "Search session history...",
      "search.panel": "Search",
    },
  },
  setup(ctx) {
    const ui = ctx.ui

    ctx.add(Style, css)

    let searchFallbackDialog: { close(): void } | undefined

    function openSearchPanel(initialQuery = "") {
      setOlsPanelQuery(initialQuery)
      const session = ctx.sessions.current()
      if (!session) {
        if (searchFallbackDialog) return
        searchFallbackDialog = ctx.dialogs.open((dialog) => {
          onCleanup(() => { searchFallbackDialog = undefined })
          return (
            <ui.Dialog title="Search" size="x-large">
              <SearchSurface ctx={ctx} variant="modal" initialQuery={initialQuery} onClose={dialog.close} />
            </ui.Dialog>
          )
        })
        return
      }
      searchFallbackDialog?.close()
      try {
        // Always select the tab so it becomes the focused panel even if another
        // panel (usage, memory, backups) is already open.
        ctx.layout.open(`${ctx.id}:search`, session)
      } catch {
        // Layout not ready; retry on next interaction.
      }
    }

    ctx.add(
      Command,
      (): Command => ({
        id: "search",
        title: "Search session history...",
        description:
          "Full-text, fuzzy, regex, tool, and file search across all session conversations",
        keywords: "find history messages conversation regex fuzzy search grep",
        group: "Session",
        section: "session",
        bind: "mod+shift+f",
        slash: {
          name: "search",
          arguments: true,
        },
        featured: true,
        run(input) {
          openSearchPanel(typeof input === "string" ? input : "")
        },
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "search-panel",
        title: "Toggle session search panel",
        description: "Open or close the Session Search side panel",
        keywords: "panel sidebar search history",
        group: "Session",
        section: "session",
        bind: "mod+alt+f",
        run() {
          const session = ctx.sessions.current()
          if (session) {
            ctx.layout.toggle(`${ctx.id}:search`, session)
          } else {
            openSearchPanel("")
          }
        },
      }),
    )

    if (typeof document !== "undefined") {
      const isBuiltinTitlebarSearchButton = (el: Element): boolean => {
        const btn = el.closest("button")
        if (!btn || btn.closest(".ols-root")) return false
        if (btn.getAttribute("data-action") === "vertical-tabs-search") {
          return true
        }
        if (!btn.closest('[data-slot="titlebar-v2"]')) return false
        if (btn.closest("[data-titlebar-plugin-item]")) return false
        const aria = (btn.getAttribute("aria-label") ?? "").toLowerCase()
        if (aria.includes("search")) return true
        const useEl = btn.querySelector('svg[data-slot="icon-svg"] use')
        const href =
          useEl?.getAttribute("href") ??
          useEl?.getAttribute("xlink:href") ??
          ""
        return href.includes("magnifying-glass")
      }

      const handleCaptureClick = (e: MouseEvent) => {
        const target = e.target
        if (!(target instanceof Element)) return

        if (isBuiltinTitlebarSearchButton(target)) {
          e.preventDefault()
          e.stopPropagation()
          openSearchPanel("")
          return
        }

        const homeSearch = target.closest(
          '[data-component="home-session-search"]',
        )
        if (homeSearch) {
          e.preventDefault()
          e.stopPropagation()
          const input = homeSearch.querySelector("input")
          const initial = input instanceof HTMLInputElement ? input.value : ""
          if (input instanceof HTMLElement) input.blur()
          openSearchPanel(initial)
        }
      }

      const handleCaptureFocusIn = (e: FocusEvent) => {
        const target = e.target
        if (!(target instanceof Element)) return
        const homeSearch = target.closest(
          '[data-component="home-session-search"]',
        )
        if (!homeSearch) return
        const initial =
          target instanceof HTMLInputElement ? target.value : ""
        if (target instanceof HTMLElement) {
          target.blur()
        }
        openSearchPanel(initial)
      }

      document.addEventListener("click", handleCaptureClick, true)
      document.addEventListener("focusin", handleCaptureFocusIn, true)

      const syncBuiltinSearchButtonLabel = () => {
        const buttons = document.querySelectorAll<HTMLButtonElement>(
          'button[data-action="vertical-tabs-search"]',
        )
        for (const btn of buttons) {
          for (const span of btn.querySelectorAll("span")) {
            const txt = span.textContent?.trim().toLowerCase() ?? ""
            if (txt === "search sessions") {
              span.textContent = "Search"
              span.classList.add("whitespace-nowrap")
            } else if (span.classList.contains("ms-auto") || span.querySelector("bdi, kbd")) {
              span.remove()
            }
          }
          if (btn.getAttribute("aria-label")?.toLowerCase() === "search sessions") {
            btn.setAttribute("aria-label", "Search")
          }
          if (btn.getAttribute("title")?.toLowerCase() === "search sessions") {
            btn.setAttribute("title", "Search")
          }
        }
      }

      syncBuiltinSearchButtonLabel()
      setTimeout(syncBuiltinSearchButtonLabel, 50)

      const redirectedInputs = new WeakSet<HTMLInputElement>()
      const observer = new MutationObserver(() => {
        syncBuiltinSearchButtonLabel()
        const builtinInput = document.querySelector<HTMLInputElement>(
          '.command-palette input[placeholder="Search sessions"], .command-palette-dialog input[placeholder="Search sessions..."]',
        )
        if (builtinInput && !redirectedInputs.has(builtinInput)) {
          redirectedInputs.add(builtinInput)
          const initial = builtinInput.value || ""
          builtinInput.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape", code: "Escape", bubbles: true, cancelable: true,
          }))
          openSearchPanel(initial)
        }
      })

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true })
      }

      onCleanup(() => {
        document.removeEventListener("click", handleCaptureClick, true)
        document.removeEventListener("focusin", handleCaptureFocusIn, true)
        observer.disconnect()
      })
    }

    const searchTab: PanelTab = {
      id: "search",
      get title() {
        return ctx.t("search.panel")
      },
      closable: "compact",
    }

    ctx.add(Panel, {
      id: "search",
      region: "side",
      list: (input) => (input.open.includes("search") ? [searchTab] : []),
      render: () => <SearchSurface ctx={ctx} variant="panel" />,
    })

    ctx.add(
      MenuItem,
      (): MenuItem => {
        const session = ctx.sessions.current()
        return {
          menu: "session.panel",
          id: "search",
          title: "Search",
          description: "Search conversation history",
          icon: "magnifying-glass",
          keybind: `${ctx.id}.search-panel`,
          opened:
            !!session &&
            ctx.layout.state(`${ctx.id}:search`, session) !== "closed",
          run: () => {
            const current = ctx.sessions.current()
            if (current) {
              ctx.layout.open(`${ctx.id}:search`, current)
            } else {
              openSearchPanel("")
            }
          },
        }
      },
    )
  },
})
