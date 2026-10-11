import { describe, expect, test } from 'claude-code/testing'

import { describeCommand, isDatabaseTool, MAX_ROWS, parseTables } from '../hooks/lib/tables'

const STRICT = { isJson: false, isDelimited: false, isCsv: false, hasHeader: true }
const CLIENT = { isJson: true, isDelimited: true, isCsv: true, hasHeader: true }

const PLANETS = [
  ['1', 'Mercury', '0', ''],
  ['2', 'Venus', '0', 'hot | very'],
  ['3', 'Earth', '1', 'home'],
  ['4', 'Mars', '2', 'red'],
]

describe('parseTables', () => {
  test('reads psql aligned output, bars inside a value kept', () => {
    const [table, ...rest] = parseTables(
      [
        ' id |  name   | moons |    note    ',
        '----+---------+-------+------------',
        '  1 | Mercury |     0 | ',
        '  2 | Venus   |     0 | hot | very',
        '  3 | Earth   |     1 | home',
        '  4 | Mars    |     2 | red',
        '(4 rows)',
        '',
      ].join('\n'),
      STRICT,
    )

    expect(rest).toEqual([])
    expect(table?.format).toBe('psql')
    expect(table?.columns).toEqual(['id', 'name', 'moons', 'note'])
    expect(table?.rows).toEqual(PLANETS)
  })

  test('joins a psql cell that continues on the next line', () => {
    const [table] = parseTables(
      [' id |  body  ', '----+--------', '  1 | first +', '    | second', '  2 | one', '(2 rows)'].join('\n'),
      STRICT,
    )

    expect(table?.rows).toEqual([
      ['1', 'first\nsecond'],
      ['2', 'one'],
    ])
  })

  test('reads a psql result of one column by its row count', () => {
    const [table] = parseTables([' count ', '-------', '    42', '(1 row)'].join('\n'), STRICT)

    expect(table?.columns).toEqual(['count'])
    expect(table?.rows).toEqual([['42']])
  })

  test('keeps an empty psql result as a table with no rows', () => {
    const [table] = parseTables([' id | name ', '----+------', '(0 rows)'].join('\n'), STRICT)

    expect(table?.columns).toEqual(['id', 'name'])
    expect(table?.rows).toEqual([])
  })

  test('reads psql expanded records', () => {
    const [table] = parseTables(
      ['-[ RECORD 1 ]---', 'id   | 1', 'name | Mercury', '-[ RECORD 2 ]---', 'id   | 2', 'name | Venus'].join('\n'),
      STRICT,
    )

    expect(table?.format).toBe('psql-expanded')
    expect(table?.columns).toEqual(['id', 'name'])
    expect(table?.rows).toEqual([
      ['1', 'Mercury'],
      ['2', 'Venus'],
    ])
  })

  test('reads an ASCII box (mysql, sqlite3 -table), NULL as no value', () => {
    const [table] = parseTables(
      [
        '+----+---------+-------+------------+',
        '| id |  name   | moons |    note    |',
        '+----+---------+-------+------------+',
        '|  1 | Mercury |     0 | NULL       |',
        '|  2 | Venus   |     0 | hot | very |',
        '+----+---------+-------+------------+',
        '2 rows in set (0.00 sec)',
      ].join('\n'),
      STRICT,
    )

    expect(table?.format).toBe('box')
    expect(table?.rows).toEqual([
      ['1', 'Mercury', '0', null],
      ['2', 'Venus', '0', 'hot | very'],
    ])
  })

  test('reads a unicode box (sqlite3 -box, duckdb), a type row under the names left out', () => {
    const [table] = parseTables(
      [
        '┌───────┬─────────┐',
        '│  id   │  name   │',
        '│ int32 │ varchar │',
        '├───────┼─────────┤',
        '│     1 │ Mercury │',
        '│     2 │ Venus   │',
        '└───────┴─────────┘',
      ].join('\n'),
      STRICT,
    )

    expect(table?.columns).toEqual(['id', 'name'])
    expect(table?.rows).toEqual([
      ['1', 'Mercury'],
      ['2', 'Venus'],
    ])
  })

  test('reads a markdown table and unwraps a cell written bold or as code', () => {
    const [table] = parseTables(
      ['Here it is:', '', '| Store | Price |', '|:------|------:|', '| **North** | `1.20` |', '| South | 0.95 |', '', 'Done.'].join('\n'),
      STRICT,
    )

    expect(table?.format).toBe('markdown')
    expect(table?.columns).toEqual(['Store', 'Price'])
    expect(table?.rows).toEqual([
      ['North', '1.20'],
      ['South', '0.95'],
    ])
  })

  test('reads sqlite3 -column output by the runs of its rule', () => {
    const [table] = parseTables(
      [
        'id   name    moons     note',
        '--  -------  -----  ----------',
        ' 1  Mercury      0',
        ' 2  Venus        0  hot | very',
      ].join('\n'),
      STRICT,
    )

    expect(table?.format).toBe('columns')
    expect(table?.columns).toEqual(['id', 'name', 'moons', 'note'])
    expect(table?.rows).toEqual([
      ['1', 'Mercury', '0', ''],
      ['2', 'Venus', '0', 'hot | very'],
    ])
  })

  test('reads a JSON list of objects, a missing key and null as no value', () => {
    const [table] = parseTables(
      '[{"id":1,"name":"Mercury","tags":["a"]},\n{"id":2,"note":null,"name":"Venus"}]',
      CLIENT,
    )

    expect(table?.format).toBe('json')
    expect(table?.columns).toEqual(['id', 'name', 'tags', 'note'])
    expect(table?.rows).toEqual([
      ['1', 'Mercury', '["a"]', null],
      ['2', 'Venus', null, null],
    ])
  })

  test('finds the rows a JSON answer wraps, and reads columns beside rows', () => {
    const [wrapped] = parseTables('{"ok":true,"result":{"rows":[{"a":1},{"a":2}]}}', CLIENT)
    const [grid] = parseTables('{"columns":[{"name":"a"},{"name":"b"}],"rows":[[1,"x"],[2,null]]}', CLIENT)

    expect(wrapped?.rows).toEqual([['1'], ['2']])
    expect(grid?.columns).toEqual(['a', 'b'])
    expect(grid?.rows).toEqual([
      ['1', 'x'],
      ['2', null],
    ])
  })

  test('reads CSV, tab-separated and bar-separated lines only for a database client', () => {
    const csv = 'id,name,note\r\n1,Mercury,\r\n2,Venus,"hot, ""very"""\r\n'
    const tsv = 'id\tname\n1\tMercury\n2\tVenus\n'
    const bars = 'id|name\n1|Mercury\n2|Venus\n'

    expect(parseTables(csv, STRICT)).toEqual([])
    expect(parseTables(tsv, STRICT)).toEqual([])
    expect(parseTables(bars, STRICT)).toEqual([])
    expect(parseTables(csv, CLIENT)[0]?.rows).toEqual([
      ['1', 'Mercury', ''],
      ['2', 'Venus', 'hot, "very"'],
    ])
    expect(parseTables(tsv, CLIENT)[0]?.format).toBe('tsv')
    expect(parseTables(bars, CLIENT)[0]?.columns).toEqual(['id', 'name'])
  })

  test('numbers the columns of output printed without its names', () => {
    const [table] = parseTables('1|Mercury\n2|Venus\n', { ...CLIENT, hasHeader: false })

    expect(table?.columns).toEqual(['column 1', 'column 2'])
    expect(table?.rows).toEqual([
      ['1', 'Mercury'],
      ['2', 'Venus'],
    ])
  })

  test('finds every table of an output that holds several', () => {
    const found = parseTables(
      [' a | b ', '---+---', ' 1 | 2', '(1 row)', '', ' c | d ', '---+---', ' 3 | 4', '(1 row)'].join('\n'),
      STRICT,
    )

    expect(found.map(table => table.columns)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('keeps the first rows of a result too long to hold, and says so', () => {
    const lines = [' n | m ', '---+---']

    for (let index = 0; index < MAX_ROWS + 5; index += 1) {
      lines.push(` ${index} | x`)
    }

    const [table] = parseTables(lines.join('\n'), STRICT)

    expect(table?.rows.length).toBe(MAX_ROWS)
    expect(table?.isTruncated).toBe(true)
  })

  test('names a column that has no name and tells apart two of one name', () => {
    const [table] = parseTables([' id |  | id ', '----+--+----', '  1 | x | 2', '(1 row)'].join('\n'), STRICT)

    expect(table?.columns).toEqual(['id', 'column 2', 'id (2)'])
  })

  test('finds no table in prose, listings, rules, headings or code', () => {
    const texts = [
      'The build passed in 12s.\nNothing else to report.',
      'total 8\ndrwxr-xr-x 2 user user 4096 Jan  1 00:00 src\n-rw-r--r-- 1 user user  120 Jan  1 00:00 a.ts',
      'Title\n-----\n\nA paragraph under a setext heading.\n\n---\n\nAnother.',
      'if (a || b) {\n  return a | b\n}',
      'a == b | c\nd | e',
      '{"name":"pkg","version":"1.0.0","scripts":{"test":"x"}}',
      '[1, 2, 3]',
    ]

    for (const text of texts) {
      expect(parseTables(text, STRICT)).toEqual([])
    }

    expect(parseTables('{"name":"pkg","version":"1.0.0"}', CLIENT)).toEqual([])
    expect(parseTables('[1, 2, 3]', CLIENT)).toEqual([])
    expect(parseTables('', CLIENT)).toEqual([])
  })
})

describe('parseTables, the hard cases', () => {
  test('keeps a psql value that ends in a plus sign', () => {
    const [table] = parseTables([' id | lang ', '----+------', '  1 | C++', '  2 | Java', '(2 rows)'].join('\n'), STRICT)

    expect(table?.rows).toEqual([
      ['1', 'C++'],
      ['2', 'Java'],
    ])
  })

  test('keeps the blank line inside a psql cell of several lines', () => {
    const [table] = parseTables(
      [' id | body  ', '----+-------', '  1 | first+', '    |      +', '    | third', '(1 row)'].join('\n'),
      STRICT,
    )

    expect(table?.rows).toEqual([['1', 'first\n\nthird']])
  })

  test('joins a psql expanded value that goes on in the next line', () => {
    const [table] = parseTables(
      ['-[ RECORD 1 ]--', 'id   | 1', 'body | first +', '     | second'].join('\n'),
      STRICT,
    )

    expect(table?.columns).toEqual(['id', 'body'])
    expect(table?.rows).toEqual([['1', 'first\nsecond']])
  })

  test('keeps the rows after a psql row whose bars stand off the rule', () => {
    const [table] = parseTables(
      [' id | name  | note ', '----+-------+------', '  1 | 日本語 | a | b', '  2 | x     | y', '(2 rows)'].join('\n'),
      STRICT,
    )

    expect(table?.rows).toEqual([
      ['1', '日本語', 'a | b'],
      ['2', 'x', 'y'],
    ])
  })

  test('takes no notice box or diagram for a table', () => {
    const texts = [
      ['╭──────────────────────────────╮', '│ Ignored build scripts: foo.  │', '│ Run "pnpm approve-builds".   │', '╰──────────────────────────────╯'].join('\n'),
      ['┌──────────────────────────────┐', '│ Update available 5.0.0 → 6.0.0 │', '│ Run npm i -g x to update     │', '└──────────────────────────────┘'].join('\n'),
      ['+--------+', '| Client |', '+--------+', '    |', '+--------+', '| Server |', '+--------+'].join('\n'),
    ]

    for (const text of texts) {
      expect(parseTables(text, STRICT)).toEqual([])
    }
  })

  test('reads a boxed result of one column, which has a rule under its name', () => {
    const [table] = parseTables(['+-------+', '| name  |', '+-------+', '| Venus |', '| Mars  |', '+-------+'].join('\n'), STRICT)

    expect(table?.rows).toEqual([['Venus'], ['Mars']])
  })

  test('leaves out the rows a client prints for what it elided', () => {
    const [table] = parseTables(
      ['┌────┬──────┐', '│ id │ name │', '├────┼──────┤', '│  1 │ a    │', '│  · │  ·   │', '│  9 │ z    │', '├────┴──────┤', '│ 9 rows (2 shown) │', '└───────────┘'].join('\n'),
      STRICT,
    )

    expect(table?.rows).toEqual([
      ['1', 'a'],
      ['9', 'z'],
    ])
  })

  test('unwraps a markdown cell only when one mark wraps all of it', () => {
    const [table] = parseTables(
      ['| a | b | c |', '|---|---|---|', '| `p` / `n` | **North** and **South** | **all** |'].join('\n'),
      STRICT,
    )

    expect(table?.rows).toEqual([['`p` / `n`', '**North** and **South**', 'all']])
  })

  test('reads the rows of a JSON answer that also lists its fields', () => {
    const [table] = parseTables(
      '{"rows":[{"id":1,"name":"a"}],"fields":[{"name":"id","dataTypeID":23},{"name":"name","dataTypeID":25}]}',
      CLIENT,
    )

    expect(table?.columns).toEqual(['id', 'name'])
    expect(table?.rows).toEqual([['1', 'a']])
  })

  test('reads JSON lines, and no list that is not all records', () => {
    const [table] = parseTables('{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n', CLIENT)
    const mixed = JSON.stringify([...Array.from({ length: 120 }, (_, id) => ({ id })), null, 'abc'])

    expect(table?.format).toBe('json')
    expect(table?.rows).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ])
    expect(parseTables(mixed, CLIENT)).toEqual([])
  })

  test('reads commas as columns only when the command asked for CSV', () => {
    const schema = 'CREATE TABLE planets (id integer, name text);\n'

    expect(parseTables(schema, { ...CLIENT, isCsv: false, hasHeader: false })).toEqual([])
    expect(parseTables('id,name\n1,a\n', { ...CLIENT, isCsv: false })).toEqual([])
    expect(parseTables('id,name\n1,a\n', CLIENT)[0]?.rows).toEqual([['1', 'a']])
  })

  test('reads NULL in tab-separated output as no value, and keeps a row of empty cells', () => {
    const [table] = parseTables('id\tnote\n1\tNULL\n\t\n', CLIENT)

    expect(table?.rows).toEqual([
      ['1', null],
      ['', ''],
    ])
  })

  test('counts only the wanted shapes toward the tables it keeps', () => {
    const markdown = ['| a | b |', '|---|---|', '| 1 | 2 |', ''].join('\n')
    const psql = [' c | d ', '---+---', ' 3 | 4', '(1 row)'].join('\n')
    const found = parseTables(`${markdown}\n${markdown}\n${markdown}\n${markdown}\n${psql}`, { ...STRICT, only: ['psql', 'psql-expanded', 'box'] })

    expect(found.map(table => table.columns)).toEqual([['c', 'd']])
  })

  test('stays quick on output made to look like the start of a table, over and over', () => {
    const started = Date.now()

    parseTables('+-----+\n'.repeat(20_000), STRICT)
    parseTables('-[ RECORD 1 ]--\n'.repeat(20_000), STRICT)
    parseTables('x\n---\n'.repeat(60_000), STRICT)
    parseTables(`a | b\n${' '.repeat(50_000)}x|\n`, STRICT)

    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('describeCommand', () => {
  test('knows a database client wherever it stands in the command', () => {
    expect(describeCommand('psql -c "select * from public.orders limit 5"')).toMatchObject({
      isDatabase: true,
      client: 'psql',
      title: 'public.orders',
      hasHeader: true,
    })
    expect(describeCommand('docker exec -it db psql -U app -c \'SELECT id FROM "Users"\'')).toMatchObject({
      isDatabase: true,
      client: 'psql',
      title: 'Users',
      hasHeader: true,
    })
    expect(describeCommand('/usr/bin/sqlite3 app.db ".tables"')).toMatchObject({ isDatabase: true, client: 'sqlite3', title: 'sqlite3' })
    expect(describeCommand('mysql -e "show databases"').client).toBe('mysql')
  })

  test('reads from the client flags whether the output opens with column names', () => {
    expect(describeCommand('sqlite3 app.db "select 1"').hasHeader).toBe(false)
    expect(describeCommand('sqlite3 -header -csv app.db "select 1"').hasHeader).toBe(true)
    expect(describeCommand('psql -At -c "select 1"').hasHeader).toBe(false)
    expect(describeCommand('psql --csv -c "select 1"').hasHeader).toBe(true)
    expect(describeCommand('mysql -N -e "select 1"').hasHeader).toBe(false)
  })

  test('takes a command for a database one by its SQL when no client is named', () => {
    expect(describeCommand('make query SQL="select name from planets"')).toMatchObject({
      isDatabase: true,
      client: '',
      title: 'planets',
    })
  })

  test('reads each client’s own flags, not a value stuck to one or another program’s', () => {
    expect(describeCommand('mysql -uroot -pMyNewPass -e "select 1"').hasHeader).toBe(true)
    expect(describeCommand('psql -Upostgres --csv -c "select 1"').hasHeader).toBe(true)
    expect(describeCommand('psql -hlocalhost -A -c "select 1"').hasHeader).toBe(true)
    expect(describeCommand('psql --csv -c "select 1" | column -t').hasHeader).toBe(true)
    expect(describeCommand('psql -XAt -c "select 1"').hasHeader).toBe(false)
    expect(describeCommand('psql -U app -d db -tA -c "select 1"').hasHeader).toBe(false)
    expect(describeCommand('mysql -BN -e "select 1"').hasHeader).toBe(false)
  })

  test('says whether the command asked for CSV', () => {
    expect(describeCommand('psql --csv -c "select 1"').isCsv).toBe(true)
    expect(describeCommand('sqlite3 -csv app.db "select 1"').isCsv).toBe(true)
    expect(describeCommand('sqlite3 app.db ".schema"').isCsv).toBe(false)
  })

  test('finds the client inside a wrapper, and the SQL a script is handed', () => {
    for (const command of [
      'sudo -u postgres psql -c "select 1"',
      'PGPASSWORD=x psql -c "select 1"',
      'docker compose exec db psql -U app -c "select 1"',
      'kubectl exec pod-1 -- psql -c "select 1"',
      'bash -c "psql -c \'select 1\'"',
      'cd app && sqlite3 app.db "select 1"',
      'echo "select 1" | psql',
      './scripts/sql.sh "select id, name from planets"',
      'pnpm prisma db execute --stdin <<< "SELECT * FROM planets"',
    ]) {
      expect(describeCommand(command).isDatabase).toBe(true)
    }
  })

  test('leaves every other command alone', () => {
    for (const command of [
      'ls -la',
      'git log --oneline',
      'cat README.md',
      'npm run mysqlish',
      'echo select all',
      'ls /etc/mysql',
      'docker inspect mysql',
      'git commit -m "select the right row from the list"',
      "jq 'select(.n>3)' data.json # from main",
      'grep -r psql docs/',
    ]) {
      expect(describeCommand(command).isDatabase).toBe(false)
    }
  })
})

describe('isDatabaseTool', () => {
  test('knows a database tool by its server or its name', () => {
    for (const tool of ['mcp__postgres__query', 'mcp__db__run', 'mcp__warehouse__execute_sql', 'mcp__sqlite__read_query']) {
      expect(isDatabaseTool(tool)).toBe(true)
    }

    for (const tool of ['mcp__calendar__list_events', 'mcp__files__search', 'mcp__docs__read']) {
      expect(isDatabaseTool(tool)).toBe(false)
    }
  })
})
