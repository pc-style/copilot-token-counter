import { createCliRenderer, TextRenderable, BoxRenderable, RGBA } from "@opentui/core"
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const ROOT = join(homedir(), ".copilot", "session-state")

type Totals = { input: number; output: number; cacheRead: number; reasoning: number; sessions: number }

// Per-file streaming offsets so we only parse new bytes on each tick (realtime tail).
const offsets = new Map<string, number>()
// Per-session aggregated state. We hold them separately so a session.shutdown can replace
// the running per-message running output count for that session without double-counting.
type SessionState = {
  hasShutdown: boolean
  shutdownInput: number
  shutdownOutput: number
  shutdownCacheRead: number
  shutdownReasoning: number
  liveOutput: number
}
const sessions = new Map<string, SessionState>()

function ensureSession(id: string): SessionState {
  let s = sessions.get(id)
  if (!s) {
    s = { hasShutdown: false, shutdownInput: 0, shutdownOutput: 0, shutdownCacheRead: 0, shutdownReasoning: 0, liveOutput: 0 }
    sessions.set(id, s)
  }
  return s
}

function listSessionFiles(): string[] {
  try {
    return readdirSync(ROOT)
      .map((d) => join(ROOT, d, "events.jsonl"))
      .filter((p) => {
        try { return statSync(p).isFile() } catch { return false }
      })
  } catch {
    return []
  }
}

function processLine(sessionId: string, line: string) {
  if (!line) return
  let data: any
  try { data = JSON.parse(line) } catch { return }
  const type = data?.type
  const d = data?.data
  if (!d) return

  const state = ensureSession(sessionId)

  if (type === "session.shutdown") {
    const metrics = d.modelMetrics ?? {}
    let input = 0, output = 0, cache = 0, reasoning = 0
    for (const m of Object.values<any>(metrics)) {
      const u = m?.usage ?? {}
      input     += u.inputTokens     ?? 0
      output    += u.outputTokens    ?? 0
      cache     += u.cacheReadTokens ?? 0
      reasoning += u.reasoningTokens ?? 0
    }
    state.hasShutdown      = true
    state.shutdownInput    = input
    state.shutdownOutput   = output
    state.shutdownCacheRead= cache
    state.shutdownReasoning= reasoning
  } else if (type === "assistant.message") {
    if (typeof d.outputTokens === "number") state.liveOutput += d.outputTokens
  }
}

async function tail(file: string) {
  let stat
  try { stat = statSync(file) } catch { return }
  const prev = offsets.get(file) ?? 0
  if (stat.size <= prev) {
    offsets.set(file, stat.size)
    return
  }
  const sessionId = file.split("/").slice(-2, -1)[0]!
  const fh = await open(file, "r")
  try {
    const len = stat.size - prev
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, prev)
    const text = buf.toString("utf8")
    // Carry partial-line at end: only parse complete newline-terminated lines.
    const lastNl = text.lastIndexOf("\n")
    const consume = lastNl === -1 ? "" : text.slice(0, lastNl)
    if (consume) {
      for (const line of consume.split("\n")) {
        if (line) processLine(sessionId, line)
      }
      offsets.set(file, prev + Buffer.byteLength(consume, "utf8") + 1)
    }
  } finally {
    await fh.close()
  }
}

function totals(): Totals {
  let input = 0, output = 0, cacheRead = 0, reasoning = 0
  for (const s of sessions.values()) {
    if (s.hasShutdown) {
      input     += s.shutdownInput
      output    += s.shutdownOutput
      cacheRead += s.shutdownCacheRead
      reasoning += s.shutdownReasoning
    } else {
      output += s.liveOutput
    }
  }
  return { input, output, cacheRead, reasoning, sessions: sessions.size }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

// ---------- TUI ----------
const renderer = await createCliRenderer({ exitOnCtrlC: true })

const root = new BoxRenderable(renderer, {
  id: "root",
  width: "100%",
  height: "100%",
  flexDirection: "column",
  padding: 1,
})
renderer.root.add(root)

const title = new TextRenderable(renderer, {
  id: "title",
  content: "copilot token counter",
  fg: "#00D9FF",
  attributes: 0b001,
})
root.add(title)

const sub = new TextRenderable(renderer, {
  id: "sub",
  content: ROOT,
  fg: "#666666",
})
root.add(sub)

const spacer = new TextRenderable(renderer, { id: "sp1", content: "" })
root.add(spacer)

const inputLine = new TextRenderable(renderer, { id: "in",  content: "input    : 0", fg: "#A6E3A1" })
const outputLine= new TextRenderable(renderer, { id: "out", content: "output   : 0", fg: "#F9E2AF" })
const cacheLine = new TextRenderable(renderer, { id: "ch",  content: "cache rd : 0", fg: "#89B4FA" })
const reasonLine= new TextRenderable(renderer, { id: "rs",  content: "reasoning: 0", fg: "#CBA6F7" })
const totalLine = new TextRenderable(renderer, { id: "tot", content: "total    : 0", fg: "#FFFFFF", attributes: 0b001 })
const sessLine  = new TextRenderable(renderer, { id: "ses", content: "sessions : 0", fg: "#888888" })

root.add(inputLine)
root.add(outputLine)
root.add(cacheLine)
root.add(reasonLine)
root.add(totalLine)
root.add(sessLine)

const spacer2 = new TextRenderable(renderer, { id: "sp2", content: "" })
root.add(spacer2)

const status = new TextRenderable(renderer, {
  id: "status",
  content: "watching… (q/ctrl-c to exit)",
  fg: "#555555",
})
root.add(status)

function render() {
  const t = totals()
  inputLine.content  = `input    : ${fmt(t.input)}`
  outputLine.content = `output   : ${fmt(t.output)}`
  cacheLine.content  = `cache rd : ${fmt(t.cacheRead)}`
  reasonLine.content = `reasoning: ${fmt(t.reasoning)}`
  totalLine.content  = `total    : ${fmt(t.input + t.output)}`
  sessLine.content   = `sessions : ${fmt(t.sessions)}`
  status.content     = `watching ${listSessionFiles().length} session file(s) — updated ${new Date().toLocaleTimeString()}`
}

// ---------- Watching ----------
const dirWatchers = new Map<string, FSWatcher>()

async function refresh() {
  const files = listSessionFiles()
  for (const f of files) {
    if (!dirWatchers.has(f)) {
      try {
        const w = watch(f, { persistent: true }, () => { void tail(f).then(render) })
        dirWatchers.set(f, w)
      } catch {}
    }
    await tail(f)
  }
  render()
}

// Watch the parent dir to pick up new sessions.
try {
  watch(ROOT, { persistent: true }, () => { void refresh() })
} catch {}

await refresh()
// Periodic safety net (some FS events don't fire reliably for appends).
const tick = setInterval(() => { void refresh() }, 1000)

let exiting = false
function shutdown() {
  if (exiting) return
  exiting = true
  clearInterval(tick)
  for (const w of dirWatchers.values()) { try { w.close() } catch {} }
  process.exit(0)
}
process.on("SIGINT",  shutdown)
process.on("SIGTERM", shutdown)
renderer.keyInput?.on?.("keypress", (key: any) => {
  if (key?.name === "q") shutdown()
})
