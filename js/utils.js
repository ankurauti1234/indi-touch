/* js/utils.js - Stability and Performance Utilities */

/**
 * Centralized Timer Manager to prevent memory leaks from uncleaned intervals/timeouts.
 */
class TimerManager {
    constructor() {
        this.intervals = new Set();
        this.timeouts = new Set();
    }

    setInterval(fn, delay, ...args) {
        const id = setInterval(fn, delay, ...args);
        this.intervals.add(id);
        return id;
    }

    clearInterval(id) {
        clearInterval(id);
        this.intervals.delete(id);
    }

    setTimeout(fn, delay, ...args) {
        const id = setTimeout(() => {
            fn(...args);
            this.timeouts.delete(id);
        }, delay);
        this.timeouts.add(id);
        return id;
    }

    clearTimeout(id) {
        clearTimeout(id);
        this.timeouts.delete(id);
    }

    clearAll() {
        this.intervals.forEach(id => clearInterval(id));
        this.timeouts.forEach(id => clearTimeout(id));
        this.intervals.clear();
        this.timeouts.clear();
    }
}

export const timers = new TimerManager();

/**
 * Simple debounce to limit the frequency of function calls.
 */
export function debounce(fn, ms) {
    let timeoutId;
    return (...args) => {
        timers.clearTimeout(timeoutId);
        timeoutId = timers.setTimeout(() => fn(...args), ms);
    };
}

/**
 * Throttling for high-frequency events.
 */
export function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
        const now = Date.now();
        if (now - last > ms) {
            last = now;
            fn(...args);
        }
    };
}
