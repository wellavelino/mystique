import type { Cell } from '../../types'

export type TableFormat =
  | 'psql'
  | 'psql-expanded'
  | 'box'
  | 'markdown'
  | 'columns'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'bars'

export type ParsedTable = {
  columns: string[]
  rows: Cell[][]
  format: TableFormat
  isTruncated: boolean
}

export type ParseHint = {
  /** Whether a bare JSON document may be read as a table. */
  isJson: boolean
  /** Whether bare lines of tabs or bars may be read as a table. */
  isDelimited: boolean
  /** Whether bare lines of commas may be too: only a command that asked for CSV prints them. */
  isCsv: boolean
  /** Whether such lines open with the column names; a client told to print none has no such line. */
  hasHeader: boolean
  /** The shapes wanted, when not all: the others are passed over, and do not count. */
  only?: readonly TableFormat[]
}

export const MAX_ROWS = 2000
const MAX_COLUMNS = 60
const MAX_CELL = 2000
const MAX_TEXT = 2_000_000
const MAX_TABLES = 4

/** What a parser found at a line: a table or none, and the line to go on from. */
type Hit = { table: ParsedTable | null; next: number }

const CLIENTS = new Set([
  'psql',
  'pgcli',
  'mysql',
  'mariadb',
  'mycli',
  'sqlite',
  'sqlite3',
  'litecli',
  'duckdb',
  'clickhouse-client',
  'clickhouse',
  'sqlcmd',
  'bq',
  'snowsql',
  'cockroach',
  'usql',
  'turso',
  'cqlsh',
  'trino',
  'presto',
])
// Programs that run another program: the client is looked for among their words.
const CARRIERS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose', 'kubectl', 'oc', 'ssh', 'compose'])
const PREFIXES = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'rtk', 'doas', 'nice'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const DB_TOOL =
  /sql|query|postgres|sqlite|database|(?:^|_)(?:db|pg|d1)(?:_|$)|prisma|supabase|bigquery|snowflake|clickhouse|duckdb|mongo|redshift|athena|warehouse/i
// A select list as SQL writes one: a star, a function, or a name followed by a comma, AS or FROM.
const SELECT =
  /\bselect\s+(?:distinct\s+)?(?:\*|[\w."`]+\s*\(|[\w."`]+(?=\s*,|\s+as\s|\s+from\s))[\s\S]*?\bfrom\s+[\w"`[]/i
const FROM =
  /\bfrom\s+((?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\]))*)/i
const SQLITE_HEADER =
  /(?:^|\s)-{1,2}(?:header|box|table|markdown|column)\b|\.headers?\s+on|\.mode\s+(?:box|table|markdown|column)/
const CSV_ASKED = /(?:^|[\s.-])csv\b/i

// The one-letter flags of each client that take a value: in `-Upostgres` the rest is the value.
const VALUED = { psql: 'cdfhpUvFRoLPT', mysql: 'uphPDeS' }

/** A shell command as simple commands of words: split at pipes and separators, quotes taken off. */
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [[]]
  let word = ''
  let isWord = false
  let quote = ''
  const end = () => {
    if (isWord) {
      commands.at(-1)?.push(word)
    }

    word = ''
    isWord = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''

    if (quote !== '') {
      if (char === quote) {
        quote = ''
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1
        word += command[index]
      } else {
        word += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
      isWord = true
    } else if (char === '#' && !isWord) {
      break
    } else if (char === '|' || char === ';' || char === '&' || char === '\n' || char === '(' || char === ')') {
      end()
      commands.push([])
    } else if (/\s/.test(char)) {
      end()
    } else {
      word += char
      isWord = true
    }
  }

  end()

  return commands.filter(words => words.length > 0)
}

type Client = { client: string; flags: string[] }

/** The database client a simple command runs, with the words after it; or none. */
function clientOf(words: readonly string[], depth = 0): Client | null {
  let at = 0

  // What stands before the program: wrappers, their flags, and variables set for it.
  while (
    at < words.length &&
    (PREFIXES.has(words[at] ?? '') || /^[A-Za-z_]\w*=/.test(words[at] ?? '') || (at > 0 && (words[at] ?? '').startsWith('-')))
  ) {
    at += PREFIXES.has(words[at] ?? '') && words[at] === 'sudo' && words[at + 1] === '-u' ? 3 : 1
  }

  const program = (words[at] ?? '').split('/').at(-1)?.toLowerCase() ?? ''

  if (CLIENTS.has(program)) {
    return { client: program, flags: words.slice(at + 1) }
  }

  const rest = words.slice(at + 1)

  // A shell handed a script, or a carrier handed a command, in one quoted word.
  if (depth < 2 && (SHELLS.has(program) || CARRIERS.has(program))) {
    for (const word of rest) {
      if (/\s/.test(word)) {
        for (const inner of simpleCommands(word)) {
          const found = clientOf(inner, depth + 1)

          if (found !== null) {
            return found
          }
        }
      }
    }
  }

  // A carrier that runs a program in a container or on a host names the client as a later word.
  if (CARRIERS.has(program) && (program === 'ssh' || rest.includes('exec') || rest.includes('run'))) {
    const index = rest.findIndex(word => CLIENTS.has(word.split('/').at(-1)?.toLowerCase() ?? ''))

    if (index !== -1) {
      return { client: rest[index]?.split('/').at(-1)?.toLowerCase() ?? '', flags: rest.slice(index + 1) }
    }
  }

  return null
}

/** Whether `flags` hold the one-letter flag `letter`, bundled or alone, or the long flag `long`. */
function hasFlag(flags: readonly string[], letter: string, valued: string, long: string): boolean {
  for (const flag of flags) {
    if (flag === long) {
      return true
    }

    if (!flag.startsWith('-') || flag.startsWith('--')) {
      continue
    }

    for (const char of flag.slice(1)) {
      if (char === letter) {
        return true
      }

      // The rest of the word is this flag's value, not more flags.
      if (valued.includes(char)) {
        break
      }
    }
  }

  return false
}

/** What a shell command says about its output: a database client's, of which table, how shaped. */
export function describeCommand(command: string): {
  isDatabase: boolean
  client: string
  title: string
  hasHeader: boolean
  isCsv: boolean
} {
  const commands = simpleCommands(command)
  const found = commands.map(words => clientOf(words)).find(one => one !== null) ?? null
  const client = found?.client ?? ''
  const flags = found?.flags ?? []
  const spoken = flags.join(' ')
  const hasHeader = client.startsWith('sqlite')
    ? SQLITE_HEADER.test(spoken)
    : client === 'psql'
      ? !hasFlag(flags, 't', VALUED.psql, '--tuples-only')
      : client === 'mysql' || client === 'mariadb'
        ? !hasFlag(flags, 'N', VALUED.mysql, '--skip-column-names')
        : true
  const isDatabase = client !== '' || SELECT.test(command)
  const from = FROM.exec(command)?.[1]?.replace(/["`[\]]/g, '') ?? ''

  return {
    isDatabase,
    client,
    title: (isDatabase && from) || client || 'query',
    hasHeader,
    isCsv: client === '' ? CSV_ASKED.test(command) : CSV_ASKED.test(spoken),
  }
}

/** Whether an MCP tool's full name (`mcp__server__tool`) reads as a database tool's. */
export function isDatabaseTool(tool: string): boolean {
  return DB_TOOL.test(tool.replace(/^mcp__/, ''))
}

/** Every table found in a tool's output, in the order written. */
export function parseTables(text: string, hint: ParseHint): ParsedTable[] {
  const source = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  const trimmed = source.trim()
  const isWanted = (table: ParsedTable) => hint.only === undefined || hint.only.includes(table.format)

  if (trimmed === '') {
    return []
  }

  if (hint.isJson && (trimmed.startsWith('[') || trimmed.startsWith('{'))) {
    const table = fromJson(trimmed)

    if (table !== null) {
      return isWanted(table) ? [table] : []
    }
  }

  const lines = source.replace(/\r/g, '').split('\n')
  const found: ParsedTable[] = []
  let at = 0

  while (at < lines.length && found.length < MAX_TABLES) {
    const hit =
      boxAt(lines, at) ??
      expandedAt(lines, at) ??
      psqlAt(lines, at) ??
      markdownAt(lines, at) ??
      columnsAt(lines, at)

    if (hit?.table !== null && hit?.table !== undefined && isWanted(hit.table)) {
      found.push(hit.table)
    }

    // A parser that read lines and found no table has still read them: none is read twice.
    at = Math.max(at + 1, hit?.next ?? 0)
  }

  if (found.length === 0 && hint.isDelimited) {
    const table = delimited(lines, hint)

    if (table !== null && isWanted(table)) {
      found.push(table)
    }
  }

  return found
}

function finish(
  names: readonly string[],
  records: readonly (readonly Cell[])[],
  format: TableFormat,
): ParsedTable | null {
  if (names.length === 0) {
    return null
  }

  const seen = new Map<string, number>()
  const columns = names.slice(0, MAX_COLUMNS).map((name, index) => {
    const base = name.trim() === '' ? `column ${index + 1}` : name.trim()
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)

    return count === 0 ? base : `${base} (${count + 1})`
  })
  const rows = records.slice(0, MAX_ROWS).map(record =>
    columns.map((_, index) => {
      const cell = record[index]

      if (cell === null || cell === undefined) {
        return null
      }

      return cell.length > MAX_CELL ? `${cell.slice(0, MAX_CELL)}…` : cell
    }),
  )

  return { columns, rows, format, isTruncated: records.length > MAX_ROWS }
}

const ROW_COUNT = /^\(\d+ rows?\)$/

function psqlAt(lines: readonly string[], at: number): Hit | null {
  const header = lines[at]
  const rule = lines[at + 1]?.trimEnd()

  if (header === undefined || rule === undefined || header.trim() === '') {
    return null
  }

  if (/^-+(\+-+)+$/.test(rule)) {
    const cuts = [...rule].flatMap((char, index) => (char === '+' ? [index] : []))
    const names = cut(header, cuts)

    if (names === null) {
      return null
    }

    const records: Cell[][] = []
    // The cells of a row still open, and which of them go on in the next line.
    let pending: { cells: string[]; isOpen: boolean[] } | null = null
    let next = at + 2

    for (; next < lines.length; next += 1) {
      const line = lines[next] ?? ''

      if (ROW_COUNT.test(line.trim())) {
        next += 1
        break
      }

      const raw = line.trim() === '' ? null : cut(line, cuts)

      if (raw === null) {
        break
      }

      // psql marks a cell that goes on in the next line with a + where its padding ends: a
      // padded cell ends in a space otherwise, and the last one only reaches the rule's width
      // when it is marked.
      const isOpen = raw.map((cell, index) =>
        index < raw.length - 1 ? cell.endsWith('+') : cell.endsWith('+') && line.length === rule.length,
      )
      const cells = raw.map((cell, index) => (isOpen[index] === true ? cell.slice(0, -1) : cell).trim())
      const held: { cells: string[]; isOpen: boolean[] } | null = pending
      const merged: string[] =
        held === null
          ? cells
          : held.cells.map((cell, index) => (held.isOpen[index] === true ? `${cell}\n${cells[index] ?? ''}` : cell))

      if (isOpen.includes(true)) {
        pending = { cells: merged, isOpen }
      } else {
        records.push(merged)
        pending = null
      }
    }

    if (pending !== null) {
      records.push(pending.cells)
    }

    return {
      table: finish(
        names.map(name => name.trim()),
        records,
        'psql',
      ),
      next,
    }
  }

  // One column has no + in its rule: only the row count beneath tells it from a heading.
  if (/^-{3,}$/.test(rule) && !header.includes('|')) {
    const records: Cell[][] = []

    for (let next = at + 2; next < lines.length; next += 1) {
      const line = lines[next] ?? ''

      if (ROW_COUNT.test(line.trim())) {
        const said = Number(/\d+/.exec(line)?.[0])

        return said === records.length ? { table: finish([header.trim()], records, 'psql'), next: next + 1 } : null
      }

      // A blank line or another rule ends what could have been its rows.
      if (line.trim() === '' || /^-{3,}$/.test(line.trim()) || records.length > MAX_ROWS) {
        return null
      }

      records.push([line.trim()])
    }
  }

  return null
}

function cut(line: string, cuts: readonly number[]): string[] | null {
  if (cuts.every(index => line[index] === '|')) {
    const edges = [-1, ...cuts, line.length]

    return edges.slice(0, -1).map((edge, index) => line.slice(edge + 1, edges[index + 1]))
  }

  // Wide characters move the bars off the rule's columns: fall back to the bars themselves,
  // a bar too many read as part of the last value.
  const parts = line.split('|')

  if (parts.length <= cuts.length) {
    return null
  }

  return [...parts.slice(0, cuts.length), parts.slice(cuts.length).join('|')]
}

function expandedAt(lines: readonly string[], at: number): Hit | null {
  const RECORD = /^-\[ RECORD \d+ \][-+]*$/

  if (!RECORD.test(lines[at]?.trimEnd() ?? '')) {
    return null
  }

  const names: string[] = []
  const records: Map<string, string>[] = []
  let last = ''
  let next = at

  for (; next < lines.length; next += 1) {
    const line = lines[next] ?? ''

    if (RECORD.test(line.trimEnd())) {
      records.push(new Map())
      last = ''
      continue
    }

    const bar = line.indexOf('|')

    if (line.trim() === '' || bar === -1) {
      break
    }

    const name = line.slice(0, bar).trim()
    const value = line.slice(bar + 1).trim()
    const record = records.at(-1)

    // A line with no name goes on with the value above, which ends in a + for it.
    if (name === '' && last !== '') {
      record?.set(last, `${(record.get(last) ?? '').replace(/\s*\+$/, '')}\n${value}`)
      continue
    }

    if (!names.includes(name)) {
      names.push(name)
    }

    record?.set(name, value)
    last = name
  }

  return {
    table: finish(
      names,
      records.map(record => names.map(name => record.get(name) ?? null)),
      'psql-expanded',
    ),
    next,
  }
}

const BORDER = /^[+┌├└╭╰╔╠╚╞][-─═━+┬┼┴╤╪╧╦╬╩┐┤┘╮╯╗╣╝╡]+$/
const BARS = /[|│║]/

function boxAt(lines: readonly string[], at: number): Hit | null {
  const isBorder = (line: string) => BORDER.test(line) && /[-─═━]{2}/.test(line)
  const isRow = (line: string) => line.length > 1 && BARS.test(line[0] ?? '') && BARS.test(line.at(-1) ?? '')

  if (!isBorder(lines[at]?.trim() ?? '')) {
    return null
  }

  // The top border's junctions say where the bars stand, so a bar inside a value is kept.
  const cuts = [...(lines[at]?.trim() ?? '')].flatMap((char, index, all) =>
    index > 0 && index < all.length - 1 && !/[-─═━]/.test(char) ? [index] : [],
  )
  const sections: string[][][] = [[]]
  let next = at + 1

  for (; next < lines.length; next += 1) {
    const line = lines[next]?.trim() ?? ''

    if (isBorder(line)) {
      sections.push([])
    } else if (isRow(line)) {
      const chars = [...line]
      const edges = [0, ...cuts, chars.length - 1]
      const cells = cuts.every(index => BARS.test(chars[index] ?? ''))
        ? edges.slice(0, -1).map((edge, index) => chars.slice(edge + 1, edges[index + 1]).join(''))
        : line.slice(1, -1).split(line[0] ?? '|')

      sections.at(-1)?.push(cells.map(cell => cell.trim()))
    } else {
      break
    }
  }

  const filled = sections.filter(section => section.length > 0)
  const names = filled[0]?.[0]

  // A result has a rule between its names and its rows: a box without one is a notice, a
  // diagram, a frame around text.
  if (names === undefined || filled.length < 2) {
    return { table: null, next }
  }

  // A header section's further rows are a client's own notes (DuckDB's types), not data.
  const records = filled
    .slice(1)
    .flat()
    // A row of another width is the client's footer; one of dots stands for rows it left out.
    .filter(record => record.length === names.length && !record.every(cell => cell === '·' || cell === '…'))
    .map(record => record.map(cell => (cell === 'NULL' ? null : cell)))

  return { table: records.length === 0 ? null : finish(names, records, 'box'), next }
}

/** Whether `rule` is the line under a markdown table's header. */
export function isMarkdownRule(header: string | undefined, rule: string | undefined): boolean {
  if (header === undefined || rule === undefined || !header.includes('|') || !rule.includes('|')) {
    return false
  }

  // Only dashes, colons, bars and blanks: checked first, so no long line is searched for more.
  if (!/^[\s|:-]+$/.test(rule) || !rule.includes('-')) {
    return false
  }

  const parts = rule.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')

  return parts.every(part => /^\s*:?-+:?\s*$/.test(part)) && markdownCells(header).length === parts.length
}

function markdownCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')

  return inner.split(/(?<!\\)\|/).map(cell =>
    cell
      .trim()
      .replace(/\\\|/g, '|')
      // One mark around the whole cell is how it is written, not what it says.
      .replace(/^(\*\*|__|==|`)((?:(?!\1).)+)\1$/, '$2'),
  )
}

function markdownAt(lines: readonly string[], at: number): Hit | null {
  if (!isMarkdownRule(lines[at], lines[at + 1])) {
    return null
  }

  const records: Cell[][] = []
  let next = at + 2

  for (; next < lines.length; next += 1) {
    const line = lines[next] ?? ''

    if (line.trim() === '' || !line.includes('|')) {
      break
    }

    records.push(markdownCells(line))
  }

  return { table: finish(markdownCells(lines[at] ?? ''), records, 'markdown'), next }
}

function columnsAt(lines: readonly string[], at: number): Hit | null {
  const header = lines[at]
  const rule = lines[at + 1]?.trimEnd()

  if (header === undefined || rule === undefined || header.trim() === '' || !/^-+( +-+)+$/.test(rule)) {
    return null
  }

  const starts = [...rule.matchAll(/-+/g)].map(run => run.index)
  const slice = (line: string) =>
    starts.map((start, index) => line.slice(start, starts[index + 1]).trim())
  const records: Cell[][] = []
  let next = at + 2

  for (; next < lines.length; next += 1) {
    const line = lines[next] ?? ''

    if (line.trim() === '') {
      break
    }

    records.push(slice(line))
  }

  return { table: finish(slice(header), records, 'columns'), next }
}

function delimited(lines: readonly string[], hint: ParseHint): ParsedTable | null {
  // A row of empty cells is still a row: only a line with nothing on it is none.
  const kept = lines.filter(line => (line.trim() !== '' || line.includes('\t')) && !ROW_COUNT.test(line.trim()))

  if (kept.length < (hint.hasHeader ? 2 : 1)) {
    return null
  }

  const isEven = (records: readonly (readonly string[])[]) => {
    const width = records[0]?.length ?? 0

    return width > 1 && records.every(record => record.length === width)
  }
  const named = (records: readonly (readonly Cell[])[], format: TableFormat) =>
    hint.hasHeader
      ? finish((records[0] ?? []).map(name => name ?? ''), records.slice(1), format)
      : finish((records[0] ?? []).map(() => ''), records, format)
  const tabbed = kept.map(line => line.split('\t'))

  if (isEven(tabbed)) {
    // A client's batch output writes no value as the word NULL.
    return named(
      tabbed.map((record, index) =>
        index === 0 && hint.hasHeader ? record : record.map(cell => (cell === 'NULL' ? null : cell)),
      ),
      'tsv',
    )
  }

  // Bars with no rule under the first line: a client's unaligned output (sqlite3, psql -A).
  const barred = kept.map(line => line.split('|').map(cell => cell.trim()))

  if (isEven(barred)) {
    return named(barred, 'bars')
  }

  if (!hint.isCsv) {
    return null
  }

  const records = csvRecords(kept.join('\n'))

  return isEven(records) ? named(records, 'csv') : null
}

function csvRecords(source: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let isQuoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (isQuoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        isQuoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      isQuoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }

  record.push(field)
  records.push(record)

  return records
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isRecordList(value: unknown): value is Json[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord)
}

function cellOf(value: unknown): Cell {
  if (value === null || value === undefined) {
    return null
  }

  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function parsed(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    // One object a line, as a client's JSON-lines mode prints its rows.
    const lines = source.split('\n').filter(line => line.trim() !== '')

    if (lines.length < 2 || !lines.every(line => line.trimStart().startsWith('{'))) {
      return undefined
    }

    try {
      return lines.map(line => JSON.parse(line) as unknown)
    } catch {
      return undefined
    }
  }
}

function fromJson(source: string): ParsedTable | null {
  const data = parsed(source)
  const grid = isRecord(data) ? gridOf(data) : null

  if (grid !== null) {
    return grid
  }

  const records = recordsIn(data, 0)

  if (records === null) {
    return null
  }

  const names: string[] = []

  for (const record of records.slice(0, 500)) {
    for (const name of Object.keys(record)) {
      if (!names.includes(name)) {
        names.push(name)
      }
    }
  }

  return finish(
    names,
    records.map(record => names.map(name => cellOf(record[name]))),
    'json',
  )
}

// The keys a database tool puts its rows under: read before any other list the answer holds.
const ROW_KEYS = ['rows', 'records', 'results', 'result', 'data', 'items', 'values']

/** The list of objects a JSON value is, or holds up to two keys down: its rows first, else the longest. */
function recordsIn(value: unknown, depth: number): Json[] | null {
  if (isRecordList(value)) {
    return value
  }

  if (!isRecord(value) || depth > 1) {
    return null
  }

  for (const key of ROW_KEYS) {
    const rows = value[key]

    if (isRecordList(rows)) {
      return rows
    }
  }

  let best: Json[] | null = null

  for (const inner of Object.values(value)) {
    const records = recordsIn(inner, depth + 1)

    if (records !== null && records.length > (best?.length ?? 0)) {
      best = records
    }
  }

  return best
}

/** `{ columns, rows }` as database tools answer it: names apart, rows as lists. */
function gridOf(data: Json): ParsedTable | null {
  const names = data.columns ?? data.fields ?? data.headers
  const rows = data.rows ?? data.values ?? data.data

  if (!Array.isArray(names) || !Array.isArray(rows) || names.length === 0 || !rows.every(Array.isArray)) {
    return null
  }

  return finish(
    names.map(name => (isRecord(name) ? String(name.name ?? '') : String(name))),
    (rows as unknown[][]).map(row => row.map(cellOf)),
    'json',
  )
}
