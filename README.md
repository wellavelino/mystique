# mystique

A mod for [Claude Code](https://claude.com/claude-code) that changes how you read its output:

- **A highlighter pen.** The phrases that matter in a reply are drawn with a bright background, the way you would mark a page with a pen. A second, small model reads each reply and marks it for you, and tells you what the reply left out. You can add your own marks too.
- **A side panel with two tabs.**
  - **Tables:** when Claude runs a query, the result shows as a real table, 20 rows at a time, `+20 more` on a press, any row opened as a full record.
  - **Agents:** the goal, the task list, and a card for the main thread and every subagent: what it is doing, how full its context is, and how much of the session's use is its own.
- **A progress band** above the prompt with the same figures in one line per thread.

## Install

In a Claude Code terminal session, type:

```
/plugin install mystique --marketplace wellavelino/mystique
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session). It is active at once, with no restart.

Requires a Claude Code build with function-hook mods (written against 2.1.296). That API is early access and may change between releases.

## The highlighter

Models spit a lot of text and in most cases due to lack of attention we miss important details, it highlights things that are important in the context you working

 When a turn ends, a second reader looks at the reply and:

- names up to four phrases you must not miss (the result, a decision made for you, a number that matters, a warning, something you now have to do), which are drawn as pen marks in that reply, and in no other;
- adds one line under the reply when something was left out or played down, such as a command that failed:

```
● mystique: Second reader: the migration command exited with code 3, which the reply does not mention.
```

Only you see that line; it is not sent to Claude. The review runs after the turn, so it never holds your prompt back. Replies under 200 characters, subagents' replies and interrupted turns are not read, and nothing is read where no surface draws the reply (`claude -p`).

**What it costs.** One extra model call per turn. By default the reader is `haiku` and is given the reply, what you asked for, and a count of the tool calls with the ones that failed: a few thousand tokens. In `/config` you can change the model, or switch the reader to `session`: a fork of the session on its own model, which sees the whole conversation (tool output included) and costs a cached re-read of it. Set the highlighter to `claude` to have the replying model mark its own text instead, with no extra call, or to `off`.

Your own pen:

| Command | What it does |
| --- | --- |
| `/highlight` | Highlights the text you selected with the mouse in the transcript (fullscreen terminal). |
| `/highlight some phrase` | Highlights that phrase wherever the prose of a reply holds it, in any case. Code blocks and tables are left as they are. |
| `/highlight clear` | Removes your marks and the second reader's. The ones Claude wrote into a reply stay. |

Marks last for the session.

## The panel

It opens beside the transcript (docked in the fullscreen layout, above the prompt otherwise) when there is something to show: a query result, or a subagent starting. On a narrow terminal an unasked panel waits instead of taking the screen, and a toast tells you a table was captured. Set **Panel** to `manual` in `/config` and it opens only when you ask for it.

<img width="985" height="320" alt="image" src="https://github.com/user-attachments/assets/24b6fa38-b39c-4c83-a4c0-2b835f4d0e51" />

| Command | What it does |
| --- | --- |
| `/tables` | Opens the panel on the tables captured so far. |
| `/tables clear` | Forgets them. The `clear` button in the panel does the same. |
| `/progress` | Opens the panel on the goal, every task and every subagent, and answers with the same list in words. It reads Claude Code's own task list first, where the session has one. |
| `/progress clear` | Forgets the tasks and the subagents on the board, and the main thread's last calls and thought. The goal and the figures stay. |

Click in it, or give it the keyboard with `ctrl+x tab`: `t` and `g` switch between Tables and Agents, `Esc` hands the keyboard back. Close it with its close mark or `ctrl+x x`; once you close it by hand it stays closed until you ask for it again.

### Tables

Run a query the way you always do, or let Claude run it:

```
> how many moons does each planet have? the db is ./space.db
```
<img width="984" height="610" alt="image" src="https://github.com/user-attachments/assets/734b2e96-cdc6-4adf-a2c4-445999f83949" />


| Button | Key | What it does |
| --- | --- | --- |
| `+20 more` | `m` | Shows the next 20 rows. |
| `+100` | `a` | Shows the next 100. At most 100 rows are drawn at once: past that the page slides (`rows 21-120 of 300`). |
| `first 20` | `f` | Back to the first page. |
| a row's number | | Opens the row as a record: every column, values unwrapped. `b` goes back, `p` / `n` step through rows. |
| `◀` `▶` | `h` `l` | Slides the columns when the panel is too narrow for all of them. |
| `‹` `›` | `p` `n` | Walks between the captured tables (the last 10 are kept). |
| `clear` | `c` | Forgets every captured table, as `/tables clear` does. It asks nothing first, and there is no way back. |

What is read as a table:

| Source | When |
| --- | --- |
| `psql` | aligned output (the default), expanded `-x` records, `--csv`, unaligned `-A` |
| `mysql`, `mariadb` | the boxed result grid, or tab-separated batch output |
| `sqlite3` | `-box`, `-table`, `-markdown`, `-column`, `-csv`, `-json`, the default list mode |
| `duckdb` and other clients | unicode or ASCII boxes, markdown, CSV, JSON |
| a database MCP tool | a JSON list of records, `{ columns, rows }`, or a markdown table |
| Claude's own reply | a markdown table (listed in the panel, without taking it over) |

A command counts as a database one when it names a client (`psql`, `mysql`, `sqlite3`, `duckdb`, `clickhouse-client`, `sqlcmd`, `bq`, ...) or carries a `select ... from`. Any other command is read only when its output has a database client's own shape (psql's ruled header, a box with a header rule), so `cat README.md` or `ls` does not fill the panel. A subagent's queries are captured too.

Output without any frame (CSV, tab-separated, `-A`, sqlite's list mode) is read only from a database command, and only with two columns or more: one bare column of values cannot be told from any other text. A cell longer than 2,000 characters is kept to that.

### Agents

| Card | What it shows |
| --- | --- |
| Goal | What you gave Claude Code's own `/goal`; without one, the prompt being worked on. Under it the task list Claude keeps (its todo and task tools): a bar of done over total, then every task with a bar of its own (of a list longer than 60, the stretch around the task in progress). A task has no percent, so a done one is a full bar, a waiting one an empty bar, and the one in progress a bar that moves. |
| Main thread | How full its context window is, its share of what the session spent, and your rate-limit windows (`5h`, `7d`). Then its last five tool calls, the end of what it last thought, and a field to tell it what to do next. |
| one per subagent | Its name and type, whether it runs and for how long, its tool calls and the one running now, its context, its share of the session's use, and its own tasks, each with its bar, when it keeps a list. Then its last five tool calls, each with what it was made on (the command, the file, the pattern; a failed one marked `✖`), the end of what it last thought, and, while it runs, a field to send it a message. Its mark turns while it runs. Finished agents leave with your next prompt; what they spent stays in the session's total. |

What moves is redrawn four times a second, and only while the Agents tab is on screen and something is in progress. Claude keeps a task list for work with several steps: with none, the Goal card says so.

**Steering from a card.** Click a card's field (or reach it with the keyboard once the panel has it), type, and press Enter. On a subagent's card the line goes to that subagent's inbox, and it reads it at its next model request: "stop after this file" stops it there, not in the middle of the call it is making. On the Main thread card it is submitted as a prompt of your own, which runs once the turn in progress ends. A toast says it was sent; when it was not, a line in the transcript says why. In auto mode Claude Code refuses a mod's own message to a subagent (its classifier judges only what a model request asked for), so the mod asks the main thread to pass your line on with its own `SendMessage` instead, which costs one short turn. That needs the main thread to be idle (the agent running in the background): while its turn is in progress nobody can pass the line on, and the transcript says so. While a field has the keyboard the panel's letter keys are typed into it; `Esc` hands them back. Nothing here interrupts a model request that is already under way.

**What "thinking" shows.** The last paragraph of the thread's thinking at its latest model request, as it streamed. A subagent that thought nothing shows what it last said instead, labelled `said` (its own words are drawn nowhere else); the main thread's reply is left to the transcript. The row is there only when Claude Code hands the thinking out as text: where the model's thinking is kept back (the transcript then holds an empty thinking block, as with the current models by default), with thinking off, or for an agent that runs elsewhere (a remote one), there is none to show.

**The main thread is not told what you sent.** A message that reaches a subagent directly is between you and that agent: if its report mentions being told to change course, Claude may say it sent no such message.

**Where the tasks come from.** Claude Code's own task tools (`TodoWrite`, or `TaskCreate` and `TaskUpdate`) where the session's model has them. Where it has none, the mod gives the model one of its own, `mcp__mystique__tasks`, which only keeps the list for the panel and the band: about 150 tokens of tool description in the prompt, and one short tool call each time a step starts or ends. It needs no permission prompt. Set **Task list tool** to `off` in `/config` to leave it out.

The band above the prompt shows the same in one line per thread; it appears once there is a goal, a task list or a subagent, and can be turned off.

## Settings

`/config` lists these rows for mystique:

| Setting | Values | Default |
| --- | --- | --- |
| Highlighter | `reader` (a second model marks each reply), `claude` (the replying model marks its own text), `both`, `bold` (every bold phrase), `off` (only your own `/highlight` marks) | `reader` |
| Pen color | `yellow`, `green`, `pink`, `blue`, `orange` | `yellow` |
| Second reader | `fast` (the model below, given the reply and a tool-call digest), `session` (a fork of the session, which sees everything) | `fast` |
| Second reader model | a model alias or id, used by `fast` | `haiku` |
| Table capture | `databases`, `everything` (any table-shaped tool output), `off` | `databases` |
| Progress band | `on`, `off` | `on` |
| Panel | `auto` (opens for a query result or a new subagent), `manual` (opens on `/tables` or `/progress` only) | `auto` |
| Task list tool | `auto` (the model gets the mod's task tool where Claude Code gives it none), `off` | `auto` |

## Good to know

- **Your data stays where it is.** The mod makes no network call of its own and writes no file. Captured rows, marks and the board live in the session's memory and go with it. The second reader is a model call through your own Claude Code session, like any other.
- **The panel pages what the query returned.** It never talks to your database. If the query had a `LIMIT 50`, there are 50 rows to page through; a result longer than 2,000 rows keeps its first 2,000 and says so.
- **The figures are measurements and estimates.** Context is what each thread's last model request held; a subagent's percent is taken against the main thread's window. "Of session" is a thread's share of all the tokens the session spent since the mod loaded, weighed the way the API prices one kind against another (output five times an input token, a cache write one and a quarter, a cache read a tenth). It does not know that one model costs more than another, so read it as a share of the work, not of the bill. A goal stays on the board until you clear it with `/goal clear`.
- **The second reader can be wrong.** The fast one sees the reply and a count of tool calls, not their output. Read its line as a prompt to check, not as a finding. Its marks are drawn only where the reply shows the phrase word for word, as whole words, on one line.
- **The `claude` highlighter adds one short section to the system prompt** (about 120 words) asking for `==marks==`. No other setting touches the prompt. Where nothing draws the reply (`claude -p`), the section is not sent.
- **A paragraph that holds a mark is drawn by the mod**, line by line as the reply wrote it, with its bold, italics, inline code, list markers and links (a link's address is shown beside its label); code blocks, tables and every other paragraph stay the engine's own drawing. A `==mark==` inside a table cell is drawn bold instead, and your own pens do not reach into code blocks or tables.
- Works on every surface that draws mods; built and tried in the terminal.

## Development

```sh
git clone https://github.com/wellavelino/mystique
claude --plugin-dir ./mystique     # loads the mod from disk and reloads it on save
```

```sh
claude plugin validate .           # what the engine reads, and all it would refuse
claude plugin test .               # the test suite, run against the engine itself
```

When Claude Code loads the mod from a folder it lays the API's types beside it (`.claude-plugin/types/`, never committed), and `npx -p typescript tsc -p .` type-checks against them.

```
hooks/register.tsx     the hooks: drawing, capture, tracking, commands
hooks/lib/marks.ts     which text is highlighted, and how a marked paragraph is laid out
hooks/lib/review.ts    what the second reader is asked, and reading its answer
hooks/lib/tables.ts    reading a table out of a tool's output
hooks/lib/grid.ts      fitting columns into the panel
hooks/lib/board.ts     the goal, the tasks, the agents, their context and use
types/index.d.ts       the state the mod keeps
tests/                 parsers, layout, and the panel, highlighter, band and second reader on terminal and desktop
```

## License

[MIT](LICENSE)
