"use strict";

import assert from "node:assert/strict";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { chromium } from "playwright";

const server = await createServer({ configFile: false, plugins: [solid()], server: { host: "127.0.0.1", port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
try {
  await page.goto("http://127.0.0.1:5199/test/search-shortcut.html");
  await page.waitForFunction(() => window.shortcutTest);
  for (const [className, placeholder] of [["command-palette", "Search sessions"], ["command-palette-dialog", "Search sessions..."]]) {
    await page.evaluate(([className, placeholder]) => window.shortcutTest.show(className, placeholder), [className, placeholder]);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), undefined, { timeout: 3000 });
  }
  assert.deepEqual(await page.evaluate(() => window.shortcutTest.opened), ["search:search", "search:search"]);
  await page.evaluate(() => window.shortcutTest.show("command-palette", "Search commands"));
  await page.locator('[role="dialog"]').waitFor();
  assert.equal(await page.evaluate(() => window.shortcutTest.opened.length), 2, "Unrelated command palettes must not be intercepted");
  assert.deepEqual(errors, []);
  console.log("PASS: current and legacy search dialogs redirect once and close; unrelated palettes remain open");
} finally {
  await browser.close();
  await server.close();
}
