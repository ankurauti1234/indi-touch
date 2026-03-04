import { config, memberData, tvState, getAvatarUrl } from './data.js';

let idleTimer;

export function resetIdle(isPriority = false) {
    const s = document.getElementById('screensaver');
    if (!s) return;
    s.classList.remove('active');
    clearTimeout(idleTimer);

    // Disable screensaver only during ACTIVE onboarding
    if (!config.onboardingCompleted) {
        const onboardingLayer = document.getElementById('onboarding-layer');
        const isVisible = onboardingLayer && 
                          !onboardingLayer.classList.contains('hidden') && 
                          onboardingLayer.style.display !== 'none' &&
                          onboardingLayer.style.opacity !== '0';
        if (isVisible) {
            console.log("Screensaver blocked by Onboarding Layer visibility");
            return;
        }
    }

    // Use 5s if priority (e.g. TV Off), otherwise use config or 15s default
    const timeout = isPriority ? 5000 : (config.screenTimeout || 15000);
    console.log(`Screensaver scheduled in ${timeout}ms. (TV ON: ${tvState.on}, Priority: ${isPriority})`);
    
    idleTimer = setTimeout(() => {
        if (s) {
            console.log("Screensaver activating now...");
            s.classList.add('active');
            applyWallpaper(); // Fetch latest wallpaper state
            renderScreensaverMembers();
        }
    }, timeout);
}

window.setScreensaverTimeout = (ms) => {
    // This allows immediate update from settings
    clearTimeout(idleTimer);
    resetIdle();
};

export function updateClock() {
    const now = new Date();
    // 24-hour format with seconds for dynamic feel
    const hours = now.getHours().toString().padStart(2, '0');
    const mins  = now.getMinutes().toString().padStart(2, '0');
    const secs  = now.getSeconds().toString().padStart(2, '0');
    
    const digits = document.getElementById('clock-time-digits');
    const secsEl = document.getElementById('clock-time-secs');
    
    if (digits) digits.textContent = `${hours}:${mins}`;
    if (secsEl) secsEl.textContent = secs;

    const clock = document.getElementById('clock-time');
    if (clock) {
        if (!tvState.on) clock.classList.add('massive');
        else clock.classList.remove('massive');
    }

    const dateStr = now.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}).toLowerCase();
    const dateEl = document.getElementById('clock-date');
    if (dateEl) dateEl.innerText = dateStr;
}

// OpenWeatherMap Integration
const OWM_API_KEY = '0c0a2611ed5caefff0ef2e5cb6f4cdc0';

async function fetchWeather(city) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

        const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${OWM_API_KEY}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        const data = await res.json();
        if (data && data.main) {
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

    // Show loading state immediately to prevent "empty" UI
    if (!widget.innerHTML.trim() || widget.innerHTML.includes('material-symbols-rounded')) {
       widget.innerHTML = `<span class="material-symbols-rounded" style="animation: spin 2s linear infinite">sync</span>`;
    }

    try {
        const weather = await fetchWeather(city);
        if (weather) {
            const iconUrl = `https://openweathermap.org/img/wn/${weather.icon}@2x.png`;
            // Capitalize each word of description for premium feel
            const desc = weather.desc.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            
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
    initLocation(); // Ensure weather is updated when screensaver shows

    const container = document.getElementById('saver-active-members');
    if (!container) return;

    // TV Status on Saver
    const tvTag = document.getElementById('tv-status-saver');
    const tvText = document.getElementById('tv-status-saver-text');
    const clock = document.getElementById('clock-time');

    // Force massive clock if TV is off
    if (tvTag) {
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

    const activeMembers = tvState.on ? memberData.filter(m => m.active) : [];
    
    // Dynamic scaling for many members
    const saver = document.getElementById('screensaver');
    if (saver) {
        if (activeMembers.length > 5) {
            saver.classList.add('compact-view');
        } else {
            saver.classList.remove('compact-view');
        }
    }

    // Hide/Show "Watching Now" area
    const watchingArea = container.closest('.saver-active-area');
    if (watchingArea) {
        // Only show if TV is ON and there are active members
        watchingArea.style.display = (tvState.on && activeMembers.length > 0) ? 'block' : 'none';
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
async function applyWallpaper() {
    const saver = document.getElementById('screensaver');
    if (!saver) return;

    try {
        const r = await fetch('/api/wallpaper/status');
        const d = await r.json();

        if (d.hasWallpaper) {
            // Add cache buster to ensure new uploads show up immediately
            const cacheBuster = `?t=${Date.now()}`;
            saver.style.backgroundImage = `url('${d.url}${cacheBuster}')`;
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

// Apply wallpaper on initial load
applyWallpaper();
