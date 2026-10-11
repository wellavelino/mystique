import { describe, expect, test } from 'claude-code/testing'

import { counted, digestText, fingerprints, forkPrompt, NO_CALLS, parseReview, phrasesFor, plain, reviewRequest } from '../hooks/lib/review'

const ANSWER = 'The migration is **applied**, but `2 of 14 tests` still fail.\n\nYou need to rotate the API key before Friday.'

describe('parseReview', () => {
  test('keeps the phrases the reply holds, as the reply shows them', () => {
    const review = parseReview(
      '{"highlights": ["2 of 14 tests still fail", "rotate the API key before Friday", "The migration is **applied**"], "missed": "The lint step was skipped."}',
      ANSWER,
    )

    expect(review).toEqual({
      phrases: ['2 of 14 tests still fail', 'rotate the API key before Friday', 'The migration is applied'],
      missed: 'The lint step was skipped.',
    })
  })

  test('drops a phrase the reply does not hold, a lone short word, repeats, and more than four', () => {
    const review = parseReview(
      JSON.stringify({ highlights: ['all tests pass', 'applied', 'applied', 'tests', 'still fail', 'API key', 'Friday', 7], missed: '' }),
      ANSWER,
    )

    expect(review.phrases).toEqual(['applied', 'still fail', 'API key', 'Friday'])
  })

  test('reads the object out of a reply that wraps it, and takes "none" for nothing', () => {
    const review = parseReview('Here you go:\n```json\n{"highlights": ["still fail"], "missed": "None."}\n```', ANSWER)

    expect(review).toEqual({ phrases: ['still fail'], missed: '' })
  })

  test('takes a phrase only where the reply draws it: whole words, on one line, outside code', () => {
    const answer = 'The key is not rotated.\n\n```\nrm -rf build output\n```\n\nSee the [guide](https://example.com) and\nrestart the worker.'
    const review = parseReview(
      JSON.stringify({ highlights: ['rm -rf build output', 'he key is', 'guide and restart', 'ROTATED', 'restart the  worker'], missed: '' }),
      answer,
    )

    expect(review.phrases).toEqual(['ROTATED', 'restart the worker'])
  })

  test('takes a reader that says nothing was missed at its word', () => {
    for (const missed of ['Nothing was missed.', 'No.', 'none', 'N/A', 'Nothing important was left out.', 'The reply left nothing out.', 'Nothing.', 'Nothing significant was omitted']) {
      expect(parseReview(JSON.stringify({ highlights: [], missed }), ANSWER).missed).toBe('')
    }

    expect(parseReview('{"highlights": [], "missed": "No tests were run after the change."}', ANSWER).missed).toBe(
      'No tests were run after the change.',
    )
  })

  test('keeps a terminal’s control characters out of what it says was missed', () => {
    const review = parseReview(JSON.stringify({ highlights: [], missed: 'The \u001b[31mlint\u001b[0m step\u0007 was\nskipped.' }), ANSWER)

    expect(review.missed).toBe('The lint step was skipped.')
  })

  test('finds nothing in a reply that is no JSON', () => {
    for (const text of ['', 'I could not review this.', '{"highlights": [', '[1, 2]', '"text"']) {
      expect(parseReview(text, ANSWER)).toEqual({ phrases: [], missed: '' })
    }
  })
})

describe('reviewRequest', () => {
  test('hands over what was asked, the tool digest and the reply, a long reply cut', () => {
    const request = reviewRequest('ship it', 'x'.repeat(13_000), '3 tool calls, 1 failed')

    expect(request).toMatch(/<asked>\nship it\n<\/asked>/)
    expect(request).toMatch(/1 failed/)
    expect(request).toMatch(/\[cut\]\n<\/reply>$/)
    expect(request.length).toBeLessThan(12_200)
  })
})

describe('forkPrompt', () => {
  test('shows the fork which reply it is asked about', () => {
    expect(forkPrompt('All **done**.')).toMatch(/second reader[\s\S]*<reply>\nAll \*\*done\*\*\.\n<\/reply>/)
  })
})

describe('fingerprints', () => {
  test('tell a block of the reply that was read from any other text', () => {
    const readings = [{ lines: fingerprints(ANSWER), phrases: ['still fail'] }, { lines: fingerprints('Some other reply, long enough.'), phrases: ['other'] }]

    expect(phrasesFor(readings, 'You need to rotate the API key   before Friday.')).toEqual(['still fail'])
    expect(phrasesFor(readings, 'Intro.\n\nThe migration is **applied**, but `2 of 14 tests` still fail.')).toEqual(['still fail'])
    expect(phrasesFor(readings, 'Another reply: rotate the API key before Friday.')).toEqual([])
    expect(phrasesFor([], ANSWER)).toEqual([])
  })
})

describe('plain', () => {
  test('reads text as a reply shows it', () => {
    expect(plain('The **root**  cause is\n`stale` ==cache==.')).toBe('The root cause is stale cache.')
  })
})

describe('the digest', () => {
  test('counts the calls of each thread and keeps the first line of each failure', () => {
    let digest = counted(NO_CALLS, 'Bash', false, undefined)
    digest = counted(digest, 'Bash', false, 'exit code 3\nstack trace')
    digest = counted(digest, 'Grep', true, undefined)
    digest = counted(digest, 'Read', true, 'no such file')

    expect(digest).toEqual({
      calls: 2,
      agentCalls: 2,
      failures: ['Bash failed: exit code 3', "a subagent's Read failed: no such file"],
    })
    expect(digestText(digest)).toBe(
      "The assistant made 2 tool calls itself and its subagents made 2 tool calls.\nThese failed:\n- Bash failed: exit code 3\n- a subagent's Read failed: no such file",
    )
    expect(digestText(NO_CALLS)).toMatch(/0 tool calls itself .* 0 tool calls\.\nNone of them failed\./)
  })

  test('keeps at most five failures', () => {
    let digest = NO_CALLS

    for (let index = 0; index < 8; index += 1) {
      digest = counted(digest, 'Bash', false, `failure ${index}`)
    }

    expect(digest.failures.length).toBe(5)
    expect(digest.calls).toBe(8)
  })
})
