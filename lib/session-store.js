// Persistent session store backed by the existing node:sqlite database.
// Replaces the default in-memory store so sessions survive server restarts.
// Implements the express-session Store contract: get / set / destroy / touch.

const { getDB } = require('../database');

function createSessionStore(session) {
  const Store = session.Store;

  class SqliteSessionStore extends Store {
    constructor(options = {}) {
      super(options);
      this.ttlMs = options.ttlMs || 8 * 60 * 60 * 1000; // fallback expiry if cookie has none
      const db = getDB();
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
      `);

      // Periodically drop expired rows. Unref so this never keeps the process alive.
      const pruneEveryMs = options.pruneIntervalMs || 60 * 60 * 1000;
      this._pruneTimer = setInterval(() => this.prune(), pruneEveryMs);
      if (this._pruneTimer.unref) this._pruneTimer.unref();
    }

    _expiryFor(sess) {
      const cookieExpires = sess && sess.cookie && sess.cookie.expires;
      if (cookieExpires) return new Date(cookieExpires).getTime();
      return Date.now() + this.ttlMs;
    }

    get(sid, cb) {
      try {
        const row = getDB().prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return process.nextTick(cb, null, null);
        if (row.expires <= Date.now()) {
          this.destroy(sid, () => {});
          return process.nextTick(cb, null, null);
        }
        return process.nextTick(cb, null, JSON.parse(row.data));
      } catch (err) {
        return process.nextTick(cb, err);
      }
    }

    set(sid, sess, cb = () => {}) {
      try {
        const expires = this._expiryFor(sess);
        const data = JSON.stringify(sess);
        getDB()
          .prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)')
          .run(sid, data, expires);
        return process.nextTick(cb, null);
      } catch (err) {
        return process.nextTick(cb, err);
      }
    }

    destroy(sid, cb = () => {}) {
      try {
        getDB().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return process.nextTick(cb, null);
      } catch (err) {
        return process.nextTick(cb, err);
      }
    }

    touch(sid, sess, cb = () => {}) {
      try {
        const expires = this._expiryFor(sess);
        getDB().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
        return process.nextTick(cb, null);
      } catch (err) {
        return process.nextTick(cb, err);
      }
    }

    prune() {
      try {
        getDB().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      } catch (_) {
        // Pruning is best-effort; a failed sweep retries on the next interval.
      }
    }
  }

  return new SqliteSessionStore();
}

module.exports = { createSessionStore };
