import { config, memberData, tvState, getAvatarUrl } from './data.js';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
});
let lastDateDay = -1;
let cachedDateStr = '';
let clockInterval = null;

let idleTimer;

export function resetIdle(isPriority = false) {
    const s = document.getElementById('screensaver');
    if (s) {
        s.classList.remove('active');
    }
    document.body.classList.remove('screensaver-active');
    clearTimeout(idleTimer);
    stopClock();

    // Disable screensaver only during ACTIVE onboarding
    if (!config.onboardingCompleted) {
        const onboardingLayer = document.getElementById('onboarding-layer');
        const isVisible = onboardingLayer &&
                          !onboardingLayer.classList.contains('hidden') &&
                          onboardingLayer.style.display !== 'none' &&
                          onboardingLayer.style.opacity !== '0';
        if (isVisible) {
            return;
        }
    }

    const timeout = isPriority ? 5000 : (Number(config.screenTimeout) || 15000);

    idleTimer = setTimeout(() => {
        if (s) {
            s.classList.add('active');
            document.body.classList.add('screensaver-active');
            startClock();
            applyWallpaper();
            renderScreensaverMembers();
            initLocation();
        }
    }, timeout);
}
window.setScreensaverTimeout = (ms) => {
    config.screenTimeout = ms;
    clearTimeout(idleTimer);
    resetIdle();
};

export function updateClock() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const mins = now.getMinutes().toString().padStart(2, '0');

    const digits = document.getElementById('clock-time-digits');
    const currentHhmm = `${hours}:${mins}`;

    // Only update digits DOM when minute changes (skips 59/60 invalidations)
    if (digits && digits.textContent !== currentHhmm) {
        digits.textContent = currentHhmm;
    }

    // Update date only when day changes
    const todayDay = now.getDate();
    if (todayDay !== lastDateDay) {
        cachedDateStr = dateFormatter.format(now);
        lastDateDay = todayDay;
        const dateEl = document.getElementById('clock-date');
        if (dateEl) dateEl.textContent = cachedDateStr;
    }
}

export function startClock() {
    if (!clockInterval) {
        updateClock();
        // Fire every 60 seconds instead of every second
        clockInterval = setInterval(updateClock, 60000);
    }
}

export function stopClock() {
    if (clockInterval) {
        clearInterval(clockInterval);
        clockInterval = null;
    }
}

// OpenWeatherMap Integration
let isFetchingWeather = false;

async function fetchWeather(city) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(`/api/system/weather?city=${encodeURIComponent(city)}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            return null;
        }

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

    // Show loading spinner ONLY on first run if completely empty
    if (!widget.innerHTML.trim()) {
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
            // Only show fallback if we don't already have successful weather rendered
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

    // Center the clock in screensaver when no members are active
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
            // d.url already includes server-side ?t=<mtime>
            saver.style.backgroundImage = `url('${d.url}')`;
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
    // Only force-bust cache when user explicitly changes wallpaper in settings
    applyWallpaper(true);
}

// Ensure any touch, click, or pointer on screensaver immediately dismisses it
function bindScreensaverDismiss() {
    const saver = document.getElementById('screensaver');
    if (!saver) return;

    const dismiss = () => resetIdle();
    saver.addEventListener('pointerdown', dismiss, { passive: true });
    saver.addEventListener('touchstart', dismiss, { passive: true });
    saver.addEventListener('mousedown', dismiss, { passive: true });
    saver.addEventListener('click', dismiss, { passive: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindScreensaverDismiss);
} else {
    bindScreensaverDismiss();
}

// Pre-load wallpaper once on startup
applyWallpaper();