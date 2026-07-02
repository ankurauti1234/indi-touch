import { navTo } from './navigation.js';
import { renderGrid, toggleMember } from './grid.js';
import { openSetting, closeSetting, toggleTheme, selectAvatarStyle, toggleRemoteMode, toggleAnimations } from './settings.js';
import { selectChip, addGuest, renderGuestList } from './guest.js';
import { resetIdle, updateClock, initLocation, renderScreensaverMembers, refreshWallpaperOnScreensaver } from './screensaver.js';
import { initOSK } from './keyboard.js';
import { checkOnboardingStatus } from './onboarding.js';
import { showToast } from './ui.js';
import { renderNotifications } from './notifications.js';
import { openSurvey } from './survey.js';
import { initRemote } from './remote.js';
import { initConnectionMonitor, setUsbState, setWifiState, setInternetState } from './connection.js';
import { timers } from './utils.js';
import { loadGroups, renderGroupsGrid } from './groups.js';


// Expose functions globally for HTML inline event handlers
window.navTo = navTo;
window.toggleMember = toggleMember;
window.openSetting = openSetting;
window.closeSetting = closeSetting;
window.toggleTheme = toggleTheme;
window.toggleRemoteMode = toggleRemoteMode;
window.toggleAnimations = toggleAnimations;
window.selectAvatarStyle = selectAvatarStyle;
window.selectChip = selectChip;
window.addGuest = addGuest;
window.initLocation = initLocation;
window.showToast = showToast;
window.openSurvey = openSurvey;
// Expose for Python/integration layer
window.setUsbState = setUsbState;
window.setWifiState = setWifiState;
window.setInternetState = setInternetState;
window.resetIdle = resetIdle;
window.renderScreensaverMembers = renderScreensaverMembers;
window.refreshWallpaperOnScreensaver = refreshWallpaperOnScreensaver;
window.renderGrid = renderGrid;

// Define your vertical tab order
const tabOrder = ['home', 'groups', 'guest-add', 'notifications', 'settings'];

let startY = 0;

document.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
    const endY = e.changedTouches[0].clientY;
    const deltaY = startY - endY;

    // Ignore small touches
    if (Math.abs(deltaY) < 50) return;

    const activeView = document.querySelector('.view.active');
    if (!activeView) return;

    let currentEl = e.target;
    let isAtTop = true;
    let isAtBottom = true;

    // Climb up the tree to find an ACTUAL scrolling container
    while (currentEl && currentEl !== document.body && currentEl !== document.documentElement) {
        const style = window.getComputedStyle(currentEl);
        const overflowY = style.overflowY;

        // Only check elements that the browser actually allows to scroll
        if ((overflowY === 'auto' || overflowY === 'scroll') && currentEl.scrollHeight > currentEl.clientHeight) {

            isAtTop = currentEl.scrollTop <= 0;
            // 2px tolerance for fractional pixel rounding errors
            isAtBottom = Math.abs(currentEl.scrollHeight - currentEl.clientHeight - currentEl.scrollTop) <= 2;

            break; // Found the scroll container, stop looking up
        }
        currentEl = currentEl.parentElement;
    }

    const currentId = activeView.id.replace('view-', '');
    const currentIndex = tabOrder.indexOf(currentId);
    if (currentIndex === -1) return;

    // --- NATURAL SWIPE LOGIC ---

    // 1. Swipe UP (finger moves up) -> Page content goes down.
    // Transition to NEXT tab ONLY if we are at the BOTTOM of the scroll.
    if (deltaY > 50 && isAtBottom && currentIndex < tabOrder.length - 1) {
        navTo(tabOrder[currentIndex + 1]);
    }
    // 2. Swipe DOWN (finger moves down) -> Page content goes up.
    // Transition to PREVIOUS tab ONLY if we are at the TOP of the scroll.
    else if (deltaY < -50 && isAtTop && currentIndex > 0) {
        navTo(tabOrder[currentIndex - 1]);
    }
});

// ─── Phase 2 Refinements ──────────────────────────────────────────────────────
export function resetHomeTimer() {
    if (typeof homeTimer !== 'undefined') clearTimeout(homeTimer);
    const onboardingLayer = document.getElementById('onboarding-layer');
    const isOnboarding = onboardingLayer && !onboardingLayer.classList.contains('hidden') && onboardingLayer.style.display !== 'none';

    if (config.onboardingCompleted && !isOnboarding && !document.getElementById('view-home').classList.contains('active')) {
        timers.clearTimeout(window.homeTimerId); // Track specifically if needed
        window.homeTimerId = timers.setTimeout(() => {
            console.log("Inactivity timeout: returning to home.");
            navTo('home');
        }, 300000); // 5 minutes
    }
}
window.resetHomeTimer = resetHomeTimer;

let settingsClickCount = 0;
window.handleSettingsTitleClick = () => {
    settingsClickCount++;
    console.log("Settings click:", settingsClickCount);
    if (settingsClickCount === 3) {
        document.getElementById('btn-sys-info').style.display = 'flex';
        showToast("System Info Revealed");
        settingsClickCount = 0;
    }
};

let eggClicks = 0;
let eggTimer;
window.triggerEasterEgg = () => {
    eggClicks++;
    clearTimeout(eggTimer);

    if (eggClicks === 7) {
        document.getElementById('author-overlay').classList.add('active');
        eggClicks = 0;
    } else {
        eggTimer = setTimeout(() => {
            eggClicks = 0;
        }, 1000);
    }
};

window.closeEasterEgg = () => {
    document.getElementById('author-overlay').classList.remove('active');
};

export function hideAppLoader() {
    const loader = document.getElementById('app-loading');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => {
            loader.style.display = 'none';
        }, 600);
    }
}
window.hideAppLoader = hideAppLoader;

import { tvState, memberData, save as legacySave, initData, config } from './data.js';
import { initI18n, loadLanguage, applyTranslations, getCurrentLang } from './i18n.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize Localization
    await initI18n();

    // 2. Initialize Data Layer (from API)
    await initData();

    // 3. Initialize Components
    await checkOnboardingStatus();
    initOSK();
    renderGrid();
    await loadGroups();
    renderGuestList();
    initLocation();
    renderNotifications();

    // 4. Finalize - Hide app loader
    hideAppLoader();


    // 3. Start Background Services
    timers.setInterval(updateClock, 1000);
    updateClock();

    window.changeAppLanguage = async (lang) => {
        const success = await loadLanguage(lang);
        if (success) {
            import('./data.js').then(m => m.updateSetting('language', lang));
            applyTranslations();
            updateLanguageUI(lang);
            renderGrid(); // Refresh grid for active status texts if any
            renderGroupsGrid(); // Refresh groups grid
            renderNotifications(); // Refresh notifications
        }
    };

    function updateLanguageUI(lang) {
        // Toggle checks
        ['en', 'hy', 'ru'].forEach(l => {
            const check = document.getElementById('lang-check-' + l);
            if (check) check.style.display = (l === lang) ? 'block' : 'none';
        });

        // Update main settings label
        const langText = document.getElementById('current-lang-text');
        if (langText) {
            const names = { en: 'English', hy: 'Հայերեն', ru: 'Русский' };
            langText.innerText = names[lang] || lang;
        }
    }

    // Initialize UI checks
    if (typeof updateLanguageUI === 'function') {
        updateLanguageUI(getCurrentLang());
    }

    // TV Monitoring Logic
    let lastDismissTime = 0;

    timers.setInterval(() => {
        let isTvOn = tvState.on;

        // If bluetooth is not available, TV is always considered ON
        if (!config.bleAvailable) {
            isTvOn = true;
        }

        const now = Date.now();
        const cooldownActive = (now - lastDismissTime) < 15000;

        if (!isTvOn) {
            // TV is off: hide warning popover and block interaction
            const popover = document.getElementById('critical-popover');
            if (popover) popover.classList.remove('active');
        } else if (!cooldownActive && config.onboardingCompleted) {
            // If TV is on and no members are active, show critical warning
            const activeCount = memberData.filter(m => m.active).length;
            const popover = document.getElementById('critical-popover');
            if (activeCount === 0 && popover && !popover.classList.contains('active')) {
                popover.classList.add('active');
            } else if (activeCount > 0 && popover) {
                popover.classList.remove('active');
            }
        }
    }, 5000); // 5s instead of 2s to save CPU

    // Guest 2 AM Cutoff Logic
    let lastHour = new Date().getHours();
    timers.setInterval(async () => {
        const now = new Date();
        const currentHour = now.getHours();
        if (lastHour === 1 && currentHour === 2) {
            console.log("2 AM Cutoff: Clearing guests.");
            try {
                const r = await fetch('/api/guests/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ guests: [] })
                });
                if (r.ok) {
                    const { guests: guestsData } = await import('./data.js');
                    guestsData.length = 0;
                    const { renderGuestList, updateGuestBadge } = await import('./guest.js');
                    renderGuestList();
                    updateGuestBadge();
                    showToast("System Reset: Guests cleared at 2 AM.");
                }
            } catch (e) {
                console.error("Failed to clear guests at 2 AM", e);
            }
        }
        lastHour = currentHour;
    }, 300000); // Check every 5 mins instead of 1 min

    window.handleCriticalAction = () => {
        const popover = document.getElementById('critical-popover');
        if (popover) popover.classList.remove('active');
        lastDismissTime = Date.now(); // Start 15s cooldown
        navTo('home');
        console.log("Critical action: Navigating home with 15s cooldown.");
    };

    showToast("Indi Meter is ready.", 4000);

    // Disable right-click context menu
    document.addEventListener('contextmenu', e => e.preventDefault());

    // 3. User Interaction Tracking
    document.addEventListener('keydown', () => { resetIdle(); resetHomeTimer(); });
    document.addEventListener('click', () => { resetIdle(); resetHomeTimer(); });
    resetIdle();
    resetHomeTimer();

    // 4. Remote Control System
    initRemote();

    // 5. Connection state monitoring
    initConnectionMonitor();

    console.log("System initialized.");
});