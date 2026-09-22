import { describe, expect, it } from 'vitest';
import { ANSWER_SCHEMA, parseModelAnswer } from './answer.ts';

const valid = {
  answerable: true,
  sentences: ['Focus must stay visible.', 'It is a Level AA requirement.'],
  claims: [{ sentenceIndex: 0, chunkIds: ['c1'], quote: 'the component is not entirely hidden' }],
};

describe('parseModelAnswer', () => {
  it('resolves a claim to the sentence it points at', () => {
    const { answer, dropped } = parseModelAnswer(valid);
    expect(dropped).toEqual([]);
    expect(answer.claims[0]!.sentence).toBe('Focus must stay visible.');
    expect(answer.sentences).toHaveLength(2);
  });

  it('accepts a refusal, which is not an answer with no citations', () => {
    const { answer } = parseModelAnswer({
      answerable: false,
      sentences: ['The provided sources do not cover EN 301 549.'],
      claims: [],
    });
    expect(answer.answerable).toBe(false);
    expect(answer.claims).toEqual([]);
  });

  it('drops a claim pointing at a sentence that does not exist, and says so', () => {
    const { answer, dropped } = parseModelAnswer({
      ...valid,
      claims: [...valid.claims, { sentenceIndex: 9, chunkIds: ['c1'], quote: 'x' }],
    });
    expect(answer.claims).toHaveLength(1);
    expect(dropped).toEqual(['claim 1: sentenceIndex 9 is out of range']);
  });

  it('drops a claim citing nothing, or quoting nothing', () => {
    const { answer, dropped } = parseModelAnswer({
      ...valid,
      claims: [
        { sentenceIndex: 0, chunkIds: [], quote: 'x' },
        { sentenceIndex: 0, chunkIds: ['c1'], quote: '   ' },
        { sentenceIndex: 0, chunkIds: ['c1'] },
      ],
    });
    expect(answer.claims).toEqual([]);
    expect(dropped).toEqual([
      'claim 0: chunkIds is empty',
      'claim 1: quote is empty',
      'claim 2: quote is not a string',
    ]);
  });

  it('deduplicates repeated citations within a claim', () => {
    const { answer } = parseModelAnswer({
      ...valid,
      claims: [{ sentenceIndex: 0, chunkIds: ['c1', 'c1', 'c2'], quote: 'x' }],
    });
    // Otherwise the same citation counts twice in citation precision.
    expect(answer.claims[0]!.chunkIds).toEqual(['c1', 'c2']);
  });

  it('drops blank sentences before resolving indices', () => {
    const { answer } = parseModelAnswer({
      answerable: true,
      sentences: ['  ', 'Real sentence.'],
      claims: [{ sentenceIndex: 0, chunkIds: ['c1'], quote: 'x' }],
    });
    expect(answer.sentences).toEqual(['Real sentence.']);
    expect(answer.claims[0]!.sentence).toBe('Real sentence.');
  });

  it('throws when there is nothing to show', () => {
    expect(() => parseModelAnswer(null)).toThrow(/not an object/);
    expect(() => parseModelAnswer([])).toThrow(/not an object/);
    expect(() => parseModelAnswer({ sentences: [], claims: [] })).toThrow(/answerable/);
    expect(() => parseModelAnswer({ answerable: true, claims: [] })).toThrow(/sentences/);
    expect(() => parseModelAnswer({ answerable: true, sentences: ['a'] })).toThrow(/claims/);
    expect(() => parseModelAnswer({ answerable: true, sentences: ['  '], claims: [] })).toThrow(/empty/);
  });
});

describe('ANSWER_SCHEMA', () => {
  it('requires exactly the fields the parser requires', () => {
    expect([...ANSWER_SCHEMA.required]).toEqual(['answerable', 'sentences', 'claims']);
    expect([...ANSWER_SCHEMA.properties.claims.items.required]).toEqual([
      'sentenceIndex',
      'chunkIds',
      'quote',
    ]);
  });
});
