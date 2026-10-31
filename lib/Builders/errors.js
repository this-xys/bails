export class AIRichError extends Error {
  constructor(message, code = "AIRICH_ERROR", meta = {}) {
    super(message);
    this.name = "AIRichError";
    this.code = code;
    Object.assign(this, meta);
  }
  unwrap() {
    return this.cause ?? null;
  }
  toJSON() {
    const { name, code, message, stack, cause, ...meta } = this;
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(cause
        ? { cause: cause instanceof Error ? { name: cause.name, message: cause.message } : cause }
        : {}),
      ...meta
    };
  }
}
export class ItemNotFoundError extends AIRichError {
  constructor(message, meta = {}) {
    super(message, "ITEM_NOT_FOUND", meta);
    this.name = "ItemNotFoundError";
  }
}
export class DuplicateIdError extends AIRichError {
  constructor(message, meta = {}) {
    super(message, "DUPLICATE_ID", meta);
    this.name = "DuplicateIdError";
  }
}
export class InvalidTargetError extends AIRichError {
  constructor(message, meta = {}) {
    super(message, "INVALID_TARGET", meta);
    this.name = "InvalidTargetError";
  }
}
export class ContentValidationError extends AIRichError {
  constructor(message, meta = {}) {
    super(message, "CONTENT_VALIDATION", meta);
    this.name = "ContentValidationError";
  }
}
