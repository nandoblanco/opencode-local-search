#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const cliName = "open" + "code";

export function resolveConfigDir(explicitDir) {
  if (explicitDir) {
    if (explicitDir === "~") return os.homedir();
    if (explicitDir.startsWith("~/") || explicitDir.startsWith("~\\")) {
      return path.join(os.homedir(), explicitDir.slice(2));
    }
    return path.resolve(explicitDir);
  }
  if (process.env.OPENCODE_CONFIG_DIR) return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, cliName);
  return path.join(os.homedir(), ".config", cliName);
}

function findPluginsArraySpan(raw) {
  const pluginsMatch = /"plugins"\s*:\s*\[/.exec(raw);
  if (!pluginsMatch) return null;
  const openBracketIdx = pluginsMatch.index + pluginsMatch[0].length - 1;
  let depth = 0;
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBracketIdx; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return { openBracketIdx, closeBracketIdx: i };
      }
    }
  }
  return null;
}

function findLastCodeCharIndex(str) {
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  let lastCodeIdx = -1;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      lastCodeIdx = i;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      lastCodeIdx = i;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      lastCodeIdx = i;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastCodeIdx = i;
    }
  }
  return lastCodeIdx;
}

function addPluginToJsoncFile(filePath, defaultSchema, pluginEntryStr, matchSubstr) {
  if (!fs.existsSync(filePath)) {
    const initial =
      "{\n" +
      '  "$schema": "' +
      defaultSchema +
      '",\n' +
      '  "plugins": [\n' +
      "    " +
      pluginEntryStr +
      "\n" +
      "  ]\n" +
      "}\n";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, initial, "utf8");
    return "created";
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.includes(matchSubstr)) {
    return "already-present";
  }

  const span = findPluginsArraySpan(raw);
  if (span) {
    const { openBracketIdx, closeBracketIdx } = span;
    const insideRaw = raw.slice(openBracketIdx + 1, closeBracketIdx);
    const lastCodeIdx = findLastCodeCharIndex(insideRaw);
    if (lastCodeIdx === -1) {
      const updated =
        raw.slice(0, openBracketIdx + 1) +
        "\n    " +
        pluginEntryStr +
        "\n  " +
        raw.slice(closeBracketIdx);
      fs.writeFileSync(filePath, updated, "utf8");
      return "updated";
    }
    const lastChar = insideRaw[lastCodeIdx];
    const withComma =
      lastChar === ","
        ? insideRaw.replace(/\s+$/, "")
        : insideRaw.slice(0, lastCodeIdx + 1) + "," + insideRaw.slice(lastCodeIdx + 1).replace(/\s+$/, "");
    const updated =
      raw.slice(0, openBracketIdx + 1) +
      withComma +
      "\n    " +
      pluginEntryStr +
      "\n  " +
      raw.slice(closeBracketIdx);
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  const lastBraceIdx = raw.lastIndexOf("}");
  if (lastBraceIdx !== -1) {
    const beforeRaw = raw.slice(0, lastBraceIdx);
    const lastCodeIdx = findLastCodeCharIndex(beforeRaw);
    const lastChar = lastCodeIdx !== -1 ? beforeRaw[lastCodeIdx] : "{";
    const needsComma = lastChar !== "{" && lastChar !== ",";
    const withComma = needsComma
      ? beforeRaw.slice(0, lastCodeIdx + 1) + "," + beforeRaw.slice(lastCodeIdx + 1).replace(/\s+$/, "")
      : beforeRaw.replace(/\s+$/, "");
    const updated =
      withComma +
      '\n  "plugins": [\n    ' +
      pluginEntryStr +
      "\n  ]\n}\n";
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  return "skipped";
}

export async function installPlugin(options) {
  const opts = options || {};
  const configDir = resolveConfigDir(opts.configDir);
  fs.mkdirSync(configDir, { recursive: true });

  const pkgName = "@nandoblanco/opencode-local-search";
  const matchKey = "opencode-local-search";
  const entryStr = opts.dialogWidth
    ? '["' + pkgName + '", { "dialogWidth": "' + String(opts.dialogWidth) + '" }]'
    : '"' + pkgName + '"';

  const cliConfigFile = path.join(configDir, "cli.json");
  const cliStatus = addPluginToJsoncFile(
    cliConfigFile,
    "https://" + cliName + ".ai/v2/cli.json",
    entryStr,
    matchKey
  );

  return {
    configDir,
    cliConfigFile,
    cliStatus,
  };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const cmd = process.argv[2] || "install";
  if (cmd === "install" || cmd === "init" || cmd === "setup") {
    const args = process.argv.slice(3);
    let configDir;
    let dialogWidth;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) {
        configDir = args[i + 1];
        i++;
      } else if ((args[i] === "--width" || args[i] === "--dialog-width") && args[i + 1]) {
        dialogWidth = args[i + 1];
        i++;
      }
    }
    installPlugin({ configDir, dialogWidth })
      .then((res) => {
        console.log("opencode-local-search installed:");
        console.log("  TUI config: " + res.cliConfigFile + " (" + res.cliStatus + ")");
      })
      .catch((err) => {
        console.error("Install failed:", err);
        process.exit(1);
      });
  } else {
    console.log("Usage:");
    console.log("  npx @nandoblanco/opencode-local-search install [--dir <config-dir>] [--width 80%]");
  }
}
