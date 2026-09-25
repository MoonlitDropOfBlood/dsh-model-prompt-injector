// Test-only stubs for index.js host imports. Not shipped.
export class TypertRemoteService {
  constructor(ctx, key) {
    this.ctx = ctx;
    this.name = key;
  }
}
export function Remote() {
  return function () {};
}
