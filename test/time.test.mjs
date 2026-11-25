import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beijingDateKey,
  nextResetAt,
  resetInfo,
  startOfWeek,
  startOfMonth,
  formatDuration,
  beijingHourLabel,
} from '../lib/time.mjs';

test('beijingDateKey switches at 00:00 Asia/Shanghai', () => {
  assert.equal(beijingDateKey(Date.parse('2026-11-24T15:59:59Z')), '2026-11-24');
  assert.equal(beijingDateKey(Date.parse('2026-11-24T16:00:00Z')), '2026-11-25');
});

test('nextResetAt is the next Beijing midnight', () => {
  const at = nextResetAt(Date.parse('2026-11-25T02:00:00Z'));
  assert.equal(at, Date.parse('2026-11-25T16:00:00Z'));
});

test('resetInfo reports remaining seconds', () => {
  const info = resetInfo(Date.parse('2026-11-25T02:00:00Z'));
  assert.equal(info.secondsLeft, 14 * 3600);
  assert.equal(info.timezone, 'Asia/Shanghai');
});

test('week starts on Monday and month on the 1st', () => {
  assert.equal(startOfWeek('2026-11-25'), '2026-11-23');
  assert.equal(startOfWeek('2026-11-23'), '2026-11-23');
  assert.equal(startOfWeek('2026-11-22'), '2026-11-16');
  assert.equal(startOfMonth('2026-11-25'), '2026-11-01');
});

test('formatDuration and hour labels', () => {
  assert.equal(formatDuration(50009), '13h 53m');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(beijingHourLabel(1795536000), '00:00');
});
