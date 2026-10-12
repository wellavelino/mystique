import { applyPens, shownLines, shownText } from './marks'

/** What the second reader found in a turn: phrases of the reply to highlight, and what it left out. */
export type Review = { phrases: string[]; missed: string }

const MAX_PHRASES = 4
const MAX_PHRASE = 160
const MAX_MISSED = 300
const MAX_ANSWER = 12_000

const RULES = `Answer with one JSON object and nothing else, no code fence:
{"highlights": ["..."], "missed": "..."}

"highlights": at most ${MAX_PHRASES} phrases copied word for word from the assistant's last reply, each 2 to 12 words, that the person must not miss: the result, a decision made for them, a number that matters, a warning, something they now have to do. Copy exactly, without markdown symbols. An empty list when nothing stands out.

"missed": one plain sentence naming the most important thing about this turn's work that the reply left out or played down (a command that failed, a step skipped, an assumption made, a risk taken), or "" when there is none. Do not repeat what the reply already says clearly.`

const cut = (answer: string) => (answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n[cut]` : answer)

/** The question a fork of the session is asked: it has the whole transcript before it. */
export function forkPrompt(answer: string): string {
  return `Stop working on the task. You are now a second reader checking the assistant's last reply to the person, with this whole conversation, its tool calls and their results before you. This is the reply:

<reply>
${cut(answer)}
</reply>

${RULES}`
}

/** The system prompt of a reader that sees only the turn's reply and a digest of its tool calls. */
export const REVIEW_SYSTEM = `You are a second reader of an AI coding assistant's reply to the person it works for. You are given what the person asked for, the assistant's reply, and a digest of the tool calls made since they asked.

The digest only counts tool calls and lists the ones that failed. It is not the record of the work: never conclude from it that something was not done, was made up or was skipped. Use it for one thing, a failure the reply does not mention.

${RULES}`

/** What a turn's tool calls came to, for a reader that cannot see them. */
export type Digest = { calls: number; agentCalls: number; failures: string[] }

export const NO_CALLS: Digest = { calls: 0, agentCalls: 0, failures: [] }

const MAX_FAILURES = 5

/** `digest` after one more tool call: counted on its thread, kept by name when it failed. */
export function counted(digest: Digest, tool: string, isAgent: boolean, failure: string | undefined): Digest {
  const said = failure?.trim().split('\n')[0]?.slice(0, 160)
  const failures =
    said === undefined || digest.failures.length >= MAX_FAILURES
      ? digest.failures
      : [...digest.failures, `${isAgent ? 'a subagent\'s ' : ''}${tool} failed: ${said}`]

  return {
    calls: digest.calls + (isAgent ? 0 : 1),
    agentCalls: digest.agentCalls + (isAgent ? 1 : 0),
    failures,
  }
}

/** The digest as the reader is given it. */
export function digestText(digest: Digest): string {
  const count = (calls: number) => `${calls} tool call${calls === 1 ? '' : 's'}`

  return [
    `The assistant made ${count(digest.calls)} itself and its subagents made ${count(digest.agentCalls)}.`,
    digest.failures.length === 0 ? 'None of them failed.' : 'These failed:',
    ...digest.failures.map(failure => `- ${failure}`),
  ].join('\n')
}

/** What that reader is given. */
export function reviewRequest(aim: string, answer: string, digest: string): string {
  return [
    `<asked>\n${aim || '(not known)'}\n</asked>`,
    `<tool_calls>\n${digest || '(none)'}\n</tool_calls>`,
    `<reply>\n${cut(answer)}\n</reply>`,
  ].join('\n\n')
}

/** Text as a reply shows it: its markdown symbols gone, its spaces single. */
export function plain(text: string): string {
  return text
    .replace(/==|\*\*|__|~~|[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const MAX_LINES = 300
const MIN_LINE = 12

/** A line as a number: the same for the same words, whatever the spaces between them. */
function fingerprint(line: string): number {
  let hash = 2166136261

  for (let index = 0; index < line.length; index += 1) {
    hash = Math.imul(hash ^ line.charCodeAt(index), 16777619)
  }

  return hash >>> 0
}

/** The lines of a reply long enough to tell it by, each as a number. */
export function fingerprints(text: string): number[] {
  return text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= MIN_LINE)
    .slice(0, MAX_LINES)
    .map(fingerprint)
}

/** What a reader marked in one reply: the reply's lines, as fingerprints, and the phrases. */
type Marked = { lines: readonly number[]; phrases: readonly string[] }

/** The phrases marked in the reply that `text` is a block of: those of each reading it shares a line with. */
export function phrasesFor(readings: readonly Marked[], text: string): string[] {
  if (readings.length === 0) {
    return []
  }

  const lines = new Set(fingerprints(text))

  return readings.filter(reading => reading.lines.some(line => lines.has(line))).flatMap(reading => reading.phrases)
}

const NOTHING =
  /^(none|n\/a|no|nothing)\.?$|\bnothing\b.{0,40}\b(missed|left out|omitted|played down|to add|to report|stands out)\b|\bleft nothing out\b/i

/** What a reader said was missed, fit to print: one line, no control characters, "" for "nothing". */
function missing(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  const said = plain(value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '))

  return NOTHING.test(said) ? '' : said.slice(0, MAX_MISSED)
}

/** Whether a phrase is worth a mark: two words, or one long enough not to be everywhere. */
const isTelling = (phrase: string) => phrase.length <= MAX_PHRASE && (phrase.includes(' ') ? phrase.length >= 3 : phrase.length >= 6)

/** A reader's reply as a review: the phrases the reply really shows, and the sentence on what it missed. */
export function parseReview(text: string, answer: string): Review {
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  let data: unknown

  try {
    data = JSON.parse(text.slice(from, to + 1))
  } catch {
    return { phrases: [], missed: '' }
  }

  if (typeof data !== 'object' || data === null) {
    return { phrases: [], missed: '' }
  }

  const { highlights, missed } = data as { highlights?: unknown; missed?: unknown }
  const lines = shownLines(answer)
  // A phrase no line of the reply shows could never be drawn, and may be made up.
  const isShown = (phrase: string) =>
    lines.some(line => applyPens([{ text: line }], [phrase], true).some(segment => segment.isHighlighted === true))
  const phrases = (Array.isArray(highlights) ? highlights : [])
    .filter((phrase): phrase is string => typeof phrase === 'string')
    .map(phrase => shownText(phrase).replace(/\s+/g, ' ').trim())
    .filter(phrase => isTelling(phrase) && isShown(phrase))

  return { phrases: [...new Set(phrases)].slice(0, MAX_PHRASES), missed: missing(missed) }
}
