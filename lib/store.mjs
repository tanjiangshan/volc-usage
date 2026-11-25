import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_model (
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  req_tokens INTEGER NOT NULL DEFAULT 0,
  rsp_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  credit REAL,
  credit_known INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (date, model)
);

CREATE TABLE IF NOT EXISTS day_meta (
  date TEXT PRIMARY KEY,
  complete INTEGER,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notified (
  date TEXT NOT NULL,
  tier INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (date, tier)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function toIntBoolean(value) {
  return value ? 1 : 0;
}

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  migrate() {
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = Number(row?.user_version ?? 0);
    if (version < 1) {
      this.db.exec(SCHEMA);
      this.db.exec('PRAGMA user_version = 1;');
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  }

  upsertRows(rows, fetchedAt = Date.now()) {
    if (!rows.length) return 0;

    const statement = this.db.prepare(`
      INSERT INTO daily_model (
        date, model, req_tokens, rsp_tokens, cached_tokens, total_tokens,
        request_count, credit, credit_known, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        req_tokens = excluded.req_tokens,
        rsp_tokens = excluded.rsp_tokens,
        cached_tokens = excluded.cached_tokens,
        total_tokens = excluded.total_tokens,
        request_count = excluded.request_count,
        credit = excluded.credit,
        credit_known = excluded.credit_known,
        fetched_at = excluded.fetched_at
      WHERE excluded.fetched_at >= daily_model.fetched_at
    `);

    return this.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        const result = statement.run(
          row.date,
          row.model,
          row.reqTokens,
          row.rspTokens,
          row.cachedTokens,
          row.totalTokens,
          row.requestCount,
          row.credit,
          toIntBoolean(row.creditKnown),
          fetchedAt,
        );
        changed += Number(result.changes ?? 0);
      }
      return changed;
    });
  }

  upsertDayMeta(date, complete, fetchedAt = Date.now()) {
    if (!date) return;
    const value =
      complete === true ? 1 : complete === false ? 0 : complete === null ? null : null;
    this.db
      .prepare(`
        INSERT INTO day_meta (date, complete, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          complete = excluded.complete,
          fetched_at = excluded.fetched_at
        WHERE excluded.fetched_at >= day_meta.fetched_at
      `)
      .run(date, value, fetchedAt);
  }

  getHistory(limit = 90) {
    const rows = this.db
      .prepare(`
        SELECT
          d.date,
          d.credit,
          d.credit_known,
          d.req_tokens,
          d.rsp_tokens,
          d.cached_tokens,
          d.total_tokens,
          d.request_count,
          d.model_count,
          m.complete AS complete
        FROM (
          SELECT
            date,
            SUM(COALESCE(credit, 0)) AS credit,
            MIN(credit_known) AS credit_known,
            SUM(req_tokens) AS req_tokens,
            SUM(rsp_tokens) AS rsp_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(request_count) AS request_count,
            COUNT(*) AS model_count
          FROM daily_model
          GROUP BY date
        ) d
        LEFT JOIN day_meta m ON m.date = d.date
        ORDER BY d.date DESC
        LIMIT ?
      `)
      .all(limit);

    return rows
      .map((row) => ({
        date: row.date,
        credit: Number(row.credit ?? 0),
        creditKnown: Boolean(row.credit_known),
        reqTokens: Number(row.req_tokens ?? 0),
        rspTokens: Number(row.rsp_tokens ?? 0),
        cachedTokens: Number(row.cached_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
        requestCount: Number(row.request_count ?? 0),
        modelCount: Number(row.model_count ?? 0),
        complete:
          row.complete === null || row.complete === undefined
            ? null
            : Boolean(row.complete),
      }))
      .reverse();
  }

  getModelsForDate(date) {
    const rows = this.db
      .prepare(`
        SELECT date, model, req_tokens, rsp_tokens, cached_tokens, total_tokens,
               request_count, credit, credit_known
        FROM daily_model
        WHERE date = ?
        ORDER BY COALESCE(credit, 0) DESC, model ASC
      `)
      .all(date);

    return rows.map((row) => ({
      date: row.date,
      model: row.model,
      reqTokens: Number(row.req_tokens ?? 0),
      rspTokens: Number(row.rsp_tokens ?? 0),
      cachedTokens: Number(row.cached_tokens ?? 0),
      nonCachedInput: Math.max(0, Number(row.req_tokens ?? 0) - Number(row.cached_tokens ?? 0)),
      totalTokens: Number(row.total_tokens ?? 0),
      requestCount: Number(row.request_count ?? 0),
      credit: row.credit === null ? null : Number(row.credit),
      creditKnown: Boolean(row.credit_known),
    }));
  }

  getNotifiedTiers(date) {
    const rows = this.db.prepare('SELECT tier FROM notified WHERE date = ?').all(date);
    return new Set(rows.map((row) => Number(row.tier)));
  }

  markNotified(date, tiers, sentAt = Date.now()) {
    if (!tiers.length) return;
    const statement = this.db.prepare(
      'INSERT OR IGNORE INTO notified (date, tier, sent_at) VALUES (?, ?, ?)',
    );
    this.transaction(() => {
      for (const tier of tiers) statement.run(date, tier, sentAt);
    });
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, String(value));
  }

  getCoverage() {
    const row = this.db
      .prepare(`
        SELECT MIN(date) AS from_date, MAX(date) AS to_date,
               COUNT(DISTINCT date) AS day_count
        FROM daily_model
      `)
      .get();
    return {
      from: row?.from_date ?? null,
      to: row?.to_date ?? null,
      days: Number(row?.day_count ?? 0),
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
