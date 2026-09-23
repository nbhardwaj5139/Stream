// Keeping the screen awake while a film is on.
//
// The host's screen going dark stops the capture, and a tablet dimming in the
// middle of a scene is its own small misery. A wake lock is released whenever
// the tab is hidden, so it has to be taken again each time the page comes
// back rather than requested once and forgotten.

export class WakeLock {
  constructor({ onChange = () => {} } = {}) {
    this.supported = 'wakeLock' in navigator;
    this.onChange = onChange;
    this.wanted = false;
    this.sentinel = null;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted) this._acquire();
    });
  }

  get held() {
    return Boolean(this.sentinel) && !this.sentinel.released;
  }

  async _acquire() {
    if (!this.supported || this.held || document.visibilityState !== 'visible') return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.onChange(false);
      });
      this.onChange(true);
    } catch {
      // Refused — a battery saver, or a browser that says no. Not worth
      // interrupting anyone over.
      this.sentinel = null;
    }
  }

  async want(value) {
    this.wanted = Boolean(value);
    if (this.wanted) {
      await this._acquire();
      return;
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      /* already gone */
    }
  }
}
