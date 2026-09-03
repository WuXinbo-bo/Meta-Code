class BackendRecoveryPolicy {
  constructor({ maxAutomaticRestarts = 2, windowMs = 5 * 60_000, now = Date.now } = {}) {
    this.maxAutomaticRestarts = maxAutomaticRestarts;
    this.windowMs = windowMs;
    this.now = now;
    this.attempts = [];
  }

  remaining() {
    const threshold = this.now() - this.windowMs;
    this.attempts = this.attempts.filter((timestamp) => timestamp >= threshold);
    return Math.max(0, this.maxAutomaticRestarts - this.attempts.length);
  }

  recordAttempt() {
    if (this.remaining() <= 0) return false;
    this.attempts.push(this.now());
    return true;
  }

  reset() {
    this.attempts = [];
  }
}

module.exports = { BackendRecoveryPolicy };
