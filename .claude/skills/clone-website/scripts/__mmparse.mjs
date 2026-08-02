import fs from "node:fs";
import { chromium } from "playwright-core";

const FE = "/Users/ayushsingh/Desktop/Clientell/clientell-slack-agent-web-ui";
const MERMAID_JS = `${FE}/node_modules/mermaid/dist/mermaid.min.js`;
const full = fs.readFileSync("/tmp/opencode/swimlane.mmd", "utf8");

// EXACT copy of src/lib/mermaid.ts escapeUnquotedEdgeLabelSpecials (Layer 4)
function escapeUnquotedEdgeLabelSpecials(src) {
  if (!src.includes("|")) return src;
  let out = "";
  let inQuotes = false;
  let inEdgeLabel = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") { inQuotes = false; inEdgeLabel = false; out += ch; continue; }
    if (ch === '"') { inQuotes = !inQuotes; out += ch; continue; }
    if (ch === "|" && !inQuotes) { inEdgeLabel = !inEdgeLabel; out += ch; continue; }
    if (inEdgeLabel && !inQuotes) {
      if (ch === "(") { out += "#40;"; continue; }
      if (ch === ")") { out += "#41;"; continue; }
    }
    out += ch;
  }
  return out;
}

const cases = {
  "FULL swimlane RAW (as emitted)": full,
  "FULL swimlane AFTER Layer-4 fix": escapeUnquotedEdgeLabelSpecials(full),
  "safety: quoted '|' inside node label is untouched":
    escapeUnquotedEdgeLabelSpecials('flowchart LR\nA["a | b (x)"] -->|No (if X)| B["y"]'),
  "safety: plain diagram, no parens, unchanged":
    escapeUnquotedEdgeLabelSpecials('flowchart TB\nA["Start"] -->|Yes| B["End"]'),
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: MERMAID_JS });
await page.evaluate(() => {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", suppressErrorRendering: true });
});

for (const [label, code] of Object.entries(cases)) {
  const res = await page.evaluate(async (c) => {
    try { await window.mermaid.parse(c); return { ok: true }; }
    catch (e) { return { ok: false, msg: e && e.message ? e.message : String(e) }; }
  }, code);
  if (res.ok) console.log(`PASS  ${label}`);
  else console.log(`FAIL  ${label}\n      -> ${String(res.msg).split("\n").slice(0, 2).join(" | ")}`);
}

// Prove the fixed label still RENDERS the parens (entity -> visible "(")
const r = await page.evaluate(async (c) => {
  try { const { svg } = await window.mermaid.render("g1", c); return svg.includes("(if Contract stage)"); }
  catch { return false; }
}, escapeUnquotedEdgeLabelSpecials(full));
console.log(`RENDER label shows "(if Contract stage)" literally: ${r ? "YES" : "NO"}`);

await browser.close();
