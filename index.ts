import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  type Renderable,
} from "@opentui/core"
import { readdirSync, statSync, watch, type FSWatcher, readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

// ─── Pricing ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const pricingPath = (() => {
  for (const p of [
    join(__dirname, "pricing.json"),
    join(__dirname, "..", "pricing.json"),
    resolve(process.cwd(), "pricing.json"),
  ]) {
    try { statSync(p); return p } catch {}
  }
  throw new Error("pricing.json not found")
})()
const pricing = JSON.parse(readFileSync(pricingPath, "utf8"))
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = pricing.model_pricing
const PREMIUM_MULTIPLIER: Record<string, number> = pricing.premium_multiplier
const PREMIUM_REQUEST_COST: number = pricing.premium_request_cost

// ─── State ──────────────────────────────────────────────────────────────────
const ROOT = join(homedir(), ".copilot", "session-state")

type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requests: number
  cost: number
}

type SessionData = {
  sessionId: string
  startedAt: number
  cwd: string | null
  repository: string | null
  branch: string | null
  currentModel: string | null
  premiumRequests: number
  hasShutdown: boolean
  models: Map<string, ModelUsage>      // from shutdown.modelMetrics
  liveOutputByModel: Map<string, number>  // running outputTokens for in-progress
  liveRequestsByModel: Map<string, number>
}

const sessions = new Map<string, SessionData>()
// per-file byte offsets so we tail incrementally
const offsets = new Map<string, number>()
const fileWatchers = new Map<string, FSWatcher>()

function getSession(id: string): SessionData {
  let s = sessions.get(id)
  if (!s) {
    s = {
      sessionId: id,
      startedAt: 0,
      cwd: null,
      repository: null,
      branch: null,
      currentModel: null,
      premiumRequests: 0,
      hasShutdown: false,
      models: new Map(),
      liveOutputByModel: new Map(),
      liveRequestsByModel: new Map(),
    }
    sessions.set(id, s)
  }
  return s
}

function projectName(cwd: string | null, repo: string | null): string {
  if (repo) return repo.split("/").pop() || repo
  if (cwd)  return cwd.split("/").pop() || cwd
  return "(unknown)"
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// ─── Parsing ────────────────────────────────────────────────────────────────
function processLine(sessionId: string, line: string) {
  if (!line) return
  let evt: any
  try { evt = JSON.parse(line) } catch { return }
  const type = evt?.type
  const d = evt?.data
  if (!d) return

  const s = getSession(sessionId)

  if (type === "session.start") {
    if (evt.timestamp) s.startedAt = Date.parse(evt.timestamp) || 0
    const ctx = d.context ?? {}
    s.cwd        = ctx.cwd        ?? s.cwd
    s.repository = ctx.repository ?? s.repository
    s.branch     = ctx.branch     ?? s.branch
  } else if (type === "session.model_change") {
    if (typeof d.newModel === "string") s.currentModel = d.newModel
  } else if (type === "assistant.message") {
    if (typeof d.outputTokens === "number" && s.currentModel) {
      s.liveOutputByModel.set(s.currentModel, (s.liveOutputByModel.get(s.currentModel) ?? 0) + d.outputTokens)
      s.liveRequestsByModel.set(s.currentModel, (s.liveRequestsByModel.get(s.currentModel) ?? 0) + 1)
    }
  } else if (type === "session.shutdown") {
    s.hasShutdown = true
    s.premiumRequests = d.totalPremiumRequests ?? s.premiumRequests
    s.currentModel = d.currentModel ?? s.currentModel
    const metrics = d.modelMetrics ?? {}
    s.models.clear()
    for (const [model, mm] of Object.entries<any>(metrics)) {
      const u = mm?.usage ?? {}
      const r = mm?.requests ?? {}
      s.models.set(model, {
        inputTokens:      u.inputTokens      ?? 0,
        outputTokens:     u.outputTokens     ?? 0,
        cacheReadTokens:  u.cacheReadTokens  ?? 0,
        cacheWriteTokens: u.cacheWriteTokens ?? 0,
        reasoningTokens:  u.reasoningTokens  ?? 0,
        requests:         r.count            ?? 0,
        cost:             r.cost             ?? 0,
      })
    }
  }
}

function listSessionFiles(): string[] {
  try {
    return readdirSync(ROOT)
      .map((d) => join(ROOT, d, "events.jsonl"))
      .filter((p) => { try { return statSync(p).isFile() } catch { return false } })
  } catch { return [] }
}

async function tailFile(file: string) {
  let stat
  try { stat = statSync(file) } catch { return }
  const prev = offsets.get(file) ?? 0
  if (stat.size === prev) return
  if (stat.size < prev) { offsets.set(file, 0); return tailFile(file) }
  const sessionId = file.split("/").slice(-2, -1)[0]!
  const fh = await open(file, "r")
  try {
    const len = stat.size - prev
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, prev)
    const text = buf.toString("utf8")
    const lastNl = text.lastIndexOf("\n")
    if (lastNl === -1) return
    const consume = text.slice(0, lastNl)
    for (const line of consume.split("\n")) {
      if (line) processLine(sessionId, line)
    }
    offsets.set(file, prev + Buffer.byteLength(consume, "utf8") + 1)
  } finally {
    await fh.close()
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────
type Aggregate = {
  byModel: Map<string, ModelUsage>
  byProject: Map<string, { sessions: number; requests: number; input: number; output: number; cacheRead: number; cost: number }>
  byDay:     Map<string, { sessions: number; requests: number; input: number; output: number; cacheRead: number; cost: number }>
  totals: { sessions: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number; premium: number; premiumCost: number }
}

function calcCost(model: string, u: ModelUsage): number {
  const p = MODEL_PRICING[model]
  if (!p) return 0
  return (
    (u.inputTokens      / 1_000_000) * p.input +
    (u.outputTokens     / 1_000_000) * p.output +
    (u.cacheReadTokens  / 1_000_000) * p.cache_read +
    (u.cacheWriteTokens / 1_000_000) * p.cache_write
  )
}

function aggregate(): Aggregate {
  const byModel = new Map<string, ModelUsage>()
  const byProject = new Map<string, any>()
  const byDay = new Map<string, any>()
  const totals = { sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, premium: 0, premiumCost: 0 }

  for (const s of sessions.values()) {
    totals.sessions++
    totals.premium      += s.premiumRequests
    totals.premiumCost  += s.premiumRequests * PREMIUM_REQUEST_COST
    const project = projectName(s.cwd, s.repository)
    const day = s.startedAt ? dayKey(s.startedAt) : "unknown"

    let sessReq = 0, sessIn = 0, sessOut = 0, sessCache = 0, sessCost = 0

    if (s.hasShutdown) {
      for (const [model, u] of s.models) {
        const cost = calcCost(model, u)
        const m = byModel.get(model) ?? { inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0, reasoningTokens:0, requests:0, cost:0 }
        m.inputTokens      += u.inputTokens
        m.outputTokens     += u.outputTokens
        m.cacheReadTokens  += u.cacheReadTokens
        m.cacheWriteTokens += u.cacheWriteTokens
        m.reasoningTokens  += u.reasoningTokens
        m.requests         += u.requests
        m.cost             += cost
        byModel.set(model, m)
        sessReq   += u.requests
        sessIn    += u.inputTokens
        sessOut   += u.outputTokens
        sessCache += u.cacheReadTokens
        sessCost  += cost
      }
    } else {
      for (const [model, out] of s.liveOutputByModel) {
        const reqs = s.liveRequestsByModel.get(model) ?? 0
        const u: ModelUsage = { inputTokens:0, outputTokens: out, cacheReadTokens:0, cacheWriteTokens:0, reasoningTokens:0, requests: reqs, cost: 0 }
        const cost = calcCost(model, u)
        const m = byModel.get(model) ?? { inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0, reasoningTokens:0, requests:0, cost:0 }
        m.outputTokens += out
        m.requests     += reqs
        m.cost         += cost
        byModel.set(model, m)
        sessReq  += reqs
        sessOut  += out
        sessCost += cost
      }
    }

    totals.requests += sessReq
    totals.input    += sessIn
    totals.output   += sessOut
    totals.cacheRead+= sessCache
    totals.cost     += sessCost
    for (const m of byModel.values()) {} // noop

    const accProject = byProject.get(project) ?? { sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 }
    accProject.sessions++
    accProject.requests  += sessReq
    accProject.input     += sessIn
    accProject.output    += sessOut
    accProject.cacheRead += sessCache
    accProject.cost      += sessCost
    byProject.set(project, accProject)

    const accDay = byDay.get(day) ?? { sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 }
    accDay.sessions++
    accDay.requests  += sessReq
    accDay.input     += sessIn
    accDay.output    += sessOut
    accDay.cacheRead += sessCache
    accDay.cost      += sessCost
    byDay.set(day, accDay)
  }

  // Recompute totals.cacheWrite/reasoning from byModel after aggregation pass
  totals.cacheWrite = 0
  totals.reasoning = 0
  for (const m of byModel.values()) { totals.cacheWrite += m.cacheWriteTokens; totals.reasoning += m.reasoningTokens }

  return { byModel, byProject, byDay, totals }
}

// ─── Formatting ─────────────────────────────────────────────────────────────
function fmtTokens(n: number): string {
  if (!n) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k"
  return n.toLocaleString("en-US")
}
function fmtCost(c: number): string {
  if (c <= 0) return "$0.00"
  if (c < 0.01) return "<$0.01"
  return "$" + c.toFixed(2)
}
function fmtNum(n: number): string { return n.toLocaleString("en-US") }
function pct(part: number, whole: number): string {
  if (!whole) return "-"
  return Math.round((part / whole) * 100) + "%"
}

// ─── Colors ────────────────────────────────────────────────────────────────
const C = {
  title:   "#00D9FF",
  border:  "#3B3B5A",
  header:  "#A6ADC8",
  label:   "#888888",
  text:    "#CDD6F4",
  num:     "#FFFFFF",
  model:   "#89B4FA",
  project: "#94E2D5",
  date:    "#FAB387",
  input:   "#A6E3A1",
  output:  "#F9E2AF",
  cache:   "#89DCEB",
  cost:    "#F5C2E7",
  total:   "#FFFFFF",
  ok:      "#A6E3A1",
  warn:    "#F38BA8",
  dim:     "#585B70",
}

// ─── TUI ────────────────────────────────────────────────────────────────────
const renderer = await createCliRenderer({ exitOnCtrlC: true })

const root = new BoxRenderable(renderer, {
  id: "root",
  width: "100%",
  height: "100%",
  flexDirection: "column",
  padding: 1,
})
renderer.root.add(root)

// header banner ────────────────────────────────────
const header = new BoxRenderable(renderer, { id: "header", flexDirection: "column" })
root.add(header)

const bannerTop = new TextRenderable(renderer, { id: "bn-top", content: "", fg: C.title })
const bannerMid = new TextRenderable(renderer, { id: "bn-mid", content: "", fg: C.title, attributes: 0b001 })
const bannerBot = new TextRenderable(renderer, { id: "bn-bot", content: "", fg: C.title })
const summaryLn = new TextRenderable(renderer, { id: "bn-sum", content: "", fg: C.label })
header.add(bannerTop); header.add(bannerMid); header.add(bannerBot); header.add(summaryLn)

const spacerH = new TextRenderable(renderer, { id: "sp-h", content: "" })
root.add(spacerH)

// dynamic sections ─────────────────────────────────
const sectionModel   = new BoxRenderable(renderer, { id: "sec-model",   flexDirection: "column" })
const spacerA        = new TextRenderable(renderer, { id: "sp-a",       content: "" })
const sectionProject = new BoxRenderable(renderer, { id: "sec-project", flexDirection: "column" })
const spacerB        = new TextRenderable(renderer, { id: "sp-b",       content: "" })
const sectionDay     = new BoxRenderable(renderer, { id: "sec-day",     flexDirection: "column" })
const spacerC        = new TextRenderable(renderer, { id: "sp-c",       content: "" })
const sectionPricing = new BoxRenderable(renderer, { id: "sec-pricing", flexDirection: "column" })

root.add(sectionModel)
root.add(spacerA)
root.add(sectionProject)
root.add(spacerB)
root.add(sectionDay)
root.add(spacerC)
root.add(sectionPricing)

const spacerF = new TextRenderable(renderer, { id: "sp-f", content: "" })
root.add(spacerF)

const footer = new TextRenderable(renderer, { id: "footer", content: "q / ctrl-c to quit", fg: C.dim })
root.add(footer)

// ─── Table renderer (returns line strings + per-line color hints) ──────────
type Cell = { text: string; fg?: string; alignRight?: boolean }
type Row  = Cell[]

// Visual width calculation (Unicode-aware, handles emoji VS16 and combining marks)
function isEastAsianWide(cp: number): boolean {
  // CJK Unified Ideographs
  if (cp >= 0x4E00 && cp <= 0x9FFF) return true
  // CJK Extension A
  if (cp >= 0x3400 && cp <= 0x4DBF) return true
  // CJK Extensions B-F
  if (cp >= 0x20000 && cp <= 0x2FA1F) return true
  // CJK Compatibility
  if (cp >= 0xF900 && cp <= 0xFAFF) return true
  // CJK Compatibility Forms
  if (cp >= 0xFE30 && cp <= 0xFE4F) return true
  // Hangul Syllables
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true
  // Hangul Jamo
  if (cp >= 0x1100 && cp <= 0x115F) return true
  if (cp >= 0x2329 && cp <= 0x232A) return true
  // Hangul Jamo Extended
  if (cp >= 0xA960 && cp <= 0xA97F) return true
  if (cp >= 0xD7B0 && cp <= 0xD7FF) return true
  // Fullwidth Forms
  if (cp >= 0xFF01 && cp <= 0xFF60) return true
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true
  // CJK Radicals, Symbols, Punctuation, Hiragana, Katakana
  if (cp >= 0x2E80 && cp <= 0x303E) return true
  if (cp >= 0x3040 && cp <= 0x31FF) return true
  // Enclosed CJK, Compatibility, Bopomofo, Yi
  if (cp >= 0x3200 && cp <= 0x4DCF) return true
  // Emoji ranges
  if (cp >= 0x1F300 && cp <= 0x1F9FF) return true
  if (cp >= 0x1F600 && cp <= 0x1F64F) return true
  if (cp >= 0x1F680 && cp <= 0x1F6FF) return true
  if (cp >= 0x2600 && cp <= 0x26FF) return true
  if (cp >= 0x2700 && cp <= 0x27BF) return true
  return false
}

function isCombiningMark(cp: number): boolean {
  if (cp >= 0x0300 && cp <= 0x036F) return true
  if (cp >= 0x1AB0 && cp <= 0x1AFF) return true
  if (cp >= 0x1DC0 && cp <= 0x1DFF) return true
  if (cp >= 0x20D0 && cp <= 0x20FF) return true
  if (cp >= 0xFE20 && cp <= 0xFE2F) return true
  return false
}

function stringWidth(str: string): number {
  const chars = Array.from(str)
  let width = 0
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    const cp = ch.codePointAt(0) ?? 0
    // VS16 (emoji presentation selector) makes preceding char 2-wide
    if (i + 1 < chars.length && chars[i + 1] === '\uFE0F') {
      width += 2
      i += 2
      continue
    }
    // Skip combining marks (zero width)
    if (isCombiningMark(cp)) {
      i += 1
      continue
    }
    // ANSI escape sequences (zero width)
    if (cp === 0x001B) {
      i += 1
      while (i < chars.length && !chars[i].match(/[A-Za-z]/)) i++
      i += 1
      continue
    }
    width += isEastAsianWide(cp) ? 2 : 1
    i += 1
  }
  return width
}

function padCell(text: string, width: number, alignRight: boolean = false): string {
  const len = stringWidth(text)
  if (len >= width) return text
  const pad = " ".repeat(width - len)
  return alignRight ? pad + text : text + pad
}

// ─── Pre-allocated table renderables ────────────────────────────────────────
type TableState = {
  lines: TextRenderable[]
  lineIndex: number
  widths: number[]
  innerWidth: number
  title: string
  headers: Cell[]
  rows: Row[]
  footerRow?: Row
  note?: { text: string; fg?: string }
}

const tables = new Map<BoxRenderable, TableState>()

function initTable(box: BoxRenderable, title: string, headers: Cell[]) {
  // Clear previous children
  const ids: string[] = []
  const children: Renderable[] = (box as any).getChildren?.() ?? (box as any)._children ?? []
  for (const c of children) ids.push((c as any).id)
  for (const id of ids) box.remove(id)

  const state: TableState = {
    lines: [],
    lineIndex: 0,
    widths: headers.map(() => 0),
    innerWidth: 0,
    title,
    headers,
    rows: [],
    footerRow: undefined,
    note: undefined,
  }
  tables.set(box, state)
  return state
}

function updateTableContent(box: BoxRenderable, headers: Cell[], rows: Row[], footerRow?: Row, note?: { text: string; fg?: string }) {
  let state = tables.get(box)
  if (!state) {
    state = initTable(box, "TABLE", headers)
  }

  state.headers = headers
  state.rows = rows
  state.footerRow = footerRow
  state.note = note

  const all: Row[] = [headers, ...rows]
  if (footerRow) all.push(footerRow)
  state.widths = headers.map((_, i) => Math.max(...all.map(r => stringWidth(r[i]?.text ?? ""))))
  state.innerWidth = state.widths.reduce((a, b) => a + b, 0) + 2 * (state.widths.length - 1) + 4

  // Ensure we have enough lines
  const neededLines = 3 + rows.length + (footerRow ? 2 : 0) + 1 + (note ? 1 : 0)
  while (state.lines.length < neededLines) {
    const line = new TextRenderable(renderer, { id: `${box.id}-line-${state.lines.length}`, content: "" })
    state.lines.push(line)
    box.add(line)
  }

  // Helper to pad content (using visual width)
  function padContent(content: string): string {
    const contentWidth = stringWidth(content)
    const padding = Math.max(0, state!.innerWidth - contentWidth)
    return content + " ".repeat(padding)
  }

  let li = 0

  // Top border with title
  const titleStr = ` ${state.title} `
  const titleStrWidth = stringWidth(titleStr)
  const topPad = state.innerWidth - titleStrWidth - 1
  state.lines[li].content = `┌─${titleStr}${"─".repeat(Math.max(0, topPad))}┐`
  state.lines[li].fg = C.border
  state.lines[li].attributes = 0
  li++

  // Header row
  const headerCells = headers.map((c, i) => padCell(c.text, state!.widths[i]!, c.alignRight ?? i > 0))
  const headerContent = "  " + headerCells.join("  ")
  state.lines[li].content = `│${padContent(headerContent)}│`
  state.lines[li].fg = C.header
  state.lines[li].attributes = 0b010
  li++

  // Header separator
  const sepContent = "  " + state.widths.map(w => "─".repeat(w)).join("  ") + "  "
  state.lines[li].content = `│${padContent(sepContent)}│`
  state.lines[li].fg = C.dim
  state.lines[li].attributes = 0
  li++

  // Data rows
  for (const row of rows) {
    const cells = row.map((c, i) => padCell(c.text, state!.widths[i]!, c.alignRight ?? i > 0))
    const content = "  " + cells.join("  ")
    state.lines[li].content = `│${padContent(content)}│`
    state.lines[li].fg = row[0]?.fg ?? C.text
    state.lines[li].attributes = 0
    li++
  }

  // Footer separator (if footer exists)
  if (footerRow) {
    state.lines[li].content = `│${padContent(sepContent)}│`
    state.lines[li].fg = C.dim
    state.lines[li].attributes = 0
    li++

    // Footer row
    const footerCells = footerRow.map((c, i) => padCell(c.text, state!.widths[i]!, c.alignRight ?? i > 0))
    const footerContent = "  " + footerCells.join("  ")
    state.lines[li].content = `│${padContent(footerContent)}│`
    state.lines[li].fg = C.total
    state.lines[li].attributes = 0b001
    li++
  }

  // Bottom border
  state.lines[li].content = `└${"─".repeat(state.innerWidth)}┘`
  state.lines[li].fg = C.border
  state.lines[li].attributes = 0
  li++

  // Note (if present)
  if (note) {
    state.lines[li].content = `  ${note.text}`
    state.lines[li].fg = note.fg ?? C.label
    state.lines[li].attributes = 0
    li++
  }

  // Clear remaining lines
  while (li < state.lines.length) {
    state.lines[li].content = ""
    li++
  }
}

// ─── Render ────────────────────────────────────────────────────────────────
function renderBanner(agg: Aggregate, fileCount: number) {
  const title = "COPILOT TOKEN USAGE & COST"
  const titleWidth = stringWidth(title)
  const inner = titleWidth + 10
  const padL = Math.floor((inner - titleWidth) / 2)
  const padR = inner - titleWidth - padL
  bannerTop.content = `╔${"═".repeat(inner)}╗`
  bannerMid.content = `║${" ".repeat(padL)}${title}${" ".repeat(padR)}║`
  bannerBot.content = `╚${"═".repeat(inner)}╝`
  const t = agg.totals
  summaryLn.content = `  Sessions: ${fmtNum(t.sessions)}  │  Files: ${fileCount}  │  API calls: ${fmtNum(t.requests)}  │  Premium: ${t.premium.toFixed(2)}  │  ${new Date().toLocaleTimeString()}`
}

function renderModelTable(agg: Aggregate) {
  const headers: Cell[] = [
    { text: "Model" }, { text: "Calls" }, { text: "Input" }, { text: "Cached" },
    { text: "Cache Wr" }, { text: "Output" }, { text: "Reason" }, { text: "Hit%" }, { text: "Cost" },
  ]
  const sorted = [...agg.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)
  const rows: Row[] = []
  let tCalls = 0, tIn = 0, tCache = 0, tCw = 0, tOut = 0, tReason = 0, tCost = 0
  for (const [model, u] of sorted) {
    tCalls += u.requests; tIn += u.inputTokens; tCache += u.cacheReadTokens
    tCw += u.cacheWriteTokens; tOut += u.outputTokens; tReason += u.reasoningTokens; tCost += u.cost
    rows.push([
      { text: model, fg: C.model },
      { text: fmtNum(u.requests) },
      { text: fmtTokens(u.inputTokens) },
      { text: fmtTokens(u.cacheReadTokens) },
      { text: fmtTokens(u.cacheWriteTokens) },
      { text: fmtTokens(u.outputTokens) },
      { text: fmtTokens(u.reasoningTokens) },
      { text: pct(u.cacheReadTokens, u.inputTokens + u.cacheReadTokens) },
      { text: fmtCost(u.cost) },
    ])
  }
  const footer: Row = [
    { text: "TOTAL" },
    { text: fmtNum(tCalls) },
    { text: fmtTokens(tIn) },
    { text: fmtTokens(tCache) },
    { text: fmtTokens(tCw) },
    { text: fmtTokens(tOut) },
    { text: fmtTokens(tReason) },
    { text: pct(tCache, tIn + tCache) },
    { text: fmtCost(tCost) },
  ]
  const note = agg.totals.premium > 0
    ? { text: `Premium-request cost: ${fmtCost(agg.totals.premiumCost)} (${agg.totals.premium.toFixed(2)} req @ ${fmtCost(PREMIUM_REQUEST_COST)})`, fg: C.warn }
    : undefined
  updateTableContent(sectionModel, headers, rows.length ? rows : [[
    { text: "(no data)", fg: C.dim }, ...Array(headers.length - 1).fill({ text: "" }),
  ]], rows.length ? footer : undefined, note)
}

function renderProjectTable(agg: Aggregate) {
  const headers: Cell[] = [
    { text: "Project" }, { text: "Sessions" }, { text: "Calls" },
    { text: "Input" }, { text: "Cached" }, { text: "Output" }, { text: "Cost" },
  ]
  const sorted = [...agg.byProject.entries()].sort((a, b) => b[1].cost - a[1].cost)
  const rows: Row[] = sorted.map(([p, v]) => ([
    { text: p, fg: C.project },
    { text: fmtNum(v.sessions) },
    { text: fmtNum(v.requests) },
    { text: fmtTokens(v.input) },
    { text: fmtTokens(v.cacheRead) },
    { text: fmtTokens(v.output) },
    { text: fmtCost(v.cost) },
  ]))
  updateTableContent(sectionProject, headers, rows.length ? rows : [[
    { text: "(no data)", fg: C.dim }, ...Array(headers.length - 1).fill({ text: "" }),
  ]])
}

function renderDayTable(agg: Aggregate) {
  const headers: Cell[] = [
    { text: "Date" }, { text: "Sessions" }, { text: "Calls" },
    { text: "Input" }, { text: "Cached" }, { text: "Output" }, { text: "Cost" },
  ]
  const sorted = [...agg.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const rows: Row[] = sorted.map(([day, v]) => ([
    { text: day, fg: C.date },
    { text: fmtNum(v.sessions) },
    { text: fmtNum(v.requests) },
    { text: fmtTokens(v.input) },
    { text: fmtTokens(v.cacheRead) },
    { text: fmtTokens(v.output) },
    { text: fmtCost(v.cost) },
  ]))
  updateTableContent(sectionDay, headers, rows.length ? rows : [[
    { text: "(no data)", fg: C.dim }, ...Array(headers.length - 1).fill({ text: "" }),
  ]])
}

function renderPricingTable(agg: Aggregate) {
  const headers: Cell[] = [
    { text: "Model" }, { text: "Input/1M" }, { text: "Output/1M" },
    { text: "Cache Rd/1M" }, { text: "Cache Wr/1M" },
  ]
  const used = [...agg.byModel.keys()].sort()
  const rows: Row[] = used.map((model) => {
    const p = MODEL_PRICING[model]
    return p ? [
      { text: model, fg: C.model },
      { text: `$${p.input.toFixed(2)}` },
      { text: `$${p.output.toFixed(2)}` },
      { text: `$${p.cache_read.toFixed(3)}` },
      { text: `$${p.cache_write.toFixed(2)}` },
    ] : [
      { text: model, fg: C.model },
      { text: "N/A" }, { text: "N/A" }, { text: "N/A" }, { text: "N/A" },
    ]
  })
  updateTableContent(sectionPricing, headers,
    rows.length ? rows : [[{ text: "(no data)", fg: C.dim }, ...Array(headers.length - 1).fill({ text: "" })]],
    undefined,
    { text: "Estimated API-equivalent cost. Copilot subscriptions include token usage.", fg: C.dim },
  )
}

// Initialize table states (pre-allocate renderables)
initTable(sectionModel, "PER-MODEL SUMMARY", [
  { text: "Model" }, { text: "Calls" }, { text: "Input" }, { text: "Cached" },
  { text: "Cache Wr" }, { text: "Output" }, { text: "Reason" }, { text: "Hit%" }, { text: "Cost" },
])
initTable(sectionProject, "PER-PROJECT BREAKDOWN", [
  { text: "Project" }, { text: "Sessions" }, { text: "Calls" },
  { text: "Input" }, { text: "Cached" }, { text: "Output" }, { text: "Cost" },
])
initTable(sectionDay, "DAILY BREAKDOWN", [
  { text: "Date" }, { text: "Sessions" }, { text: "Calls" },
  { text: "Input" }, { text: "Cached" }, { text: "Output" }, { text: "Cost" },
])
initTable(sectionPricing, "PRICING REFERENCE", [
  { text: "Model" }, { text: "Input/1M" }, { text: "Output/1M" },
  { text: "Cache Rd/1M" }, { text: "Cache Wr/1M" },
])

function render() {
  const agg = aggregate()
  renderBanner(agg, listSessionFiles().length)
  renderModelTable(agg)
  renderProjectTable(agg)
  renderDayTable(agg)
  renderPricingTable(agg)
}

// ─── Watchers ──────────────────────────────────────────────────────────────
async function refresh() {
  const files = listSessionFiles()
  for (const f of files) {
    if (!fileWatchers.has(f)) {
      try {
        const w = watch(f, { persistent: true }, () => { void tailFile(f).then(render) })
        fileWatchers.set(f, w)
      } catch {}
    }
    await tailFile(f)
  }
  render()
}

try {
  watch(ROOT, { persistent: true }, () => { void refresh() })
} catch {}

await refresh()
const tick = setInterval(() => { void refresh() }, 1000)

let exiting = false
function shutdown() {
  if (exiting) return
  exiting = true
  clearInterval(tick)
  for (const w of fileWatchers.values()) { try { w.close() } catch {} }
  process.exit(0)
}
process.on("SIGINT",  shutdown)
process.on("SIGTERM", shutdown)
renderer.keyInput?.on?.("keypress", (key: any) => {
  if (key?.name === "q") shutdown()
})
