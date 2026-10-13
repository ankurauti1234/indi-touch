import { config, memberData, tvState, getAvatarUrl } from './data.js';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
});
let lastDateDay = -1;
let cachedDateStr = '';

let idleTimer;
let isDismissing = false;

export function isScreensaverActive() {
    const s = document.getElementById('screensaver');
    return s && s.classList.contains('active');
}

export function dismissScreensaver(e) {
    const s = document.getElementById('screensaver');
    if (!s || !s.classList.contains('active')) return;

    stopClock(); 

    if (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    isDismissing = true;
    s.classList.remove('active');
    document.body.classList.remove('screensaver-active');

    // Keep pointer shield alive during the 500ms fade-out so no click hits the app below
    setTimeout(() => {
        isDismissing = false;
    }, 600);

    resetIdle();
}

export function resetIdle(isPriority = false) {
    const s = document.getElementById('screensaver');
    if (!s) return;

    clearTimeout(idleTimer);

    if (!config.onboardingCompleted) {
        const onboardingLayer = document.getElementById('onboarding-layer');
        const isVisible = onboardingLayer &&
            !onboardingLayer.classList.contains('hidden') &&
            onboardingLayer.style.display !== 'none' &&
            onboardingLayer.style.opacity !== '0';
        if (isVisible) return;
    }

    const timeout = isPriority ? 5000 : (config.screenTimeout || 15000);

    idleTimer = setTimeout(() => {
        if (s && !isDismissing) {
            document.body.classList.remove('osk-open');

            // 1. Prepare DOM contents first
            renderScreensaverMembers();

            // 2. Wait 2 frames to ensure the browser has fully painted the DOM before triggering opacity fade
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    document.body.classList.add('screensaver-active');
                    s.classList.add('active');
                    startClock();
                });
            });
        }
    }, timeout);
}

window.setScreensaverTimeout = (ms) => {
    config.screenTimeout = ms;
    clearTimeout(idleTimer);
    resetIdle();
};

let clockTimer = null;

export function startClock() {
    if (clockTimer) return;
    updateClock(); // Run immediately on show
    clockTimer = setInterval(updateClock, 1000);
}

export function stopClock() {
    if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
}

export function updateClock() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const mins = now.getMinutes().toString().padStart(2, '0');
    const secs = now.getSeconds().toString().padStart(2, '0');

    const digits = document.getElementById('clock-time-digits');
    const secsEl = document.getElementById('clock-time-secs');

    if (digits) {
        const currentHhmm = `${hours}:${mins}`;
        if (digits.textContent !== currentHhmm) {
            digits.textContent = currentHhmm;
        }
    }
    if (secsEl) {
        secsEl.textContent = secs;
    }

    const clock = document.getElementById('clock-time');
    if (clock) {
        if (!tvState.on) clock.classList.add('massive');
        else clock.classList.remove('massive');
    }

    const todayDay = now.getDate();
    if (todayDay !== lastDateDay) {
        cachedDateStr = dateFormatter.format(now);
        lastDateDay = todayDay;
        const dateEl = document.getElementById('clock-date');
        if (dateEl) dateEl.textContent = cachedDateStr;
    }
}

// OpenWeatherMap Integration via backend proxy
let isFetchingWeather = false;

async function fetchWeather(city) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(`/api/system/weather?city=${encodeURIComponent(city)}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return null;

        const data = await res.json();
        if (data && data.main && data.weather && data.weather.length > 0) {
            return {
                temp: Math.round(data.main.temp),
                icon: data.weather[0].icon,
                desc: data.weather[0].description
            };
        }
    } catch (e) {
        console.error("Weather fetch failed", e);
    }
    return null;
}

export async function initLocation() {
    const widget = document.getElementById('saver-weather');
    if (!widget || isFetchingWeather) return;

    const city = config.location || 'auto';

    if (!widget.innerHTML.trim() || widget.innerHTML.includes('material-symbols-rounded')) {
        widget.innerHTML = `<span class="material-symbols-rounded" style="animation: spin 2s linear infinite">sync</span>`;
    }

    isFetchingWeather = true;
    try {
        const weather = await fetchWeather(city);
        if (weather) {
            const iconUrl = `https://openweathermap.org/img/wn/${weather.icon}@2x.png`;
            const desc = weather.desc.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

            widget.innerHTML = `
                <img src="${iconUrl}">
                <span class="weather-temp">${weather.temp}°C</span>
                <span class="weather-desc-inline">${desc}</span>
            `;
        } else {
            if (!widget.querySelector('img')) {
                widget.innerHTML = `
                    <span class="material-symbols-rounded">wb_cloudy</span>
                    <span class="weather-temp">--°C</span>
                `;
            }
        }
    } catch (e) {
        console.warn("Weather sync error:", e);
    } finally {
        isFetchingWeather = false;
    }
}

export function renderScreensaverMembers() {
    initLocation();

    const container = document.getElementById('saver-active-members');
    if (!container) return;

    const tvTag = document.getElementById('tv-status-saver');
    const tvText = document.getElementById('tv-status-saver-text');
    const clock = document.getElementById('clock-time');

    if (tvTag) {
        if (!config.bleAvailable) {
            tvTag.style.display = 'none';
            if (clock) clock.classList.remove('massive');
        } else {
            tvTag.style.display = 'flex';
            if (tvState.on) {
                tvTag.classList.remove('offline');
                if (tvText) tvText.innerText = 'TV ON';
                if (clock) clock.classList.remove('massive');
            } else {
                tvTag.classList.add('offline');
                if (tvText) tvText.innerText = 'TV OFF';
                if (clock) clock.classList.add('massive');
            }
        }
    }

    const activeMembers = tvState.on ? memberData.filter(m => m.active) : [];

    const saver = document.getElementById('screensaver');
    if (saver) {
        if (activeMembers.length >= 5) {
            saver.classList.add('compact-view');
        } else {
            saver.classList.remove('compact-view');
        }
    }

    const hasMembers = tvState.on && activeMembers.length > 0;

    const watchingArea = container.closest('.saver-active-area');
    if (watchingArea) {
        watchingArea.style.display = hasMembers ? 'block' : 'none';
    }

    if (saver) {
        if (!hasMembers) {
            saver.classList.add('center-clock');
        } else {
            saver.classList.remove('center-clock');
        }
    }

    if (activeMembers.length === 0 || !tvState.on) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = activeMembers.map(m => {
        const url = getAvatarUrl(m);
        return `
        <div class="saver-member-item">
            <img src="${url}" class="saver-member-avatar">
            <div class="saver-member-name">${m.name}</div>
        </div>`;
    }).join('');
}

// ── WALLPAPER BACKGROUND ─────────────────────────────────────────────────────
let _cachedWallpaperUrl = null;

async function applyWallpaper(forceBust = false) {
    const saver = document.getElementById('screensaver');
    if (!saver) return;

    try {
        const r = await fetch('/api/wallpaper/status');
        const d = await r.json();

        if (d.hasWallpaper) {
            const urlToUse = d.url;
            if (_cachedWallpaperUrl !== urlToUse) {
                _cachedWallpaperUrl = urlToUse;
                saver.style.backgroundImage = `url('${urlToUse}')`;
            }
            saver.classList.add('has-wallpaper');
        } else {
            _cachedWallpaperUrl = null;
            saver.style.backgroundImage = '';
            saver.classList.remove('has-wallpaper');
        }
    } catch (e) {
        console.error('Failed to load wallpaper', e);
    }
}

export function refreshWallpaperOnScreensaver() {
    applyWallpaper(true);
}

// Setup dedicated, non-leaking touch listeners on the screensaver itself
function setupScreensaverDismissListeners() {
    const saver = document.getElementById('screensaver');
    if (!saver) return;

    // Capture touch directly on the screensaver before anything else
    ['pointerdown', 'touchstart', 'mousedown'].forEach(evtName => {
        saver.addEventListener(evtName, (e) => {
            if (saver.classList.contains('active')) {
                dismissScreensaver(e);
            }
        }, { capture: true, passive: false });
    });

    // Absorb trailing clicks during the 500ms fade-out
    document.addEventListener('click', (e) => {
        if (isDismissing) {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
    }, { capture: true, passive: false });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupScreensaverDismissListeners);
} else {
    setupScreensaverDismissListeners();
}

applyWallpaper();