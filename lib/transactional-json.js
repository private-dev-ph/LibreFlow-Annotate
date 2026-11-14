'use strict';

const { runDataCommand } = require('./data-command');

class BufferedResponseError extends Error {
  constructor(statusCode, body) {
    super('Buffered HTTP response requested rollback.');
    this.statusCode = statusCode;
    this.body = body;
  }
}

function transactionalJson(handler) {
  if (typeof handler !== 'function') throw new TypeError('transactionalJson requires a handler.');
  return function transactionalJsonHandler(req, res, next) {
    const original = {
      json: res.json.bind(res),
      send: res.send.bind(res),
      end: res.end.bind(res),
      status: res.status.bind(res),
    };
    let statusCode = res.statusCode || 200;
    let body;
    let sent = false;
    let nextError = null;
    let nextCalled = false;

    res.status = code => {
      statusCode = Number(code) || 200;
      return res;
    };
    res.json = value => {
      body = value;
      sent = true;
      return res;
    };
    res.send = value => {
      body = value;
      sent = true;
      return res;
    };
    res.end = value => {
      if (value !== undefined) body = value;
      sent = true;
      return res;
    };

    const bufferedNext = error => {
      nextCalled = true;
      if (error) {
        nextError = error;
        throw error;
      }
    };

    try {
      runDataCommand(() => {
        const result = handler(req, res, bufferedNext);
        if (result && typeof result.then === 'function') {
          throw new TypeError('transactionalJson handlers must be synchronous.');
        }
        if (nextError) throw nextError;
        if (statusCode >= 400) throw new BufferedResponseError(statusCode, sent ? body : { error: 'Request failed.' });
        return result;
      });
    } catch (error) {
      res.json = original.json;
      res.send = original.send;
      res.end = original.end;
      res.status = original.status;
      if (error instanceof BufferedResponseError) {
        return original.status(error.statusCode).json(error.body);
      }
      return next(error);
    }

    res.json = original.json;
    res.send = original.send;
    res.end = original.end;
    res.status = original.status;
    if (nextCalled && !nextError) return next();
    if (!sent) return res;
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      return original.status(statusCode).json(body);
    }
    return original.status(statusCode).send(body);
  };
}

module.exports = { transactionalJson };
