import { describe, expect, it } from 'vitest';
import { applyOp, decodeSegment, decodeSnapshot, encodeSegment, encodeSnapshot } from '../src/ops.js';

const U = '1dd497fc-7d89-4c7b-adfb-b74856043b81';
const ts = '2026-09-28T21:28:51.276477660Z';

describe('operations', () => {
  it('reads and writes taskchampion history segments', () => {
    const json = `{"operations":[{"Create":{"uuid":"${U}"}},{"Update":{"uuid":"${U}","property":"description","value":"First","timestamp":"${ts}"}},{"Update":{"uuid":"${U}","property":"wait","value":null,"timestamp":"${ts}"}},{"Delete":{"uuid":"${U}"}}]}`;
    const ops = decodeSegment(new TextEncoder().encode(json));
    expect(ops).toEqual([
      { type: 'create', uuid: U },
      { type: 'update', uuid: U, property: 'description', value: 'First', timestamp: ts },
      { type: 'update', uuid: U, property: 'wait', value: null, timestamp: ts },
      { type: 'delete', uuid: U },
    ]);
    expect(new TextDecoder().decode(encodeSegment(ops))).toBe(json);
  });

  it('applies operations the way taskchampion does', () => {
    const tasks = new Map();
    applyOp(tasks, { type: 'update', uuid: U, property: 'x', value: '1', timestamp: ts });
    expect(tasks.has(U)).toBe(false); // updates to a missing task are ignored
    applyOp(tasks, { type: 'create', uuid: U });
    applyOp(tasks, { type: 'update', uuid: U, property: 'description', value: 'First', timestamp: ts });
    applyOp(tasks, { type: 'create', uuid: U }); // creating an existing task changes nothing
    expect(tasks.get(U)).toEqual({ description: 'First' });
    applyOp(tasks, { type: 'update', uuid: U, property: 'description', value: null, timestamp: ts });
    expect(tasks.get(U)).toEqual({});
    applyOp(tasks, { type: 'delete', uuid: U });
    expect(tasks.has(U)).toBe(false);
  });

  it('round-trips a zlib snapshot', () => {
    const tasks = new Map([[U, { description: 'First', status: 'pending' }]]);
    const snap = encodeSnapshot(tasks);
    expect(snap[0]).toBe(0x78); // zlib header, as flate2's ZlibEncoder writes
    expect(decodeSnapshot(snap)).toEqual(tasks);
  });
});
