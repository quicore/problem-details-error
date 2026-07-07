// src/errors/AppError.js

import { STATUS_CODES } from 'node:http';

/**
 * Base URL used to construct RFC 9457 `type` URIs from error codes.
 * Trailing slashes are stripped to prevent double-slash URIs.
 * Set via the ERROR_TYPE_BASE_URL environment variable.
 * Falls back to "about:blank" (the RFC 9457 default) when not configured.
 * @type {string}
 */
const DEFAULT_TYPE_BASE_URL =
  process.env.ERROR_TYPE_BASE_URL?.replace(/\/+$/, '') || 'about:blank';

/**
 * Generic fallback message shown to end users when no `detail` is provided.
 * Intentionally vague to avoid leaking internal information.
 * @type {string}
 */
const DEFAULT_PUBLIC_DETAIL = 'An unexpected error occurred. Please try again later.';

/**
 * Maximum depth when serializing nested `cause` chains, to guard against
 * pathological cycles or extremely deep wrappings.
 * @type {number}
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * @typedef {Object} AppErrorOptions
 * @property {number} [status=500]
 *   HTTP status code. Maps to RFC 9457 `status`. Must be an integer in 400–599
 *   when constructor validation is enabled.
 * @property {string} [code='INTERNAL_ERROR']
 *   Machine-readable error code. When validation is enabled, must match
 *   {@link AppError.CODE_PATTERN}. Stable across versions; clients switch on this.
 * @property {string} [title]
 *   RFC 9457 `title`: short human-readable summary, identical across all
 *   occurrences of this error type. Defaults to standard HTTP status text.
 * @property {string} [detail]
 *   RFC 9457 `detail`: human-readable explanation for THIS specific occurrence.
 *   Safe to expose to end users.
 * @property {string} [type]
 *   RFC 9457 `type`: URI identifying the error class. Auto-generated from `code`
 *   when ERROR_TYPE_BASE_URL is set; otherwise defaults to "about:blank".
 * @property {Object} [errors]
 *   Structured context that IS safe to expose to clients (e.g. field-level
 *   validation errors). Serialized as `errors` in the public response body.
 * @property {Object} [internalContext]
 *   Structured context for LOGS ONLY — never serialized to clients.
 * @property {Error} [cause]
 *   The underlying error being wrapped (ES2022 standard).
 * @property {boolean} [isOperational=true]
 *   true: expected error. false: programmer bug — process should crash.
 */

/**
 * @typedef {Object} ProblemDetailsExtras
 * @property {string} [instance]
 *   RFC 9457 `instance`: URI identifying this specific occurrence.
 * @property {string} [requestId]
 *   Correlation ID for this request.
 */

/**
 * Base error class implementing RFC 9457 (Problem Details for HTTP APIs)
 * with strict separation between internal diagnostics and public payload.
 *
 * Two audiences need different information when an error occurs:
 *
 * 1. **Developers/ops (logs)** — verbose diagnostics: `message`, `stack`,
 *    `cause` chain, `internalContext`. Surfaced via {@link AppError#toLogJSON}.
 *
 * 2. **API clients (HTTP response)** — safe, stable RFC 9457 payload:
 *    `type`, `title`, `status`, `detail`, `code`, `errors`.
 *    Surfaced via {@link AppError#toProblemDetails}.
 *
 * Typically subclassed per error type (`NotFoundError`, `ValidationError`, ...)
 * so call sites pass only what's unique per occurrence.
 *
 * @example
 * // Direct usage (rare):
 * throw new AppError('DB query failed in getUserById(id=abc123)', {
 *   status: 500,
 *   code: 'DB_QUERY_FAILED',
 *   cause: dbError,
 *   internalContext: { userId: 'abc123' },
 * });
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9457 RFC 9457 — Problem Details for HTTP APIs}
 */
export class AppError extends Error {
  /**
   * Regex used to validate error codes. Default requires SCREAMING_SNAKE_CASE
   * starting with a letter. Override at the class level to enforce a different
   * convention across your app:
   *
   * @example
   * AppError.CODE_PATTERN = /^[a-z][a-z0-9_]*$/; // allow lower_snake_case
   *
   * @type {RegExp}
   */
  static CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  /**
   * Whether the constructor validates `status` and `code` at runtime.
   * Defaults to `true` in non-production environments and `false` in production
   * to avoid throwing during error handling. Toggle explicitly to override:
   *
   * @example
   * AppError.VALIDATE = true; // always validate
   *
   * @type {boolean}
   */
  static VALIDATE = process.env.NODE_ENV !== 'production';

  /**
   * Construct a new AppError.
   *
   * @param {string} message
   *   INTERNAL message for logs. Verbose, may include IDs and parameters.
   *   Never sent to clients.
   * @param {AppErrorOptions} [options={}]
   */
  constructor(message, {
    status = 500,
    code = 'INTERNAL_ERROR',
    title,
    detail,
    type,
    errors = null,
    internalContext = null,
    cause,
    isOperational = true,
  } = {}) {
    super(message, cause ? { cause } : undefined);

    if (AppError.VALIDATE) {
      AppError.validateStatus(status);
      AppError.validateCode(code);
    }

    /** @type {string} */
    this.name = this.constructor.name;

    /**
     * HTTP status code (RFC 9457 `status`).
     * @type {number}
     */
    this.status = status;

    /**
     * Machine-readable error code. Stable across versions.
     * @type {string}
     */
    this.code = code;

    /**
     * RFC 9457 `title` — short human summary.
     * @type {string}
     */
    this.title = title || AppError.titleForStatus(status);

    /**
     * RFC 9457 `detail` — public, per-occurrence message. SAFE TO EXPOSE.
     * @type {string}
     */
    this.detail = detail || DEFAULT_PUBLIC_DETAIL;

    /**
     * RFC 9457 `type` — URI identifying the error class.
     * @type {string}
     */
    this.type = type || AppError.buildTypeUri(code);

    /**
     * Structured context SAFE to expose to clients. Serialized as `errors`
     * in the public response body. Property is named `errors` to match the
     * wire format and avoid `detail`/`details` confusion.
     * @type {?Object}
     */
    this.errors = errors;

    /**
     * Structured context for INTERNAL LOGS ONLY. Never serialized publicly.
     * @type {?Object}
     */
    this.internalContext = internalContext;

    /**
     * Whether this is an expected (operational) error vs a programmer bug.
     * @type {boolean}
     */
    this.isOperational = isOperational;

    /**
     * ISO-8601 timestamp of when the error was created. Distinct from the
     * logger's own timestamp — captures *when the error happened*, not when
     * it was eventually logged.
     * @type {string}
     */
    this.timestamp = new Date().toISOString();

    // V8-only API; guarded for portability (Bun, browsers, some runtimes).
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Validate an HTTP status code is an integer in the 400–599 range.
   * Subclasses or apps can override to widen/narrow the accepted range.
   *
   * @param {number} status
   * @throws {TypeError} If status is not a valid HTTP error code.
   */
  static validateStatus(status) {
    if (
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      throw new TypeError(
        `AppError: 'status' must be an integer in 400–599, got ${JSON.stringify(status)}`
      );
    }
  }

  /**
   * Validate an error code matches {@link AppError.CODE_PATTERN}.
   *
   * @param {string} code
   * @throws {TypeError} If code is not a string or doesn't match the pattern.
   */
  static validateCode(code) {
    if (typeof code !== 'string' || !AppError.CODE_PATTERN.test(code)) {
      throw new TypeError(
        `AppError: 'code' must match ${AppError.CODE_PATTERN}, got ${JSON.stringify(code)}`
      );
    }
  }

  /**
   * Build an RFC 9457 `type` URI from an error code.
   * Returns "about:blank" when no base URL is configured.
   *
   * @param {string} code - Error code in SCREAMING_SNAKE_CASE.
   * @returns {string} A URI suitable for the RFC 9457 `type` field.
   */
  static buildTypeUri(code) {
    if (DEFAULT_TYPE_BASE_URL === 'about:blank') return 'about:blank';
    const slug = code.toLowerCase().replace(/_/g, '-');
    return `${DEFAULT_TYPE_BASE_URL}/${slug}`;
  }

  /**
   * Look up the default RFC 9457 `title` for an HTTP status code.
   * Uses Node's built-in IANA-mapped status text.
   *
   * @param {number} status - HTTP status code.
   * @returns {string} Human-readable status text, or "Error" as fallback.
   */
  static titleForStatus(status) {
    return STATUS_CODES[status] || 'Error';
  }

  /**
   * Serialize an Error (or arbitrary cause value) recursively, walking the
   * `cause` chain up to {@link MAX_CAUSE_DEPTH} levels. Guards against cycles
   * and non-Error causes.
   *
   * @param {*} err - The cause value to serialize.
   * @param {number} [depth=0] - Current recursion depth.
   * @returns {*} A plain-object representation suitable for log serializers.
   */
  static serializeCause(err, depth = 0) {
    if (err == null) return null;
    if (depth >= MAX_CAUSE_DEPTH) return '[cause chain truncated]';
    if (!(err instanceof Error)) return err;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause != null
        ? AppError.serializeCause(err.cause, depth + 1)
        : null,
    };
  }

  /**
   * Serialize this error as an RFC 9457 Problem Details object suitable
   * for sending in an HTTP response body.
   *
   * SAFE TO SEND TO CLIENTS. Omits internal `message`, `stack`, `cause`,
   * and `internalContext`.
   *
   * Send with `Content-Type: application/problem+json`.
   *
   * @param {ProblemDetailsExtras} [extras={}]
   * @returns {Object} An RFC 9457-compliant Problem Details object.
   *
   * @example
   * res
   *   .status(err.status)
   *   .type('application/problem+json')
   *   .json(err.toProblemDetails({ instance: req.originalUrl, requestId: req.id }));
   */
  toProblemDetails(extras = {}) {
    const body = {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.detail,
      code: this.code,
    };
    if (extras.instance) body.instance = extras.instance;
    if (extras.requestId) body.requestId = extras.requestId;
    // `errors` may legitimately be {} or [], so check for presence not truthiness.
    if (this.errors != null) body.errors = this.errors;
    return body;
  }

  /**
   * Serialize this error for INTERNAL LOGGING. Includes the internal message,
   * full stack, recursive cause chain, and internal context.
   *
   * NEVER send this output to clients.
   *
   * @returns {Object} A plain object representation safe for log serializers.
   *
   * @example
   * logger.error({ err, req: { id: req.id, url: req.url } });
   * // Pino/Winston call err.toJSON() (which delegates here) automatically.
   */
  toLogJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      isOperational: this.isOperational,
      timestamp: this.timestamp,
      internalContext: this.internalContext,
      stack: this.stack,
      cause: AppError.serializeCause(this.cause),
    };
  }

  /**
   * Standard hook used by `JSON.stringify` and most structured loggers
   * (pino, winston, bunyan). Delegates to {@link AppError#toLogJSON}.
   *
   * @returns {Object}
   */
  toJSON() {
    return this.toLogJSON();
  }
}
