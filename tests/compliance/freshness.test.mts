// Run:  node --experimental-strip-types --test tests/compliance/freshness.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_SKIP_AFTER_MS, DATA_STALE_AFTER_MS, autoAction, classifyFreshness, freshnessDetail, freshnessMessage, monthLabel, nairobiDate, staleNoticeText, toMillis,
} from '../../functions/src/compliance/freshness.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

test('thresholds are 3 and 7 days', () => {
  assert.equal(DATA_STALE_AFTER_MS, 3 * DAY);
  assert.equal(DATA_SKIP_AFTER_MS, 7 * DAY);
});

test('classifyFreshness: boundaries', () => {
  assert.equal(classifyFreshness(NOW, NOW).level, 'fresh');
  assert.equal(classifyFreshness(NOW - 3 * DAY, NOW).level, 'fresh');          // exactly 3 days is still fresh
  assert.equal(classifyFreshness(NOW - 3 * DAY - 1, NOW).level, 'stale');
  assert.equal(classifyFreshness(NOW - 7 * DAY, NOW).level, 'stale');          // exactly 7 days is still a warning, not a skip
  assert.equal(classifyFreshness(NOW - 7 * DAY - 1, NOW).level, 'expired');
  assert.deepEqual(classifyFreshness(null, NOW), { syncedAt: null, level: 'unknown', ageDays: null });
  assert.equal(classifyFreshness(NOW + 5 * 60_000, NOW).level, 'fresh');       // clock a little ahead
  assert.equal(classifyFreshness(NOW - 5 * DAY, NOW).ageDays, 5);
});

test('autoAction: what the scheduler does', () => {
  assert.equal(autoAction('fresh', 5, 15), 'generate');
  assert.equal(autoAction('stale', 5, 15), 'generate_warn');
  assert.equal(autoAction('expired', 5, 15), 'wait');
  assert.equal(autoAction('unknown', 14, 15), 'wait');
  assert.equal(autoAction('expired', 15, 15), 'skip');
  assert.equal(autoAction('unknown', 20, 15), 'skip');
  assert.equal(autoAction('stale', 20, 15), 'generate_warn');
});

test('toMillis reads every shape the sync stamp can take', () => {
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toMillis(new Date(NOW)), NOW);
  assert.equal(toMillis('2026-11-14T09:00:00.000Z'), NOW);
  assert.equal(toMillis({ toMillis: () => NOW }), NOW);
  assert.equal(toMillis({ seconds: 1_700_000_000, nanoseconds: 500_000_000 }), 1_700_000_000_500);
  assert.equal(toMillis({ _seconds: 1_700_000_000 }), 1_700_000_000_000);
  for (const bad of [null, undefined, 0, -5, NaN, 'soon', {}, [], true]) assert.equal(toMillis(bad), null);
});

test('PDF wording', () => {
  assert.equal(freshnessMessage(classifyFreshness(NOW - DAY, NOW)), null);
  const stale = freshnessMessage(classifyFreshness(NOW - 5 * DAY, NOW))!;
  assert.equal(stale.severe, false);
  assert.match(stale.text, /2026-11-09 \(5 days ago\)/);
  const expired = freshnessMessage(classifyFreshness(NOW - 9 * DAY, NOW))!;
  assert.equal(expired.severe, true);
  assert.match(expired.text, /make the report again/);
  const unknown = freshnessMessage(classifyFreshness(null, NOW))!;
  assert.equal(unknown.severe, true);
  assert.match(freshnessDetail(classifyFreshness(NOW - DAY, NOW)), /1 day ago/);
});

test('nairobiDate uses UTC+3', () => {
  assert.equal(nairobiDate(Date.UTC(2026, 10, 14, 22, 0, 0)), '2026-11-15');
  assert.equal(monthLabel('2026-10'), 'October 2026');
});

test('SMS wording', () => {
  const warned = staleNoticeText({ outcome: 'warned', level: 'stale', ageDays: 5, property: 'Sunrise Apartments', month: '2026-10' });
  assert.match(warned, /October 2026 MRI report for Sunrise Apartments is ready/);
  assert.match(warned, /5 days ago/);
  const skipped = staleNoticeText({ outcome: 'skipped', level: 'expired', ageDays: 9, property: 'Sunrise Apartments', month: '2026-10' });
  assert.match(skipped, /did not make/);
  assert.match(skipped, /free report is kept/);
  const never = staleNoticeText({ outcome: 'skipped', level: 'unknown', ageDays: null, property: '', month: '2026-10' });
  assert.match(never, /have not synced/);
  assert.match(never, /your property/);
  assert.ok(warned.length <= 306 && skipped.length <= 306);                    // at most two SMS segments
});

test('blocked: over 7 days or never synced; the message says why', async () => {
  const { isBlocked, staleBlockMessage } = await import('../../functions/src/compliance/freshness.ts');
  assert.equal(isBlocked(classifyFreshness(NOW - 2 * DAY, NOW)), false);
  assert.equal(isBlocked(classifyFreshness(NOW - 5 * DAY, NOW)), false);       // a stale report may still be ordered; the PDF carries the warning
  assert.equal(isBlocked(classifyFreshness(NOW - 7 * DAY, NOW)), false);
  assert.equal(isBlocked(classifyFreshness(NOW - 7 * DAY - 1, NOW)), true);
  assert.equal(isBlocked(classifyFreshness(null, NOW)), true);
  assert.match(staleBlockMessage(classifyFreshness(NOW - 9 * DAY, NOW)), /2026-11-05 \(9 days ago\).*too old.*syncs/);
  assert.match(staleBlockMessage(classifyFreshness(null, NOW)), /have not synced/);
});
