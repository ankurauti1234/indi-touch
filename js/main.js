import { navTo } from './navigation.js';
import { renderGrid, toggleMember } from './grid.js';
import { openSetting, closeSetting, toggleTheme, selectAvatarStyle, toggleRemoteMode, toggleAnimations } from './settings.js';
import { selectChip, addGuest, renderGuestList } from './guest.js';
import { resetIdle, updateClock, initLocation, renderScreensaverMembers, refreshWallpaperOnScreensaver, initScreensaverInteraction } from './screensaver.js';
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
let startedAtTop = false;
let startedAtBottom = false;
let isScrollableContext = false;
let consumeNextClick = false;

document.addEventListener('touchstart', e => {

    if (document.body.dataset.screensaverWakeLock === '1') {

        delete document.body.dataset.screensaverWakeLock;

        const screensaver = document.getElementById('screensaver');

        if (screensaver?.classList.contains('active')) {
            resetIdle(true);
        }

        startY = 0;
        startedAtTop = false;
        startedAtBottom = false;
        isScrollableContext = false;
        consumeNextClick = true;

        return;
    }

    const screensaver = document.getElementById('screensaver');
    if (screensaver?.classList.contains('active')) {
        return;
    }

    startY = e.touches[0].clientY;

    // Reset states for this new touch
    startedAtTop = true;
    startedAtBottom = true;
    isScrollableContext = false;

    let currentEl = e.target;

    // Check where the scroll bar is AT THE EXACT MOMENT the finger touches the screen
    while (currentEl && currentEl !== document.body && currentEl !== document.documentElement) {
        const style = window.getComputedStyle(currentEl);
        const overflowY = style.overflowY;

        if ((overflowY === 'auto' || overflowY === 'scroll') && currentEl.scrollHeight > currentEl.clientHeight) {
            isScrollableContext = true;

            startedAtTop = currentEl.scrollTop <= 0;

            startedAtBottom =
                Math.abs(
                    currentEl.scrollHeight -
                    currentEl.clientHeight -
                    currentEl.scrollTop
                ) <= 5;

            break;
        }

        currentEl = currentEl.parentElement;
    }

}, { passive: true });

document.addEventListener('touchend', e => {

    if (startY === 0) {
        startY = -1;
        return;
    }

    const screensaver = document.getElementById('screensaver');
    if (screensaver?.classList.contains('active')) {
        return;
    }

    // --- MODAL LOCK FOR TOUCH SWIPES ---
    const isModalActive = !!document.querySelector(
        '#group-modal-overlay.active, ' +
        '#wifi-password-overlay.active, ' +
        '#alert-modal, ' +
        '#duplicate-modal, ' +
        '#delete-confirm-modal, ' +
        '#wifi-warning-overlay.visible'
    );

    // If a modal is open, completely ignore the swipe
    if (isModalActive) {
        return;
    }
    // -----------------------------------------

    const endY = e.changedTouches[0].clientY;
    const deltaY = startY - endY;

    // If this was a small tap (not a swipe), try to focus inputs under the touch
    if (Math.abs(deltaY) < 50) {
        try {
            const findInputFromTouch = (t) => {
                if (!t) return null;
                if (t.matches && t.matches('input,textarea')) return t;
                const ancInput = t.closest && t.closest('input,textarea');
                if (ancInput) return ancInput;
                const container = t.closest && t.closest('.list-item, .group-member-item, .item-content, #view-guest, #view-settings, #group-members-list');
                if (container) return container.querySelector('input,textarea');
                return null;
            };

            const inputEl = findInputFromTouch(e.target);
            if (inputEl) {
                // Programmatically focus; keyboard.js listens for focusin to show OSK
                inputEl.focus({ preventScroll: false });
                // Move caret to end of existing text so user can delete/append naturally
                try {
                    const len = inputEl.value ? inputEl.value.length : 0;
                    // Delay slightly to ensure focus applied in all WebEngine contexts
                    setTimeout(() => {
                        try {
                            if (typeof inputEl.setSelectionRange === 'function') {
                                inputEl.setSelectionRange(len, len);
                            } else if (typeof inputEl.selectionStart !== 'undefined') {
                                inputEl.selectionStart = inputEl.selectionEnd = len;
                            }
                        } catch (err) {}
                    }, 10);
                } catch (err) {}
                setTimeout(() => { try { inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (err) {} }, 80);
                // Stop the following synthesized click from triggering buttons or submits
                try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } catch (err) {}
                return;
            }
        } catch (err) {
            console.error('tap->focus helper failed', err);
        }

        return;
    }

    const activeView = document.querySelector('.view.active');
    if (!activeView) return;

    // --- NEW: DEEP SETTINGS LOCK ---
    // If we are in the settings view, and a panel other than 'set-main' is active, block swipe
    if (activeView.id === 'view-settings') {
        const isDeepSetting = !!activeView.querySelector('.settings-panel.active:not(#set-main)');
        if (isDeepSetting) {
            return;
        }
    }
    // -------------------------------

    const currentId = activeView.id.replace('view-', '');
    const currentIndex = tabOrder.indexOf(currentId);
    if (currentIndex === -1) return;

    // Swipe UP -> NEXT tab
    if (deltaY > 50 && currentIndex < tabOrder.length - 1) {
        if (!isScrollableContext || startedAtBottom) {
            navTo(tabOrder[currentIndex + 1]);
        }
    }

    // Swipe DOWN -> PREVIOUS tab
    else if (deltaY < -50 && currentIndex > 0) {
        if (!isScrollableContext || startedAtTop) {
            navTo(tabOrder[currentIndex - 1]);
        }
    }

});

document.addEventListener('click', (e) => {
    // Only swallow the very next click if it was set by the screensaver wake-lock
    // and the click is not targeting a genuine interactive element (inputs/buttons/modals).
    if (!consumeNextClick) {
        return;
    }

    consumeNextClick = false;

    // Only perform swallowing in the explicit screensaver wake scenario
    const wakeLockActive = document.body.dataset.screensaverWakeLock === '1';
    if (!wakeLockActive) {
        return; // allow the click through for other consumeNextClick reasons
    }

    // If the user tapped an input, textarea, select, button, or inside a modal/list-item,
    // do not swallow — allow native behavior to proceed.
    const target = e.target;
    const interactive = target.closest && target.closest('input, textarea, select, button, .modal-card, .popover-card, .group-card, .list-item, #group-modal-overlay, #wifi-password-overlay, #alert-modal');
    if (interactive) {
        return; // allow event to reach the interactive element
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

}, true);

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
    // 1. Initialize Localization & Data
    await initI18n();
    await initData();

    // 2. Initialize Components (Call these ONCE)
    await checkOnboardingStatus();
    initOSK();
    renderGrid();
    await loadGroups();
    renderGuestList();
    initLocation();
    renderNotifications();
    // initScreensaverInteraction(); // Added here

    // 3. Finalize - Hide app loader
    hideAppLoader();

    // 4. Background Services & Logic
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

    // 5. Unified User Interaction Tracking
    const activityEvents = ['touchstart', 'touchmove', 'click', 'scroll', 'keydown'];

    function handleUserActivity(e) {
        // If the screensaver is active, DON'T process navigation logic
        const s = document.getElementById('screensaver');
        if (s && s.classList.contains('active')) return;

        resetIdle();
        resetHomeTimer();
    }
    activityEvents.forEach(eventType => {
        document.addEventListener(eventType, handleUserActivity, { passive: true });
    });
    handleUserActivity();

    // 6. Systems
    initRemote();
    initConnectionMonitor();
    document.addEventListener('contextmenu', e => e.preventDefault());

    console.log("System initialized.");
});