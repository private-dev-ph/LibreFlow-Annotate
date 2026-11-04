const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

class DurableFileSessionStore extends session.Store {
  constructor(directory) {
    super();
    this.directory = directory;
    this.queues = new Map();
    this.clearQueue = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  filename(sid) {
    return path.join(this.directory, `${crypto.createHash('sha256').update(sid).digest('hex')}.json`);
  }

  enqueue(sid, operation, callback = () => {}) {
    const previous = this.queues.get(sid);
    const clearBarrier = this.clearQueue;
    const queued = (previous || Promise.resolve()).catch(() => {})
      .then(() => clearBarrier.catch(() => {}))
      .then(() => operation());
    this.queues.set(sid, queued);
    const finish = () => {
      if (this.queues.get(sid) === queued) this.queues.delete(sid);
    };
    queued.then(
      value => { try { callback(null, value); } catch (_) {} finish(); },
      error => { try { callback(error); } catch (_) {} finish(); },
    );
  }

  async write(sid, value) {
    const filename = this.filename(sid);
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : null;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ session: value, expiresAt }), { mode: 0o600 });
      await fs.promises.rename(temporary, filename);
    } catch (error) {
      try { await fs.promises.unlink(temporary); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
      throw error;
    }
  }

  get(sid, callback = () => {}) {
    this.enqueue(sid, async () => {
      let text;
      try { text = await fs.promises.readFile(this.filename(sid), 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      const record = JSON.parse(text);
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        try { await fs.promises.unlink(this.filename(sid)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return null;
      }
      return record.session;
    }, callback);
  }

  set(sid, value, callback = () => {}) {
    this.enqueue(sid, () => this.write(sid, value), callback);
  }

  touch(sid, value, callback = () => {}) {
    this.enqueue(sid, async () => {
      let text;
      try { text = await fs.promises.readFile(this.filename(sid), 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const record = JSON.parse(text);
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        try { await fs.promises.unlink(this.filename(sid)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return;
      }
      await this.write(sid, value);
    }, callback);
  }

  destroy(sid, callback = () => {}) {
    this.enqueue(sid, async () => {
      try { await fs.promises.unlink(this.filename(sid)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, callback);
  }

  clear(callback = () => {}) {
    const pending = [...this.queues.values()];
    const clearRun = this.clearQueue
      .then(() => Promise.allSettled(pending))
      .then(async () => {
        const files = await fs.promises.readdir(this.directory);
        await Promise.all(files.filter(name => name.endsWith('.json'))
          .map(name => fs.promises.unlink(path.join(this.directory, name))));
      });
    this.clearQueue = clearRun;
    clearRun.then(
      () => { try { callback(null); } catch (_) {} },
      error => { try { callback(error); } catch (_) {} },
    ).then(() => {
      if (this.clearQueue === clearRun) this.clearQueue = Promise.resolve();
    });
  }
}

module.exports = { DurableFileSessionStore };
