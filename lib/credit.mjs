function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function num(value, fallback = 0) {
  return isNum(value) ? value : fallback;
}

function pushWarning(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message);
}

function checkBreakdown(creditValue, breakdown, label, warnings) {
  if (!isNum(creditValue) || !breakdown || typeof breakdown !== 'object') return;
  const sum =
    num(breakdown.input) + num(breakdown.cached) + num(breakdown.output);
  const tolerance = Math.max(1e-6, Math.abs(creditValue) * 1e-9);
  if (Math.abs(sum - creditValue) > tolerance) {
    pushWarning(
      warnings,
      `${label}: credit (${creditValue}) 与 credit_breakdown 之和 (${sum}) 不一致`,
    );
  }
}

// 把 by-model 响应里的 daily[] 展平。
// null 且无 token/请求 -> 明确的 0；null/缺失但有消耗 -> 未知，不能当 0。
export function normalizeDailyModelRows(response) {
  const rows = [];
  const warnings = [];
  const data = Array.isArray(response?.data) ? response.data : [];

  for (const entry of data) {
    const model = String(entry?.model ?? 'unknown');
    const daily = Array.isArray(entry?.daily) ? entry.daily : [];

    for (const day of daily) {
      const date = String(day?.date ?? '');
      if (!date) {
        pushWarning(warnings, `${model}: daily 条目缺少 date`);
        continue;
      }

      const reqTokens = Math.max(0, num(day.req_tokens));
      const rspTokens = Math.max(0, num(day.rsp_tokens));
      const cachedTokens = Math.max(0, num(day.cached_tokens));
      const requestCount = Math.max(0, num(day.request_count));
      const totalTokens = isNum(day.total_tokens)
        ? day.total_tokens
        : reqTokens + rspTokens;

      if (cachedTokens > reqTokens) {
        pushWarning(
          warnings,
          `${date} ${model}: cached_tokens (${cachedTokens}) 大于 req_tokens (${reqTokens})`,
        );
      }

      let creditValue = null;
      let creditKnown = false;

      if (isNum(day.credit)) {
        creditValue = day.credit;
        creditKnown = true;
      } else if (day.credit === null) {
        if (reqTokens === 0 && rspTokens === 0 && requestCount === 0) {
          creditValue = 0;
          creditKnown = true;
        } else {
          pushWarning(warnings, `${date} ${model}: credit 为 null 但有消耗，按未知处理`);
        }
      } else {
        if (reqTokens === 0 && rspTokens === 0 && requestCount === 0) {
          creditValue = 0;
          creditKnown = true;
        } else {
          pushWarning(warnings, `${date} ${model}: credit 字段缺失，按未知处理`);
        }
      }

      checkBreakdown(creditValue, day.credit_breakdown, `${date} ${model}`, warnings);

      rows.push({
        date,
        model,
        reqTokens,
        rspTokens,
        cachedTokens,
        totalTokens,
        requestCount,
        credit: creditValue,
        creditKnown,
      });
    }
  }

  return { rows, warnings };
}

export function aggregateByDate(rows) {
  const map = new Map();

  for (const row of rows) {
    const date = row.date;
    const item =
      map.get(date) ??
      {
        date,
        credit: 0,
        creditKnown: true,
        reqTokens: 0,
        rspTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        modelCount: 0,
      };

    if (row.creditKnown && isNum(row.credit)) item.credit += row.credit;
    else item.creditKnown = false;

    item.reqTokens += row.reqTokens;
    item.rspTokens += row.rspTokens;
    item.cachedTokens += row.cachedTokens;
    item.totalTokens += row.totalTokens;
    item.requestCount += row.requestCount;
    item.modelCount += 1;
    map.set(date, item);
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// by-model?window=today 的模型明细。
export function normalizeModelWindow(response) {
  const models = [];
  const warnings = [];
  const data = Array.isArray(response?.data) ? response.data : [];

  for (const entry of data) {
    const model = String(entry?.model ?? 'unknown');
    const reqTokens = Math.max(0, num(entry.req_tokens));
    const rspTokens = Math.max(0, num(entry.rsp_tokens));
    const cachedTokens = Math.max(0, num(entry.cached_tokens));
    const requestCount = Math.max(0, num(entry.request_count));
    const totalTokens = isNum(entry.total_tokens)
      ? entry.total_tokens
      : reqTokens + rspTokens;

    if (cachedTokens > reqTokens) {
      pushWarning(
        warnings,
        `${model}: cached_tokens (${cachedTokens}) 大于 req_tokens (${reqTokens})`,
      );
    }

    let creditValue = null;
    let creditKnown = false;
    if (isNum(entry.credit)) {
      creditValue = entry.credit;
      creditKnown = true;
    } else if (entry.credit === null) {
      if (reqTokens === 0 && rspTokens === 0 && requestCount === 0) {
        creditValue = 0;
        creditKnown = true;
      } else {
        pushWarning(warnings, `${model}: credit 为 null 但有消耗，按未知处理`);
      }
    } else if (reqTokens === 0 && rspTokens === 0 && requestCount === 0) {
      creditValue = 0;
      creditKnown = true;
    } else {
      pushWarning(warnings, `${model}: credit 字段缺失，按未知处理`);
    }

    checkBreakdown(creditValue, entry.credit_breakdown, model, warnings);

    models.push({
      model,
      reqTokens,
      rspTokens,
      cachedTokens,
      nonCachedInput: Math.max(0, reqTokens - cachedTokens),
      totalTokens,
      requestCount,
      credit: creditValue,
      creditKnown,
      share: isNum(entry.share) ? entry.share : null,
    });
  }

  return finalizeModelWindow(models, warnings);
}

export function finalizeModelWindow(models, warnings = []) {
  let totalCredit = 0;
  let allKnown = true;
  for (const model of models) {
    if (model.creditKnown && isNum(model.credit)) totalCredit += model.credit;
    else allKnown = false;
  }

  for (const model of models) {
    model.creditShare =
      allKnown && totalCredit > 0 && isNum(model.credit)
        ? model.credit / totalCredit
        : null;
  }

  models.sort((a, b) => {
    const av = isNum(a.credit) ? a.credit : -1;
    const bv = isNum(b.credit) ? b.credit : -1;
    return bv - av;
  });

  return {
    models,
    totalCredit,
    creditKnown: allKnown,
    warnings,
    totals: models.reduce(
      (acc, model) => {
        acc.reqTokens += model.reqTokens;
        acc.rspTokens += model.rspTokens;
        acc.cachedTokens += model.cachedTokens;
        acc.nonCachedInput += model.nonCachedInput;
        acc.requestCount += model.requestCount;
        return acc;
      },
      {
        reqTokens: 0,
        rspTokens: 0,
        cachedTokens: 0,
        nonCachedInput: 0,
        requestCount: 0,
      },
    ),
  };
}

// summary 没有 credit，只能校验 token / 请求覆盖率。
export function coverageCheck(summaryData, modelTotals) {
  if (!summaryData || !modelTotals) {
    return { ok: null, reason: '缺少 summary 或 by-model 数据' };
  }

  const summary = {
    reqTokens: num(summaryData.req_tokens),
    rspTokens: num(summaryData.rsp_tokens),
    cachedTokens: num(summaryData.cached_tokens),
    requestCount: num(summaryData.request_count),
  };
  const models = {
    reqTokens: num(modelTotals.reqTokens),
    rspTokens: num(modelTotals.rspTokens),
    cachedTokens: num(modelTotals.cachedTokens),
    requestCount: num(modelTotals.requestCount),
  };

  const diffs = {
    reqTokens: models.reqTokens - summary.reqTokens,
    rspTokens: models.rspTokens - summary.rspTokens,
    cachedTokens: models.cachedTokens - summary.cachedTokens,
    requestCount: models.requestCount - summary.requestCount,
  };

  const ok = Object.values(diffs).every((value) => value === 0);
  return { ok, summary, models, diffs };
}

export function sevenDayStats(history, todayKey) {
  const candidates = history
    .filter(
      (item) =>
        item.date < todayKey &&
        item.creditKnown &&
        isNum(item.credit) &&
        item.complete !== false,
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const recent = candidates.slice(-7);
  if (!recent.length) return { days: 0, avg: null, max: null, maxDate: null };

  const total = recent.reduce((sum, item) => sum + item.credit, 0);
  let maxItem = recent[0];
  for (const item of recent) {
    if (item.credit > maxItem.credit) maxItem = item;
  }

  return {
    days: recent.length,
    avg: total / recent.length,
    max: maxItem.credit,
    maxDate: maxItem.date,
  };
}

export function percentOf(credit, limit) {
  if (!isNum(credit) || !isNum(limit) || limit <= 0) return null;
  return (credit / limit) * 100;
}

export function crossedTiers(percent, thresholds) {
  if (!isNum(percent)) return [];
  return thresholds.filter((tier) => percent >= tier);
}

export function dailyCompleteMap(response) {
  const map = new Map();
  const data = Array.isArray(response?.data) ? response.data : [];
  for (const item of data) {
    if (!item?.date) continue;
    map.set(String(item.date), item.complete === true ? true : item.complete === false ? false : null);
  }
  return map;
}

// /v1/usage/daily 提供每天的请求数、token 和 complete；
// credit 仍以 by-model 为准。两者按 date 合并。
export function dailyTotalsMap(response) {
  const map = new Map();
  const data = Array.isArray(response?.data) ? response.data : [];
  for (const item of data) {
    if (!item?.date) continue;
    const reqTokens = Math.max(0, num(item.req_tokens));
    const rspTokens = Math.max(0, num(item.rsp_tokens));
    map.set(String(item.date), {
      date: String(item.date),
      reqTokens,
      rspTokens,
      cachedTokens: Math.max(0, num(item.cached_tokens)),
      totalTokens: isNum(item.total_tokens) ? item.total_tokens : reqTokens + rspTokens,
      requestCount: Math.max(0, num(item.request_count)),
      complete: item.complete === true ? true : item.complete === false ? false : null,
    });
  }
  return map;
}
