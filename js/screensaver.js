import { config, memberData, tvState, getAvatarUrl } from './data.js';

let idleTimer = null;
let clockTimer = null;
let lastClockDate = '';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
});


export function resetIdle(isPriority = false) {
    const s = document.getElementById('screensaver');
    if (!s) return;

    s.classList.remove('active');
    stopClock();
    clearTimeout(idleTimer);
    idleTimer = null;

    // Disable screensaver only during ACTIVE onboarding.
    if (!config.onboardingCompleted) {
        const onboardingLayer = document.getElementById('onboarding-layer');

        const isVisible =
            onboardingLayer &&
            !onboardingLayer.classList.contains('hidden') &&
            onboardingLayer.style.display !== 'none' &&
            onboardingLayer.style.opacity !== '0';

        if (isVisible) {
            console.log("Screensaver blocked by Onboarding Layer visibility");
            return;
        }
    }

    // Use 5s if priority (e.g. TV Off), otherwise use configured timeout
    // or 15s as the default.
    const timeout = isPriority
        ? 5000
        : (config.screenTimeout || 15000);

    console.log(
        `Screensaver scheduled in ${timeout}ms. ` +
        `(TV ON: ${tvState.on}, Priority: ${isPriority})`
    );

    idleTimer = setTimeout(() => {
        console.log("Screensaver activating now...");

        s.classList.add('active');

        applyWallpaper();
        renderScreensaverMembers();
        startClock();

        idleTimer = null;
    }, timeout);
}


window.setScreensaverTimeout = (ms) => {
    // This allows immediate update from settings.
    clearTimeout(idleTimer);
    idleTimer = null;
    resetIdle();
};


export function updateClock() {
    const now = new Date();

    // 24-hour format without seconds.
    const hours = now.getHours().toString().padStart(2, '0');
    const mins = now.getMinutes().toString().padStart(2, '0');
    const hhmm = `${hours}:${mins}`;

    const digits = document.getElementById('clock-time-digits');
    const dateEl = document.getElementById('clock-date');

    // Only update the minute display when it actually changes.
    if (digits && digits.textContent !== hhmm) {
        digits.textContent = hhmm;
    }

    // Only recompute/update the date when the calendar day changes.
    const dateKey =
        `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    if (dateEl && dateKey !== lastClockDate) {
        dateEl.textContent = dateFormatter.format(now);
        lastClockDate = dateKey;
    }
}


function scheduleNextClockUpdate() {
    if (!clockTimer) return;

    const now = new Date();

    // Schedule close to the beginning of the next minute.
    const delay =
        (60 - now.getSeconds()) * 1000 -
        now.getMilliseconds() +
        50;

    clockTimer = setTimeout(() => {
        updateClock();
        scheduleNextClockUpdate();
    }, Math.max(delay, 100));
}


export function startClock() {
    if (clockTimer) return;

    updateClock();
    scheduleNextClockUpdate();
}


export function stopClock() {
    if (clockTimer) {
        clearTimeout(clockTimer);
        clockTimer = null;
    }
}


// ── Weather Integration ──────────────────────────────────────────────────────
//
// The OpenWeather API key must never be exposed to the browser.
// Weather is fetched through the local backend endpoint instead.

async function fetchWeather(city) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const url = `/api/system/weather?city=${encodeURIComponent(city)}`;

        const res = await fetch(url, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`Weather request failed: HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data && data.main && Array.isArray(data.weather) && data.weather[0]) {
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
    const city = config.location || 'Yerevan';
    const widget = document.getElementById('saver-weather');

    if (!widget) return;

    // Show loading state immediately to prevent empty UI.
    if (
        !widget.innerHTML.trim() ||
        widget.innerHTML.includes('material-symbols-rounded')
    ) {
        widget.innerHTML =
            '<span class="material-symbols-rounded" ' +
            'style="animation: spin 2s linear infinite">sync</span>';
    }

    try {
        const weather = await fetchWeather(city);

        if (weather) {
            const iconUrl =
                `https://openweathermap.org/img/wn/${weather.icon}@2x.png`;

            // Capitalize each word of description for premium feel.
            const desc = weather.desc
                .split(' ')
                .map(
                    w => w.charAt(0).toUpperCase() + w.slice(1)
                )
                .join(' ');

            widget.innerHTML = `
                <img src="${iconUrl}">
                <span class="weather-temp">${weather.temp}°C</span>
                <span class="weather-desc-inline">${desc}</span>
            `;
        } else {
            throw new Error("Null weather data");
        }
    } catch (e) {
        console.warn("Weather sync failed, using fallback", e);

        widget.innerHTML = `
            <span class="material-symbols-rounded">wb_cloudy</span>
            <span class="weather-temp">--°C</span>
        `;
    }
}


export function renderScreensaverMembers() {
    initLocation();

    const container = document.getElementById('saver-active-members');
    if (!container) return;

    // TV status on screensaver.
    const tvTag = document.getElementById('tv-status-saver');
    const tvText = document.getElementById('tv-status-saver-text');

    if (tvTag) {
        if (!config.bleAvailable) {
            tvTag.style.display = 'none';
        } else {
            tvTag.style.display = 'flex';

            if (tvState.on) {
                tvTag.classList.remove('offline');

                if (tvText) {
                    tvText.textContent = 'TV ON';
                }
            } else {
                tvTag.classList.add('offline');

                if (tvText) {
                    tvText.textContent = 'TV OFF';
                }
            }
        }
    }

    const activeMembers = tvState.on
        ? memberData.filter(m => m.active)
        : [];

    // Dynamic scaling for many members.
    const saver = document.getElementById('screensaver');

    if (saver) {
        if (activeMembers.length > 5) {
            saver.classList.add('compact-view');
        } else {
            saver.classList.remove('compact-view');
        }
    }

    // Hide/show "Watching Now" area.
    const watchingArea = container.closest('.saver-active-area');

    if (watchingArea) {
        // Only show if TV is ON and there are active members.
        watchingArea.style.display =
            (tvState.on && activeMembers.length > 0)
                ? 'block'
                : 'none';
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
            </div>
        `;
    }).join('');
}


// ── WALLPAPER BACKGROUND ─────────────────────────────────────────────────────

async function applyWallpaper() {
    const saver = document.getElementById('screensaver');
    if (!saver) return;

    try {
        const r = await fetch('/api/wallpaper/status');

        if (!r.ok) {
            throw new Error(`Wallpaper request failed: HTTP ${r.status}`);
        }

        const d = await r.json();

        if (d.hasWallpaper) {
            // Add cache buster to ensure new uploads show up immediately.
            const cacheBuster = `?t=${Date.now()}`;

            saver.style.backgroundImage =
                `url('${d.url}${cacheBuster}')`;

            saver.classList.add('has-wallpaper');
        } else {
            saver.style.backgroundImage = '';
            saver.classList.remove('has-wallpaper');
        }
    } catch (e) {
        console.error('Failed to load wallpaper', e);
    }
}


export function refreshWallpaperOnScreensaver() {
    applyWallpaper();
}


// Apply wallpaper on initial load.
applyWallpaper();