export const idleTimeoutMs = 30 * 60 * 1000;
export const absoluteTimeoutMs = 8 * 60 * 60 * 1000;

export function authenticationExpiresAt(value) {
  return Number.isSafeInteger(value?.authenticatedAt)
    ? value.authenticatedAt + absoluteTimeoutMs
    : 0;
}
