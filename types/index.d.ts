/** The last compaction of this session, as the mod saw it. */
export type Compaction = {
  /** When, in milliseconds. */
  at: number
  /** Why: the threshold reached, the person's request, or "other" for a compaction the mod did not start. */
  reason: 'threshold' | 'requested' | 'other'
  /** Size of the conversation before, in tokens. */
  before: number
  /** Size after, measured by the mod at the end of the next turn (the engine's figure leaves out the system prompt). */
  after?: number
  /** Size after as the engine announced it (system prompt and tools left out): a floor, known at once. */
  engineAfter?: number
}

declare module 'claude-code' {
  interface PluginState {
    seuil: {
      compaction: Shaped<Compaction | null>
      /** The line shown under the prompt. */
      line: Shaped<string | null>
    }
  }
}
