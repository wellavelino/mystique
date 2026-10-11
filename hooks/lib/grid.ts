import type { Cell } from '../../types'

export const NULL = 'NULL'

const NARROWEST = 3
const WIDEST = 28
const WIDEST_GROWN = 60
const GAP = 2
const SLIVER = 8

export type Fit = {
  /** How many columns are drawn, from the first asked for. */
  count: number
  /** The cells each drawn column takes. */
  widths: number[]
  /** The cells the row number takes. */
  numberWidth: number
}

const LONGEST = 400

/** What a cell shows on one line of the grid: the start of a long value, its line breaks marked. */
export function shown(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? NULL : cell.slice(0, LONGEST).replace(/\s*\n\s*/g, ' ⏎ ')
}

const width = (text: string) => [...text].length

/** `text` cut to `cells`, the cut marked: what is drawn is never longer than its column. */
export function clip(text: string, cells: number): string {
  // A letter is one or two units long: only the start of a long text is ever taken apart.
  const reach = cells * 2 + 2
  const letters = [...text.slice(0, reach)]

  return text.length <= reach && letters.length <= cells
    ? text
    : `${letters.slice(0, Math.max(0, cells - 1)).join('')}…`
}

/**
 * Which columns fit `room` cells, starting at column `from`, and how wide each is drawn:
 * as wide as its longest value up to a cap, the last ones growing into what is left.
 */
export function fitColumns(
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
  from: number,
  room: number,
  lastRow: number,
): Fit {
  const numberWidth = Math.max(2, String(lastRow).length)
  const longest = columns.map((name, index) =>
    rows.reduce((most, row) => Math.max(most, width(shown(row[index]))), width(name)),
  )
  const widths: number[] = []
  let left = room - numberWidth

  for (let index = from; index < columns.length; index += 1) {
    const wanted = Math.min(WIDEST, Math.max(NARROWEST, longest[index] ?? NARROWEST))

    if (wanted + GAP > left && widths.length > 0) {
      // What is left still shows the start of one more column, when it is worth reading.
      if (left - GAP >= SLIVER) {
        widths.push(left - GAP)
        left = 0
      }

      break
    }

    const taken = Math.max(NARROWEST, Math.min(wanted, left - GAP))
    widths.push(taken)
    left -= taken + GAP
  }

  if (from + widths.length === columns.length) {
    for (let index = 0; index < widths.length && left > 0; index += 1) {
      const most = Math.min(WIDEST_GROWN, longest[from + index] ?? 0)
      const more = Math.min(left, Math.max(0, most - (widths[index] ?? 0)))
      widths[index] = (widths[index] ?? 0) + more
      left -= more
    }
  }

  return { count: widths.length, widths, numberWidth }
}

const NUMBER = /^[-+]?[\d,]*\.?\d+(e[-+]?\d+)?%?$/i

/** Whether a column reads as numbers in these rows, and so is drawn against the right edge. */
export function isNumeric(rows: readonly (readonly Cell[])[], index: number): boolean {
  let count = 0

  for (const row of rows) {
    const cell = row[index]

    if (cell === null || cell === undefined || cell === '') {
      continue
    }

    if (!NUMBER.test(cell)) {
      return false
    }

    count += 1
  }

  return count > 0
}
