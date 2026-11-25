import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDailyModelRows,
  aggregateByDate,
  normalizeModelWindow,
  coverageCheck,
  sevenDayStats,
  percentOf,
  crossedTiers,
  dailyTotalsMap,
} from '../lib/credit.mjs';

test('normalizeDailyModelRows: numeric, null and missing credit', () => {
  const response = {
    data: [
      {
        model: 'm1',
        daily: [
          { date: '2026-11-24', req_tokens: 100, rsp_tokens: 10, cached_tokens: 40, request_count: 2, credit: 1.5 },
          { date: '2026-11-23', req_tokens: 0, rsp_tokens: 0, cached_tokens: 0, request_count: 0, credit: null },
          { date: '2026-11-22', req_tokens: 10, rsp_tokens: 0, cached_tokens: 0, request_count: 1, credit: null },
          { date: '2026-11-21', req_tokens: 10, rsp_tokens: 0, cached_tokens: 0, request_count: 1 },
        ],
      },
    ],
  };

  const { rows, warnings } = normalizeDailyModelRows(response);
  assert.equal(rows.length, 4);

  assert.deepEqual(rows[0], {
    date: '2026-11-24',
    model: 'm1',
    reqTokens: 100,
    rspTokens: 10,
    cachedTokens: 40,
    totalTokens: 110,
    requestCount: 2,
    credit: 1.5,
    creditKnown: true,
  });

  assert.equal(rows[1].credit, 0);
  assert.equal(rows[1].creditKnown, true);
  assert.equal(rows[2].credit, null);
  assert.equal(rows[2].creditKnown, false);
  assert.equal(rows[3].credit, null);
  assert.equal(rows[3].creditKnown, false);
  assert.ok(warnings.some((warning) => warning.includes('credit 为 null')));
  assert.ok(warnings.some((warning) => warning.includes('credit 字段缺失')));
});

test('normalizeDailyModelRows: credit_breakdown mismatch warns', () => {
  const response = {
    data: [
      {
        model: 'm1',
        daily: [
          {
            date: '2026-11-25',
            req_tokens: 100,
            rsp_tokens: 10,
            cached_tokens: 20,
            request_count: 1,
            credit: 3,
            credit_breakdown: { input: 1, cached: 0.5, output: 1 },
          },
        ],
      },
    ],
  };
  const { warnings } = normalizeDailyModelRows(response);
  assert.ok(warnings.some((warning) => warning.includes('credit_breakdown')));
});

test('aggregateByDate sums known values and marks partial data', () => {
  const rows = [
    { date: '2026-11-24', credit: 1.5, creditKnown: true, reqTokens: 100, rspTokens: 10, cachedTokens: 40, totalTokens: 110, requestCount: 2 },
    { date: '2026-11-24', credit: 2.5, creditKnown: true, reqTokens: 200, rspTokens: 20, cachedTokens: 80, totalTokens: 220, requestCount: 3 },
    { date: '2026-11-23', credit: null, creditKnown: false, reqTokens: 1, rspTokens: 0, cachedTokens: 0, totalTokens: 1, requestCount: 1 },
  ];
  const result = aggregateByDate(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-11-23');
  assert.equal(result[0].creditKnown, false);
  assert.equal(result[1].credit, 4);
  assert.equal(result[1].requestCount, 5);
  assert.equal(result[1].reqTokens, 300);
});

test('normalizeModelWindow computes totals, shares and non-cached input', () => {
  const response = {
    data: [
      {
        model: 'a',
        req_tokens: 1000,
        rsp_tokens: 100,
        cached_tokens: 800,
        request_count: 2,
        credit: 4,
        credit_breakdown: { input: 1, cached: 1, output: 2 },
      },
      {
        model: 'b',
        req_tokens: 500,
        rsp_tokens: 50,
        cached_tokens: 0,
        request_count: 1,
        credit: 1,
        credit_breakdown: { input: 0.5, cached: 0, output: 0.5 },
      },
    ],
  };
  const window = normalizeModelWindow(response);
  assert.equal(window.totalCredit, 5);
  assert.equal(window.creditKnown, true);
  assert.equal(window.totals.reqTokens, 1500);
  assert.equal(window.totals.nonCachedInput, 700);
  assert.equal(window.models[0].model, 'a');
  assert.equal(window.models[0].creditShare, 0.8);
  assert.equal(window.models[1].creditShare, 0.2);
});

test('coverageCheck compares tokens and requests exactly', () => {
  const summary = { req_tokens: 1500, rsp_tokens: 150, cached_tokens: 800, request_count: 3 };
  const totals = { reqTokens: 1500, rspTokens: 150, cachedTokens: 800, requestCount: 3 };
  assert.equal(coverageCheck(summary, totals).ok, true);
  assert.equal(coverageCheck(summary, { ...totals, requestCount: 4 }).ok, false);
  assert.equal(coverageCheck(null, totals).ok, null);
});

test('sevenDayStats excludes today, incomplete and unknown days', () => {
  const history = [
    { date: '2026-11-18', credit: 100, creditKnown: true, complete: true },
    { date: '2026-11-19', credit: 200, creditKnown: true, complete: true },
    { date: '2026-11-20', credit: 300, creditKnown: true, complete: false },
    { date: '2026-11-21', credit: null, creditKnown: false, complete: true },
    { date: '2026-11-22', credit: 400, creditKnown: true, complete: true },
    { date: '2026-11-25', credit: 999, creditKnown: true, complete: false },
  ];
  const stats = sevenDayStats(history, '2026-11-25');
  assert.equal(stats.days, 3);
  assert.equal(stats.avg, (100 + 200 + 400) / 3);
  assert.equal(stats.max, 400);
  assert.equal(stats.maxDate, '2026-11-22');
});

test('percent and tiers', () => {
  assert.equal(percentOf(75, 150), 50);
  assert.equal(percentOf(null, 150), null);
  assert.deepEqual(crossedTiers(75, [20, 40, 60, 80, 100, 120]), [20, 40, 60]);
});

test('dailyTotalsMap exposes request_count with ?days=31', () => {
  const map = dailyTotalsMap({
    data: [
      {
        date: '2026-11-24',
        req_tokens: 100,
        rsp_tokens: 10,
        cached_tokens: 40,
        request_count: 9,
        complete: true,
      },
    ],
  });
  assert.deepEqual(map.get('2026-11-24'), {
    date: '2026-11-24',
    reqTokens: 100,
    rspTokens: 10,
    cachedTokens: 40,
    totalTokens: 110,
    requestCount: 9,
    complete: true,
  });
});
