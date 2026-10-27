# opencode-local-search

**Local-first, zero-token interactive session search plugin for OpenCode**: indexes your local SQLite session history automatically, previews matching messages, tools, and files as you type, and jumps straight to the exact matched message in any conversation.

![opencode-local-search TUI preview](./assets/screenshot.png)

## Background

This project started as a small local CLI script wired to a custom `/search` command. It queried OpenCode's SQLite database and printed matching session IDs into the chat, which worked as a quick prototype but had two limitations in daily use:

1. **Every search ran through an LLM turn**: Because custom markdown commands send their output to the model, searching past sessions took several seconds and used prompt and completion tokens just to look up an old conversation.
2. **Results were static text**: Getting a list of session IDs in the chat still meant copying an ID or opening `/sessions` to actually switch to the session.

`opencode-local-search` makes session search a native part of the terminal interface:

1. **Zero-token local SQLite indexing**: Queries OpenCode's local SQLite database directly inside the TUI using the runtime's built-in driver (`bun:sqlite` or `node:sqlite`) without making an LLM request.
2. **Live split-pane preview**: Filter across your past work on every keystroke on the left while inspecting highlighted message snippets, tools used, and files touched on the right.
3. **Jump to the exact message**: Pressing `Enter` opens the selected session and scrolls the transcript straight to the message that matched instead of the bottom of the conversation.

## Features

| Feature | Details |
| :--- | :--- |
| Local-first, zero-token execution | Queries your local OpenCode SQLite database directly inside the TUI with zero LLM token usage, zero server tools, and zero cloud dependencies |
| Zero external npm dependencies | Uses the SQLite driver built into OpenCode's runtime (`bun:sqlite` or `node:sqlite`) and a built-in bounded Levenshtein matcher, requiring no native C++ addons |
| Dual-schema support (OpenCode V2 + V1) | Automatically detects and indexes both the OpenCode V2 schema (`session_v2` and `session_message`) and the V1 schema (`session`, `message`, and `part`) |
| Interactive `/search` TUI modal | Wide (`80%` default, configurable via `dialogWidth`) split-pane popup with colored filter pills (`^p` scope, `^g` role, `^t` date, `^r` mode, `^l` refresh), live session list on the left, and highlighted message/tool/file snippet cards on the right |
| Session-level multi-term AND ranking | Searching `auth cookie` finds sessions where both terms appear anywhere across the session title, user prompts, assistant replies, tool calls, or file paths, ranking single-message co-occurrences higher |
| Typo-tolerant fuzzy & regex search | Supports `"exact phrase"`, `/regex/i` (`re:`), explicit `~fuzzy` terms, and automatic bounded Levenshtein fallback when a multi-word query has a typo |
| Auto-scroll to matched message | Pressing `Enter` (or clicking any snippet card in the preview pane) opens the session and automatically scrolls the transcript to the exact matched message |

## Installation

### Option 1: One-Command Install (Recommended)

```sh
npx @nandoblanco/opencode-local-search install
# or directly from GitHub:
npx github:nandoblanco/opencode-local-search install
```

Or install with OpenCode's native plugin CLI:

```sh
opencode plugin add @nandoblanco/opencode-local-search
# or directly from GitHub:
opencode plugin add github:nandoblanco/opencode-local-search
```

### Option 2: Manual Configuration

Add `@nandoblanco/opencode-local-search` to `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
	"plugins": [
		[
			"@nandoblanco/opencode-local-search",
			{
				"dialogWidth": "80%"
			}
		]
	]
}
```

### From a Local Directory

Clone or copy this folder and reference it in `~/.config/opencode/cli.json` (no `npm install` or build step required):

```json
{
	"plugins": ["file:///path/to/opencode-local-search"]
}
```

## Usage

### Zero-Token TUI Commands

1. **Interactive `/search` popup**: Run `/search` to open the popup, or `/search <query>` (for example `/search playwright` or `/search file:tui.ts`) to open with your search pre-filled.
2. **Command palette**: Press `Ctrl+P` and select `Search session history...`.
3. **Custom keybind**: Bind `session.history.search` in `~/.config/opencode/cli.json`:

```json
{
	"keybinds": {
		"session.history.search": "ctrl+f"
	}
}
```

## TUI Query Syntax (`/search`)

Type filters inline in the search bar or toggle them with keyboard shortcuts and clickable filter pills.

| Syntax | Description | Example |
| :--- | :--- | :--- |
| `term1 term2` | Session-level AND across title, messages, tools, and files (single-message hits rank higher) | `auth cookie` |
| `"exact phrase"` | Exact substring phrase match | `"session_message"` |
| `~term` | Typo-tolerant fuzzy match (bounded Levenshtein distance) | `~playwrigth` |
| `/pattern/i` or `re:pattern` | Regular expression match | `/error\s+\d+/i` |
| `role:user` / `role:assistant` / `role:shell` | Filter by message author (`from:user`, `from:ai` also work) | `role:user backup` |
| `scope:project` / `scope:all` | Filter to current workspace directory or all workspaces | `scope:project` |
| `date:today` / `date:yesterday` / `date:7d` / `date:30d` | Relative date filter | `date:7d migration` |
| `date:YYYY-MM` or `date:YYYY-MM-DD..YYYY-MM-DD` | Month or date range filter | `date:2026-10` |
| `file:<path>` | Filter sessions that read or modified a matching file path | `file:tui.ts` |
| `tool:<name>` | Filter sessions that invoked a matching tool | `tool:edit` |
| `in:title` / `in:message` / `in:tool` / `in:file` | Restrict search to a specific entry type | `in:title plugin` |

## Keyboard Shortcuts (`/search`)

| Key | Action |
| :--- | :--- |
| `Enter` | Open the selected session and auto-scroll to the active matched snippet |
| `Up` / `Down` or `Ctrl+N` / `Ctrl+K` | Move selection up or down (or cycle matching snippets when the Preview pane is focused; `j`/`k` also work in List and Preview panes) |
| `PageUp` / `PageDown` or `Ctrl+U` / `Ctrl+D` | Jump 6 sessions up/down (or scroll the Preview pane by 8 lines when focused) |
| `Tab` / `Shift+Tab` | Switch focus between Search Input, Session List, and Preview Pane (`/` returns to Search Input) |
| `Ctrl+P` | Toggle project scope pill (`scope:all` <-> `scope:project`) |
| `Ctrl+G` | Cycle role filter pill (`all` -> `user` -> `assistant` -> `shell`) |
| `Ctrl+T` | Cycle date filter pill (`all` -> `today` -> `yesterday` -> `7d` -> `30d`) |
| `Ctrl+R` | Cycle search mode pill (`smart` -> `fuzzy` -> `regex`) |
| `Ctrl+L` | Force refresh the SQLite session index |
| `Esc` | Close popup |

## How It Works (Architecture & Internals)

### 1. Zero-Dependency Native SQLite Driver (`openReadOnlyDb` & `resolveDbPath`)

`opencode-local-search` has zero runtime npm dependencies and requires no compiled C++ addons. When the popup opens, `openReadOnlyDb()` detects the active JavaScript runtime (`Bun` vs. Node.js) and dynamically imports the built-in SQLite driver (`bun:sqlite` or `node:sqlite`) in read-only mode.

`resolveDbPath()` locates the OpenCode database in this order:

1. Explicit `customPath` argument (used by tests or custom callers)
2. `OPENCODE_DB_PATH` environment variable
3. `$XDG_DATA_HOME/opencode/opencode.db`
4. `~/.local/share/opencode/opencode.db` (macOS, Linux, Windows)
5. `%LOCALAPPDATA%/opencode/opencode.db` (Windows fallback)

Once loaded, `loadSessionIndex()` caches the parsed `SessionIndex` in memory for 6 seconds (`INDEX_TTL_MS = 6000`) so typing in the search bar filters in sub-millisecond time without re-querying SQLite on every keystroke (`Ctrl+L` forces an immediate re-index).

### 2. Dual-Schema Indexing (OpenCode V2 + V1 Fallback)

At index time, `loadSessionIndex()` inspects `sqlite_master` to support both OpenCode database generations automatically:

- **OpenCode V2 (`session_v2` + `session_message`)**:
   - Inspects `PRAGMA table_info(session_v2)` to resolve workspace directory columns (`directory` or `COALESCE(workspace_directory, root_directory, '')`) and exclude archived sessions (`WHERE time_archived IS NULL`).
   - Loads the 800 most recently updated sessions and uses a window function (`ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC)`) to pull up to the latest 250 messages per session (`LIMIT 30000`, with a plain `ORDER BY` fallback if window functions are unavailable).
- **OpenCode V1 Fallback (`session` + `message` + `part`)**:
   - Automatically falls back to joining `part` and `message` (`json_extract(m.data, '$.role')`) if `session_v2` is not present.
- **Structured entry extraction**:
   - The indexer splits each message JSON payload into three `SearchEntry` kinds:
      - `message`: User prompt text and assistant reply text parts
      - `tool`: Tool invocations (`[toolName] key: value · ...` via `stringifyToolInput()`) and shell commands plus terminal output (`$ command\noutput`)
      - `filepath`: Attached user files, patch file lists, and file paths extracted from tool arguments (`path`, `filePath`, `file`, `file_path`, `targetFile`, `workdir`, `directory`, `files` via `extractFilePathsFromInput()`)

### 3. Query Parser & Session-Level AND Ranking (`parseSearchQuery` & `searchSessionIndex`)

`parseSearchQuery()` tokenizes raw input with `/(\/[^/]+\/[gimsuy]*|[a-zA-Z]+:"[^"]+"|"[^"]+"|\S+)/g`, separating inline filter tokens (`role:`, `scope:`, `date:`, `file:`, `tool:`, `in:`, `re:`, `~fuzzy`) from search terms and quoted phrases.

When filtering sessions, `searchSessionIndex()` enforces **session-level multi-term AND matching**: every required term in `terms` and `fuzzyTerms` must appear somewhere in the session, even if one term is in the session title, another is in a user prompt, and a third is in an edited file path. `searchSessionIndex()` scores matching sessions with fixed weights:

| Signal | Score Contribution | Notes |
| :--- | :--- | :--- |
| Title regex match | `+120` | When searching in `regex` mode (`/pattern/i` or `re:`) |
| Title exact substring match | `+90` | Per query term matched in `session.title` |
| Title fuzzy match | `+65 - (distance * 10)` | Explicit `~term` (`+55 - distance * 10` in `fuzzy` mode) |
| Entry exact match | `+35 * entryMatchedTerms` | Per message, tool call, or file path entry (`+50` / `+35` in `regex` mode) |
| Entry fuzzy match | `+20 * entryMatchedTerms` | When matched via bounded Levenshtein distance |
| Single-message co-occurrence bonus | `+45` | Added when a single message contains **all** query terms |
| Active `file:` / `tool:` target bonus | `+25` | Added when an entry directly matches the active `file:` or `tool:` filter |
| Recency boost | `max(0, 15 - recencyDays * 0.4)` | Breaks ties in favor of recently updated sessions |

### 4. Zero-Dependency Typo Tolerance (`editDistanceBounded` & `findFuzzyWordMatch`)

`src/search.ts` implements a bounded Levenshtein dynamic programming matcher (`editDistanceBounded(a, b, maxDist)`) for typo tolerance:

- Uses two rolling row arrays (`prev` and `curr`) and aborts immediately if length difference exceeds `maxDist` or if the minimum value in the current DP row exceeds `maxDist`.
- Allows edit distance `<= 1` for short words (3 to 5 characters) and `<= 2` for longer words (6+ characters), pre-filtering candidate tokens by a shared 2-character prefix or length within `maxDist`.
- **Automatic Smart Fallback**: In default `smart` mode, if a multi-word query fails the strict session-level AND check because one word has a typo (for example, `playwrigth`), `searchSessionIndex()` automatically retries the missing term through `findFuzzyWordMatch()` (`+30` title / `+22` entry) and tags the resulting snippet as `[FUZZY]`.

### 5. Auto-Scroll to the Exact Matched Message (`scrollToMatchedMessage`)

When you press `Enter` on a session (or click a specific snippet card in the right preview pane), the plugin navigates to that session (`context.ui.router.navigate({ type: "session", sessionID })`) and runs `scrollToMatchedMessage()` to scroll the transcript to the matched message:

1. **Message store sync**: Triggers `context.data.session.message.sync(sessionId)` and polls the live `@opentui` render tree every 60ms (up to 25 attempts) while the session view mounts.
2. **Viewport discovery**: Traverses `context.renderer.root` to find the largest visible `ScrollBoxRenderable` representing the conversation transcript.
3. **Three-tier node resolution**:
   - **Tier 1 (Exact ID)**: Matches a render node whose `id` equals or contains the target `messageId`.
   - **Tier 2 (Tiered text needles + chronological ratio)**: Walks `scrollBox.content` and compares `extractRenderableText(node)` against progressively broader normalized snippet needles. If multiple nodes match the same text, it computes the message's chronological index ratio (`msgIdx / (liveMessages.length - 1)`) and picks the candidate whose vertical position (`relY`) is closest to `ratio`.
   - **Tier 3 (Collapsed tool fallback)**: If the match was inside a collapsed tool call output, falls back after 6 attempts to scrolling to `topChildren[Math.round(ratio * (topChildren.length - 1))]`.
4. **Viewport positioning & scroll lock**: Scrolls the matched node to 22% from the top of the viewport (`scrollBox.scrollBy({ x: 0, y: dy })`), sets `scrollBox._hasManualScroll = true` so OpenCode's auto-scroll-to-bottom does not snap back, and re-applies the offset after 120ms to settle layout reflows.

### 6. Interactive OpenTUI `/search` Modal Architecture (`src/tui.ts`)

1. **Wide modal layout (`applyDialogWidth` & `dialog.set`)**:
   - Calls `context.ui.dialog.show(...)` followed by `context.ui.dialog.set({ size: "xlarge", centered: true })` so the dialog opens wide without being reset to default width.
   - Inside `onMount` and `ref`, `applyDialogWidth()` walks upward from `rootRef` to the outer `absolute`-positioned dialog container and sets `width: "80%"` (or your configured `dialogWidth`), `maxWidth: "80%"`, and `minWidth: 72`.
2. **Interactive filter pills & inline badge sync**:
   - Renders clickable `Pill` components beneath the search input for `scope:<all|project>` (`^p`), `role:<role>` (`^g`), `date:<range>` (`^t`), and `mode:<mode>` (`^r`), plus live indicator badges when `file:<path>`, `tool:<name>`, or regex syntax errors are active in the query string.
3. **Split-pane session list & selectable snippet cards**:
   - Splits the main body into a 44%-width left session list (session title, match kind badge, relative age, and 1-line snippet preview) and a 56%-width right preview pane (session metadata header, files touched chips, and individual matched snippet cards).
   - Focusing the right preview pane (`Tab`) lets you cycle through individual snippet cards inside the selected session with `Up`/`Down` and press `Enter` (or click a card directly) to jump straight to that specific message.

### 7. Agent Tools Registered by the Server Plugin

`src/server.ts` is intentionally a no-op entrypoint that registers **zero LLM agent tools**. All session indexing, filtering, and navigation happen strictly inside the TUI (`src/tui.ts`), adding **0 schema tokens** to your model context.

### 8. Token Usage Breakdown

Every operation in `opencode-local-search` uses zero LLM tokens:

| Operation | Token Cost | Why |
| :--- | :--- | :--- |
| Opening `/search` & indexing SQLite (`loadSessionIndex`) | **0 tokens** | Queries `~/.local/share/opencode/opencode.db` directly in read-only mode via `bun:sqlite` or `node:sqlite` |
| Live filtering, fuzzy matching & snippet preview | **0 tokens** | Runs synchronously in memory (`searchSessionIndex`) inside the TUI process on every keystroke |
| Jumping to a matched session & message (`Enter`) | **0 tokens** | Navigates via `context.ui.router.navigate()` and scrolls the local `@opentui` transcript tree directly |
| Server plugin entrypoint (`src/server.ts`) | **0 schema tokens** | Registers no LLM tools or system prompts |

## Configuration Options

Options can be passed in `~/.config/opencode/cli.json` (or `opencode.jsonc`) or via environment variables:

```json
{
	"plugins": [
		[
			"@nandoblanco/opencode-local-search",
			{
				"dialogWidth": "80%"
			}
		]
	]
}
```

| Option | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `dialogWidth` | `OPENCODE_SESSION_SEARCH_DIALOG_WIDTH` | `"80%"` | Width of the centered `/search` TUI modal (`"80%"` or column count like `120`; also respects `OPENCODE_DIALOG_WIDTH`) |
| *(db path)* | `OPENCODE_DB_PATH` | `~/.local/share/opencode/opencode.db` | Override path to the OpenCode SQLite database |

## License

MIT
