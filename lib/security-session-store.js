const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

class DurableFileSessionStore extends session.Store {
  constructor(directory) {
    super();
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  filename(sid) {
    return path.join(this.directory, `${crypto.createHash('sha256').update(sid).digest('hex')}.json`);
  }

  get(sid, callback) {
    fs.readFile(this.filename(sid), 'utf8', (error, text) => {
      if (error) return callback(error.code === 'ENOENT' ? null : error);
      try {
        const record = JSON.parse(text);
        if (record.expiresAt && record.expiresAt <= Date.now()) {
          fs.unlink(this.filename(sid), () => {});
          return callback(null, null);
        }
        callback(null, record.session);
      } catch (parseError) { callback(parseError); }
    });
  }

  set(sid, value, callback = () => {}) {
    const filename = this.filename(sid);
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : null;
    fs.writeFile(temporary, JSON.stringify({ session: value, expiresAt }), { mode: 0o600 }, error => {
      if (error) return callback(error);
      fs.rename(temporary, filename, renameError => {
        if (renameError) return fs.unlink(temporary, () => callback(renameError));
        callback(null);
      });
    });
  }

  touch(sid, value, callback) { this.set(sid, value, callback); }

  destroy(sid, callback = () => {}) { fs.unlink(this.filename(sid), error => callback(error?.code === 'ENOENT' ? null : error)); }

  clear(callback = () => {}) {
    fs.readdir(this.directory, (error, files) => {
      if (error) return callback(error);
      Promise.all(files.filter(name => name.endsWith('.json')).map(name => fs.promises.unlink(path.join(this.directory, name))))
        .then(() => callback(null), callback);
    });
  }
}

module.exports = { DurableFileSessionStore };
