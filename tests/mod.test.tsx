import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

// Calls to MCP tools no machine need have connected: the tool table is each machine's own,
// so these are typed loosely to check anywhere.
const DATABASE_CALL = { tool: 'mcp__postgres__query', sql: 'select * from people' } as never
const OTHER_CALL = { tool: 'mcp__calendar__list_events' } as never

const PANE = {
  plugin: 'mystique',
  component: 'Pane',
  requestId: 'mystique',
  props: {
    title: 'Data',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const reply = (text: string) =>
  ({
    plugin: 'mystique',
    component: 'AssistantMessage',
    requestId: 'message-1',
    props: { text, isFirstOfReply: true },
  }) as const

/** A slash command as the person typing it raises it. */
const typed = (command: string, args: string) =>
  ({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

/** psql's aligned output for `count` planets. */
function planets(count: number): string {
  const lines = ['  id | name      ', '-----+-----------']

  for (let index = 1; index <= count; index += 1) {
    lines.push(`${String(index).padStart(4)} | planet-${String(index).padEnd(3)}`)
  }

  return [...lines, `(${count} rows)`, ''].join('\n')
}

/** The engine beneath the mod: a shell that prints `stdout`, a clock, and a surface that seats panes. */
function world(on: On, stdout: string): { opened: string[] } {
  const opened: string[] = []
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false }, text: stdout }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: opened.length === 0 ? [] : [{ id: 'mystique', title: 'mystique', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine drew: {e.props.text}</Text>
  })

  return { opened }
}

describe('the data panel', () => {
  test('shows a query result 20 rows at a time and loads 20 more on a press', async ($, on) => {
    const { opened } = world(on, planets(45))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    expect(opened).toEqual(['mystique'])

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const rows = async () => (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('row-')).length

      expect((await ui.find({ type: 'Text', text: 'planets' }))?.text).toBe('▦ planets')
      expect(await ui.find({ type: 'Text', text: /psql · 45 rows × 2 columns/ })).toBeDefined()
      expect(await rows()).toBe(20)
      expect(await ui.find({ type: 'Text', text: '20 of 45 rows' })).toBeDefined()
      expect((await ui.find({ key: 'more' }))?.props.label).toBe('+20 more')

      await ui.press({ key: 'more' })
      expect(await rows()).toBe(40)
      expect((await ui.find({ key: 'more' }))?.props.label).toBe('+5 more')

      await ui.press({ key: 'more' })
      expect(await rows()).toBe(45)
      expect(await ui.find({ key: 'more' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'planet-45' })).toBeDefined()

      await ui.press({ key: 'fewer' })
      expect(await rows()).toBe(20)
      await ui.unmount()
    }
  })

  test('opens a row as a record with every field, and goes back', async ($, on) => {
    world(on, planets(3))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'row-1' })
      expect(await ui.find({ type: 'Text', text: /row 2 of 3/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'planet-2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'planet-1' })).toBeUndefined()

      await ui.press({ key: 'down' })
      expect(await ui.find({ type: 'Text', text: 'planet-3' })).toBeDefined()

      await ui.press({ key: 'back' })
      expect(await ui.find({ type: 'Text', text: 'planet-1' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('slides its columns when a narrow dock cannot hold them all', async ($, on) => {
    world(on, '[{"id":1,"first_name":"Ada","city":"London","country":"United Kingdom"}]')
    await $.tool.call(DATABASE_CALL)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })

    expect(await ui.find({ type: 'Text', text: /columns 1-\d of 4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'country' })).toBeUndefined()

    await ui.press({ key: 'right' })
    await ui.press({ key: 'right' })
    await ui.press({ key: 'right' })
    expect(await ui.find({ type: 'Text', text: 'country' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'United Kingdom' })).toBeDefined()

    // The last columns fit now, and the way back is still drawn.
    await ui.press({ key: 'left' })
    await ui.press({ key: 'left' })
    await ui.press({ key: 'left' })
    expect(await ui.find({ type: 'Text', text: /columns 1-\d of 4/ })).toBeDefined()
    await ui.unmount()
  })

  test('keeps each result and walks between them', async ($, on) => {
    world(on, planets(2))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from moons"' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /table 2 of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'moons' })).toBeDefined()

    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: 'planets' })).toBeDefined()
    await ui.unmount()
  })

  test('takes a table from a plain command only in a database client’s own shape', async ($, on) => {
    const { opened } = world(on, '| a | b |\n|---|---|\n| 1 | 2 |\n')
    await $.tool.call({ tool: 'Bash', command: 'cat NOTES.md' })
    await $.tool.call(OTHER_CALL)
    await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.md' })

    expect(opened).toEqual([])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'No tables yet' })).toBeDefined()
    await ui.unmount()
  })

  test('takes every table-shaped output when asked to capture everything', { options: { capture: 'everything' } }, async ($, on) => {
    const { opened } = world(on, '| a | b |\n|---|---|\n| 1 | 2 |\n')
    await $.tool.call({ tool: 'Bash', command: 'cat NOTES.md' })

    expect(opened).toEqual(['mystique'])
  })

  test('captures nothing when capture is off', { options: { capture: 'off' } }, async ($, on) => {
    const { opened } = world(on, planets(2))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    expect(opened).toEqual([])
  })

  test('opens on /tables, counts what it holds, and forgets it on /tables clear', async ($, on) => {
    const { opened } = world(on, planets(2))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1 from a"' })
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1 from b"' })

    expect((await $.command.run(typed('tables', ''))).text).toBe('Panel opened: 2 tables.')
    expect(opened).toEqual(['mystique', 'mystique', 'mystique'])

    expect((await $.command.run(typed('tables', 'clear'))).text).toBe('The captured tables are forgotten.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'No tables yet' })).toBeDefined()
    await ui.unmount()
  })

  test('forgets the tables on a press of clear in the panel', async ($, on) => {
    world(on, planets(2))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1 from a"' })
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1 from b"' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ key: 'clear' }))?.props).toMatchObject({ label: 'clear', hotkey: 'c' })
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'clear' })

    expect(await ui.find({ type: 'Text', text: 'No tables yet' })).toBeDefined()
    expect((await ui.find({ key: 'tab-tables' }))?.props).toMatchObject({ label: 'Tables 0' })
    // Nothing is left to clear.
    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    await ui.unmount()
  })

  test('keeps the tab the person is on when the tables are forgotten', async ($, on) => {
    world(on, planets(2))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1 from a"' })
    await $.command.run(typed('progress', ''))
    await $.command.run(typed('tables', 'clear'))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'tab-agents' }))?.props).toMatchObject({ variant: 'primary' })
    await ui.unmount()
  })

  test('lists a table from Claude’s reply without taking the panel from a query', async ($, on) => {
    const { opened } = world(on, planets(2))
    const say = (uuid: string) =>
      $.session.append({
        message: {
          type: 'assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'Summary:\n\n| store | price |\n|---|---|\n| North | 1.20 |\n' }],
        },
        door: 'response',
        origin: { kind: 'model', model: 'test' },
        uuid,
      })

    await say('reply-1')
    expect(opened).toEqual([])

    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await first.find({ type: 'Text', text: "Claude's reply" })).toBeDefined()
    expect(await first.find({ type: 'Text', text: 'North' })).toBeDefined()
    await first.unmount()

    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })
    await say('reply-2')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'planets' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /table 2 of 3/ })).toBeDefined()
    await ui.unmount()
  })

  test('slides its page over a long result, a hundred rows drawn at most', async ($, on) => {
    world(on, planets(300))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = async () => (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('row-')).map(button => button.key)

    await ui.press({ key: 'leap' })
    expect((await rows()).length).toBe(100)
    expect(await ui.find({ type: 'Text', text: '120 of 300 rows' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'rows 21-120 of 300' })).toBeDefined()

    await ui.press({ key: 'leap' })
    expect((await rows()).at(0)).toBe('row-120')
    expect((await rows()).at(-1)).toBe('row-219')
    expect(await ui.find({ type: 'Text', text: 'planet-220' })).toBeDefined()

    await ui.press({ key: 'row-219' })
    expect(await ui.find({ type: 'Text', text: /row 220 of 300/ })).toBeDefined()
    await ui.press({ key: 'back' })

    await ui.press({ key: 'fewer' })
    expect((await rows()).length).toBe(20)
    expect(await ui.find({ type: 'Text', text: '20 of 300 rows' })).toBeDefined()
    await ui.unmount()
  })

  test('draws long values cut to their columns, and a wide record within what a drawing holds', async ($, on) => {
    const record = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`note_${index}`, 'x'.repeat(5000)]))
    world(on, JSON.stringify([record, record]))
    await $.tool.call(DATABASE_CALL)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lengths = async () => (await ui.findAll({ type: 'Text' })).map(text => text.text.length)

    expect(Math.max(...(await lengths()))).toBeLessThan(100)

    await ui.press({ key: 'row-0' })
    expect((await lengths()).reduce((sum, length) => sum + length, 0)).toBeLessThan(60_000)
    expect(await ui.find({ type: 'Text', text: /x… \(1168 more characters\)$/ })).toBeDefined()
    await ui.unmount()
  })

  test('keeps the table on screen when older ones make room for new ones', async ($, on) => {
    world(on, planets(2))

    for (let index = 1; index <= 10; index += 1) {
      await $.tool.call({ tool: 'Bash', command: `psql -c "select * from t${index}"` })
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: '▦ t1' })).toBeDefined()

    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '| store | price |\n|---|---|\n| North | 1.20 |\n' }] },
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: 'reply-1',
    })

    expect(await ui.find({ type: 'Text', text: '▦ t1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /table 1 of 10/ })).toBeDefined()

    // The second oldest went in its place.
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: '▦ t3' })).toBeDefined()
    await ui.unmount()
  })

  test('says a table was captured and stays closed where the panel is set to manual', { options: { panel: 'manual' } }, async ($, on) => {
    const { opened } = world(on, planets(2))
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    expect(opened).toEqual([])
    expect(toasts).toEqual(['Table captured: planets (2 rows). /tables shows it.'])

    await $.command.run(typed('tables', ''))
    expect(opened).toEqual(['mystique'])
  })

  test('returns the tool’s own answer untouched, a failed one included', async ($, on) => {
    mock.clock(on)
    on('tool.call', () => ({ result: 'boom', text: 'boom', isError: true }))

    expect(await $.tool.call({ tool: 'Bash', command: 'psql -c "select 1"' })).toMatchObject({ isError: true, text: 'boom' })
  })
})

describe('the highlighter', () => {
  test('draws a phrase Claude marked with the pen on every surface', { options: { highlight: 'claude' } }, async ($, on) => {
    world(on, '')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...reply('Use ==port 5433== for the replica.'), surface })
      const marked = (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined)

      expect(marked.map(text => text.text)).toEqual(['port 5433'])
      expect(marked[0]?.props.backgroundColor).toBe('#ffe95c')
      expect(await ui.find({ type: 'Text', text: /^engine drew/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('leaves a reply without marks to the engine', async ($, on) => {
    world(on, '')

    const ui = await $.ui.mount({ ...reply('Nothing **special** here.'), surface: 'terminal' })

    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine drew: Nothing **special** here.')
    await ui.unmount()
  })

  test('uses the chosen ink and highlights bold when asked to', { options: { highlight: 'bold', color: 'green' } }, async ($, on) => {
    world(on, '')

    const ui = await $.ui.mount({ ...reply('The **root cause** is ==here==.'), surface: 'terminal' })
    const marked = (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined)

    expect(marked.map(text => [text.text, text.props.backgroundColor])).toEqual([['root cause', '#8dfc8d']])
    await ui.unmount()
  })

  test('highlights what the person typed or selected, and clears it', async ($, on) => {
    world(on, '')
    on('ui.selection', () => ({ value: { text: 'is stale' } }))

    expect((await $.command.run(typed('highlight', 'cache'))).text).toBe('Highlighted: cache')
    expect((await $.command.run(typed('highlight', ''))).text).toBe('Highlighted: is stale')

    const ui = await $.ui.mount({ ...reply('The cache is stale.'), surface: 'terminal' })
    const marked = async () =>
      (await ui.findAll({ type: 'Text' })).filter(text => text.props.backgroundColor !== undefined).map(text => text.text)

    expect(await marked()).toEqual(['cache', 'is stale'])

    await $.command.run(typed('highlight', 'clear'))
    expect(await marked()).toEqual([])
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine drew: The cache is stale.')
    await ui.unmount()
  })

  test('asks Claude for marks only where a surface draws the reply', { options: { highlight: 'claude' } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
    const ask = { model: 'test', promptModel: 'test', tools: [], outputStyle: null, traits: [] }
    const drawn = await $.prompt.compose({ ...ask, surfaces: ['terminal'] })
    const headless = await $.prompt.compose({ ...ask, surfaces: [] })

    expect(drawn.sections.map(section => section.id)).toEqual(['intro', 'mystique:highlight'])
    expect(drawn.sections.at(-1)?.scope).toBe('session')
    expect(drawn.sections.at(-1)?.text).toMatch(/==like this==/)
    expect(headless.sections.map(section => section.id)).toEqual(['intro'])
  })

  test('leaves the system prompt alone unless Claude is asked for marks, as by default', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are helpful.', scope: 'shared' }] }))
    const composed = await $.prompt.compose({ model: 'test', promptModel: 'test', tools: [], outputStyle: null, traits: [], surfaces: ['terminal'] })

    expect(composed.sections.map(section => section.id)).toEqual(['intro'])
  })

  test('says so when there is nothing selected to highlight', async ($, on) => {
    world(on, '')
    on('ui.selection', () => ({ value: undefined }))

    expect((await $.command.run(typed('highlight', ''))).text).toMatch(/Nothing to highlight/)
  })
})

describe('the panel’s tabs', () => {
  test('switches between the tables and the agents, and /progress opens on the agents', async ($, on) => {
    const { opened } = world(on, planets(2))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    await $.tool.call({ tool: 'Bash', command: 'psql -c "select * from planets"' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ key: 'tab-tables' }))?.props).toMatchObject({ label: 'Tables 1', variant: 'primary' })
      expect((await ui.find({ key: 'tab-agents' }))?.props).toMatchObject({ label: 'Agents 0', variant: 'secondary' })

      await ui.press({ key: 'tab-agents' })
      expect((await ui.find({ key: 'tab-agents' }))?.props.variant).toBe('primary')
      expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Main thread' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '▦ planets' })).toBeUndefined()

      await ui.press({ key: 'tab-tables' })
      expect(await ui.find({ type: 'Text', text: '▦ planets' })).toBeDefined()
      await ui.unmount()
    }

    expect((await $.command.run(typed('progress', ''))).text).toBe('Panel opened: no tasks and no subagents on the board yet.')
    expect(opened.at(-1)).toBe('mystique')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'tab-agents' }))?.props.variant).toBe('primary')
    await ui.unmount()
  })
})
