import { describe, expect, test } from 'claude-code/testing'

import { applyPens, inline, layout, penPieces, shownLines } from '../hooks/lib/marks'
import type { Segment } from '../hooks/lib/marks'

const MARKS = { hasMarks: true, hasBold: false, pens: [] }
const BOLD = { hasMarks: false, hasBold: true, pens: [] }

const highlighted = (segments: readonly Segment[]) =>
  segments.filter(segment => segment.isHighlighted === true).map(segment => segment.text)

describe('inline', () => {
  test('highlights a marked phrase and leaves the rest as written', () => {
    expect(inline('Use ==port 5433== for the replica.', MARKS)).toEqual([
      { text: 'Use ' },
      { text: 'port 5433', isHighlighted: true },
      { text: ' for the replica.' },
    ])
  })

  test('keeps bold, italic, code and links around and inside a mark', () => {
    const segments = inline('**Done**: ==run `make db` *now*== or see [the guide](https://example.com/g).', MARKS)

    expect(segments).toEqual([
      { text: 'Done', isBold: true },
      { text: ': ' },
      { text: 'run ', isHighlighted: true },
      { text: 'make db', isHighlighted: true, isCode: true },
      { text: ' ', isHighlighted: true },
      { text: 'now', isHighlighted: true, isItalic: true },
      { text: ' or see ' },
      { text: 'the guide', href: 'https://example.com/g' },
      { text: ' (https://example.com/g)', isDim: true },
      { text: '.' },
    ])
  })

  test('takes no comparison, code or unclosed mark for a highlight', () => {
    for (const text of [
      'if a == b and c == d then stop',
      'a==b and c==d',
      'compare with `x ==y== z` in code',
      'a mark that is ==still streaming',
      '== spaced == out',
      '====',
    ]) {
      expect(highlighted(inline(text, MARKS))).toEqual([])
    }
  })

  test('reads the marks as plain text when Claude is not asked for them', () => {
    expect(inline('Use ==port 5433== here.', BOLD)).toEqual([{ text: 'Use ==port 5433== here.' }])
  })

  test('highlights bold text when bold is the pen', () => {
    expect(highlighted(inline('The **root cause** is a *stale* cache.', BOLD))).toEqual(['root cause'])
  })

  test('leaves arithmetic and snake_case alone', () => {
    expect(inline('2 * 3 * 4 and snake_case_name and a*b*c', MARKS)).toEqual([
      { text: '2 * 3 * 4 and snake_case_name and a*b*c' },
    ])
  })
})

describe('applyPens', () => {
  test('highlights each occurrence of a phrase, whatever its case, across styles', () => {
    const segments = inline('The **retry** budget: Retry budget is 3.', MARKS)

    expect(highlighted(applyPens(segments, ['retry budget']))).toEqual(['retry', ' budget', 'Retry budget'])
    expect(applyPens(segments, ['retry budget']).map(segment => segment.text).join('')).toBe(
      'The retry budget: Retry budget is 3.',
    )
  })

  test('changes nothing where no phrase occurs', () => {
    const segments = inline('Nothing here.', MARKS)

    expect(applyPens(segments, ['absent'])).toEqual(segments)
  })
})

describe('penPieces', () => {
  test('takes a selection line by line, spaces folded, scraps dropped', () => {
    expect(penPieces('  first   line \n\nx\nsecond line')).toEqual(['first line', 'second line'])
  })
})

describe('layout', () => {
  test('leaves a reply with nothing to highlight to the engine, untouched', () => {
    const text = '# Title\n\nSome **bold** text.\n\n```js\nconst a = b == c\n```\n'

    expect(layout(text, MARKS)).toEqual({ kind: 'plain', text })
  })

  test('draws the block that holds a mark and hands the others to markdown', () => {
    const laid = layout(
      ['Intro paragraph.', '', '- first', '- ==second== item', '  wrapped here', '', '```sh', 'echo ==no==', '```', '', 'Outro.'].join('\n'),
      MARKS,
    )

    expect(laid).toEqual({
      kind: 'blocks',
      blocks: [
        { kind: 'markdown', text: 'Intro paragraph.' },
        {
          kind: 'lines',
          lines: [
            { prefix: '- ', segments: [{ text: 'first' }] },
            { prefix: '- ', segments: [{ text: 'second', isHighlighted: true }, { text: ' item' }] },
            { prefix: '  ', segments: [{ text: 'wrapped here' }] },
          ],
        },
        { kind: 'markdown', text: '```sh\necho ==no==\n```\n\nOutro.' },
      ],
    })
  })

  test('keeps each line of a block as written: numbers, headings, quotes, plain lines', () => {
    const laid = layout(['## The ==plan==', '1. one', '2) two', '> quoted', 'tail'].join('\n'), MARKS)

    expect(laid.kind).toBe('blocks')

    if (laid.kind === 'blocks' && laid.blocks[0]?.kind === 'lines') {
      expect(laid.blocks[0].lines.map(line => line.prefix)).toEqual(['', '1. ', '2) ', '▎ ', ''])
      expect(laid.blocks[0].lines[0]?.segments).toEqual([
        { text: 'The ', isBold: true },
        { text: 'plan', isBold: true, isHighlighted: true },
      ])
    }
  })

  test('makes a mark inside a table bold, since a cell cannot be drawn marked', () => {
    const text = '| a | b |\n|---|---|\n| ==x== | y |'

    expect(layout(text, MARKS)).toEqual({ kind: 'plain', text: '| a | b |\n|---|---|\n| **x** | y |' })
  })

  test('never highlights a heading for being bold', () => {
    const laid = layout('# Heading\n\nA **key** point.', BOLD)

    expect(laid).toEqual({
      kind: 'blocks',
      blocks: [
        { kind: 'markdown', text: '# Heading' },
        {
          kind: 'lines',
          lines: [
            {
              prefix: '',
              segments: [{ text: 'A ' }, { text: 'key', isBold: true, isHighlighted: true }, { text: ' point.' }],
            },
          ],
        },
      ],
    })
  })

  test('highlights the person’s own phrase wherever a reply holds it', () => {
    const laid = layout('The cache is stale.\n\nFlush the Cache first.', { hasMarks: false, hasBold: false, pens: ['cache'] })

    expect(laid.kind).toBe('blocks')

    if (laid.kind === 'blocks') {
      expect(laid.blocks.flatMap(block => (block.kind === 'lines' ? block.lines.flatMap(line => highlighted(line.segments)) : []))).toEqual(['cache', 'Cache'])
    }
  })
})

describe('inline, the hard cases', () => {
  const text = (source: string) => inline(source, MARKS).map(segment => segment.text).join('')

  test('takes shell comparisons and a mark that would cut a code span for plain text', () => {
    for (const source of ['test "$a"=="$b" || "$c"=="$d"', 'a ==b `c==` d', 'x==y==z']) {
      expect(highlighted(inline(source, MARKS))).toEqual([])
      expect(text(source).replace(/`/g, '')).toBe(source.replace(/`/g, ''))
    }
  })

  test('marks a phrase that stands after an opening bracket or before punctuation', () => {
    expect(highlighted(inline('(==first==) and ==second==, then ==third==.', MARKS))).toEqual(['first', 'second', 'third'])
  })

  test('reads bold italic, and leaves the underscores of a name alone', () => {
    expect(inline('***both*** and my__dunder__name', MARKS)).toEqual([
      { text: 'both', isBold: true, isItalic: true },
      { text: ' and my__dunder__name' },
    ])
  })

  test('shows where a link goes, brackets in its address included', () => {
    expect(inline('See [wiki](https://en.wikipedia.org/wiki/A_(b)).', MARKS)).toEqual([
      { text: 'See ' },
      { text: 'wiki', href: 'https://en.wikipedia.org/wiki/A_(b)' },
      { text: ' (https://en.wikipedia.org/wiki/A_(b))', isDim: true },
      { text: '.' },
    ])
    expect(inline('[https://example.com](https://example.com)', MARKS)).toEqual([
      { text: 'https://example.com', href: 'https://example.com' },
    ])
  })
})

describe('applyPens, the hard cases', () => {
  test('still finds a phrase on a line whose letters change length in lower case', () => {
    expect(highlighted(applyPens([{ text: 'The İstanbul cache' }], ['cache']))).toEqual(['cache'])
  })

  test('matches whole words only when asked to', () => {
    const segments = [{ text: 'There is another notice about the keyboard, not the key.' }]

    expect(highlighted(applyPens(segments, ['not', 'the key'], true))).toEqual(['not', 'the key'])
    expect(highlighted(applyPens(segments, ['not'], false))).toEqual(['not', 'not', 'not'])
  })
})

describe('layout, the hard cases', () => {
  test('keeps the sharp of a heading that ends in one', () => {
    const laid = layout('## Using C# with ==care==', MARKS)

    expect(laid.kind === 'blocks' && laid.blocks[0]?.kind === 'lines' ? laid.blocks[0].lines[0]?.segments.map(segment => segment.text).join('') : '').toBe('Using C# with care')
  })

  test('keeps the lines of a paragraph apart, as the reply wrote them', () => {
    const laid = layout('Key facts:\nPort: ==5432==\nHost: localhost', MARKS)

    expect(laid.kind === 'blocks' && laid.blocks[0]?.kind === 'lines' ? laid.blocks[0].lines.map(line => line.segments.map(segment => segment.text).join('')) : []).toEqual(['Key facts:', 'Port: 5432', 'Host: localhost'])
  })

  test('leaves code indented by four spaces to the engine', () => {
    const text = 'Run:\n\n    echo ==no==\n\nThen ==yes==.'
    const laid = layout(text, MARKS)

    expect(laid).toEqual({
      kind: 'blocks',
      blocks: [
        { kind: 'markdown', text: 'Run:\n\n    echo ==no==' },
        { kind: 'lines', lines: [{ prefix: '', segments: [{ text: 'Then ' }, { text: 'yes', isHighlighted: true }, { text: '.' }] }] },
      ],
    })
  })

  test('rewrites nothing inside a fence, whatever the fence holds', () => {
    const text = ['~~~', '```', '| a | b |', '|---|---|', '| ==b== | c |', '~~~', '', '| x | y |', '|---|---|', '| ==x== | y |'].join('\n')
    const laid = layout(text, MARKS)

    expect(laid.kind).toBe('plain')
    expect(laid.kind === 'plain' ? laid.text.split('\n')[4] : '').toBe('| ==b== | c |')
    expect(laid.kind === 'plain' ? laid.text.split('\n').at(-1) : '').toBe('| **x** | y |')
  })
})

describe('shownLines', () => {
  test('gives the text of a reply as its prose draws it, code and tables aside', () => {
    expect(shownLines('The **root** cause: `a == b`.\n\n```\ncode ==here==\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- See [the guide](https://example.com).')).toEqual([
      'The root cause: a == b.',
      'See the guide (https://example.com).',
    ])
  })
})
