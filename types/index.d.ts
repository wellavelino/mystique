export type Cell = string | null

/** One captured table as the panel lists it; its rows are kept apart, by id. */
export type DataTable = {
  id: string
  title: string
  source: string
  format: string
  columns: string[]
  rowCount: number
  isTruncated: boolean
}

/** What the panel shows: which tab, which table, how many rows, from which column, which record. */
export type View = {
  tab: 'tables' | 'agents'
  tableId: string | null
  shown: number
  column: number
  row: number | null
}

/** What the second reader marked in one reply: the reply's lines, as fingerprints, and the phrases. */
export type Reading = {
  lines: number[]
  phrases: string[]
}

/** One task of a list Claude keeps while it works. */
export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** What it reads as while in progress ("Running tests"). */
  active?: string
}

/** One subagent as the progress band follows it. */
export type AgentRow = {
  id: string
  label: string
  type: string
  status: 'running' | 'done' | 'failed'
  /** Tool calls it made, and the last one's name. */
  tools: number
  last: string
  /** Tokens its context held at its last model request. */
  context: number
  /** What it has spent so far, in input-token equivalents. */
  used: number
  tasks: Task[]
  /** When it was first heard of and when it ended, in milliseconds of the session's clock. */
  startedAt: number
  endedAt?: number
}

/** What the progress band draws: the goal, the main thread's tasks and use, and each subagent's. */
export type Board = {
  /** The goal set with /goal, when one is. */
  goal: string | null
  /** The prompt the turn in progress answers. */
  ask: string
  tasks: Task[]
  agents: AgentRow[]
  context: number
  window: number
  used: number
  /** All the session spent, the agents that left the board included. */
  total: number
  limits: { kind: string; percent: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    mystique: {
      tables: DataTable[]
      rows: StateFamily<Cell[][]>
      view: View
      pens: string[]
      readings: Reading[]
      board: Board
      /** The frame the panel's moving marks are drawn at; it counts on only while something moves. */
      frame: number
      isDismissed: boolean
    }
  }
}
