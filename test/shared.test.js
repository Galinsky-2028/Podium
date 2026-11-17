import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, defaultShot } from '../shared/timeline.js';
import { bakeGrade, toCube, parseCube, LOOKS } from '../shared/luts.js';

test('timeline: a-roll is sequential, b-roll anchors and clamps inside the speech', () => {
  const a1 = defaultShot('aroll', { text: 'one two three', clipId: 'c1' });
  const a2 = defaultShot('aroll', { text: 'four five six', clipId: 'c2', transition: 'dip' });
  const b = defaultShot('broll', { anchor: a2.id, offset: 1, duration: 3, clipId: 'c3' });
  const clips = { c1: { status: 'ready', duration: 4 }, c2: { status: 'ready', duration: 5 }, c3: { status: 'ready', duration: 6 } };
  const tl = buildTimeline({ shots: [a1, a2, b] }, clips);
  assert.equal(tl.duration, 9);
  assert.equal(tl.v1[1].start, 4);
  assert.ok(tl.v1[1].dipIn > 0 && tl.v1[0].dipOut > 0);
  assert.equal(tl.v2[0].start, 5);
  assert.equal(tl.v2[0].dur, 3);
  // trims flow through and re-time everything after
  a1.trimOut = 1;
  const tl2 = buildTimeline({ shots: [a1, a2, b] }, clips);
  assert.equal(tl2.v1[1].start, 3);
  assert.equal(tl2.v2[0].start, 4);
});

test('timeline: missing clips use speech-length estimates', () => {
  const a = defaultShot('aroll', { text: 'word '.repeat(25) });
  const tl = buildTimeline({ shots: [a] }, {});
  assert.ok(tl.duration > 9 && tl.duration < 12);
  assert.equal(tl.v1[0].ready, false);
});

test('luts: identity at none, every look bakes in range, cube round-trips', () => {
  const id = bakeGrade({ look: 'none' }, {}, 5);
  assert.ok(Math.abs(id[3 * 3] - 0.75) < 1e-6);
  for (const l of LOOKS) {
    const t = bakeGrade({ look: l.id }, {}, 9);
    assert.ok(t.every((v) => v >= 0 && v <= 1), l.id);
  }
  const t = bakeGrade({ look: 'teal-orange', exposure: 0.3 }, {}, 9);
  const p = parseCube(toCube(t, 9));
  assert.equal(p.size, 9);
  assert.ok(Math.abs(p.table[100] - t[100]) < 1e-5);
  const viaCustom = bakeGrade({ look: 'x' }, { x: p }, 9);
  assert.ok(Math.abs(viaCustom[100] - t[100]) < 1e-4);
});
