const mysql = require('mysql2/promise');
const session = require('express-session');

const clone = value => value === undefined ? undefined : structuredClone(value);

class Database {
  constructor(env = process.env) {
    this.config = {
      host: String(env.DB_HOST || '').trim(), port: Number(env.DB_PORT || 3306),
      database: String(env.DB_NAME || '').trim(), user: String(env.DB_USER || '').trim(),
      password: String(env.DB_PASSWORD || ''),
    };
    if (!this.config.host || !this.config.database || !this.config.user || !this.config.password
      || !Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      throw Error('Configura DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD en .env');
    }
    this.pool = null;
  }

  async initialize() {
    this.pool = mysql.createPool({ ...this.config, waitForConnections: true, connectionLimit: 8,
      maxIdle: 4, idleTimeout: 60000, enableKeepAlive: true, charset: 'utf8mb4', decimalNumbers: true });
    try {
      await this.pool.query('SELECT 1');
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS millenniafenixbot_kv (
        namespace VARCHAR(64) NOT NULL,
        record_key VARCHAR(191) NOT NULL,
        value_json LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (namespace, record_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS millenniafenixbot_blobs (
        namespace VARCHAR(64) NOT NULL,
        record_key VARCHAR(191) NOT NULL,
        content_type VARCHAR(100) NOT NULL,
        data LONGBLOB NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (namespace, record_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS millenniafenixbot_sessions (
        sid VARCHAR(128) NOT NULL PRIMARY KEY,
        session_json LONGTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  async get(namespace, key, fallback = null) {
    const [rows] = await this.pool.execute('SELECT value_json FROM millenniafenixbot_kv WHERE namespace=? AND record_key=? LIMIT 1', [namespace, key]);
    return rows.length ? JSON.parse(rows[0].value_json) : clone(fallback);
  }

  async set(namespace, key, value) {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 16 * 1024 * 1024) throw Error('El dato supera el límite de almacenamiento');
    await this.pool.execute(`INSERT INTO millenniafenixbot_kv(namespace,record_key,value_json) VALUES(?,?,?)
      ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)`, [namespace, key, json]);
    return value;
  }

  async setIfAbsent(namespace, key, value) {
    const json = JSON.stringify(value);
    const [result] = await this.pool.execute('INSERT IGNORE INTO millenniafenixbot_kv(namespace,record_key,value_json) VALUES(?,?,?)', [namespace, key, json]);
    return result.affectedRows === 1;
  }

  async delete(namespace, key) {
    const [result] = await this.pool.execute('DELETE FROM millenniafenixbot_kv WHERE namespace=? AND record_key=?', [namespace, key]);
    return result.affectedRows > 0;
  }

  async entries(namespace) {
    const [rows] = await this.pool.execute('SELECT record_key,value_json FROM millenniafenixbot_kv WHERE namespace=? ORDER BY record_key', [namespace]);
    return rows.map(row => [row.record_key, JSON.parse(row.value_json)]);
  }

  async getBlob(namespace, key) {
    const [rows] = await this.pool.execute('SELECT content_type,data,updated_at FROM millenniafenixbot_blobs WHERE namespace=? AND record_key=? LIMIT 1', [namespace, key]);
    return rows.length ? { contentType: rows[0].content_type, data: Buffer.from(rows[0].data), updatedAt: rows[0].updated_at } : null;
  }

  async setBlob(namespace, key, data, contentType = 'application/octet-stream') {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.pool.execute(`INSERT INTO millenniafenixbot_blobs(namespace,record_key,content_type,data) VALUES(?,?,?,?)
      ON DUPLICATE KEY UPDATE content_type=VALUES(content_type),data=VALUES(data)`, [namespace, key, contentType, bytes]);
  }

  async setBlobIfAbsent(namespace, key, data, contentType = 'application/octet-stream') {
    const [result] = await this.pool.execute('INSERT IGNORE INTO millenniafenixbot_blobs(namespace,record_key,content_type,data) VALUES(?,?,?,?)',
      [namespace, key, contentType, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    return result.affectedRows === 1;
  }

  async deleteBlob(namespace, key) {
    const [result] = await this.pool.execute('DELETE FROM millenniafenixbot_blobs WHERE namespace=? AND record_key=?', [namespace, key]);
    return result.affectedRows > 0;
  }

  async listBlobs(namespace) {
    const [rows] = await this.pool.execute('SELECT record_key,content_type,OCTET_LENGTH(data) AS bytes,updated_at FROM millenniafenixbot_blobs WHERE namespace=? ORDER BY record_key', [namespace]);
    return rows.map(row => ({ key: row.record_key, contentType: row.content_type, bytes: Number(row.bytes), updatedAt: row.updated_at }));
  }

  namespace(name) {
    if (!/^[a-z][a-z0-9:_-]{0,63}$/.test(name)) throw Error('Espacio de almacenamiento inválido');
    return Object.freeze({
      get: (key, fallback = null) => this.get(name, key, fallback),
      set: (key, value) => this.set(name, key, value),
      setIfAbsent: (key, value) => this.setIfAbsent(name, key, value),
      delete: key => this.delete(name, key),
      entries: () => this.entries(name),
      getBlob: key => this.getBlob(name, key),
      setBlob: (key, data, contentType) => this.setBlob(name, key, data, contentType),
      setBlobIfAbsent: (key, data, contentType) => this.setBlobIfAbsent(name, key, data, contentType),
      deleteBlob: key => this.deleteBlob(name, key),
      listBlobs: () => this.listBlobs(name),
    });
  }

  async close() { if (this.pool) { const pool = this.pool; this.pool = null; await pool.end(); } }
}

class DatabaseSessionStore extends session.Store {
  constructor(database, ttl = 8 * 3600000) { super(); this.database = database; this.ttl = ttl; }
  expiration(data) {
    const date = data?.cookie?.expires ? new Date(data.cookie.expires).getTime() : 0;
    return Number.isFinite(date) && date > 0 ? date : Date.now() + (Number(data?.cookie?.originalMaxAge) || this.ttl);
  }
  get(id, callback) {
    (async () => {
      const [rows] = await this.database.pool.execute('SELECT session_json,expires_at FROM millenniafenixbot_sessions WHERE sid=? LIMIT 1', [id]);
      if (!rows.length) return null;
      if (Number(rows[0].expires_at) <= Date.now()) { await this.destroyAsync(id); return null; }
      return JSON.parse(rows[0].session_json);
    })().then(value => callback(null, value), callback);
  }
  set(id, data, callback = () => {}) {
    this.database.pool.execute(`INSERT INTO millenniafenixbot_sessions(sid,session_json,expires_at) VALUES(?,?,?)
      ON DUPLICATE KEY UPDATE session_json=VALUES(session_json),expires_at=VALUES(expires_at)`,
    [id, JSON.stringify(data), this.expiration(data)]).then(() => callback(null), callback);
  }
  destroyAsync(id) { return this.database.pool.execute('DELETE FROM millenniafenixbot_sessions WHERE sid=?', [id]); }
  destroy(id, callback = () => {}) { this.destroyAsync(id).then(() => callback(null), callback); }
  touch(id, data, callback = () => {}) {
    this.database.pool.execute('UPDATE millenniafenixbot_sessions SET expires_at=? WHERE sid=?', [this.expiration(data), id]).then(() => callback(null), callback);
  }
}

module.exports = { Database, DatabaseSessionStore };
