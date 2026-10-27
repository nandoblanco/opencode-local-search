#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const cliName = "open" + "code";

export function resolveConfigDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  if (process.env.OPENCODE_CONFIG_DIR) return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, cliName);
  return path.join(os.homedir(), ".config", cliName);
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

  const pluginsMatch = /"plugins"\s*:\s*\[/.exec(raw);
  if (pluginsMatch) {
    const openBracketIdx = pluginsMatch.index + pluginsMatch[0].length - 1;
    let depth = 0;
    let inString = false;
    let escape = false;
    let closeBracketIdx = -1;

    for (let i = openBracketIdx; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "[") depth++;
        else if (ch === "]") {
          depth--;
          if (depth === 0) {
            closeBracketIdx = i;
            break;
          }
        }
      }
    }

    if (closeBracketIdx !== -1) {
      const inside = raw.slice(openBracketIdx + 1, closeBracketIdx).trim();
      let insertion;
      if (!inside) {
        insertion = pluginEntryStr;
      } else {
        const trimmedBeforeClose = raw.slice(openBracketIdx + 1, closeBracketIdx).replace(/\s+$/, "");
        const needsComma = !trimmedBeforeClose.endsWith(",");
        insertion =
          trimmedBeforeClose +
          (needsComma ? "," : "") +
          "\n    " +
          pluginEntryStr +
          "\n  ";
      }
      const updated =
        raw.slice(0, openBracketIdx + 1) +
        (inside ? insertion : "\n    " + insertion + "\n  ") +
        raw.slice(closeBracketIdx);
      fs.writeFileSync(filePath, updated, "utf8");
      return "updated";
    }
  }

  const lastBraceIdx = raw.lastIndexOf("}");
  if (lastBraceIdx !== -1) {
    const before = raw.slice(0, lastBraceIdx).replace(/\s+$/, "");
    const needsComma = !before.endsWith("{") && !before.endsWith(",");
    const updated =
      before +
      (needsComma ? "," : "") +
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

  const pkgName = "opencode-local-search";
  const entryStr = opts.dialogWidth
    ? '["' + pkgName + '", { "dialogWidth": "' + String(opts.dialogWidth) + '" }]'
    : '"' + pkgName + '"';

  const cliConfigFile = path.join(configDir, "cli.json");
  const cliStatus = addPluginToJsoncFile(
    cliConfigFile,
    "https://" + cliName + ".ai/v2/cli.json",
    entryStr,
    pkgName
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
    installPlugin()
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
    console.log("  npx opencode-local-search install");
  }
}
