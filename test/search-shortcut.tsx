import { createRoot } from "solid-js";
import search from "../src/gui";

const opened: string[] = [];
createRoot(() => search.setup!({
  id: "search",
  ui: {},
  add() {},
  sessions: { current: () => ({ id: "test" }) },
  layout: { open: (key: string) => opened.push(key) },
} as any));

(window as any).shortcutTest = {
  opened,
  show(className: string, placeholder: string) {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.className = className;
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.value = "backup";
    dialog.append(input);
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") dialog.remove();
    });
    document.body.append(dialog);
  },
};
