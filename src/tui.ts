"use strict";

import type { TuiPluginContext } from "@opencode-ai/plugin/tui";
import { TextAttributes } from "@opentui/core";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  use,
} from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  type DatePreset,
  formatRelativeTime,
  loadSessionIndex,
  parseSearchQuery,
  type RoleFilter,
  type ScopeFilter,
  type SearchMode,
  type SearchSessionMatch,
  searchSessionIndex,
  type SessionIndex,
} from "./search.ts";

function splitHighlightedText(
  text: string,
  term: string
): Array<{ text: string; match: boolean }> {
  if (!term || !term.trim()) {
    return [{ text, match: false }];
  }
  const cleanTerm = term.trim().toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lower.indexOf(cleanTerm, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), match: false });
    }
    parts.push({ text: text.slice(idx, idx + cleanTerm.length), match: true });
    cursor = idx + cleanTerm.length;
  }
  return parts.length ? parts : [{ text, match: false }];
}

interface SearchNavigationTarget {
  messageId: string;
  snippet: string;
  matchedTerm: string;
  kind: string;
  timeCreated: number;
  messageRatio?: number;
}

interface DialogProps {
  context: TuiPluginContext;
  initialQuery: string;
  currentDirectory: string;
  close: () => void;
  navigateSession: (sessionId: string, target?: SearchNavigationTarget) => void;
}

const ROLE_CYCLE: RoleFilter[] = ["all", "user", "assistant", "shell"];
const DATE_CYCLE: DatePreset[] = ["all", "today", "yesterday", "7d", "30d"];
const MODE_CYCLE: SearchMode[] = ["smart", "fuzzy", "regex"];

async function loadTuiRenderer() {

  function el(
    tag: string,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) {
    const node = createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined) continue;
        if (key === "ref" && typeof val === "function") {
          use(val as (e: unknown) => void, node, undefined);
        } else if (
          typeof val === "function" &&
          !key.startsWith("on") &&
          key !== "renderBefore"
        ) {
          effect((prev: unknown) => setProp(node, key, (val as () => unknown)(), prev));
        } else {
          setProp(node, key, val);
        }
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (typeof child === "string") {
        insertNode(node, createTextNode(child));
      } else {
        insert(node, child);
      }
    }
    return node;
  }

  function SessionSearchDialog(props: DialogProps) {
    const [query, setQuery] = createSignal(props.initialQuery);
    const [scope, setScope] = createSignal<ScopeFilter>("all");
    const [role, setRole] = createSignal<RoleFilter>("all");
    const [datePreset, setDatePreset] = createSignal<DatePreset>("all");
    const [mode, setMode] = createSignal<SearchMode>("smart");
    const [focusPane, setFocusPane] = createSignal<"search" | "list" | "preview">("search");
    const [selectedIndex, setSelectedIndex] = createSignal(0);
    const [selectedSnippetIndex, setSelectedSnippetIndex] = createSignal(0);
    const [indexData, setIndexData] = createSignal<SessionIndex>({
      dbPath: "",
      loadedAt: 0,
      sessions: [],
    });
    const [loading, setLoading] = createSignal(true);
    const [errorMsg, setErrorMsg] = createSignal("");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rootRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inputRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listScrollRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let previewScrollRef: any;

    const applyDialogWidth = () => {
      try {
        props.context.ui.dialog.set({
          size: "xlarge",
          centered: true,
        });
      } catch {
        // ignore if dialog state is not ready yet
      }

      if (!rootRef) return;
      try {
        // Walk up to the dialog container box (direct child of the full-screen absolute overlay)
        // and set its width/maxWidth to 70% of the terminal viewport.
        let cursor = rootRef;
        let dialogBox = rootRef;
        while (cursor.parent && cursor.parent._positionType !== "absolute") {
          cursor = cursor.parent;
          dialogBox = cursor;
        }
        dialogBox.width = "70%";
        dialogBox.maxWidth = "70%";
        dialogBox.minWidth = 72;

        let inner = rootRef;
        while (inner && inner !== dialogBox) {
          inner.width = "100%";
          inner.maxWidth = "100%";
          inner = inner.parent;
        }
        rootRef.requestRender?.();
      } catch {
        // ignore layout mutation errors
      }
    };

    const theme = () => props.context.theme.surface("dialog");

    const reloadIndex = async (force = false) => {
      setLoading(true);
      setErrorMsg("");
      try {
        const loaded = await loadSessionIndex(force);
        setIndexData(loaded);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    const parsedQuery = createMemo(() =>
      parseSearchQuery(query(), {
        scope: scope(),
        currentDirectory: props.currentDirectory,
        role: role(),
        datePreset: datePreset(),
        mode: mode(),
      })
    );

    const results = createMemo<SearchSessionMatch[]>(() => {
      const idx = indexData();
      if (!idx.sessions.length) return [];
      return searchSessionIndex(idx, query(), {
        scope: scope(),
        currentDirectory: props.currentDirectory,
        role: role(),
        datePreset: datePreset(),
        mode: mode(),
        limit: 60,
      });
    });

    createEffect(() => {
      query();
      scope();
      role();
      datePreset();
      mode();
      setSelectedIndex(0);
      setSelectedSnippetIndex(0);
      queueMicrotask(() => listScrollRef?.scrollTo?.(0));
    });

    const selectedMatch = createMemo<SearchSessionMatch | undefined>(() => {
      const list = results();
      if (!list.length) return undefined;
      const idx = Math.max(0, Math.min(list.length - 1, selectedIndex()));
      return list[idx];
    });

    const moveSelection = (delta: number) => {
      if (focusPane() === "preview") {
        const snippets = selectedMatch()?.matches ?? [];
        if (!snippets.length) return;
        const nextSnippet = Math.max(
          0,
          Math.min(snippets.length - 1, selectedSnippetIndex() + delta)
        );
        setSelectedSnippetIndex(nextSnippet);
        queueMicrotask(() => {
          previewScrollRef?.scrollChildIntoView?.(`snippet-row-${nextSnippet}`);
        });
        return;
      }
      const list = results();
      if (!list.length) return;
      const next = Math.max(0, Math.min(list.length - 1, selectedIndex() + delta));
      setSelectedIndex(next);
      setSelectedSnippetIndex(0);
      queueMicrotask(() => {
        listScrollRef?.scrollChildIntoView?.(`session-row-${next}`);
        previewScrollRef?.scrollTo?.(0);
      });
    };

    const toggleScope = () => {
      setScope((prev: ScopeFilter) => (prev === "all" ? "project" : "all"));
    };

    const cycleRole = () => {
      setRole((prev: RoleFilter) => ROLE_CYCLE[(ROLE_CYCLE.indexOf(prev) + 1) % ROLE_CYCLE.length]);
    };

    const cycleDate = () => {
      setDatePreset((prev: DatePreset) => DATE_CYCLE[(DATE_CYCLE.indexOf(prev) + 1) % DATE_CYCLE.length]);
    };

    const cycleMode = () => {
      setMode((prev: SearchMode) => MODE_CYCLE[(MODE_CYCLE.indexOf(prev) + 1) % MODE_CYCLE.length]);
    };

    const openSelected = (explicitHit?: SearchSessionMatch["matches"][number]) => {
      const current = selectedMatch();
      if (!current) return;

      const snippets = current.matches ?? [];
      const chosen =
        explicitHit ??
        snippets[Math.max(0, Math.min(snippets.length - 1, selectedSnippetIndex()))] ??
        current.bestMatch;

      // If the active match is a session title match, prefer the first message match in the session if available
      const messageHit =
        chosen && chosen.messageId
          ? chosen
          : snippets.find((m) => Boolean(m.messageId)) ?? chosen;

      let messageRatio: number | undefined;
      if (messageHit?.messageId && current.session.entries.length > 0) {
        const uniqueMsgIds: string[] = [];
        const sortedEntries = [...current.session.entries].sort(
          (a, b) => a.timeCreated - b.timeCreated
        );
        for (const entry of sortedEntries) {
          if (entry.messageId && !uniqueMsgIds.includes(entry.messageId)) {
            uniqueMsgIds.push(entry.messageId);
          }
        }
        const msgIdx = uniqueMsgIds.indexOf(messageHit.messageId);
        if (msgIdx !== -1 && uniqueMsgIds.length > 1) {
          messageRatio = msgIdx / (uniqueMsgIds.length - 1);
        } else if (msgIdx === 0) {
          messageRatio = 0;
        }
      }

      props.navigateSession(
        current.session.id,
        messageHit
          ? {
              messageId: messageHit.messageId,
              snippet: messageHit.snippet,
              matchedTerm: messageHit.matchedTerm,
              kind: messageHit.kind,
              timeCreated: messageHit.timeCreated,
              messageRatio,
            }
          : undefined
      );
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleKeyPress = (event: any) => {
      const name = String(event.name || "").toLowerCase();
      const enter = ["return", "enter", "linefeed"].includes(name);

      if (name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        props.close();
        return;
      }

      if (enter) {
        event.preventDefault();
        event.stopPropagation();
        openSelected();
        return;
      }

      if (name === "tab") {
        event.preventDefault();
        event.stopPropagation();
        const order: Array<"search" | "list" | "preview"> = ["search", "list", "preview"];
        const idx = order.indexOf(focusPane());
        const next = order[(idx + (event.shift ? -1 : 1) + order.length) % order.length];
        setFocusPane(next);
        return;
      }

      if (event.ctrl && name === "p") {
        event.preventDefault();
        event.stopPropagation();
        toggleScope();
        return;
      }
      if (event.ctrl && name === "g") {
        event.preventDefault();
        event.stopPropagation();
        cycleRole();
        return;
      }
      if (event.ctrl && name === "t") {
        event.preventDefault();
        event.stopPropagation();
        cycleDate();
        return;
      }
      if (event.ctrl && name === "r") {
        event.preventDefault();
        event.stopPropagation();
        cycleMode();
        return;
      }
      if (event.ctrl && name === "l") {
        event.preventDefault();
        event.stopPropagation();
        reloadIndex(true);
        return;
      }

      if (
        name === "down" ||
        (event.ctrl && name === "n") ||
        (focusPane() === "list" && !event.ctrl && name === "j")
      ) {
        event.preventDefault();
        event.stopPropagation();
        moveSelection(1);
        return;
      }
      if (
        name === "up" ||
        (event.ctrl && name === "k") ||
        (focusPane() === "list" && !event.ctrl && name === "k")
      ) {
        event.preventDefault();
        event.stopPropagation();
        moveSelection(-1);
        return;
      }
      if (name === "pagedown" || (event.ctrl && name === "d")) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(8);
        } else {
          moveSelection(6);
        }
        return;
      }
      if (name === "pageup" || (event.ctrl && name === "u")) {
        event.preventDefault();
        event.stopPropagation();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(-8);
        } else {
          moveSelection(-6);
        }
        return;
      }
      if (focusPane() === "preview" && !event.ctrl && (name === "j" || name === "k")) {
        event.preventDefault();
        event.stopPropagation();
        previewScrollRef?.scrollBy?.(name === "j" ? 2 : -2);
        return;
      }
      if (focusPane() !== "search" && !event.ctrl && name === "/") {
        event.preventDefault();
        event.stopPropagation();
        setFocusPane("search");
        return;
      }
    };

    onMount(() => {
      props.context.renderer.keyInput.prependListener("keypress", handleKeyPress);
      applyDialogWidth();
      queueMicrotask(() => {
        applyDialogWidth();
        if (props.initialQuery && inputRef && inputRef.value !== props.initialQuery) {
          inputRef.value = props.initialQuery;
        }
      });
      reloadIndex(false);
    });

    onCleanup(() => {
      props.context.renderer.keyInput.removeListener("keypress", handleKeyPress);
    });

    const Pill = (pillProps: {
      label: () => string;
      shortcut?: string;
      active: () => boolean;
      onClick: () => void;
    }) =>
      el(
        "box",
        {
          flexDirection: "row",
          flexShrink: 0,
          paddingX: 1,
          backgroundColor: () =>
            pillProps.active()
              ? theme().background.action.primary.focused
              : theme().background.raised.base,
          onMouseUp: pillProps.onClick,
        },
        el(
          "text",
          {
            fg: () =>
              pillProps.active()
                ? theme().text.action.primary.focused
                : theme().text.base,
            attributes: () => (pillProps.active() ? TextAttributes.BOLD : undefined),
          },
          pillProps.label
        ),
        pillProps.shortcut
          ? el(
              "text",
              {
                fg: () =>
                  pillProps.active()
                    ? theme().text.action.primary.focused
                    : theme().text.muted,
              },
              ` ${pillProps.shortcut}`
            )
          : null
      );

    return el(
      "box",
      {
        ref: (r: unknown) => {
          rootRef = r;
          queueMicrotask(applyDialogWidth);
        },
        width: "100%",
        height: 28,
        flexDirection: "column",
        backgroundColor: () => theme().background.base,
      },
      // 1. Header Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingX: 2,
          paddingTop: 1,
          flexShrink: 0,
        },
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center" },
          el(
            "text",
            {
              fg: () => theme().text.base,
              attributes: TextAttributes.BOLD,
            },
            "Session Search"
          ),
          el(
            "text",
            { fg: () => theme().text.muted },
            () =>
              loading()
                ? "indexing SQLite..."
                : `${results().length} of ${indexData().sessions.length} sessions`
          )
        ),
        el(
          "box",
          {
            flexDirection: "row",
            gap: 2,
            alignItems: "center",
          },
          el(
            "text",
            { fg: () => theme().text.muted },
            () => props.context.ui.format.path(props.currentDirectory)
          ),
          el(
            "box",
            {
              paddingX: 1,
              onMouseUp: () => props.close(),
            },
            el("text", { fg: () => theme().text.muted }, "esc")
          )
        )
      ),

      // 2. Search Input + Filter Pills Row
      el(
        "box",
        {
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          gap: 1,
          flexShrink: 0,
          border: ["bottom"],
          borderColor: () => theme().border.base,
        },
        el(
          "box",
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 1,
          },
          el(
            "text",
            {
              fg: () =>
                focusPane() === "search"
                  ? theme().text.action.primary.base
                  : theme().text.muted,
              attributes: TextAttributes.BOLD,
            },
            "›"
          ),
          el("input", {
            id: "session-search-input",
            ref: (r: unknown) => {
              inputRef = r;
              if (props.initialQuery && r && (r as { value?: string }).value !== props.initialQuery) {
                (r as { value: string }).value = props.initialQuery;
              }
            },
            flexGrow: 1,
            value: () => query(),
            focused: () => focusPane() === "search",
            maxLength: 2000,
            placeholder:
              "Search keywords, \"exact phrase\", /regex/i, ~fuzzy, role:user, date:7d, file:path, tool:name...",
            placeholderColor: () => theme().text.muted,
            textColor: () => theme().text.base,
            focusedTextColor: () => theme().text.formfield.focused,
            cursorColor: () => theme().text.formfield.focused,
            backgroundColor: () => theme().background.base,
            focusedBackgroundColor: () => theme().background.formfield.focused,
            onMouseDown: () => setFocusPane("search"),
            onInput: (val: string) => setQuery(val),
          })
        ),
        // Filter pills bar
        el(
          "box",
          {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 1,
            alignItems: "center",
          },
          Pill({
            label: () =>
              `scope:${(parsedQuery().scope ?? scope()) === "project" ? "project" : "all"}`,
            shortcut: "^p",
            active: () => (parsedQuery().scope ?? scope()) === "project",
            onClick: toggleScope,
          }),
          Pill({
            label: () => `role:${parsedQuery().role}`,
            shortcut: "^g",
            active: () => parsedQuery().role !== "all",
            onClick: cycleRole,
          }),
          Pill({
            label: () =>
              `date:${parsedQuery().dateRange?.label ?? datePreset()}`,
            shortcut: "^t",
            active: () => Boolean(parsedQuery().dateRange),
            onClick: cycleDate,
          }),
          Pill({
            label: () => `mode:${parsedQuery().effectiveMode}`,
            shortcut: "^r",
            active: () => parsedQuery().effectiveMode !== "smart",
            onClick: cycleMode,
          }),
          createComponent(Show, {
            get when() {
              return Boolean(parsedQuery().fileFilter);
            },
            get children() {
              return el(
                "text",
                { fg: () => theme().text.action.primary.base },
                () => ` [file:${parsedQuery().fileFilter}]`
              );
            },
          }),
          createComponent(Show, {
            get when() {
              return Boolean(parsedQuery().toolFilter);
            },
            get children() {
              return el(
                "text",
                { fg: () => theme().text.action.primary.base },
                () => ` [tool:${parsedQuery().toolFilter}]`
              );
            },
          }),
          createComponent(Show, {
            get when() {
              return Boolean(parsedQuery().regexError);
            },
            get children() {
              return el(
                "text",
                { fg: () => theme().text.feedback.error.base },
                () => ` Regex: ${parsedQuery().regexError}`
              );
            },
          })
        )
      ),

      // 3. Split-Pane Main Body (Left: Session List, Right: Match Preview)
      el(
        "box",
        {
          flexDirection: "row",
          flexGrow: 1,
          minHeight: 0,
        },
        // Left Pane: Results List (44% width)
        el(
          "scrollbox",
          {
            id: "session-search-list",
            ref: (r: unknown) => {
              listScrollRef = r;
            },
            width: "44%",
            height: "100%",
            flexShrink: 0,
            border: ["right"],
            borderColor: () =>
              focusPane() === "list" ? theme().text.base : theme().border.base,
            scrollbarOptions: { visible: false },
            onMouseDown: () => setFocusPane("list"),
          },
          createComponent(Show, {
            get when() {
              return !loading() && results().length > 0;
            },
            get fallback() {
              return el(
                "box",
                { paddingX: 2, paddingY: 1 },
                el(
                  "text",
                  { fg: () => theme().text.muted },
                  () =>
                    loading()
                      ? "Loading sessions..."
                      : errorMsg()
                        ? `Error: ${errorMsg()}`
                        : "No matching sessions found. Try ~fuzzy, scope:all, or fewer terms."
                )
              );
            },
            get children() {
              return createComponent(For, {
                get each() {
                  return results();
                },
                children: (item: SearchSessionMatch, idx: () => number) => {
                  const isSelected = () => selectedIndex() === idx();
                  return el(
                    "box",
                    {
                      id: () => `session-row-${idx()}`,
                      flexDirection: "column",
                      paddingX: 1,
                      paddingY: 0,
                      marginBottom: 1,
                      flexShrink: 0,
                      backgroundColor: () =>
                        isSelected()
                          ? theme().background.action.primary.focused
                          : undefined,
                      onMouseUp: () => {
                        setSelectedIndex(idx());
                        openSelected();
                      },
                      onMouseOver: () => {
                        setSelectedIndex(idx());
                      },
                    },
                    el(
                      "box",
                      {
                        flexDirection: "row",
                        justifyContent: "space-between",
                        width: "100%",
                      },
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          truncate: true,
                          flexShrink: 1,
                          minWidth: 0,
                          fg: () =>
                            isSelected()
                              ? theme().text.action.primary.focused
                              : theme().text.base,
                          attributes: () =>
                            isSelected() ? TextAttributes.BOLD : undefined,
                        },
                        () =>
                          `${isSelected() ? "› " : "  "}${item.session.title}`
                      ),
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          flexShrink: 0,
                          fg: () =>
                            isSelected()
                              ? theme().text.action.primary.focused
                              : theme().text.muted,
                        },
                        () =>
                          ` [${item.matchBadge}] ${formatRelativeTime(item.session.timeUpdated)}`
                      )
                    ),
                    el(
                      "text",
                      {
                        wrapMode: "none",
                        truncate: true,
                        fg: () =>
                          isSelected()
                            ? theme().text.action.primary.focused
                            : theme().text.muted,
                      },
                      () => `  ${item.bestSnippet}`
                    )
                  );
                },
              });
            },
          })
        ),

        // Right Pane: Rich Match & Session Context Preview (56% width)
        el(
          "scrollbox",
          {
            id: "session-search-preview",
            ref: (r: unknown) => {
              previewScrollRef = r;
            },
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            paddingX: 2,
            paddingY: 1,
            focused: () => focusPane() === "preview",
            onMouseDown: () => setFocusPane("preview"),
          },
          createComponent(Show, {
            get when() {
              return selectedMatch();
            },
            get fallback() {
              return el(
                "text",
                { fg: () => theme().text.muted },
                "Select a session on the left to inspect matching messages, tools, and files."
              );
            },
            get children() {
              return el(
                "box",
                { flexDirection: "column", gap: 1 },
                el(
                  "text",
                  {
                    fg: () => theme().text.base,
                    attributes: TextAttributes.BOLD,
                  },
                  () => selectedMatch()?.session.title ?? ""
                ),
                el(
                  "text",
                  { fg: () => theme().text.muted, wrapMode: "word" },
                  () => {
                    const m = selectedMatch();
                    if (!m) return "";
                    const dir = m.session.directory
                      ? props.context.ui.format.path(m.session.directory)
                      : "(no directory)";
                    return `${dir} · updated ${formatRelativeTime(m.session.timeUpdated)} · ${m.totalMatches} match${m.totalMatches === 1 ? "" : "es"}`;
                  }
                ),
                createComponent(Show, {
                  get when() {
                    return (selectedMatch()?.session.tools.length ?? 0) > 0;
                  },
                  get children() {
                    return el(
                      "text",
                      { fg: () => theme().text.muted, wrapMode: "word" },
                      () =>
                        `Tools: ${selectedMatch()?.session.tools.slice(0, 8).join(", ")}`
                    );
                  },
                }),
                createComponent(Show, {
                  get when() {
                    return (selectedMatch()?.session.files.length ?? 0) > 0;
                  },
                  get children() {
                    return el(
                      "text",
                      { fg: () => theme().text.muted, wrapMode: "word" },
                      () =>
                        `Files: ${selectedMatch()
                          ?.session.files.slice(0, 4)
                          .map((f: string) => props.context.ui.format.path(f))
                          .join(", ")}${(selectedMatch()?.session.files.length ?? 0) > 4 ? ` (+${(selectedMatch()?.session.files.length ?? 0) - 4} more)` : ""}`
                    );
                  },
                }),
                el(
                  "text",
                  {
                    fg: () => theme().text.base,
                    attributes: TextAttributes.BOLD,
                    marginTop: 1,
                  },
                  () =>
                    query().trim()
                      ? `Matching Snippets (${selectedMatch()?.matches.length ?? 0} shown)`
                      : "Recent Conversation Preview"
                ),
                createComponent(For, {
                  get each() {
                    return selectedMatch()?.matches ?? [];
                  },
                  children: (hit: SearchSessionMatch["matches"][number], idx: () => number) => {
                    const isActiveSnippet = () => idx() === selectedSnippetIndex();
                    return el(
                      "box",
                      {
                        id: () => `snippet-row-${idx()}`,
                        flexDirection: "column",
                        paddingLeft: 1,
                        marginBottom: 1,
                        border: ["left"],
                        borderColor: () =>
                          isActiveSnippet()
                            ? theme().text.action.primary.base
                            : theme().border.base,
                        onMouseUp: () => {
                          setSelectedSnippetIndex(idx());
                          openSelected(hit);
                        },
                      },
                      el(
                        "text",
                        {
                          fg: () =>
                            isActiveSnippet()
                              ? theme().text.action.primary.base
                              : theme().text.muted,
                          attributes: TextAttributes.BOLD,
                        },
                        () => {
                          const roleTag =
                            hit.kind === "title"
                              ? "[TITLE]"
                              : hit.kind === "fuzzy"
                                ? `[FUZZY · ${hit.role.toUpperCase()}]`
                                : hit.kind === "filepath"
                                  ? "[FILE]"
                                  : hit.kind === "tool"
                                    ? `[TOOL:${hit.toolName || "call"}]`
                                    : hit.role === "user"
                                      ? "[USER]"
                                      : "[ASSISTANT]";
                          const prefix = isActiveSnippet() ? "› " : "";
                          return `${prefix}${roleTag} · ${formatRelativeTime(hit.timeCreated)}`;
                        }
                      ),
                      el(
                        "text",
                        {
                          wrapMode: "word",
                          fg: () => theme().text.base,
                        },
                        createComponent(For, {
                          get each() {
                            return splitHighlightedText(hit.snippet, hit.matchedTerm);
                          },
                          children: (seg: { text: string; match: boolean }) =>
                            el(
                              "span",
                              {
                                fg: () =>
                                  seg.match
                                    ? theme().text.action.primary.base
                                    : theme().text.base,
                                attributes: () =>
                                  seg.match ? TextAttributes.BOLD : undefined,
                              },
                              seg.text
                            ),
                        })
                      )
                    );
                  },
                })
              );
            },
          })
        )
      ),

      // 4. Footer Shortcut Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 2,
          paddingX: 2,
          paddingY: 1,
          flexShrink: 0,
          border: ["top"],
          borderColor: () => theme().border.base,
        },
        el(
          "text",
          {
            fg: () => theme().text.muted,
            flexShrink: 1,
            minWidth: 0,
            wrapMode: "none",
            truncate: true,
          },
          "enter open · ↑/↓ or ^n/^k select · ^p scope · ^g role · ^t date · ^r mode · tab pane"
        ),
        el(
          "text",
          { fg: () => theme().text.muted, flexShrink: 0, wrapMode: "none" },
          "0 tokens"
        )
      )
    );
  }

  return (props: DialogProps) => createComponent(SessionSearchDialog, props);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRenderableText(node: any): string {
  if (!node) return "";
  if (typeof node.plainText === "string" && node.plainText.length > 0) {
    return node.plainText;
  }
  if (typeof node._content === "string" && node._content.length > 0) {
    return node._content;
  }
  if (typeof node.content === "string" && node.content.length > 0) {
    return node.content;
  }
  if (typeof node.textBuffer?.getPlainText === "function") {
    try {
      const text = node.textBuffer.getPlainText();
      if (typeof text === "string" && text.length > 0) return text;
    } catch {
      // ignore buffer read errors
    }
  }
  return "";
}

function normalizeSearchNeedle(raw: string): string {
  return raw
    .replace(/^\.{2,}\s*/, "")
    .replace(/\s*\.{2,}$/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function scrollToMatchedMessage(
  context: TuiPluginContext,
  sessionId: string,
  target?: SearchNavigationTarget
) {
  if (!target) return;
  if (target.kind === "title" && !target.messageId) return;

  try {
    void Promise.resolve(context.data?.session?.message?.sync?.(sessionId)).catch(
      () => {}
    );
  } catch {
    // ignore sync errors
  }

  const rawNeedle = normalizeSearchNeedle(target.snippet || "");
  const matchedTermLower = (target.matchedTerm || "").trim().toLowerCase();

  // Build candidate phrase needles from most specific to broadest
  const needles: string[] = [];
  if (rawNeedle.length >= 8) {
    needles.push(rawNeedle.slice(0, 48));
    if (matchedTermLower && rawNeedle.includes(matchedTermLower)) {
      const idx = rawNeedle.indexOf(matchedTermLower);
      const start = Math.max(0, idx - 12);
      const windowSlice = rawNeedle.slice(start, start + 36).trim();
      if (windowSlice.length >= 6 && !needles.includes(windowSlice)) {
        needles.push(windowSlice);
      }
    }
  }
  if (matchedTermLower.length >= 2 && !needles.includes(matchedTermLower)) {
    needles.push(matchedTermLower);
  }

  let attempts = 0;
  const maxAttempts = 25;

  const tryScroll = (): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (context.renderer as any)?.root;
    if (!root || typeof root.getChildren !== "function") return false;

    // 1. Find the largest visible ScrollBoxRenderable in the active session view
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scrollBoxes: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findScrollBoxes = (node: any) => {
      if (!node || node.isDestroyed || node.visible === false) return;
      if (
        typeof node.scrollTo === "function" &&
        typeof node.scrollBy === "function" &&
        node.content &&
        node.viewport
      ) {
        scrollBoxes.push(node);
      }
      const children =
        typeof node.getChildren === "function" ? node.getChildren() : [];
      for (const child of children) {
        findScrollBoxes(child);
      }
    };
    findScrollBoxes(root);
    if (!scrollBoxes.length) return false;

    scrollBoxes.sort(
      (a, b) =>
        (b.viewport?.width ?? 0) * (b.viewport?.height ?? 0) -
        (a.viewport?.width ?? 0) * (a.viewport?.height ?? 0)
    );
    const scrollBox = scrollBoxes[0];
    const topChildren =
      typeof scrollBox.content?.getChildren === "function"
        ? scrollBox.content.getChildren()
        : [];
    if (!topChildren.length || (scrollBox.scrollHeight ?? 0) <= 0) {
      return false;
    }

    // 2. Determine chronological message ratio (0 = oldest at top, 1 = newest at bottom)
    let ratio = target.messageRatio;
    try {
      const liveMessages = context.data?.session?.message?.list?.(sessionId);
      if (Array.isArray(liveMessages) && liveMessages.length > 0 && target.messageId) {
        const msgIdx = liveMessages.findIndex((m) => m?.id === target.messageId);
        if (msgIdx !== -1) {
          ratio =
            liveMessages.length > 1 ? msgIdx / (liveMessages.length - 1) : 0;
          const liveMsg = liveMessages[msgIdx] as unknown as Record<string, unknown>;
          if (typeof liveMsg?.text === "string") {
            const liveNeedle = normalizeSearchNeedle(liveMsg.text).slice(0, 48);
            if (liveNeedle.length >= 6 && !needles.includes(liveNeedle)) {
              needles.unshift(liveNeedle);
            }
          }
        }
      }
    } catch {
      // ignore data store lookup errors
    }

    // 3. Walk descendants of scrollBox.content to locate the matching message node
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let idMatchNode: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textMatchesByTier: Array<Array<any>> = needles.map(() => []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walkContent = (node: any) => {
      if (!node || node.isDestroyed || node.visible === false) return;
      if (
        !idMatchNode &&
        target.messageId &&
        typeof node.id === "string" &&
        (node.id === target.messageId || node.id.includes(target.messageId))
      ) {
        idMatchNode = node;
      }

      const rawText = extractRenderableText(node);
      if (rawText) {
        const normalized = rawText.replace(/\s+/g, " ").toLowerCase();
        for (let i = 0; i < needles.length; i++) {
          if (normalized.includes(needles[i])) {
            textMatchesByTier[i].push(node);
            break;
          }
        }
      }

      const children =
        typeof node.getChildren === "function" ? node.getChildren() : [];
      for (const child of children) {
        walkContent(child);
      }
    };
    walkContent(scrollBox.content);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let targetNode: any = idMatchNode;
    if (!targetNode) {
      const candidates = textMatchesByTier.find((tier) => tier.length > 0);
      if (candidates && candidates.length > 0) {
        if (candidates.length === 1 || ratio === undefined) {
          targetNode = candidates[0];
        } else {
          const totalHeight = Math.max(1, scrollBox.scrollHeight || 1);
          const contentTop = scrollBox.content?.y ?? 0;
          let bestDist = Infinity;
          for (const candidate of candidates) {
            const relY = Math.max(0, (candidate.y ?? 0) - contentTop) / totalHeight;
            const dist = Math.abs(relY - ratio);
            if (dist < bestDist) {
              bestDist = dist;
              targetNode = candidate;
            }
          }
        }
      }
    }

    const applyScrollToNode = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: any
    ) => {
      const viewportTop = scrollBox.viewport?.y ?? 0;
      const viewportHeight = scrollBox.viewport?.height ?? 20;
      const desiredScreenY = viewportTop + Math.floor(viewportHeight * 0.22);
      const dy = (node.y ?? 0) - desiredScreenY;
      scrollBox._hasManualScroll = true;
      if (dy !== 0) {
        scrollBox.scrollBy({ x: 0, y: dy });
      }
      scrollBox._hasManualScroll = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (context.renderer as any)?.requestRender?.();
    };

    if (targetNode) {
      applyScrollToNode(targetNode);
      setTimeout(() => {
        try {
          applyScrollToNode(targetNode);
        } catch {
          // ignore
        }
      }, 120);
      return true;
    }

    // Fallback when text is inside a collapsed tool output and layout has stabilized
    if (attempts >= 6 && ratio !== undefined) {
      const childIdx = Math.max(
        0,
        Math.min(topChildren.length - 1, Math.round(ratio * (topChildren.length - 1)))
      );
      const approxNode = topChildren[childIdx];
      if (approxNode) {
        applyScrollToNode(approxNode);
        return true;
      }
    }

    return false;
  };

  const timer = setInterval(() => {
    attempts++;
    if (tryScroll() || attempts >= maxAttempts) {
      clearInterval(timer);
    }
  }, 60);
}

async function openFallbackSelectDialog(
  context: TuiPluginContext,
  initialQuery: string,
  currentDirectory: string
) {
  const index = await loadSessionIndex(false);
  const matches = searchSessionIndex(index, initialQuery, {
    currentDirectory,
    limit: 50,
  });

  if (!matches.length) {
    context.ui.toast.show({
      title: "Session Search",
      message: initialQuery
        ? `No sessions matched "${initialQuery}".`
        : "No sessions found.",
      variant: "warning",
    });
    return;
  }

  const options = matches.map((m) => ({
    title: m.session.title,
    value: m.session.id,
    description: `[${m.matchBadge}] ${m.bestSnippet}`,
    footer: `${formatRelativeTime(m.session.timeUpdated)} · ${context.ui.format.path(m.session.directory || "")}`,
  }));

  const selectedId = await context.ui.dialog.select<string>({
    title: initialQuery ? `Session Search: "${initialQuery}"` : "Session Search",
    placeholder: "Filter matching sessions...",
    options,
  });

  if (selectedId) {
    context.ui.router.navigate({
      type: "session",
      sessionID: selectedId,
    });
  }
}

export default {
  id: "opencode-session-search",
  async setup(context: TuiPluginContext) {
    if (!context?.ui) {
      return;
    }
    const currentDirectory = context.location?.directory ?? process.cwd();
    const renderDialogPromise = loadTuiRenderer().catch(() => null);

    const openSearchPopup = async (rawArgs?: unknown) => {
      const initialQuery =
        typeof rawArgs === "string"
          ? rawArgs.trim()
          : typeof (rawArgs as { arguments?: unknown } | undefined)?.arguments === "string"
            ? ((rawArgs as { arguments: string }).arguments).trim()
            : "";
      const renderDialog = await renderDialogPromise;
      if (!renderDialog) {
        await openFallbackSelectDialog(context, initialQuery, currentDirectory);
        return;
      }

      try {
        context.ui.dialog.show(() =>
          renderDialog({
            context,
            initialQuery,
            currentDirectory,
            close: () => context.ui.dialog.clear(),
            navigateSession: (
              sessionId: string,
              target?: SearchNavigationTarget
            ) => {
              context.ui.dialog.clear();
              context.ui.router.navigate({
                type: "session",
                sessionID: sessionId,
              });
              scrollToMatchedMessage(context, sessionId, target);
            },
          })
        );
        context.ui.dialog.set({
          size: "xlarge",
          centered: true,
        });
      } catch {
        await openFallbackSelectDialog(context, initialQuery, currentDirectory);
      }
    };

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "session.history.search",
              title: "Search session history...",
              description:
                "Interactive zero-token popup to search past sessions (multi-term, regex, fuzzy, role/date/file/tool filters)",
              category: "Session",
              palette: true,
              slash: {
                name: "search",
                arguments: true,
              },
              run: (input) => {
                void openSearchPopup(input);
              },
            },
          ],
        }));
        return null;
      },
    });
  },
};
