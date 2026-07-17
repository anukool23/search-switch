/**
 * Sentinel error types.
 *
 * Same reasoning as dbswitch's ErrNotFound / ErrDuplicate: callers must be able
 * to branch on *what went wrong* without string-matching a backend's error text.
 * `catch (e) { if (e instanceof IndexNotFoundError) ... }` keeps working when the
 * driver changes; `if (e.message.includes("index_not_found_exception"))` does not.
 */

export class SearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchError";
  }
}

/** The index does not exist. */
export class IndexNotFoundError extends SearchError {
  constructor(index: string, options?: { cause?: unknown }) {
    super(`index not found: ${index}`, options);
    this.name = "IndexNotFoundError";
  }
}

/** A document lookup by id found nothing. */
export class DocumentNotFoundError extends SearchError {
  constructor(index: string, id: string, options?: { cause?: unknown }) {
    super(`document not found: ${index}/${id}`, options);
    this.name = "DocumentNotFoundError";
  }
}

/** The backend was unreachable, refused the connection, or timed out. */
export class ConnectionError extends SearchError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/**
 * The driver's optional peer dependency isn't installed.
 *
 * Backend clients are optional peers so consumers only pay for the driver they
 * use — the tradeoff is this error instead of a compile-time guarantee.
 */
export class DriverNotInstalledError extends SearchError {
  constructor(driver: string, pkg: string, options?: { cause?: unknown }) {
    super(
      `search-switch: driver "${driver}" requires the peer dependency "${pkg}". Install it with: npm install ${pkg}`,
      options,
    );
    this.name = "DriverNotInstalledError";
  }
}

/** The request was malformed before it ever reached the backend. */
export class ValidationError extends SearchError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
