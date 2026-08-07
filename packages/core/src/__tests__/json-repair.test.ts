import { describe, expect, it } from 'vitest';

import { extractJSON } from '../utils/json-repair';

describe('extractJSON', () => {
  it('parses a plain JSON array', () => {
    expect(extractJSON('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('strips a ```json fenced code block', () => {
    expect(extractJSON('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('strips a plain ``` fenced code block', () => {
    expect(extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('trims leading and trailing prose around the JSON', () => {
    expect(extractJSON('Sure, here is the JSON:\n[{"a":1}]\nHope that helps!')).toEqual([{ a: 1 }]);
  });

  it('recovers from trailing commas', () => {
    expect(extractJSON('[{"a":1},{"b":2},]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('recovers from a trailing comma before an object-closing brace', () => {
    expect(extractJSON('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('throws the original error when the content is unrecoverable', () => {
    expect(() => extractJSON('this is not json {{{')).toThrow();
  });
});
