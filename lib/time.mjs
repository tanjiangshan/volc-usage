// 时间工具：网关的 usage date 固定使用 Asia/Shanghai（UTC+8，无夏令时）。
// 所有“今天”的判断都从这里来，避免服务器本地时区影响归日。

export const TIMEZONE = 'Asia/Shanghai';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function shifted(now) {
  return new Date(now + OFFSET_MS);
}

export function beijingDateKey(now = Date.now()) {
  const d = shifted(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function beijingParts(now = Date.now()) {
  const d = shifted(now);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

// 下一个 Asia/Shanghai 00:00 对应的 epoch ms。
export function nextResetAt(now = Date.now()) {
  const p = beijingParts(now);
  return Date.UTC(p.year, p.month - 1, p.day + 1) - OFFSET_MS;
}

export function resetInfo(now = Date.now()) {
  const at = nextResetAt(now);
  return {
    at,
    secondsLeft: Math.max(0, Math.ceil((at - now) / 1000)),
    timezone: TIMEZONE,
  };
}

export function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatDateKey(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(key, n) {
  return formatDateKey(parseDateKey(key) + n * DAY_MS);
}

// 自然周，周一起。
export function startOfWeek(key) {
  const ms = parseDateKey(key);
  const weekday = new Date(ms).getUTCDay(); // 0=周日
  const diff = (weekday + 6) % 7;
  return formatDateKey(ms - diff * DAY_MS);
}

export function startOfMonth(key) {
  return `${String(key).slice(0, 7)}-01`;
}

export function daysBetween(fromKey, toKey) {
  return Math.round((parseDateKey(toKey) - parseDateKey(fromKey)) / DAY_MS) + 1;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// 把小时时间戳格式化为 Asia/Shanghai 的 HH:00。
export function beijingHourLabel(tsSeconds) {
  const d = new Date(tsSeconds * 1000 + OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}
