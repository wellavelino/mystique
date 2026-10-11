import { describe, expect, test } from 'claude-code/testing'

import { clip, fitColumns, isNumeric, shown } from '../hooks/lib/grid'

const ROWS = [
  ['1', 'Mercury', 'the closest planet to the sun, with no moons at all'],
  ['2', 'Venus', null],
]

describe('fitColumns', () => {
  test('draws every column when the room holds them, the last growing into what is left', () => {
    const fit = fitColumns(['id', 'name', 'note'], ROWS, 0, 80, 2)

    expect(fit.count).toBe(3)
    expect(fit.widths[0]).toBe(3)
    expect(fit.widths[1]).toBe(7)
    expect(fit.widths[2]).toBe(51)
    expect(fit.numberWidth + fit.widths.reduce((sum, width) => sum + width + 2, 0)).toBeLessThanOrEqual(80)
  })

  test('draws the columns that fit a narrow dock and starts where asked', () => {
    const narrow = fitColumns(['id', 'name', 'note'], ROWS, 0, 24, 2)
    const moved = fitColumns(['id', 'name', 'note'], ROWS, 2, 24, 2)

    expect(narrow.widths).toEqual([3, 7])
    expect(moved.count).toBe(1)
    expect(moved.widths[0]).toBeLessThanOrEqual(20)
  })

  test('shows the start of one more column in what is left, unless too little to read', () => {
    expect(fitColumns(['id', 'name', 'note'], ROWS, 0, 28, 2).widths).toEqual([3, 7, 10])
    expect(fitColumns(['id', 'name', 'note'], ROWS, 0, 20, 2).widths).toEqual([3, 7])
  })

  test('always draws one column, however little room there is', () => {
    expect(fitColumns(['a very long column name'], [], 0, 6, 0).count).toBe(1)
  })
})

describe('isNumeric', () => {
  test('tells a column of numbers from one of words, blanks aside', () => {
    const rows = [
      ['1', '12.50', 'x', null],
      ['2', '-3,000', '4', null],
      ['', '15%', '5', null],
    ]

    expect([0, 1, 2, 3].map(index => isNumeric(rows, index))).toEqual([true, true, false, false])
  })
})

describe('shown', () => {
  test('draws no value as NULL and a line break as a mark', () => {
    expect(shown(null)).toBe('NULL')
    expect(shown('a\n  b')).toBe('a ⏎ b')
  })
})

describe('clip', () => {
  test('cuts a text to its column and marks the cut', () => {
    expect(clip('Mercury', 7)).toBe('Mercury')
    expect(clip('Mercury', 5)).toBe('Merc…')
    expect(clip('😀😀😀', 3)).toBe('😀😀😀')
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…')
    expect(clip('x'.repeat(100_000), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  test('shows only the start of a very long cell', () => {
    expect(shown('x'.repeat(100_000)).length).toBe(400)
  })
})
