function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 把 /v1/models 的返回整理成页面需要的结构。
// credit 是网关的模型系数；同一模型的不同提供方会各占一行。
export function normalizeModelCatalog(response, { fetchedAt = Date.now() } = {}) {
  const source = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response)
      ? response
      : [];
  const warnings = [];
  const byId = new Map();

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      warnings.push('有一条模型记录缺少 id，已跳过');
      continue;
    }

    const credit = toNumber(item.credit);
    if (credit === null) warnings.push(`${id} 的 credit 系数缺失`);

    const history = (Array.isArray(item.credit_history) ? item.credit_history : [])
      .filter((entry) => entry && typeof entry.from === 'string')
      .map((entry) => ({ from: entry.from, credit: toNumber(entry.credit) }))
      .filter((entry) => entry.credit !== null)
      .sort((a, b) => a.from.localeCompare(b.from));

    const name =
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    const slash = id.indexOf('/');

    byId.set(id, {
      id,
      name,
      provider: slash > 0 ? id.slice(0, slash) : '官方',
      ownedBy: typeof item.owned_by === 'string' ? item.owned_by : null,
      credit,
      history,
      previous: history.length >= 2 ? history[history.length - 2] : null,
      changedAt: history.length ? history[history.length - 1].from : null,
    });
  }

  const models = [...byId.values()].sort((a, b) => {
    const av = a.credit === null ? Number.POSITIVE_INFINITY : a.credit;
    const bv = b.credit === null ? Number.POSITIVE_INFINITY : b.credit;
    if (av !== bv) return av - bv;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return { models, warnings, fetchedAt };
}
