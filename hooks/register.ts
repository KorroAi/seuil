import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Compaction } from '../types'

// Seuil ("threshold" in French). Every model call re-reads the whole conversation, so a long session pays
// mostly for re-reading. This mod compacts the conversation on its own, between two turns, once it grows past
// a threshold. It never compacts in the middle of a turn and touches nothing else.
//
// The default comes from a replay of 144 real sessions (paper/PAPER.md): between 150 k and 250 k the saving is
// the same within a point (about 33 % of the cost); at 300 k it is about 3 points lower, for 40 % fewer
// compactions, so less detail is lost along the way. Compacting when the cache has expired after a pause was
// measured too: on top of the threshold it adds nothing, so it is not here.

type Settings = { threshold: number; enabled: boolean }
/** A compaction the mod starts itself. */
type Wanted = 'threshold' | 'requested'

const DEFAULTS: Settings = { threshold: 300000, enabled: true }
const MIN_THRESHOLD = 100000
// Never wait for the window to be nearly full: on a smaller window the threshold drops to this share of it.
const WINDOW_SHARE = 0.75
// One compaction must not trigger the next: the conversation has to grow back by at least half first.
const REGROWTH = 1.5
// ...but only after a compaction that could not bring the conversation well under the threshold (a summary still
// too big). A compaction that worked never blocks the next one: the threshold alone decides again.
const SHRUNK = 0.8
// What the engine's size after leaves out (system prompt, tools): added before comparing it to the threshold.
const OVERHEAD = 40000
// The engine refuses to compact while a turn is still running: retry for a minute.
const ATTEMPTS = 30
const RETRY_MS = 2000

// What the summary must keep. The summary itself follows the conversation's language.
const INSTRUCTIONS = [
  "Write the summary in the conversation's own language. Keep, in this order:",
  '1. The goal and the request in progress, in the user\'s own words when recent.',
  '2. Every decision, preference and correction the user gave, quoted. Never drop one.',
  '3. The exact state of the work: what is done and verified, what is done but unverified, what failed and why.',
  '4. The files in play, each with its full path and its role.',
  '5. What remains to do, in order.',
  '6. Pitfalls met and the commands that proved useful.',
  'Drop tool outputs, images, and the detail of abandoned attempts.',
].join('\n')

const USAGE = '/seuil · /seuil 250 (threshold, in thousands of tokens) · /seuil now · /seuil off · /seuil on'

const compaction = atom({ plugin: 'seuil', key: 'compaction' } as const, null, { shape: 'compaction-2' })
// The line shown under the prompt. Kept in state: the terminal redraws its hint line as soon as it changes.
const line = atom({ plugin: 'seuil', key: 'line' } as const, null, { shape: 'line-1' })

let running = false
let scheduled = false
// A compaction the mod asked for through /compact, waiting to be seen going through.
let expected: { reason: Wanted; before: number } | undefined
// After a compaction: how many turn ends may still pass before a fresh size reading arrives.
let toMeasure = 0
// The size read just before the last compaction: an equal reading still dates from before it.
let readBefore = 0
// Headless session: known at start, or learned from the engine's first refusal.
let headless = false
// On the terminal the line goes at the end of the hint line under the prompt. The plugin status line would draw it
// as a warning ("⚠seuil: Seuil · …", seen in a real run), so it serves only the other surfaces.
let terminal = false
// While a turn of the main conversation runs: refreshes the line.
let ticker: { cancel: () => void } | undefined
const TICK_MS = 2000

/** 98 k, 1.2 M. */
const k = (tokens: number) => {
  if (tokens < 999500) {
    return `${Math.round(tokens / 1000)} k`
  }

  const millions = tokens / 1000000

  return `${millions >= 9.95 ? Math.round(millions) : Number(millions.toFixed(1))} M`
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readSettings = async ($: EngineInterface): Promise<Settings> => {
  const stored = (await $.store.get('settings').catch(() => undefined)) as Partial<Settings> | undefined
  // Version 0.1 kept its settings under French names: carry them over once.
  const legacy = stored === undefined ? ((await $.store.get('reglage').catch(() => undefined)) as { seuil?: unknown; actif?: unknown } | undefined) : undefined
  const threshold = stored?.threshold ?? legacy?.seuil
  const enabled = stored?.enabled ?? legacy?.actif

  return {
    threshold: typeof threshold === 'number' && Number.isFinite(threshold) ? Math.max(MIN_THRESHOLD, threshold) : DEFAULTS.threshold,
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULTS.enabled,
  }
}

const readCounter = async ($: EngineInterface, key: 'compactions' | 'removed') => {
  const value = Number((await $.store.get(key)) ?? (key === 'removed' ? await $.store.get('retires') : undefined) ?? 0)

  return Number.isFinite(value) ? value : 0
}

const usage = async ($: EngineInterface) => {
  const { context } = await $.session.usage()

  return { tokens: context.tokens ?? 0, window: context.window }
}

const size = async ($: EngineInterface) => (await usage($)).tokens

/** The threshold that applies now: the setting, lowered on a context window too small to reach it. */
const effective = (settings: Settings, window: number | undefined) =>
  typeof window === 'number' && window > 0 ? Math.min(settings.threshold, Math.floor(window * WINDOW_SHARE)) : settings.threshold

const describe = (last: Compaction | null) =>
  last === null || last.before === 0 ? undefined : `${k(last.before)}${last.after === undefined ? '' : ` → ${k(last.after)}`}`

/** Shows `text` under the prompt: in the hint line on the terminal, as the plugin's status line elsewhere. */
const display = async ($: EngineInterface, text: string) => {
  if ((await read($, line)) !== text) {
    await update($, line, () => text)
  }

  if (!terminal) {
    $.ui.status(text)
  }
}

const show = async ($: EngineInterface) => {
  const settings = await readSettings($)

  if (!settings.enabled) {
    await display($, 'Seuil off')

    return
  }

  const now = await usage($).catch(() => ({ tokens: 0, window: undefined }))
  const threshold = k(effective(settings, now.window))
  const last = describe(await read($, compaction))

  // Before the first answer (of the session, or after a compaction) the engine does not know the size yet: it reads 0.
  await display(
    $,
    now.tokens === 0
      ? `Seuil · ${last === undefined ? '' : `last compaction ${last} · `}compacts at ${threshold}`
      : `Seuil · ${k(now.tokens)} / ${threshold}${last === undefined ? '' : ` · last compaction ${last}`}`,
  )
}

/** Records a compaction: the session's state, and for the mod's own ones the counters and the message. */
const record = async ($: EngineInterface, reason: Compaction['reason'], before: number, engineAfter?: number): Promise<string> => {
  // The size after is not taken from the engine: its figure leaves out the system prompt and tools (seen in a
  // real run). It is measured at the end of the next turn, once a real answer has refreshed it. The engine's
  // figure is kept anyway: when that next turn is long, the conversation has already grown back by its end.
  const entry: Compaction = { at: await $.clock.now(), reason, before, ...(typeof engineAfter === 'number' && engineAfter > 0 ? { engineAfter } : {}) }

  await update($, compaction, () => entry)
  toMeasure = 2

  if (reason === 'other') {
    readBefore = before

    return ''
  }

  await $.store.set('compactions', (await readCounter($, 'compactions')) + 1)

  const what = `compacted a ${k(before)} conversation (${reason === 'threshold' ? 'threshold reached' : 'on request'}).`

  // The terminal heads a toast with the plugin's name and starts a transcript line with "seuil: ": neither repeats it.
  $.ui.toast(capital(what), { timeoutMs: 10000 })
  // A line in the transcript too: the trace stays once the toast is gone.
  $.ui.log(what)

  return `Seuil: ${what}`
}

/**
 * Compacts through the /compact command, which opens its own turn. The only road in a headless session
 * (-p mode, an SDK host), where the engine does not offer direct compaction yet.
 */
const viaCommand = async ($: EngineInterface, reason: Wanted, before: number): Promise<string> => {
  expected = { reason, before }
  await $.command.run({ command: 'compact', args: INSTRUCTIONS.replace(/\s*\n\s*/g, ' ') })

  // The `session.compact` hook recorded it on the way; otherwise record it here, without the size after.
  if (expected === undefined) {
    return 'Seuil: compacted through /compact.'
  }

  expected = undefined

  return record($, reason, before)
}

/** Compacts now. Returns a line to show; throws when the engine refuses (a turn is still running). */
const compact = async ($: EngineInterface, reason: Wanted): Promise<string> => {
  if (running) {
    return 'A compaction is already running.'
  }

  running = true

  try {
    const before = await size($)

    readBefore = before
    await display($, `Seuil · compacting ${k(before)}…`)

    if (headless) {
      return await viaCommand($, reason, before)
    }

    let done

    try {
      done = await $.session.compact({ instructions: INSTRUCTIONS })
    } catch (error) {
      // The engine says itself that the session is headless (message seen in a real run): switch roads.
      if (!/headless/i.test(message(error))) {
        throw error
      }

      headless = true

      return await viaCommand($, reason, before)
    }

    if (done.skip !== undefined) {
      const refused = `Compaction refused (${done.skip}).`

      $.ui.toast(refused)

      return `Seuil: ${refused}`
    }

    return await record($, reason, done.tokensBefore ?? before, done.tokensAfter)
  } finally {
    running = false
    await show($).catch(() => undefined)
  }
}

/**
 * True when the conversation has grown back enough since the last compaction to deserve another.
 * 15/11/2026, bug seen in a real session: the size after a /compact was read at the end of the next turn, a long
 * autonomous one; the conversation had grown from about 100 k back to 288 k meanwhile. The mod took 288 k for the
 * result of the compaction and waited for 432 k (288 k × 1.5) while the threshold was 300 k. Now the guard holds only
 * when the compaction itself left the conversation too big: an "after" larger than the "before" is not a result, and
 * the engine's own figure (plus what it leaves out) shows whether the compaction worked.
 */
const regrown = async ($: EngineInterface, tokens: number, threshold: number) => {
  const last = await read($, compaction)

  if (last?.after === undefined) {
    return true
  }

  const result = Math.min(last.after, last.engineAfter === undefined ? Infinity : last.engineAfter + OVERHEAD)

  if (last.after >= last.before || result < threshold * SHRUNK) {
    return true
  }

  return tokens >= last.after * REGROWTH
}

/** True when the automatic compaction should start now. Checked again right before compacting. */
const over = async ($: EngineInterface) => {
  const settings = await readSettings($)
  const now = await usage($)

  const threshold = effective(settings, now.window)

  return settings.enabled && now.tokens >= threshold && (await regrown($, now.tokens, threshold))
}

/** Starts a compaction outside any hook, and retries it while a turn is still running. */
const launch = ($: EngineInterface, reason: Wanted, attempt = 1) => {
  // One scheduled compaction at a time: two turn ends close together do not make two.
  if (attempt === 1 && scheduled) {
    return
  }

  scheduled = true
  $.clock.after(attempt === 1 ? 0 : RETRY_MS, () => {
    // At the threshold, check again at the last moment: the conversation may have been compacted meanwhile.
    const go = async () => (reason === 'requested' || (await over($)) ? compact($, reason) : undefined)

    void go().then(
      () => {
        scheduled = false
      },
      error => {
        $.ui.log(`Seuil: attempt ${attempt} refused (${message(error)})`, { to: 'debug' })

        if (attempt < ATTEMPTS) {
          launch($, reason, attempt + 1)

          return
        }

        scheduled = false

        // At the threshold, stay quiet: a new turn has started, and the check runs again when it ends.
        if (reason === 'requested') {
          const failed = `could not compact (${message(error)})`

          $.ui.toast(capital(failed), { timeoutMs: 10000 })
          $.ui.log(failed)
        }
      },
    )
  })
}

/**
 * After a compaction: records the real size of the conversation as soon as a fresh reading arrives.
 * Returns true while the reading still dates from before: this turn end's check is then skipped.
 */
const measure = async ($: EngineInterface): Promise<boolean> => {
  if (toMeasure === 0) {
    return false
  }

  toMeasure -= 1

  const last = await read($, compaction)
  const mark = readBefore > 0 ? readBefore : (last?.before ?? 0)

  if (last === null || mark === 0) {
    toMeasure = 0

    return false
  }

  const tokens = await size($)

  // Not fresh yet: the engine does not know the compacted size before its first answer (it returns 0, seen in
  // a real run), or it still returns the size from before.
  if (tokens === 0 || Math.abs(tokens - mark) <= mark * 0.02) {
    return toMeasure > 0
  }

  toMeasure = 0
  await update($, compaction, () => ({ ...last, after: tokens }))

  if (last.reason !== 'other') {
    await $.store.set('removed', (await readCounter($, 'removed')) + Math.max(0, last.before - tokens))
  }

  return false
}

/** Turn end: starts a compaction when the threshold is reached. */
const afterTurn = async ($: EngineInterface) => {
  if (await measure($)) {
    await show($)

    return
  }

  if (await over($)) {
    launch($, 'threshold')

    return
  }

  await show($)
}

/** The real state, for the model: what the engine says about the conversation, and what the mod will do. */
const diagnostic = async ($: EngineInterface, compactNow: boolean): Promise<string> => {
  const settings = await readSettings($)
  const now = await usage($)
  const last = await read($, compaction)
  const done = await readCounter($, 'compactions')
  const removed = await readCounter($, 'removed')
  const applies = effective(settings, now.window)
  const lines = [
    `conversation: ${k(now.tokens)} tokens, window of ${k(now.window)} (read from the engine)`,
    `settings: threshold ${k(settings.threshold)}${applies < settings.threshold ? ` (${k(applies)} on this window)` : ''}, ${settings.enabled ? 'on' : 'off'}`,
    `over the threshold: ${(await over($)) ? 'yes, compaction at the end of the turn' : 'no'}`,
    `last compaction this session: ${last === null ? 'none' : `${describe(last) ?? k(last.before)} (${last.reason})`}`,
    `since install: ${count(done, 'compaction')}, ${k(removed)} removed`,
  ]

  if (compactNow) {
    launch($, 'requested')
    lines.push('compaction requested: it starts as soon as the turn is handed back (retried for a minute)')
  }

  return lines.join('\n')
}

const command = async ($: EngineInterface, args: string): Promise<string> => {
  const word = args.trim().toLowerCase()
  const settings = await readSettings($)

  if (word === 'off' || word === 'on') {
    await $.store.set('settings', { ...settings, enabled: word === 'on' })
    await show($)

    return word === 'on' ? `On: compacts between turns above ${k(settings.threshold)}.` : 'Off: no automatic compaction until /seuil on.'
  }

  if (word === 'now' || word === 'maintenant') {
    // Not from the command itself: the engine refuses to compact under the turn the command holds.
    launch($, 'requested')

    return 'Compaction scheduled: it starts as soon as this turn ends.'
  }

  if (/^\d+$/.test(word)) {
    const threshold = Math.max(MIN_THRESHOLD, Number(word) * 1000)

    await $.store.set('settings', { ...settings, threshold })
    await show($)

    return `Threshold set to ${k(threshold)}${threshold !== Number(word) * 1000 ? ' (the minimum)' : ''}.`
  }

  if (word !== '') {
    return `Usage: ${USAGE}`
  }

  const now = await usage($).catch(() => ({ tokens: 0, window: undefined }))
  const applies = effective(settings, now.window)
  const done = await readCounter($, 'compactions')
  const removed = await readCounter($, 'removed')
  const last = await read($, compaction)

  return [
    settings.enabled
      ? `On: compacts between turns above ${k(applies)}${applies < settings.threshold ? ` (${k(settings.threshold)} set, lowered to ${Math.round(WINDOW_SHARE * 100)} % of this model's window)` : ''}.`
      : 'Off: no automatic compaction until /seuil on.',
    `Conversation now: ${now.tokens === 0 ? 'not measured yet (it is after the first answer)' : k(now.tokens)}.`,
    last === null ? 'No compaction in this session yet.' : `Last compaction: ${describe(last) ?? k(last.before)}.`,
    `Since install: ${count(done, 'compaction')}, ${k(removed)} tokens taken out, each of which would have been re-read on every later call.`,
    `Commands: ${USAGE}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'seuil',
      description: 'Automatic compaction: status, /seuil 250 (threshold in thousands of tokens), /seuil now, /seuil off',
    })

    await $.tool.register({
      name: 'diagnostic',
      description:
        "Real state of the Seuil mod: conversation size read from the engine, threshold, compactions done. With compact=true, requests a compaction that starts as soon as the turn is handed back (only when the user asks for one).",
      inputSchema: {
        type: 'object',
        properties: { compact: { type: 'boolean', description: 'Request a compaction at the end of the turn.' } },
      },
    })

    headless = e.isInteractive === false
    terminal = e.surface === 'terminal'

    const started = await next(e)

    await show($).catch(() => undefined)

    return started
  })

  on('command.run', { command: 'seuil' }, async ($, e) => ({ text: await command($, e.args) }))

  // The terminal's hint line under the prompt ("? for shortcuts"), with the line added at its end, dim.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = e.surface === 'terminal' ? await read($, line).catch(() => null) : null

    return next(text === null ? e : { ...e, props: { ...e.props, tail: text } })
  })

  on('tool.call', { tool: 'mcp__seuil__diagnostic' }, async ($, e) => {
    const input = e as unknown as { compact?: unknown }

    return { result: await diagnostic($, input.compact === true).catch(error => `Seuil: diagnostic unavailable (${message(error)})`) }
  })

  // Every compaction of the main conversation is recorded, whether it comes from the mod, from /compact or from
  // the engine: the mod knows where it starts again from, and does not start another one right away.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)

    if (done.skip === undefined && e.agentId === undefined && e.trigger !== 'precompute') {
      const wanted = expected

      expected = undefined
      await record($, wanted?.reason ?? 'other', done.tokensBefore ?? wanted?.before ?? 0, done.tokensAfter).catch(() => undefined)
    }

    return done
  })

  // During a turn the line follows the conversation as it grows: a long agentic turn can go far past the threshold
  // before it ends, and the person sees it happen.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)

    if (e.agentId === undefined && ticker === undefined) {
      ticker = $.clock.every(TICK_MS, () => {
        if (!running && toMeasure === 0) {
          void show($).catch(() => undefined)
        }
      })
    }

    return started
  })

  // The turn end does not wait: the compaction starts on a timer, outside this hook.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      ticker?.cancel()
      ticker = undefined
    }

    if (e.agentId === undefined && !e.isAborted) {
      void afterTurn($).catch(() => undefined)
    }

    return done
  })
}
