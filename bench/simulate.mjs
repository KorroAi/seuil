// What would Seuil have saved you? Replays your own recorded Claude Code sessions with automatic compaction
// at several thresholds, and prints the saving as a share of their real cost. Read-only: no session is changed,
// nothing is sent anywhere.
//   node bench/simulate.mjs [days=30]           reads ~/.claude/projects (sessions changed in the last N days)
//   node bench/simulate.mjs --calls calls.json  replays calls extracted earlier (--save calls.json writes them)
//
// Cost unit: 1 = the price of one input token. Cache read 0.1, cache write 1 h 2, 5 min 1.25, output 5:
// Anthropic's usual price ratios; check the official pricing page, the saving moves if they change.
//
// A simulated compaction:
//  - happens only at a turn boundary (the first call after a message from the person), as Seuil does;
//  - costs the summarizer reading the whole context (from cache, or at full price after a pause of more than
//    an hour, once the cache has expired), writing the summary,
//    and writing what remains back to cache;
//  - brings the context back to the median size really observed after a compaction in your sessions,
//    plus "forgetting": tokens re-read afterwards because the summary dropped them (0, 20 k, 50 k).
// Every real call is then replayed with the lighter context: what was removed is no longer read or written.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)

  return i === -1 ? undefined : args[i + 1]
}
const DAYS = Number(args.find(a => /^\d+$/.test(a)) ?? 30)
const PRICE = { read: 0.1, write1h: 2, write5m: 1.25, input: 1, output: 5 }
const HOUR = 3600000
const median = list => (list.length === 0 ? 0 : [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)])

/** Each call: [time, input, cache read, cache write 1 h, cache write 5 min, output, opens a turn]. */
const extract = async () => {
  const root = join(homedir(), '.claude', 'projects')
  const since = Date.now() - DAYS * 86400000
  const sessions = []

  if (!existsSync(root)) throw new Error(`No recorded sessions found in ${root}.`)

  for (const project of readdirSync(root)) {
    let names

    try {
      names = readdirSync(join(root, project))
    } catch {
      continue
    }

    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue

      const path = join(root, project, name)
      const stat = statSync(path)

      if (stat.mtimeMs < since || stat.size < 200000) continue

      const seen = new Set()
      const calls = []
      let turn = true

      for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"')
        // A real message from the person is short; heavy lines are tool results.
        const isMessage = !isAssistant && line.length < 40000 && line.includes('"type":"user"') && !line.includes('"tool_result"')

        if (!isAssistant && !isMessage) continue

        let o

        try {
          o = JSON.parse(line)
        } catch {
          continue
        }

        if (o.isSidechain) continue

        if (o.type === 'user') {
          if (!o.isMeta) turn = true

          continue
        }

        const u = o.message?.usage
        const id = o.message?.id

        if (o.type !== 'assistant' || !u || !id || seen.has(id)) continue

        seen.add(id)

        const read = u.cache_read_input_tokens ?? 0
        const write = u.cache_creation_input_tokens ?? 0
        const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0

        if (read + write + (u.input_tokens ?? 0) === 0) continue

        calls.push([Date.parse(o.timestamp) || 0, u.input_tokens ?? 0, read, write1h, Math.max(0, write - write1h), u.output_tokens ?? 0, turn ? 1 : 0])
        turn = false
      }

      // Projects are numbered, never named: the output can be shared as it is.
      if (calls.length >= 5) sessions.push({ project, calls })
    }
  }

  return sessions
}

const loaded = flag('--calls')
// Files written by the first, French version of this script (outils/extraire.mjs) read the same.
const sessions = loaded
  ? JSON.parse(readFileSync(loaded, 'utf8')).sessions.map(s => ({ project: s.project ?? s.projet, calls: s.calls ?? s.appels }))
  : await extract()

if (flag('--save')) writeFileSync(flag('--save'), JSON.stringify({ days: DAYS, extractedAt: new Date().toISOString(), sessions }))

if (sessions.length === 0) {
  console.log('No session large enough to replay (at least 200 KB of transcript and 5 model calls).')
  process.exit(0)
}

const size = a => a[1] + a[2] + a[3] + a[4]
const cost = a => PRICE.input * a[1] + PRICE.read * a[2] + PRICE.write1h * a[3] + PRICE.write5m * a[4] + PRICE.output * a[5]

const firsts = []
const afters = []
let total = 0

for (const s of sessions) {
  firsts.push(size(s.calls[0]))
  s.cost = s.calls.reduce((n, a) => n + cost(a), 0)
  s.max = s.calls.reduce((n, a) => Math.max(n, size(a)), 0)
  s.start = s.calls[0][0]
  total += s.cost

  // A real compaction shows up as the context dropping by more than 40 % from one call to the next.
  s.calls.forEach((a, i) => {
    if (i > 0 && size(a) < size(s.calls[i - 1]) * 0.6) afters.push(size(a))
  })
}

const FIRST = median(firsts)
// With no compaction in your history, assume the context comes back to 90 k (the median seen in the paper's data).
const AFTER = afters.length > 0 ? median(afters) : 90000
const FRESH = Math.max(5000, AFTER - FIRST) // the summary and the messages kept

/** Replays one session with automatic compaction at `threshold`. */
const replay = (s, { threshold, forgetting }) => {
  let context = size(s.calls[0])
  let simulated = 0
  let compactions = 0

  s.calls.forEach((a, i) => {
    if (i > 0) {
      const before = s.calls[i - 1]
      const fires = a[6] === 1 && context >= threshold && context > (AFTER + forgetting) * 1.3
      // After a pause of more than an hour the cache has expired: the summarizer reads the context at full price.
      const cold = a[0] - before[0] > HOUR

      if (fires) {
        simulated += (cold ? PRICE.input : PRICE.read) * context + PRICE.output * Math.min(FRESH, 10000) + PRICE.write1h * (FRESH + forgetting)
        context = AFTER + forgetting
        compactions += 1
      }

      context = size(a) < size(before) * 0.6 ? Math.min(context, size(a)) : Math.min(size(a), context + (size(a) - size(before)))
    }

    const removed = Math.max(0, size(a) - context)
    const read = Math.min(a[2], removed)
    const written = Math.min(a[3] + a[4], removed - read)
    const writePrice = a[3] + a[4] > 0 ? (PRICE.write1h * a[3] + PRICE.write5m * a[4]) / (a[3] + a[4]) : PRICE.write1h

    simulated += cost(a) - PRICE.read * read - writePrice * written
  })

  return { cost: simulated, compactions }
}

const run = policy => {
  let simulated = 0
  let compactions = 0
  const gains = []

  for (const s of sessions) {
    const r = replay(s, policy)

    simulated += r.cost
    compactions += r.compactions
    gains.push({ s, gain: 1 - r.cost / s.cost })
  }

  return { gain: 1 - simulated / total, compactions, gains }
}

const pc = x => `${(100 * x).toFixed(1).padStart(5)} %`
const calls = sessions.reduce((n, s) => n + s.calls.length, 0)
const out = []
const say = t => out.push(t)

say(`Seuil bench: ${sessions.length} sessions, ${calls} model calls${loaded ? '' : ` (last ${DAYS} days)`}.`)
say(`Real cost: ${(total / 1e6).toFixed(0)} M input-token equivalents. First call of a session: ${Math.round(FIRST / 1000)} k (median); after a compaction: ${Math.round(AFTER / 1000)} k (${afters.length} seen).`)
say('')
say('Saving, as a share of the real cost ("forgetting" = tokens re-read after each compaction):')
say('   threshold   forget 0    forget 20 k   forget 50 k   compactions')

for (const threshold of [120000, 150000, 180000, 200000, 220000, 250000, 300000, 400000]) {
  const c = [0, 20000, 50000].map(forgetting => run({ threshold, forgetting }))

  say(`   ${String(threshold / 1000).padStart(5)} k    ${c.map(x => pc(x.gain)).join('       ')}       ${c[0].compactions}`)
}

const ref = run({ threshold: 300000, forgetting: 20000 })
const sorted = [...ref.gains].sort((a, b) => a.gain - b.gain)

say('')
say('At 300 k (the default) with 20 k forgetting:')
say(`   per session: worst ${pc(sorted[0].gain).trim()}, median ${pc(sorted[Math.floor(sorted.length / 2)].gain).trim()}, best ${pc(sorted.at(-1).gain).trim()}; ${ref.gains.filter(g => g.gain < 0).length} of ${sessions.length} sessions lose, ${ref.gains.filter(g => g.gain > 0.1).length} gain more than 10 %.`)

for (const [name, keep] of [['sessions that stay under 300 k', s => s.max <= 300000], ['sessions that go over 300 k', s => s.max > 300000]]) {
  const part = ref.gains.filter(g => keep(g.s))
  const real = part.reduce((n, g) => n + g.s.cost, 0)

  say(`   ${name}: ${pc(real === 0 ? 0 : part.reduce((n, g) => n + g.gain * g.s.cost, 0) / real).trim()} saved (${part.length} sessions, ${pc(real / total).trim()} of the cost)`)
}

const middle = median(sessions.map(s => s.start))

for (const [name, keep] of [['first half of the period', s => s.start < middle], ['second half', s => s.start >= middle]]) {
  const part = ref.gains.filter(g => keep(g.s))
  const real = part.reduce((n, g) => n + g.s.cost, 0)

  say(`   ${name}: ${pc(real === 0 ? 0 : part.reduce((n, g) => n + g.gain * g.s.cost, 0) / real).trim()} saved (${part.length} sessions)`)
}

const projects = {}

for (const g of ref.gains) {
  const p = (projects[g.s.project] ??= { real: 0, saved: 0, n: 0 })

  p.real += g.s.cost
  p.saved += g.gain * g.s.cost
  p.n += 1
}

say('   per project (largest first, unnamed):')
Object.values(projects)
  .sort((a, b) => b.real - a.real)
  .slice(0, 8)
  .forEach((p, i) => say(`     project ${i + 1}: ${pc(p.saved / p.real).trim()} saved (${p.n} session${p.n === 1 ? '' : 's'}, ${pc(p.real / total).trim()} of the cost)`))

say('')
say('A simulation, not a measurement: it assumes the work goes on the same after a compaction. See paper/PAPER.md.')
console.log(out.join('\n'))
