# @quicore/problem-details-error

> A typed, RFC 9457-compliant error class for Node.js with strict separation of internal diagnostics and public API responses.

[![npm version](https://img.shields.io/npm/v/@quicore/problem-details-error.svg)](https://www.npmjs.com/package/@quicore/problem-details-error)
[![license](https://img.shields.io/npm/l/@quicore/problem-details-error.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@quicore/problem-details-error.svg)](https://nodejs.org)

`@quicore/problem-details-error` gives you one base `AppError` class — and the patterns to subclass it — so every error in your Node.js API:

- Logs verbose diagnostics for developers (`message`, `stack`, full `cause` chain, internal context)
- Returns a clean, [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) payload to clients
- Never leaks internal IDs, SQL fragments, or stack traces in HTTP responses
- Plays nicely with Pino, Winston, and `JSON.stringify` out of the box

---

## Why?

Errors have two audiences: the developer reading logs at 2 AM and the API client receiving the response. They need different information.

This package enforces the split:

| Concern         | Internal (logs)                       | Public (RFC 9457)         |
| --------------- | ------------------------------------- | ------------------------- |
| What happened   | `message`, `stack`, `cause`           | `title`, `detail`         |
| Identification  | `internalContext`                     | `type`, `code`            |
| HTTP            | `status`                              | `status`                  |
| Structured data | `internalContext`                     | `errors`                  |

You write one error class per error type. Call sites stay clean. The middleware does the rest.

---

## Install

```bash
npm install @quicore/problem-details-error
```

Requires Node.js 18 or newer.

---

## Quick start

```js
const { AppError } = require('@quicore/problem-details-error');

throw new AppError('Database query failed in getUserById(id=abc123)', {
  status: 500,
  code: 'DB_QUERY_FAILED',
  cause: dbError,
  internalContext: { userId: 'abc123' },
});
```

What the **client sees** (`Content-Type: application/problem+json`):

```json
{
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "An unexpected error occurred. Please try again later.",
  "code": "DB_QUERY_FAILED",
  "instance": "/users/abc123",
  "requestId": "8f3e1a2b-..."
}
```

What the **logs capture**:

```json
{
  "name": "AppError",
  "message": "Database query failed in getUserById(id=abc123)",
  "code": "DB_QUERY_FAILED",
  "status": 500,
  "isOperational": true,
  "timestamp": "2026-05-22T10:23:45.123Z",
  "internalContext": { "userId": "abc123" },
  "stack": "AppError: Database query failed...",
  "cause": {
    "name": "Error",
    "message": "ECONNREFUSED 127.0.0.1:5432",
    "stack": "..."
  }
}
```

---

## Subclass for cleaner call sites

Don't repeat boilerplate at every throw. Subclass once, throw with intent:

```js
const { AppError } = require('@quicore/problem-details-error');

class NotFoundError extends AppError {
  constructor(resource, identifier, { cause } = {}) {
    super(`${resource} not found (identifier=${JSON.stringify(identifier)})`, {
      status: 404,
      code: `${resource.toUpperCase()}_NOT_FOUND`,
      detail: `The requested ${resource.toLowerCase()} could not be found.`,
      cause,
      internalContext: { resource, identifier },
    });
  }
}

// Now your call sites read like English:
throw new NotFoundError('User', { id: 'abc123' });
```

A starter set of subclasses (`NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`, `RateLimitError`, `ExternalServiceError`, `DatabaseError`) ships in the [examples](./examples/httpErrors.js).

---

## Express integration

```js
const express = require('express');
const crypto = require('crypto');
const { AppError } = require('@quicore/problem-details-error');

const app = express();
app.use(express.json());

// Attach a request ID for log correlation
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

// ... your routes ...

// Central error handler — last middleware
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    // Log full internal view
    req.log?.error({ err }); // err.toJSON() runs automatically

    // Return safe public view
    return res
      .status(err.status)
      .type('application/problem+json')
      .json(err.toProblemDetails({
        instance: req.originalUrl,
        requestId: req.id,
      }));
  }

  // Unknown error — never leak details
  req.log?.error({ err });
  res.status(500).type('application/problem+json').json({
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred. Please try again later.',
    code: 'INTERNAL_ERROR',
    instance: req.originalUrl,
    requestId: req.id,
  });
});
```

---

## API

### `new AppError(message, options)`

| Param                     | Type      | Default              | Description                                                    |
| ------------------------- | --------- | -------------------- | -------------------------------------------------------------- |
| `message`                 | `string`  | —                    | **Internal** message for logs. Verbose, may include IDs.       |
| `options.status`          | `number`  | `500`                | HTTP status (RFC 9457 `status`). Integer 400–599.              |
| `options.code`            | `string`  | `'INTERNAL_ERROR'`   | Machine-readable code. Default pattern: `/^[A-Z][A-Z0-9_]*$/`. |
| `options.title`           | `string`  | from `STATUS_CODES`  | Short human summary (RFC 9457 `title`).                        |
| `options.detail`          | `string`  | generic fallback     | Public per-occurrence message (RFC 9457 `detail`).             |
| `options.type`            | `string`  | built from `code`    | URI identifying the error class (RFC 9457 `type`).             |
| `options.errors`          | `object`  | `null`               | Structured data **safe to expose** (e.g. field errors).        |
| `options.internalContext` | `object`  | `null`               | Structured data for **logs only**.                             |
| `options.cause`           | `Error`   | `undefined`          | Underlying error being wrapped (ES2022).                       |
| `options.isOperational`   | `boolean` | `true`               | `false` for programmer bugs (should crash the process).        |

### `err.toProblemDetails(extras)`

Returns an RFC 9457 Problem Details object. **Safe to send to clients.**

```js
res
  .status(err.status)
  .type('application/problem+json')
  .json(err.toProblemDetails({ instance: req.originalUrl, requestId: req.id }));
```

### `err.toLogJSON()` / `err.toJSON()`

Returns the full internal view including stack and recursive `cause` chain (depth-capped at 5).

`toJSON()` is the standard hook Pino, Winston, and `JSON.stringify` call automatically — you usually don't need to invoke it yourself.

### Static configuration

```js
AppError.CODE_PATTERN = /^[a-z][a-z0-9_]*$/; // override code format
AppError.VALIDATE = true;                    // force validation in production
```

`VALIDATE` defaults to `true` in non-production, `false` in production (so validation bugs surface in dev/test but never throw inside production error-handling code paths).

### Static helpers

- `AppError.validateStatus(status)` — throws `TypeError` if out of range
- `AppError.validateCode(code)` — throws `TypeError` if pattern fails
- `AppError.buildTypeUri(code)` — builds the RFC 9457 `type` URI
- `AppError.titleForStatus(status)` — looks up the HTTP status title
- `AppError.serializeCause(err)` — recursively serializes a cause chain

---

## Environment variables

| Variable                | Effect                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `ERROR_TYPE_BASE_URL`   | Base URL for generated `type` URIs (e.g. `https://api.example.com/errors`). Trailing slashes are stripped. Defaults to `about:blank`. |
| `NODE_ENV`              | Controls default value of `AppError.VALIDATE`.                                       |

---

## Design principles

1. **Two audiences, two views.** Logs get everything; clients get RFC 9457 only.
2. **Standards over invention.** RFC 9457 is the spec; we don't reinvent error shapes.
3. **Subclass to encode conventions.** Base class is generic; subclasses make call sites readable.
4. **Fail loud in dev, fail safe in prod.** Validation throws in dev; skipped in prod to avoid cascading errors.
5. **No magic.** Static methods, no private fields, no decorators, no framework lock-in.

---

## License

MIT