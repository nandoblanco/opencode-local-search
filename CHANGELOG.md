# Changelog

## Unreleased

- Renamed OpenCode Desktop sidebar label (`vertical-tabs-search`), panel tab title, and dialog title from `Search sessions` to `Search` and stripped any trailing shortcut badge from the left sidebar button (`src/gui.tsx`).
- Added a centered loading spinner overlay (`.ols-loading-center` / `.ols-loading-pill`) inside the search results split view (`src/gui.tsx`, `src/gui.css`) and reduced search input debounce to 16ms.
- Accelerated session search (`src/search.ts`, `src/server.ts`) with incremental SQLite `session_v2` delta indexing (`time_updated > cachedMaxUpdated`), skipping redundant V1 fallback table scans when V2 sessions exist, and prewarming the index on server plugin startup.
- Added session sort modes (`updated`, `relevance`, `newest`, `oldest`, `title`, `context`, `tokens`) via `src/sort.ts` with interactive sort controls in `/search` TUI (`src/tui.ts`) and OpenCode Desktop (`src/gui.tsx`).
- Included `archived`, `contextTokens`, and `totalTokens` session metadata in RPC and server search responses (`src/rpc.ts`, `src/server.ts`).

## 1.1.0 (2026-11-12)

- Added OpenCode Desktop Session Search (`src/gui.tsx`, `src/gui.css`, `dist/gui-experimental.cjs`, and `SearchRpc` in `src/rpc.ts`) with a persistent side panel (`Ctrl+Shift+F` to open/focus, `Ctrl+Alt+F` to toggle), fallback dialog when no session is active, and routing from OpenCode Desktop's built-in titlebar, vertical-tabs, Home session search, and Search sessions dialog.
- Updated `cli.js` and `src/server.ts` to register `SearchRpc.query` for shared SQLite session search across TUI and Desktop.

## 1.0.2 (2026-10-28)

- Refined the `/search` OpenTUI modal layout (`src/tui.ts`) with a bordered filter bar and split-pane session and message snippet cards.

## 1.0.1 (2026-10-26)

- Scoped npm package as `@nandoblanco/opencode-local-search` with public `publishConfig` and normalized `bin` and `repository` fields.
- Hardened regex ReDoS guards in `parseQuery`, enforced inline filters during fuzzy fallback matching in `src/search.ts`, bounded the in-memory index cache, and cleaned up transcript auto-scroll timers in `src/tui.ts`.

## 1.0.0 (2026-10-25)

- Initial release of `opencode-local-search` for OpenCode.
- Added zero-token local SQLite session indexing (`bun:sqlite` and `node:sqlite`) supporting both OpenCode V2 (`session_v2`, `session_message`) and V1 (`session`, `message`, `part`) schemas.
- Added multi-term session-level AND ranking, exact phrase matching, regex (`/pattern/i` and `re:`), bounded Levenshtein fuzzy search (`~term`), inline filter tokens (`role:`, `date:`, `file:`, `tool:`, `scope:`), one-command CLI installer (`cli.js`), and the `/search` split-pane TUI modal (`src/tui.ts`) with auto-scroll to matched messages.
