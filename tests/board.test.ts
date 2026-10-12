import { describe, expect, test } from 'claude-code/testing'

import { aimed, asked, bar, cleared, compact, elapsed, EMPTY, ended, filled, hasWork, isAsk, named, nearby, progress, reconciled, share, spent, stepped, tasked, tooled } from '../hooks/lib/board'

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 800 }

describe('usage', () => {
  test('counts what a context holds and what a request spent', () => {
    expect(filled(USAGE)).toBe(42_000)
    expect(spent(USAGE)).toBe(1000 + 1000 + 1000 + 4000)
  })
})

describe('tasked', () => {
  test('takes a todo list whole', () => {
    const tasks = tasked([], 'TodoWrite', {
      todos: [
        { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
    }, {})

    expect(progress(tasks)).toEqual({ done: 1, total: 3, current: 'Writing tests' })
  })

  test('follows tasks as they are created, started, finished and deleted', () => {
    let tasks = tasked([], 'TaskCreate', { subject: 'Fix bug', description: 'x', activeForm: 'Fixing bug' }, { task: { id: '1', subject: 'Fix bug' } })
    tasks = tasked(tasks, 'TaskCreate', { subject: 'Add test', description: 'y' }, { task: { id: '2', subject: 'Add test' } })
    expect(progress(tasks)).toEqual({ done: 0, total: 2, current: '' })

    tasks = tasked(tasks, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true })
    expect(progress(tasks).current).toBe('Fixing bug')

    tasks = tasked(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })
    tasks = tasked(tasks, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })
    expect(progress(tasks)).toEqual({ done: 1, total: 1, current: '' })
  })

  test('learns of a task made before it was watching, and ignores an update that failed', () => {
    const tasks = tasked([], 'TaskUpdate', { taskId: '7', status: 'in_progress', subject: 'Old task' }, { success: true })

    expect(tasks).toEqual([{ id: '7', subject: 'Old task', status: 'in_progress', active: undefined }])
    expect(tasked(tasks, 'TaskUpdate', { taskId: '7', status: 'completed' }, { success: false })).toEqual(tasks)
    expect(tasked(tasks, 'Bash', { command: 'ls' }, {})).toEqual(tasks)
  })
})

describe('the board', () => {
  test('names the work by the prompt, and by the goal once one is set', () => {
    let board = asked(EMPTY, 'Fix the flaky login test\nand tell me why it flaked')
    expect(board.ask).toBe('Fix the flaky login test')
    expect(hasWork(board)).toBe(false)

    board = aimed(board, 'all tests pass on main')
    expect(board.goal).toBe('all tests pass on main')
    expect(hasWork(board)).toBe(true)
    expect(asked(board, '/tables')).toEqual(board)
    expect(asked(board, '<agent-message from="a1">done</agent-message>')).toEqual(board)
    expect(aimed(board, '').goal).toBe('all tests pass on main')
    expect(aimed(board, 'clear').goal).toBe(null)
  })

  test('follows each subagent: its tool calls, its context, and its share of what was spent', () => {
    let board = stepped(EMPTY, undefined, USAGE, 5000)
    board = stepped(board, 'agent-1', { ...USAGE, cache_read_input_tokens: 10_000 }, 5000)
    board = tooled(board, 'agent-1', 'Grep', { pattern: 'x' }, {}, 6000)
    board = tooled(board, 'agent-1', 'mcp__db__query', {}, {}, 7000)

    expect(board.context).toBe(42_000)
    expect(board.agents).toEqual([
      { id: 'agent-1', label: '', type: '', status: 'running', tools: 2, last: 'db query', context: 12_000, used: 4000, tasks: [], startedAt: 5000, endedAt: undefined },
    ])
    expect(share(board, board.used)).toBe(64)
    expect(share(board, board.agents[0]?.used ?? 0)).toBe(36)
    expect(share(EMPTY, 0)).toBe(0)

    const over = ended(board, 'agent-1', 'done', 65_000)
    expect(over.agents[0]).toMatchObject({ status: 'done', startedAt: 5000, endedAt: 65_000 })
    expect(ended(board, 'never-seen', 'failed', 1)).toEqual(board)
  })

  test('keeps an agent’s own task list apart from the main one', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] }, {}, 0)
    board = tooled(board, 'agent-1', 'TodoWrite', { todos: [{ content: 'b', status: 'pending', activeForm: 'B' }, { content: 'c', status: 'pending', activeForm: 'C' }] }, {}, 0)

    expect(progress(board.tasks).total).toBe(1)
    expect(progress(board.agents[0]?.tasks ?? []).total).toBe(2)
  })

  test('clears a finished task list and finished agents when the next prompt comes', () => {
    let board = tooled(EMPTY, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }] }, {}, 0)
    board = stepped(board, 'agent-1', USAGE, 0)
    board = stepped(board, 'agent-2', USAGE, 0)
    board = ended(board, 'agent-1', 'done', 10)

    const next = asked(board, 'next thing')

    expect(next.tasks).toEqual([])
    expect(next.agents.map(agent => agent.id)).toEqual(['agent-2'])
  })
})

describe('the board, the hard cases', () => {
  test('takes a prompt that opens with a path or a tag of its own for an ask', () => {
    for (const text of ['/etc/hosts has a stale entry, fix it', '<div> does not close in index.html', 'Fix it', '/src/app.ts:12 throws']) {
      expect(isAsk(text)).toBe(true)
    }

    for (const text of ['', '  ', '/tables', '/goal ship it', '/plugin:skill arg', '<agent-message from="a1">done</agent-message>', '<task-notification>x</task-notification>', '<system-reminder>x</system-reminder>', '<local-command-stdout>x</local-command-stdout>', '<command-name>/x</command-name>', '<teammate-message teammate_id="a">x</teammate-message>', '<cross-session-message>x</cross-session-message>']) {
      expect(isAsk(text)).toBe(false)
    }
  })

  test('keeps counting what an agent spent after it leaves the board', () => {
    let board = stepped(EMPTY, undefined, USAGE, 0)
    board = stepped(board, 'agent-1', { ...USAGE, cache_read_input_tokens: 10_000 }, 0)
    board = asked(ended(board, 'agent-1', 'done', 10), 'next thing')

    expect(board.agents).toEqual([])
    expect(board.total).toBe(11_000)
    expect(share(board, board.used)).toBe(64)
  })

  test('reads a board kept before the total was counted', () => {
    const { total, ...old } = stepped(stepped(EMPTY, undefined, USAGE, 0), 'agent-1', USAGE, 0)

    expect(total).toBe(14_000)
    expect(share(old as typeof EMPTY, 7000)).toBe(50)
  })

  test('books a subagent’s update of a main task on the main list', () => {
    let board = tooled(EMPTY, undefined, 'TaskCreate', { subject: 'Fix bug' }, { task: { id: '1' } }, 0)
    board = tooled(board, 'agent-1', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true }, 0)

    expect(progress(board.tasks)).toEqual({ done: 1, total: 1, current: '' })
    expect(board.agents[0]).toMatchObject({ tools: 1, last: 'TaskUpdate', tasks: [] })
  })

  test('makes room for a new agent by letting the oldest finished one go', () => {
    let board = EMPTY

    for (let index = 0; index < 24; index += 1) {
      board = stepped(board, `agent-${index}`, USAGE, index)
    }

    board = ended(board, 'agent-5', 'done', 100)
    board = stepped(board, 'agent-new', USAGE, 200)

    expect(board.agents.length).toBe(24)
    expect(board.agents.some(agent => agent.id === 'agent-5')).toBe(false)
    expect(board.agents.some(agent => agent.id === 'agent-0')).toBe(true)
    expect(board.agents.at(-1)?.id).toBe('agent-new')
  })

  test('names an agent on the board, and never brings back one that left', () => {
    const board = stepped(EMPTY, 'agent-1', USAGE, 0)

    expect(named(board, 'agent-1', 'Review', 'Explore').agents[0]).toMatchObject({ label: 'Review', type: 'Explore' })
    expect(named(EMPTY, 'agent-1', 'Review', 'Explore')).toEqual(EMPTY)
  })

  test('ends the rows of agents the engine no longer runs', () => {
    let board = stepped(EMPTY, 'agent-1', USAGE, 0)
    board = stepped(board, 'agent-2', USAGE, 0)

    const now = reconciled(board, ['agent-2'], 50)

    expect(now.agents.map(agent => [agent.id, agent.status, agent.endedAt])).toEqual([
      ['agent-1', 'done', 50],
      ['agent-2', 'running', undefined],
    ])
  })

  test('forgets the tasks and the agents on a clear, and keeps the figures', () => {
    let board = aimed(stepped(EMPTY, undefined, USAGE, 0), 'ship it')
    board = tooled(board, undefined, 'TodoWrite', { todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] }, {}, 0)
    board = cleared(stepped(board, 'agent-1', USAGE, 0))

    expect(board).toMatchObject({ goal: 'ship it', tasks: [], agents: [], context: 42_000, total: 14_000 })
  })
})

describe('bar', () => {
  test('fills in proportion, shows any progress, and fills up only when done', () => {
    expect(bar(0, 10)).toEqual({ full: '', rest: '░░░░░░░░░░' })
    expect(bar(0.01, 10).full).toBe('█')
    expect(bar(0.5, 10).full).toBe('█████')
    expect(bar(0.99, 10).full).toBe('█████████')
    expect(bar(1, 10)).toEqual({ full: '██████████', rest: '' })
    expect(bar(Number.NaN, 4)).toEqual({ full: '', rest: '░░░░' })
    expect(bar(3, 4).full).toBe('████')
  })
})

describe('compact', () => {
  test('writes a token count short', () => {
    expect([950, 1000, 48_200, 999_600, 1_240_000].map(compact)).toEqual(['950', '1k', '48k', '1.0M', '1.2M'])
  })
})

describe('elapsed', () => {
  test('writes a stretch of time short', () => {
    expect([0, 48_400, 72_000, 3_780_000].map(elapsed)).toEqual(['0s', '48s', '1m 12s', '1h 03m'])
  })
})

describe('nearby', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    id,
    subject: id,
    status: index < 3 ? ('completed' as const) : ('pending' as const),
  }))

  test('shows a short list whole', () => {
    expect(nearby(tasks, 6)).toEqual({ before: 0, shown: tasks, after: 0 })
  })

  test('opens a long list just before the first task not done', () => {
    const window = nearby(tasks, 3)

    expect(window.shown.map(task => task.id)).toEqual(['c', 'd', 'e'])
    expect([window.before, window.after]).toEqual([2, 1])
  })

  test('shows the end of a list that is all done', () => {
    const done = tasks.map(task => ({ ...task, status: 'completed' as const }))

    expect(nearby(done, 2).shown.map(task => task.id)).toEqual(['e', 'f'])
  })
})
