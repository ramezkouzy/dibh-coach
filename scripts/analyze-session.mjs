#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { analyzeSession, parseSessionJson } from "../src/lib/tracking-analysis.mjs";

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("Usage: pnpm session:analyze path/to/dibh-session-*.json [...]");
  process.exit(1);
}

let failures = 0;
for (const path of paths) {
  try {
    const session = parseSessionJson(await readFile(path, "utf8"));
    const analysis = analyzeSession(session);
    console.log(`\n${path}`);
    console.log(`  confidence: ${analysis.trackingConfidence}`);
    console.log(
      `  target: ${analysis.summary.learnedTargetPitchDeg}° ` +
        `(baseline ${analysis.summary.baselinePitchDeg}°, excursion ${analysis.summary.targetExcursionDeg}°)`,
    );
    console.log(
      `  holds: ${analysis.summary.holdCount}, reached target: ${analysis.summary.reachedTargetCount}, ` +
        `suggested cap: ${analysis.summary.suggestedSelfTestCapSec}s`,
    );
    if (analysis.issues.length) {
      console.log("  issues:");
      for (const item of analysis.issues) {
        const where = item.holdIndex ? ` hold ${item.holdIndex}` : "";
        console.log(`    - [${item.severity}]${where} ${item.code}: ${item.message}`);
      }
    }
    if (analysis.recommendations.length) {
      console.log("  recommendations:");
      for (const item of analysis.recommendations) {
        console.log(`    - [${item.priority}] ${item.code}: ${item.message}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures) process.exit(1);
