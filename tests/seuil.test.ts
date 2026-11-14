import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
const TYPED = { command: 'seuil', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

/**
 * A fake engine: a conversation of `tokens`, that every compaction brings back to 90 k in all.
 * Like the real one, it announces a size after that leaves out the system prompt (20 k): the mod must not trust it.
 */
const world = (on: On, tokens: number, window = 1000000) => {
  const state = {
    tokens,
    window,
    compactions: 0,
    instructions: '',
    refuse: false,
    busy: 0, // how many times the engine still answers "a turn is running"
    broken: false, // the engine can no longer tell the conversation's size
    store: {} as Record<string, unknown>,
    status: [] as (string | undefined)[],
    toasts: [] as string[],
    logs: [] as string[],
  }

  on('command.register', () => ({ value: { command: 'seuil' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__seuil__diagnostic' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: state.store[e.key] }))
  on('store.set', (_, e) => {
    state.store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    state.status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    state.logs.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => {
    if (state.broken) {
      throw new Error('usage unavailable')
    }

    return {
      value: { startedAt: 0, context: { tokens: state.tokens, window: state.window, percent: 0 }, rateLimits: [] },
    }
  })
  on('session.compact', (_, e) => {
    if (state.busy > 0) {
      state.busy -= 1

      throw new Error('a turn is running')
    }

    if (state.refuse) {
      return { skip: 'refused by another hook' }
    }

    const before = state.tokens

    state.compactions += 1
    state.instructions = e.instructions ?? ''
    state.tokens = 90000

    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: before, tokensAfter: 20000 }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return state
}

test('below the threshold nothing moves; above it, the conversation is compacted after the turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 150000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(0)
  expect(state.status.at(-1)).toBe('Seuil · 150 k / 300 k')

  state.tokens = 331000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect(state.instructions).toContain('Every decision, preference and correction the user gave')
  expect(state.store.compactions).toBe(1)
  expect(state.toasts.at(-1)).toBe('Seuil: compacted a 331 k conversation (threshold reached).')
  // the trace stays in the transcript
  expect(state.logs).toEqual(['Seuil: compacted a 331 k conversation (threshold reached).'])
  expect(state.status.at(-1)).toBe('Seuil · 90 k / 300 k · last compaction 331 k')

  // at the next turn, the real size is measured (not the engine's figure); no new compaction
  state.tokens = 120000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect(state.store.removed).toBe(211000)
  expect(state.status.at(-1)).toBe('Seuil · 120 k / 300 k · last compaction 331 k → 120 k')
})

test('an aborted turn or a subagent triggers nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 400000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  await $.turn.complete({ ...TURN, agentId: 'a1' })
  await clock.advance(10)
  expect(state.compactions).toBe(0)
})

test('while a turn is still running the compaction is retried, then dropped cleanly', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 300000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // two refusals from the engine, then it goes through on the third attempt
  state.busy = 2
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(0)
  await clock.advance(2000)
  expect(state.compactions).toBe(0)
  await clock.advance(2000)
  expect(state.compactions).toBe(1)

  // the size read still dates from before the compaction: this turn end's check is skipped
  state.tokens = 300000
  state.busy = 99
  await $.turn.complete(TURN)
  await clock.advance(70000)
  expect(state.busy).toBe(99)

  // a new turn runs for more than a minute: thirty attempts, then the mod stays quiet until the next turn end
  await $.turn.complete(TURN)
  await clock.advance(70000)
  expect(state.compactions).toBe(1)
  expect(state.busy).toBe(69)
  expect(state.toasts.at(-1)).toContain('compacted')

  // on request, the failure is said
  expect((await $.command.run({ ...TYPED, args: 'now' })).text).toContain('Compaction scheduled')
  await clock.advance(70000)
  expect(state.busy).toBe(39)
  expect(state.toasts.at(-1)).toContain('Seuil: could not compact (')
  expect(state.logs.at(-1)).toContain('Seuil: could not compact (')
})

test('refusal, switching off and commands', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 300000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // another hook refuses the compaction: nothing is counted
  state.refuse = true
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.tokens).toBe(300000)
  expect(state.store.compactions).toBeUndefined()
  expect(state.toasts.at(-1)).toBe('Seuil: compaction refused (refused by another hook).')
  state.refuse = false

  expect((await $.command.run({ ...TYPED, args: 'off' })).text).toBe('Seuil is off: no more automatic compaction.')
  expect(state.status.at(-1)).toBe('Seuil · off')
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(0)

  expect((await $.command.run({ ...TYPED, args: 'on' })).text).toBe('Seuil is on.')
  expect((await $.command.run({ ...TYPED, args: '50' })).text).toBe('Threshold set to 100 k (minimum 100 k).')
  expect((await $.command.run({ ...TYPED, args: '350' })).text).toBe('Threshold set to 350 k.')
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(0)

  // on request: the command hands back, the compaction starts afterwards
  expect((await $.command.run({ ...TYPED, args: 'now' })).text).toBe('Compaction scheduled: it starts as soon as this turn is handed back.')
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect(state.toasts.at(-1)).toBe('Seuil: compacted a 300 k conversation (on request).')

  const right = (await $.command.run({ ...TYPED, args: '' })).text ?? ''

  expect(right).toContain('Seuil is on: automatic compaction between two turns above 350 k.')
  expect(right).toContain('Last compaction: 300 k.')
  expect(right).toContain('Since install: 1 compaction, 0 k removed')

  // after the next turn, the real size is known and the total removed counted
  await $.turn.complete(TURN)
  await clock.advance(10)

  const then = (await $.command.run({ ...TYPED, args: '' })).text ?? ''

  expect(then).toContain('Last compaction: 300 k → 90 k.')
  expect(then).toContain('Since install: 1 compaction, 210 k removed')
  expect((await $.command.run({ ...TYPED, args: 'whatever' })).text).toContain('Usage: /seuil')
})

test('two turn ends close together make one compaction, and a failed reading breaks nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 300000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // the engine can no longer give the size: the mod stays quiet, the turn ends normally
  state.broken = true
  expect((await $.turn.complete(TURN)).text).toBe('done')
  await clock.advance(10)
  expect(state.compactions).toBe(0)
  state.broken = false

  // two turn ends back to back, before the timer has run
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect(state.store.compactions).toBe(1)

  // damaged settings in the store: back to the defaults
  state.store.settings = { threshold: 'lots', enabled: 'yes' }
  expect((await $.command.run({ ...TYPED, args: '' })).text).toContain('above 300 k.')
})

test('settings and totals saved by version 0.1 are carried over', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 260000)

  state.store.reglage = { seuil: 250000, actif: true }
  state.store.compactions = 4
  state.store.retires = 800000

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(state.status.at(-1)).toBe('Seuil · 260 k / 250 k')
  expect((await $.command.run({ ...TYPED, args: '' })).text).toContain('Since install: 4 compactions, 800 k removed')

  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)

  state.tokens = 100000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.store.compactions).toBe(5)
  expect(state.store.removed).toBe(960000)

  // a setting written now goes under the new name
  await $.command.run({ ...TYPED, args: 'off' })
  expect(state.store.settings).toEqual({ threshold: 250000, enabled: false })
})

test('on a smaller context window the threshold drops to 75 % of it', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 140000, 200000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(state.status.at(-1)).toBe('Seuil · 140 k / 150 k')
  expect((await $.command.run({ ...TYPED, args: '' })).text).toContain("above 150 k (300 k set, lowered to 75 % of this model's window)")

  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(0)

  state.tokens = 152000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect((await $.tool.call({ tool: 'mcp__seuil__diagnostic' })).result).toContain('threshold 300 k (150 k on this window)')
})

test('the diagnostic tool tells the real state and can request a compaction', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 412000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const seen = await $.tool.call({ tool: 'mcp__seuil__diagnostic' })

  expect(seen.result).toContain('conversation: 412 k tokens, window of 1000 k (read from the engine)')
  expect(seen.result).toContain('settings: threshold 300 k, on')
  expect(seen.result).toContain('over the threshold: yes, compaction at the end of the turn')
  expect(seen.result).toContain('last compaction this session: none')
  expect(state.compactions).toBe(0)

  // the turn runs for four more seconds, then the requested compaction goes through
  state.busy = 2
  expect((await $.tool.call({ tool: 'mcp__seuil__diagnostic', compact: true })).result).toContain('compaction requested')
  await clock.advance(10)
  expect(state.compactions).toBe(0)
  await clock.advance(4000)
  expect(state.compactions).toBe(1)
  expect((await $.tool.call({ tool: 'mcp__seuil__diagnostic' })).result).toContain('last compaction this session: 412 k (requested)')
})

test('in a headless session the compaction goes through the /compact command', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 300000)
  let ran = ''

  on('command.run', (_, e) => {
    ran = `${e.command} ${e.args}`

    return { text: 'Compacted' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await $.turn.complete(TURN)
  await clock.advance(10)

  expect(ran.startsWith("compact Write the summary in the conversation's own language.")).toBe(true)
  expect(ran).not.toContain('\n')
  // the engine's direct compaction was not called
  expect(state.compactions).toBe(0)
  expect(state.store.compactions).toBe(1)
  expect(state.logs.at(-1)).toBe('Seuil: compacted a 300 k conversation (threshold reached).')

  // the end of the /compact turn: the engine does not know the new size yet (it returns 0), nothing is started or recorded
  ran = ''
  state.tokens = 0
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(ran).toBe('')

  // the next turn brings a fresh reading: the real size is recorded
  state.tokens = 95000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(ran).toBe('')
  expect(state.store.removed).toBe(205000)
})

test('a compaction from elsewhere is recorded, and does not trigger another one', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = world(on, 500000)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // the person types /compact: the engine compacts, the mod sees it go through
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'everything', toolUses: [] }] })
  expect(state.compactions).toBe(1)
  expect(state.store.compactions).toBeUndefined()
  expect(state.toasts).toHaveLength(0)

  // the size read is still the old one at the end of the next turn: no second compaction
  state.tokens = 500000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)

  // then the check resumes, from the real size after
  state.tokens = 100000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(1)
  expect(state.store.removed).toBeUndefined()
  state.tokens = 340000
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(state.compactions).toBe(2)
  expect(state.store.compactions).toBe(1)
})
