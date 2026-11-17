import { createRoot, For } from "solid-js";
import { render } from "solid-js/web";
import search from "../src/gui";
import { Panel, Style } from "@opencode/plugin/gui";

const calls: any[] = [];
let archived = true;
let fail = false;
const client = {
  session: { async update(input: any) { calls.push(input); if (fail) throw new Error("Restore failed"); archived = false; } },
  rpc: () => ({ async query(input: any) {
    calls.push(input);
    const results = [
      { id: "archived", title: "Archived architecture discussion", archived, contextTokens: 42000, totalTokens: 310000, timeCreated: 10, timeUpdated: 20 },
      { id: "active", title: "Active implementation", archived: false, contextTokens: 12000, totalTokens: 70000, timeCreated: 20, timeUpdated: 10 },
    ].map(s => ({ ...s, directory: "/example/project", directoryNorm: "/example/project", tools: [], files: [], score: 1, totalMatches: 0, matches: [], recentEntries: [], snippet: "Session history preview", matchBadge: "title" }));
    if (input.sort === "newest" || input.sort === "title") results.reverse();
    return { totalSessions: 2, results, parsed: { terms: [], fuzzyTerms: [], effectiveMode: "smart" } };
  } }),
};
const ui = {
  TextInput: (p: any) => <input aria-label={p.label} placeholder={p.placeholder} value={p.value} onInput={e => p.onInput(e.currentTarget.value)} />,
  Button: (p: any) => <button disabled={p.busy} onClick={p.onClick}>{p.children}</button>,
  IconButton: (p: any) => <button aria-label={p.icon} onClick={p.onClick}>↻</button>,
  Icon: () => <span aria-hidden="true">·</span>,
  Tooltip: (p: any) => p.children,
  Loader: () => <span>Loading</span>,
  Menu: (p: any) => <details><summary>{p.label}</summary><div role="menu"><For each={p.items}>{item => <button role="menuitem" onClick={e => { e.currentTarget.closest("details")!.open = false; item.onSelect?.(); }}>{item.label}</button>}</For></div></details>,
};
const style = document.createElement("style");
style.textContent = "body{margin:0;background:#141417}#app{height:100vh}button,input,summary{font:inherit;color:inherit}button,summary{cursor:pointer;background:#25252c;border:1px solid #555;padding:8px;border-radius:4px}input{box-sizing:border-box;width:100%;padding:10px;background:#1c1c21;border:1px solid #555}details{position:relative}details [role=menu]{position:absolute;z-index:20;background:#25252c;min-width:180px;display:flex;flex-direction:column}";
document.head.append(style);
createRoot(() => search.setup!({
  id: "search", ui, client, sessions: { current: () => ({ id: "test", server: { id: "local", client } }) },
  appearance: { mode: () => "dark" }, servers: { list: () => ["local"], get: () => ({ client }) },
  toast: { show: (message: any) => calls.push(message) }, layout: {}, t: (s: string) => s,
  add(kind: any, value: any) {
    if (kind === Style) { const sheet = document.createElement("style"); sheet.textContent = value; document.head.append(sheet); }
    if (kind === Panel) render(value.render, document.getElementById("app")!);
  },
} as any));
(window as any).surfaceTest = { calls, setFail(value: boolean) { fail = value; } };
