/**
 * Base class for every error this library throws on purpose.
 */
export class LasError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'LasError'
  }
}

/**
 * The bytes do not form a valid LAS file, or a read ran past the end of the
 * region it was allowed to touch.
 */
export class LasFormatError extends LasError {
  /**
   * @param {string} message
   * @param {{ offset?: number, cause?: unknown }} [options]
   */
  constructor (message, options = {}) {
    super(options.offset === undefined ? message : `${message} (at byte ${options.offset})`, options)
    this.name = 'LasFormatError'
    /** Byte offset in the file where the problem was found, when known. */
    this.offset = options.offset
  }
}

/**
 * The file is valid but uses something this library cannot decode yet.
 */
export class LasUnsupportedError extends LasError {
  constructor (message, options) {
    super(message, options)
    this.name = 'LasUnsupportedError'
  }
}
