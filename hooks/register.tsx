import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, DataTable, Task, View } from '../types'
import {
  aimed,
  asked,
  bar,
  cleared,
  compact,
  elapsed,
  EMPTY,
  ended,
  hasWork,
  isAsk,
  isLive,
  named,
  nearby,
  progress,
  pulse,
  reconciled,
  share,
  spinner,
  stepped,
  summary,
  sweep,
  tasked,
  TASKS_TOOL,
  tooled,
} from './lib/board'
import type { Usage } from './lib/board'
import { clip, fitColumns, isNumeric, NULL, shown } from './lib/grid'
import { INSTRUCTION, layout, MAX_PENS, penPieces } from './lib/marks'
import type { Line, Segment } from './lib/marks'
import {
  counted,
  digestText,
  fingerprints,
  forkPrompt,
  NO_CALLS,
  parseReview,
  phrasesFor,
  REVIEW_SYSTEM,
  reviewRequest,
} from './lib/review'
import { describeCommand, isDatabaseTool, parseTables } from './lib/tables'
import type { ParsedTable } from './lib/tables'

const PANE = 'mystique'
const PAGE = 20
const LEAP = 100
// The rows drawn at once: past it the page slides, so a long result never outgrows a drawing.
const WINDOW = 100
const MAX_TABLES = 10
const MAX_RECORD = 50_000
const START: View = { tab: 'tables', tableId: null, shown: PAGE, column: 0, row: null }
const MAX_READINGS = 40
const MIN_REVIEWED_REPLY = 200
const MAX_AGENT_ROWS = 6
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])
// What moves in the panel moves four times a second, and each task's own bar is this wide.
const TICK = 250
const TASK_BAR = 10
// The task rows one drawing holds: a longer list shows the stretch around the task in progress.
const MAX_TASK_ROWS = 60

const tables = atom({ plugin: 'mystique', key: 'tables' } as const, [])
const view = atom({ plugin: 'mystique', key: 'view' } as const, START)
const pens = atom({ plugin: 'mystique', key: 'pens' } as const, [])
const readings = atom({ plugin: 'mystique', key: 'readings' } as const, [])
const board = atom({ plugin: 'mystique', key: 'board' } as const, EMPTY)
const frame = atom({ plugin: 'mystique', key: 'frame' } as const, 0)
const isDismissed = atom({ plugin: 'mystique', key: 'isDismissed' } as const, false)
const ROWS = { plugin: 'mystique', key: 'rows' } as const

// Highlighter inks: bright enough to read as a pen, dark text on each.
const INKS: Record<string, string> = {
  yellow: '#ffe95c',
  green: '#8dfc8d',
  pink: '#ff9fd6',
  blue: '#8fd6ff',
  orange: '#ffbb66',
}
const INK_TEXT = '#141414'

const OWN_TASKS = new RegExp(`^${TASKS_TOOL}$`)

// The task tool the model is given where Claude Code has none of its own, as the model reads it.
const TASKS_SPEC = {
  name: 'tasks',
  description:
    'Keeps the task list the person watches in their progress panel. Use it for work of three or more steps: call it once with every step "pending", then again whenever a step starts ("in_progress", one at a time) or is finished ("completed"). Always send the whole list. Do not use it for single-step work, or to report results.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Every task of the list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The task, as an instruction: "Run the tests".' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'The task while it runs: "Running the tests".' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isDeferred: false,
}

type Captured = { title: string; source: string; table: ParsedTable }

// The next frame of the panel's moving marks, once asked for, and when.
let pending: { timer: { cancel: () => void }; at: number } | null = null
// Whether the task list is being read for the board: a call of the mod's own, not the assistant's.
let isRefreshing = false

/** Reads the engine's own task list onto the board, where the session has the tool for it. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    if (!(await $.tool.list()).some(tool => tool.name === 'TaskList')) {
      return
    }

    isRefreshing = true
    const ran = await $.tool.call({ tool: 'TaskList' })

    if (ran.deny === undefined && ran.isError !== true) {
      await update($, board, held => ({ ...held, tasks: tasked(held.tasks, 'TaskList', {}, ran.result) }))
    }
  } catch {
    // Without the list the board shows what it heard of.
  } finally {
    isRefreshing = false
  }
}

/**
 * Opens the panel on `tab`, unless the person closed it by hand. A panel already open keeps the
 * tab they are on unless `isTaking`: a result they asked for takes it, an agent starting does not.
 */
async function reveal($: EngineInterface, tab: View['tab'], isTaking: boolean): Promise<boolean> {
  if (await read($, isDismissed)) {
    return false
  }

  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isTaking || !isOpen) {
    await update($, view, held => ({ ...held, tab }))
  }

  return (await $.ui.open({ id: PANE, title: 'mystique', columns: 72 })).isPlaced
}

/**
 * Keeps what was captured and shows the newest when asked to, opening the panel for it where
 * the panel opens by itself (`isAuto`).
 */
async function keep(
  $: EngineInterface,
  found: readonly Captured[],
  isShown: boolean,
  isAuto: boolean,
): Promise<void> {
  const stamp = await $.clock.now()
  const entries: DataTable[] = []

  for (const { title, source, table } of found) {
    const id = `${stamp}-${entries.length}-${Math.random().toString(36).slice(2, 8)}`
    await $.state.set({ ...ROWS, id }, table.rows)
    entries.push({
      id,
      title,
      source,
      format: table.format,
      columns: table.columns,
      rowCount: table.rows.length,
      isTruncated: table.isTruncated,
    })
  }

  const newest = entries.at(-1)

  if (newest === undefined) {
    return
  }

  const inView = isShown ? null : (await read($, view)).tableId
  let dropped: DataTable[] = []
  await update($, tables, list => {
    const all = [...list, ...entries]
    // The oldest go first, the one on screen never.
    dropped = all.filter(table => table.id !== inView).slice(0, Math.max(0, all.length - MAX_TABLES))

    return all.filter(table => !dropped.includes(table))
  })

  for (const old of dropped) {
    await $.state.set({ ...ROWS, id: old.id }, [])
  }

  await update($, view, held =>
    isShown || held.tableId === null ? { ...START, tab: held.tab, tableId: newest.id } : held,
  )

  if (!isShown) {
    return
  }

  // Closed by hand, the panel stays closed: the person hears of the table and opens it.
  if (!isAuto || !(await reveal($, 'tables', true))) {
    $.ui.toast(`Table captured: ${newest.title} (${newest.rowCount} rows). /tables shows it.`)
  }
}

/** Books one answered model request on the board: its context and cost, and a new agent's name. */
async function track(
  $: EngineInterface,
  agentId: string | undefined,
  usage: Usage,
  isAuto: boolean,
): Promise<void> {
  const now = await $.clock.now()

  if (agentId === undefined) {
    const { context, rateLimits } = await $.session.usage()
    const limits = rateLimits.map(limit => ({ kind: limit.kind, percent: limit.percentUsed }))

    await update($, board, held => {
      const booked = stepped(held, undefined, usage, now)

      return { ...booked, context: context.tokens ?? booked.context, window: context.window, limits }
    })

    return
  }

  await update($, board, held => stepped(held, agentId, usage, now))
  const row = (await read($, board)).agents.find(agent => agent.id === agentId)

  if (row?.label === '') {
    const info = (await $.agent.list()).find(agent => agent.id === agentId)
    const label = info?.name || info?.description || info?.type || 'agent'

    await update($, board, held => named(held, agentId, label, info?.type ?? ''))

    // A new agent is worth showing; one already on the board is not news.
    if (isAuto) {
      await reveal($, 'agents', false)
    }
  }
}

/** Ends the rows of the agents the engine no longer runs: one whose end the mod never heard of. */
async function settle($: EngineInterface): Promise<void> {
  try {
    const live = (await $.agent.list())
      .filter(agent => agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'killed')
      .map(agent => agent.id)
    const now = await $.clock.now()

    await update($, board, held => reconciled(held, live, now))
  } catch {
    // Without the engine's list the rows stay as they are.
  }
}

/**
 * Asks a second reader what in the turn's reply must not be missed, highlights those phrases,
 * and says what the reply left out. `session` asks a fork of the session itself, which has the
 * whole transcript before it; any other mode asks `model`, which sees the reply and a digest.
 */
async function review(
  $: EngineInterface,
  mode: string,
  model: string,
  answer: string,
  digest: string,
): Promise<void> {
  try {
    // Where nothing draws the reply, nobody would see what the reader has to say.
    if ((await $.session.surfaces()).length === 0) {
      return
    }

    const held = await read($, board)
    const reply =
      mode === 'session'
        ? await $.model.fork({ prompt: forkPrompt(answer) })
        : await $.model.complete({
            model,
            system: REVIEW_SYSTEM,
            prompt: reviewRequest(held.goal ?? held.ask, answer, digest),
            maxTokens: 500,
            effort: 'low',
            timeoutMs: 30_000,
          })

    if (!reply.isAnswered) {
      return
    }

    const found = parseReview(reply.text, answer)

    if (found.phrases.length > 0) {
      const reading = { lines: fingerprints(answer), phrases: found.phrases }

      await update($, readings, list => [...list, reading].slice(-MAX_READINGS))
    }

    if (found.missed !== '') {
      $.ui.log(`Second reader: ${found.missed}`)
    }
  } catch {
    // A review that fails costs the person nothing but the review.
  }
}

export const register: Register = (on, options) => {
  const mode = String(options.highlight ?? 'reader')
  const hasMarks = mode === 'claude' || mode === 'both'
  const hasReader = mode === 'reader' || mode === 'both'
  const hasBold = mode === 'bold' || mode === 'both'
  const ink = INKS[String(options.color ?? 'yellow')] ?? '#ffe95c'
  const capture = String(options.capture ?? 'databases')
  const hasBand = String(options.band ?? 'on') !== 'off'
  const isAuto = String(options.panel ?? 'auto') !== 'manual'
  const hasTasks = String(options.tasks ?? 'auto') !== 'off'
  const reader = String(options.reader ?? 'fast')
  const readerModel = String(options.readerModel ?? 'haiku') || 'haiku'
  // The tool calls since the person last asked, for a reader that cannot see them.
  let digest = NO_CALLS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tables',
      description: 'Open the data panel with the tables mystique captured (clear: forget them)',
      argumentHint: '[clear]',
    })
    await $.command.register({
      name: 'progress',
      description: 'Open the panel on the goal, the tasks and every subagent (clear: forget the tasks and agents)',
      argumentHint: '[clear]',
    })
    await $.command.register({
      name: 'highlight',
      description: 'Highlight the text you selected, or a phrase you type (clear: remove your marks)',
      argumentHint: '[phrase | clear]',
    })

    // A session whose model has no task list tool gets the mod's own, so there is a list to show.
    if (hasTasks) {
      try {
        const hasOwn = (await $.tool.list()).some(tool => tool.name === 'TodoWrite' || tool.name === 'TaskCreate')

        if (!hasOwn) {
          await $.tool.register(TASKS_SPEC)
        }
      } catch {
        return next(e)
      }
    }

    return next(e)
  })

  // The mod's own tool is in no table of tools the types know: it is matched by its name's pattern.
  // It only keeps a list for the person to watch, so it needs no asking; a rule against it stands.
  on('tool.check', { tool: OWN_TASKS }, async ($, e, next) => {
    const decided = await next(e)

    return decided.decision === 'ask' ? { ...decided, decision: 'allow' } : decided
  })

  on('tool.call', { tool: OWN_TASKS }, async ($, e) => {
    const given: { todos?: unknown; agentId?: string } = e

    if (!Array.isArray(given.todos)) {
      const text = 'Send the whole list as "todos": an array of { content, status, activeForm }.'

      return { result: text, text, isError: true }
    }

    const now = await $.clock.now()
    let kept: Task[] = []

    await update($, board, held => {
      const booked = tooled(held, e.agentId, TASKS_TOOL, e, {}, now)
      kept = e.agentId === undefined ? booked.tasks : (booked.agents.find(agent => agent.id === e.agentId)?.tasks ?? [])

      return booked
    })

    const { done, total, current } = progress(kept)
    const text = `Task list kept: ${done} of ${total} done${current === '' ? '' : `, now: ${current}`}.`

    // A tool served as an MCP one answers in text.
    return { result: text, text }
  })

  // The highlighter -----------------------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    // Where nothing draws the reply (a headless run), the marks would reach a reader raw.
    if (!hasMarks || e.surfaces.length === 0) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'mystique:highlight', text: INSTRUCTION, scope: 'session' },
      ],
    }
  })

  on('command.run', { command: 'highlight' }, async ($, e) => {
    const asked = e.args.trim()

    if (asked === 'clear') {
      await update($, pens, () => [])
      await update($, readings, () => [])

      return { text: 'The highlights are removed.' }
    }

    const selected = asked === '' ? ((await $.ui.selection())?.text ?? '') : asked
    const pieces = penPieces(selected)

    if (pieces.length === 0) {
      return {
        text: 'Nothing to highlight: select text in the transcript with the mouse first, or type the phrase after /highlight.',
      }
    }

    await update($, pens, list => [...new Set([...list, ...pieces])].slice(-MAX_PENS))

    return { text: `Highlighted: ${pieces.join(' / ')}` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) {
      return next(e)
    }

    // The person's pens mark every reply; a reader's phrases only the reply it read.
    const whole = phrasesFor(await read($, readings), e.props.text)
    const laid = layout(e.props.text, { hasMarks, hasBold, pens: await read($, pens), whole })

    if (laid.kind === 'plain') {
      return laid.text === e.props.text
        ? next(e)
        : next({ ...e, props: { ...e.props, text: laid.text } })
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const run = (segment: Segment) =>
      segment.isHighlighted === true ? (
        <Text
          backgroundColor={ink}
          color={INK_TEXT}
          bold={segment.isBold}
          italic={segment.isItalic}
          strikethrough={segment.isStruck}
        >
          {segment.text}
        </Text>
      ) : (
        <Text
          color={segment.isCode === true ? 'permission' : undefined}
          bold={segment.isBold}
          italic={segment.isItalic}
          dimColor={segment.isDim}
          strikethrough={segment.isStruck}
          underline={segment.href === undefined ? undefined : true}
        >
          {segment.text}
        </Text>
      )
    const row = (line: Line) => (
      <Box flexDirection="row">
        {line.prefix !== '' && (
          <Box flexShrink={0}>
            <Text dimColor={line.prefix.startsWith('▎')}>{line.prefix}</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">{line.segments.map(run)}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="text">{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
          {laid.blocks.map(block =>
            block.kind === 'markdown' ? (
              <Markdown text={block.text} />
            ) : (
              <Box flexDirection="column">{block.lines.map(row)}</Box>
            ),
          )}
        </Box>
      </Box>
    )
  })

  // The second reader ---------------------------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId

    try {
      if (agentId !== undefined) {
        const now = await $.clock.now()

        await update($, board, held => ended(held, agentId, e.reason === 'answer' ? 'done' : 'failed', now))
      } else if (hasReader && e.reason === 'answer' && e.answer.length >= MIN_REVIEWED_REPLY) {
        const answer = e.answer
        const said = digestText(digest)

        // On a timer, so the turn ends now and the review lands when it is ready.
        $.clock.after(10, () => {
          void review($, reader, readerModel, answer, said)
        })
      }
    } catch {
      return done
    }

    return done
  })

  // The progress band ---------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    // A turn the engine starts (an agent reporting back) carries on the same piece of work.
    if (isAsk(e.text)) {
      digest = NO_CALLS
    }

    try {
      if (isAsk(e.text) && (await read($, board)).agents.some(agent => agent.status === 'running')) {
        await settle($)
      }

      await update($, board, held => asked(held, e.text))
    } catch {
      return next(e)
    }

    return next(e)
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    // Claude Code's own /goal: the band only reads what it was given.
    const ran = await next(e)

    try {
      await update($, board, held => aimed(held, e.args))
    } catch {
      return ran
    }

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    try {
      if (response.usage !== null) {
        await track($, e.agentId, response.usage, isAuto)
      }
    } catch {
      return response
    }

    return response
  })

  if (hasBand) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const held = await read($, board)

      if (e.props.hasSurvey || !hasWork(held)) {
        return next(e)
      }

      const { Box, Text } = $.ui.resolve(e)
      const isWide = e.props.bodyColumns >= 100
      const heat = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')
      const meter = (fraction: number, width: number, color: string) => {
        const drawn = bar(fraction, width)

        return (
          <Text>
            <Text color={color}>{drawn.full}</Text>
            <Text dimColor>{drawn.rest}</Text>
          </Text>
        )
      }
      const context = (tokens: number) => {
        if (tokens <= 0) {
          return null
        }

        const percent = held.window > 0 ? Math.round((tokens / held.window) * 100) : null

        return (
          <Box marginLeft={2} flexShrink={0}>
            <Text dimColor>ctx </Text>
            {percent !== null && meter(percent / 100, 5, heat(percent))}
            <Text>
              {percent === null ? '' : ` ${percent}%`}
              {isWide || percent === null ? ` ${compact(tokens)}` : ''}
            </Text>
          </Box>
        )
      }
      const tasks = (list: AgentRow['tasks']) => {
        const { done, total } = progress(list)

        return (
          total > 0 && (
            <Box marginLeft={2} flexShrink={0}>
              {meter(done / total, 10, 'success')}
              <Text>
                {' '}
                {done}/{total}
              </Text>
            </Box>
          )
        )
      }
      const current = progress(held.tasks).current
      // One row is kept for the count of the agents that do not fit.
      const room = Math.max(0, Math.min(MAX_AGENT_ROWS, e.props.maxRows - (current === '' ? 1 : 2) - 1))
      // Those still running first: what is finished waits for the next prompt to leave.
      const agents = [...held.agents].sort(
        (one, other) => Number(other.status === 'running') - Number(one.status === 'running'),
      )
      const drawn = agents.slice(0, room)
      const labelWidth = Math.min(28, drawn.reduce((most, agent) => Math.max(most, [...agent.label].length), 5))

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color="claude">◆ </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-end">
                {held.goal === null ? held.ask || 'Working' : `Goal: ${held.goal}`}
              </Text>
            </Box>
            {tasks(held.tasks)}
            {context(held.context)}
            {isWide && held.agents.length > 0 && (
              <Box marginLeft={2} flexShrink={0}>
                <Text dimColor>{share(held, held.used)}% of use</Text>
              </Box>
            )}
            {isWide &&
              held.limits
                .filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
                .map(limit => (
                  <Box marginLeft={2} flexShrink={0}>
                    <Text dimColor>{limit.kind === 'five_hour' ? '5h' : '7d'} </Text>
                    <Text color={heat(limit.percent)}>{Math.round(limit.percent)}%</Text>
                  </Box>
                ))}
          </Box>
          {current !== '' && (
            <Text dimColor wrap="truncate-end">
              {'  ▸ '}
              {current}
            </Text>
          )}
          {drawn.map(agent => (
            <Box flexDirection="row">
              <Text dimColor>{'  ↳ '}</Text>
              <Box width={labelWidth} flexShrink={0}>
                <Text dimColor={agent.status !== 'running'} wrap="truncate-end">
                  {agent.label || 'agent'}
                </Text>
              </Box>
              <Box marginLeft={2} flexGrow={1} flexShrink={1}>
                <Text color={agent.status === 'failed' ? 'error' : undefined} dimColor wrap="truncate-end">
                  {agent.status}
                  {agent.tools > 0 ? ` · ${agent.tools} tool${agent.tools === 1 ? '' : 's'}` : ''}
                  {agent.status === 'running' && agent.last !== '' ? ` · ${agent.last}` : ''}
                </Text>
              </Box>
              {tasks(agent.tasks)}
              {context(agent.context)}
              {isWide && (
                <Box marginLeft={2} flexShrink={0}>
                  <Text dimColor>{share(held, agent.used)}% of use</Text>
                </Box>
              )}
            </Box>
          ))}
          {agents.length > drawn.length && (
            <Text dimColor>
              {'  '}+{agents.length - drawn.length} more agent{agents.length - drawn.length === 1 ? '' : 's'}
            </Text>
          )}
        </Box>
      )
    })
  }

  // The data panel ------------------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const agentId = e.agentId
    const isFailed = ran.deny !== undefined || ran.isError === true

    // The mod's own task calls are no work of the assistant's, and are booked where they are served.
    if ((isRefreshing && tool === 'TaskList') || tool === TASKS_TOOL) {
      return ran
    }

    // What the mod misses is never worth a tool call: a step of its own that fails is dropped.
    try {
      digest = counted(digest, tool, agentId !== undefined, isFailed ? (ran.deny ?? ran.text ?? '') : undefined)

      if (agentId !== undefined || TASK_TOOLS.has(tool)) {
        const now = await $.clock.now()

        await update($, board, held =>
          tooled(held, agentId, tool, isFailed ? undefined : e, isFailed ? undefined : ran.result, now),
        )
      }
    } catch {
      // The board lags one call behind.
    }

    if (capture === 'off' || isFailed) {
      return ran
    }

    try {
      const isAll = capture === 'everything'
      const record: unknown = ran.result
      const stdout =
        typeof record === 'object' && record !== null && 'stdout' in record ? record.stdout : undefined
      const text = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : (ran.text ?? '')

      if (tool === 'Bash') {
        const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
        const said = describeCommand(command)
        const isOpen = said.isDatabase || isAll
        const found = parseTables(text, {
          isJson: isOpen,
          isDelimited: said.isDatabase,
          isCsv: said.isDatabase && said.isCsv,
          hasHeader: said.hasHeader,
          // Any command may print a database client's table; the looser shapes need a client.
          only: isOpen ? undefined : ['psql', 'psql-expanded', 'box'],
        })

        await keep(
          $,
          found.map(table => ({ title: said.title, source: said.client || 'shell', table })),
          true,
          isAuto,
        )
      } else if (tool.startsWith('mcp__') && !tool.startsWith('mcp__mystique__') && (isAll || isDatabaseTool(tool))) {
        const [, server = '', name = ''] = tool.split('__')
        const found = parseTables(text, { isJson: true, isDelimited: false, isCsv: false, hasHeader: true })

        await keep(
          $,
          found.map(table => ({ title: name || server, source: server, table })),
          true,
          isAuto,
        )
      }
    } catch {
      return ran
    }

    return ran
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const kept = await next(e)

    if (capture === 'off' || e.agentId !== undefined) {
      return kept
    }

    try {
      const found: Captured[] = []

      for (const block of e.message.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.includes('|')) {
          for (const table of parseTables(block.text, {
            isJson: false,
            isDelimited: false,
            isCsv: false,
            hasHeader: true,
            only: ['markdown'],
          })) {
            found.push({ title: "Claude's reply", source: 'reply', table })
          }
        }
      }

      // A reply's table joins the list without taking the panel from a query's result.
      await keep($, found, false, isAuto)
    } catch {
      return kept
    }

    return kept
  })

  on('command.run', { command: 'tables' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      const list = await read($, tables)
      await update($, tables, () => [])
      await update($, view, () => START)

      for (const table of list) {
        await $.state.set({ ...ROWS, id: table.id }, [])
      }

      return { text: 'The captured tables are forgotten.' }
    }

    await update($, isDismissed, () => false)
    await reveal($, 'tables', true)
    const count = (await read($, tables)).length

    return { text: count === 0 ? 'Panel opened. No table captured yet.' : `Panel opened: ${count} table${count === 1 ? '' : 's'}.` }
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, board, cleared)

      return { text: 'The tasks and the subagents are forgotten.' }
    }

    await update($, isDismissed, () => false)
    await refresh($)
    await reveal($, 'agents', true)

    return { text: summary(await read($, board)) }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // Closed by hand, it stays closed until /tables or /progress asks for it again.
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    pending?.timer.cancel()
    pending = null

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tables)
    const held = await read($, view)
    const work = await read($, board)
    const room = Math.max(20, e.props.bodyColumns)
    const tab = held.tab === 'agents' ? 'agents' : 'tables'
    const set = (change: (held: View) => View) => () => update($, view, change)
    const running = work.agents.filter(agent => agent.status === 'running').length
    const rule = (
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(room)}
      </Text>
    )
    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Button
            key="tab-tables"
            label={`Tables ${list.length}`}
            hotkey="t"
            variant={tab === 'tables' ? 'primary' : 'secondary'}
            onPress={set(now => ({ ...now, tab: 'tables' }))}
          />
          <Button
            key="tab-agents"
            label={`Agents ${work.agents.length}`}
            hotkey="g"
            variant={tab === 'agents' ? 'primary' : 'secondary'}
            onPress={set(now => ({ ...now, tab: 'agents' }))}
          />
          {running > 0 && <Text color="claude">● {running} running</Text>}
        </Box>
        {rule}
      </Box>
    )

    if (tab === 'agents') {
      const now = await $.clock.now()
      const isMoving = isLive(work)
      const at = isMoving ? await read($, frame) : 0

      // What moves is drawn again a frame later: the write draws the panel, which asks for the
      // next, so the frames stop by themselves when the panel goes or the work is done. A frame
      // asked for long ago never came, and is asked for again.
      if (isMoving && (pending === null || now - pending.at > 8 * TICK)) {
        pending?.timer.cancel()

        const timer = $.clock.after(TICK, () => {
          if (pending?.timer === timer) {
            pending = null
          }

          update($, frame, count => count + 1).catch(() => undefined)
        })

        pending = { timer, at: now }
      }

      const span = Math.max(8, Math.min(24, room - 36))
      const heat = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')
      const stat = (name: string, fraction: number | null, color: string, text: string, hasEdge = false) => {
        const drawn = bar(fraction ?? 0, span)
        // The cell a bar grows into next swells and fades while the work on it goes on.
        const edge = hasEdge && drawn.rest !== '' ? pulse(at) : ''

        return (
          <Box flexDirection="row">
            <Box width={9} flexShrink={0}>
              <Text dimColor>{name}</Text>
            </Box>
            {fraction !== null && (
              <Box marginRight={1} flexShrink={0}>
                <Text color={color}>{drawn.full}</Text>
                {edge !== '' && <Text color={color}>{edge}</Text>}
                <Text dimColor>{edge === '' ? drawn.rest : drawn.rest.slice(1)}</Text>
              </Box>
            )}
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{text}</Text>
            </Box>
          </Box>
        )
      }
      const context = (tokens: number, isWhole: boolean) => {
        if (tokens <= 0) {
          return null
        }

        const percent = work.window > 0 ? Math.round((tokens / work.window) * 100) : null
        const size = isWhole && work.window > 0 ? `${compact(tokens)} of ${compact(work.window)}` : compact(tokens)

        return percent === null
          ? stat('context', null, 'success', size)
          : stat('context', percent / 100, heat(percent), `${percent}%  ${size}`)
      }
      const use = (used: number) => {
        const percent = share(work, used)

        return stat('use', percent / 100, 'claude', `${percent}% of session`)
      }
      const steps = (tasks: readonly Task[]) => {
        const { done, total } = progress(tasks)

        return (
          total > 0 &&
          stat('tasks', done / total, 'success', `${done}/${total}`, tasks.some(task => task.status === 'in_progress'))
        )
      }
      // A task has no measure of its own: done is a full bar, in progress a moving one.
      const track = (task: Task) => {
        if (task.status !== 'in_progress') {
          return task.status === 'completed' ? (
            <Text color="success">{'━'.repeat(TASK_BAR)}</Text>
          ) : (
            <Text dimColor>{'─'.repeat(TASK_BAR)}</Text>
          )
        }

        const moving = sweep(TASK_BAR, at)

        return (
          <Text>
            <Text dimColor>{moving.before}</Text>
            <Text color="claude">{moving.lit}</Text>
            <Text dimColor>{moving.after}</Text>
          </Text>
        )
      }
      const row = (task: Task) => (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              {task.status === 'completed' ? (
                <Text color="success">✔</Text>
              ) : task.status === 'in_progress' ? (
                <Text color="claude">▸</Text>
              ) : (
                <Text dimColor>○</Text>
              )}
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold={task.status === 'in_progress'} dimColor={task.status === 'completed'} wrap="truncate-end">
                {task.status === 'in_progress' ? task.active || task.subject : task.subject}
              </Text>
            </Box>
            <Box marginLeft={1} flexShrink={0}>
              {track(task)}
            </Box>
          </Box>
      )
      const todos = (tasks: readonly Task[], room: number) => {
        const near = nearby(tasks, room)

        return [
          near.before > 0 && <Text dimColor>{`  … ${near.before} done before`}</Text>,
          ...near.shown.map(row),
          near.after > 0 && <Text dimColor>{`  … ${near.after} more to do`}</Text>,
        ]
      }
      // The agents' lists share as many rows as the main list has to itself.
      const listing = work.agents.filter(agent => agent.tasks.length > 0).length
      const agentRows = Math.max(3, Math.floor(MAX_TASK_ROWS / Math.max(1, listing)))
      const limits = work.limits
        .filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
        .map(limit => `${limit.kind === 'five_hour' ? '5h' : '7d'} ${Math.round(limit.percent)}%`)
        .join(' · ')
      // Those still running first, the newest of each kind on top.
      const agents = [...work.agents].reverse().sort(
        (one, other) => Number(other.status === 'running') - Number(one.status === 'running'),
      )

      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text color="claude" bold>
              ◆ {work.goal === null ? 'Working on' : 'Goal'}
            </Text>
            <Text wrap="wrap">{work.goal ?? (work.ask || 'Nothing yet. Your next prompt shows here.')}</Text>
            {work.tasks.length > 0 && <Box marginTop={1}>{steps(work.tasks)}</Box>}
            {todos(work.tasks, MAX_TASK_ROWS)}
            {work.tasks.length === 0 && (
              <Text dimColor wrap="wrap">
                No task list yet. Claude keeps one for work with several steps, and each task shows here.
              </Text>
            )}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>Main thread</Text>
            {context(work.context, true)}
            {work.agents.length > 0 && use(work.used)}
            {limits !== '' && stat('limits', null, 'success', limits)}
            {work.context <= 0 && limits === '' && <Text dimColor>Figures arrive with the next model request.</Text>}
          </Box>
          {agents.length === 0 && (
            <Box paddingX={1} marginTop={1}>
              <Text dimColor wrap="wrap">
                No subagents yet. Each one Claude starts gets a card here, with its context and its share of
                the session's use.
              </Text>
            </Box>
          )}
          {agents.map(agent => {
            const isRunning = agent.status === 'running'
            const color = isRunning ? 'claude' : agent.status === 'failed' ? 'error' : 'success'
            const began = agent.startedAt ?? now
            const took = elapsed((agent.endedAt ?? now) - began)

            return (
              <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!isRunning} paddingX={1}>
                <Box flexDirection="row">
                  <Box width={2} flexShrink={0}>
                    <Text color={color}>{isRunning ? spinner(at) : agent.status === 'failed' ? '✖' : '✔'}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text bold wrap="truncate-end">
                      {agent.label || 'agent'}
                    </Text>
                  </Box>
                  <Box marginLeft={1} flexShrink={0}>
                    <Text color={color} dimColor={!isRunning}>
                      {isRunning ? `running ${took}` : `${agent.status} in ${took}`}
                    </Text>
                  </Box>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {[
                    agent.type,
                    `${agent.tools} tool${agent.tools === 1 ? '' : 's'}`,
                    isRunning && agent.last !== '' ? `now: ${agent.last}` : '',
                  ]
                    .filter(part => part !== '')
                    .join(' · ')}
                </Text>
                {context(agent.context, false)}
                {use(agent.used)}
                {steps(agent.tasks)}
                {todos(agent.tasks, agentRows)}
              </Box>
            )
          })}
        </Box>
      )
    }

    const found = list.findIndex(one => one.id === held.tableId)
    const at = found === -1 ? list.length - 1 : found
    const table = list[at]
    // A view of a table that is gone starts over on the one drawn in its place.
    const seen = found === -1 ? { ...START, tab } : held

    if (table === undefined) {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>No tables yet</Text>
          <Text dimColor wrap="wrap">
            Run a query with psql, mysql, sqlite3, duckdb or a database MCP tool and its result shows
            here, 20 rows at a time.
          </Text>
        </Box>
      )
    }

    const { value: rows = [] } = await $.state.get({ ...ROWS, id: table.id })
    const turn = (step: number) =>
      set(now => ({ ...START, tab: now.tab, tableId: list[(at + step + list.length) % list.length]?.id ?? null }))
    const title = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text bold color="claude" wrap="truncate-end">
              ▦ {table.title}
            </Text>
          </Box>
          {list.length > 1 && (
            <Box gap={1} marginLeft={1} flexShrink={0}>
              <Button key="prev" label="‹" hotkey="p" onPress={turn(-1)} />
              <Text dimColor>
                table {at + 1} of {list.length}
              </Text>
              <Button key="next" label="›" hotkey="n" onPress={turn(1)} />
            </Box>
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          {table.source} · {table.rowCount} row{table.rowCount === 1 ? '' : 's'} × {table.columns.length}{' '}
          column{table.columns.length === 1 ? '' : 's'}
          {table.isTruncated ? ' (the first kept)' : ''}
        </Text>
      </Box>
    )

    if (seen.row !== null && rows[seen.row] !== undefined) {
      const index = seen.row
      const record = rows[index] ?? []
      // A record is drawn whole, up to what one drawing may hold.
      const most = Math.max(100, Math.floor(MAX_RECORD / Math.max(1, table.columns.length)))
      const value = (cell: string) =>
        cell.length > most ? `${cell.slice(0, most)}… (${cell.length - most} more characters)` : cell
      const nameWidth = Math.min(
        Math.floor(room / 3),
        table.columns.reduce((most, name) => Math.max(most, [...name].length), 3),
      )
      const step = (by: number) =>
        set(now => ({ ...now, row: Math.min(rows.length - 1, Math.max(0, index + by)) }))

      return (
        <Box flexDirection="column">
          {header}
          {title}
          <Box gap={1} marginY={1}>
            <Button key="back" label="Back" hotkey="b" variant="primary" onPress={set(now => ({ ...now, row: null }))} />
            <Button key="up" label="‹" hotkey="p" onPress={step(-1)} />
            <Text dimColor>
              row {index + 1} of {rows.length}
            </Text>
            <Button key="down" label="›" hotkey="n" onPress={step(1)} />
          </Box>
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {table.columns.map((name, column) => (
              <Box flexDirection="row">
                <Box width={nameWidth} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">
                    {name}
                  </Text>
                </Box>
                <Box marginLeft={2} flexGrow={1} flexShrink={1}>
                  {record[column] === null || record[column] === undefined ? (
                    <Text dimColor>{NULL}</Text>
                  ) : (
                    <Text wrap="wrap">{value(record[column] ?? '')}</Text>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const count = Math.min(rows.length, Math.max(PAGE, seen.shown))
    const first = Math.max(0, count - WINDOW)
    const page = rows.slice(first, count)
    const from = Math.min(Math.max(0, seen.column), table.columns.length - 1)
    const fit = fitColumns(table.columns, page, from, room, count)
    const columns = fit.widths.map((width, offset) => ({
      index: from + offset,
      width,
      isRight: isNumeric(page, from + offset),
    }))
    const left = rows.length - count
    const more = (by: number) => set(now => ({ ...now, shown: count + by }))
    const slide = (by: number) =>
      set(now => ({ ...now, column: Math.min(table.columns.length - 1, Math.max(0, from + by)) }))

    return (
      <Box flexDirection="column">
        {header}
        {title}
        {(from > 0 || fit.count < table.columns.length) && (
          <Box gap={1}>
            <Button key="left" label="◀" hotkey="h" onPress={slide(-1)} />
            <Text dimColor>
              columns {from + 1}-{from + fit.count} of {table.columns.length}
            </Text>
            <Button key="right" label="▶" hotkey="l" onPress={slide(1)} />
          </Box>
        )}
        <Box flexDirection="row" marginTop={1}>
          <Box width={fit.numberWidth} flexShrink={0}>
            <Text dimColor>#</Text>
          </Box>
          {columns.map(column => (
            <Box
              width={column.width}
              marginLeft={2}
              flexShrink={0}
              justifyContent={column.isRight ? 'flex-end' : 'flex-start'}
            >
              <Text bold wrap="truncate-end">
                {clip(table.columns[column.index] ?? '', column.width)}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row">
          <Box width={fit.numberWidth} flexShrink={0}>
            <Text dimColor>{'─'.repeat(fit.numberWidth)}</Text>
          </Box>
          {columns.map(column => (
            <Box width={column.width} marginLeft={2} flexShrink={0}>
              <Text dimColor>{'─'.repeat(column.width)}</Text>
            </Box>
          ))}
        </Box>
        {page.map((record, offset) => (
          <Box flexDirection="row">
            <Box width={fit.numberWidth} flexShrink={0}>
              <Button
                key={`row-${first + offset}`}
                plain
                label={String(first + offset + 1)}
                onPress={set(now => ({ ...now, row: first + offset }))}
              />
            </Box>
            {columns.map(column => (
              <Box
                width={column.width}
                marginLeft={2}
                flexShrink={0}
                justifyContent={column.isRight ? 'flex-end' : 'flex-start'}
              >
                <Text
                  wrap="truncate-end"
                  dimColor={record[column.index] === null || record[column.index] === undefined}
                >
                  {clip(shown(record[column.index]), column.width)}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {rule}
        <Box gap={1} flexWrap="wrap">
          <Text dimColor>
            {rows.length === 0
              ? 'no rows'
              : first === 0
                ? `${count} of ${rows.length} rows`
                : `rows ${first + 1}-${count} of ${rows.length}`}
          </Text>
          {left > 0 && (
            <Button
              key="more"
              label={`+${Math.min(PAGE, left)} more`}
              hotkey="m"
              variant="primary"
              onPress={more(PAGE)}
            />
          )}
          {left > PAGE && <Button key="leap" label={`+${Math.min(LEAP, left)}`} hotkey="a" onPress={more(LEAP)} />}
          {count > PAGE && <Button key="fewer" label="first 20" hotkey="f" onPress={more(PAGE - count)} />}
        </Box>
        {rows.length > 0 && (
          <Text dimColor wrap="wrap">
            Press a row number for the whole record.
          </Text>
        )}
      </Box>
    )
  })
}
