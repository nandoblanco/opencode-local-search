"use strict";

import assert from "node:assert/strict";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

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
  await page.goto("http://127.0.0.1:5199/test/search-surface.html");
  await page.getByRole("button", { name: "Unarchive", exact: true }).waitFor();
  mkdirSync(".screenshots", { recursive: true });
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: `.screenshots/search-archived-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  for (const label of ["Relevance", "Newest created", "Oldest created", "Title A–Z", "Latest context size", "Total tokens used", "Recently updated"]) {
    await page.locator("summary").filter({ hasText: "Sort:" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await page.waitForFunction(label => document.querySelector("summary")?.textContent === `Sort: ${label}`, label);
    await page.waitForTimeout(80);
    if (label === "Latest context size" || label === "Total tokens used") {
      await page.screenshot({ path: `.screenshots/search-${label === "Latest context size" ? "context" : "tokens"}-1100.png` });
      assert.equal(await page.locator(".ols-row-meta").first().innerText().then(text => text.includes(label === "Latest context size" ? "42,000" : "310,000")), true);
    }
  }
  await page.locator("summary").filter({ hasText: "Sort:" }).click();
  await page.screenshot({ path: ".screenshots/search-sort-menu-1100.png" });
  await page.getByRole("menuitem", { name: "Recently updated", exact: true }).click();
  await page.evaluate(() => window.surfaceTest.setFail(true));
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await page.waitForFunction(() => window.surfaceTest.calls.some(c => c.title === "Unable to unarchive session"));
  await page.evaluate(() => window.surfaceTest.setFail(false));
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await page.getByRole("button", { name: "Unarchive", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.surfaceTest.calls.some(c => c.sessionID === "archived" && c.archived === false)), true);
  assert.equal(await page.evaluate(() => window.surfaceTest.calls.some(c => c.forceReload === true)), true);
  await page.screenshot({ path: ".screenshots/search-restored-1100.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: all seven sort controls, archived labels, restore failure and success, forced refresh, and responsive overflow checks");
} finally {
  await browser.close();
  await server.close();
}
