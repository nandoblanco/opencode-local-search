# Changelog

## 1.2.2 (2026-11-26)

- Updated `installPlugin` (`cli.js`) to write only to `opencode.jsonc` using OpenCode V2 object syntax (`{ "package", "options" }`) instead of duplicating entries into `cli.json` or emitting V1 tuple syntax, and standardized `README.md` to lead with `opencode plugin add`.

## 1.2.1 (2026-11-26)

- Removed eager startup SQLite index prewarming from `src/server.ts` so OpenCode server startup is not blocked by synchronous database scans on large `opencode.db` files; the index still loads and caches on demand when `/search` is queried.
- Sort now switches to `Relevance` automatically while a query is typed and back to `Recently updated` when cleared, unless a sort was picked manually (`src/gui.tsx`, `src/tui.ts`).
- Desktop hides the current session from results by default, with a `Hide this session` / `This session hidden` toggle pill.
- Desktop panel now uses a container query: results and matches sit side by side at 640px and wider, and below that the list fills the panel and a row opens the matches with a `Back` button (Escape returns to the list); detail meta wraps instead of clipping (`src/gui.css`).
- TUI `/search` rows keep the title readable by showing only the age on the title line and moving the match badge to the snippet line; the count line no longer shows the `0 tokens` label.
- TUI `/search` pane headers are shorter (`SESSIONS`, `MATCH PREVIEW`) and stay on one line with truncating meta, the header path truncates instead of colliding with the key hints at narrow widths, and wrapped filter pills no longer leave a blank row.
- `package-lock.json` root version synced to the package version.
- Desktop dialog (`Ctrl+Shift+F` with no session) now fills its height instead of leaving an empty band at the bottom (`src/gui.css`).
- Desktop arrow-key navigation scrolls the selected session and match into view (`src/gui.tsx`).

## 1.2.0 (2026-11-17)

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
