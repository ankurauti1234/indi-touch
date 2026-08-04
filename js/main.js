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
import { loadGroups } from './groups.js';

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
window.setUsbState = setUsbState;
window.setWifiState = setWifiState;
window.setInternetState = setInternetState;
window.resetIdle = resetIdle;
window.renderScreensaverMembers = renderScreensaverMembers;
window.refreshWallpaperOnScreensaver = refreshWallpaperOnScreensaver;
window.renderGrid = renderGrid;

export function resetHomeTimer() {
    if (typeof homeTimer !== 'undefined') clearTimeout(homeTimer);
    const onboardingLayer = document.getElementById('onboarding-layer');
    const isOnboarding = onboardingLayer && !onboardingLayer.classList.contains('hidden') && onboardingLayer.style.display !== 'none';

    if (config.onboardingCompleted && !isOnboarding && !document.getElementById('view-home').classList.contains('active')) {
        timers.clearTimeout(window.homeTimerId);
        window.homeTimerId = timers.setTimeout(() => {
            navTo('home');
        }, 300000);
    }
}
window.resetHomeTimer = resetHomeTimer;

let settingsClickCount = 0;
window.handleSettingsTitleClick = () => {
    settingsClickCount++;
    if (settingsClickCount === 3) {
        document.getElementById('btn-sys-info').style.display = 'flex';
        showToast("System Info Revealed");
        settingsClickCount = 0;
    }
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


function showStillWatchingPopup() {
    const popup = document.getElementById("still-watching-popover");
    if (!popup) return;

    popup.classList.add("visible");

    timers.clearTimeout(stillWatchingDismissTimer);

    stillWatchingDismissTimer = timers.setTimeout(() => {
        popup.classList.remove("visible");
        restartStillWatchingTimer();
    }, 5 * 60 * 1000);
}

function restartStillWatchingTimer() {
    timers.clearTimeout(stillWatchingTimer);

    stillWatchingTimer = timers.setTimeout(() => {
        showStillWatchingPopup();
    }, 2 * 60 * 60 * 1000);
}

function updateStillWatchingState() {
    const activeCount = memberData.filter(m => m.active).length;

    if (activeCount === 0) {
        timers.clearTimeout(stillWatchingTimer);
        timers.clearTimeout(stillWatchingDismissTimer);

        document
            .getElementById("still-watching-popover")
            ?.classList.remove("visible");

        return;
    }

    restartStillWatchingTimer();
}

window.updateStillWatchingState = updateStillWatchingState;

async function endViewingSession() {
    timers.clearTimeout(stillWatchingDismissTimer);

    document
        .getElementById("still-watching-popover")
        ?.classList.remove("visible");

    const response = await fetch("/api/members/deactivate_all", {
        method: "POST"
    });

    if (!response.ok) return;

    await loadMembers();
    await loadGroups();
    renderGrid();

    const r = await fetch("/api/guests/update", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ guests: [] })
    });

    if (r.ok) {
        const { guests: guestsData } = await import("./data.js");
        guestsData.length = 0;

        const {
            renderGuestList,
            updateGuestBadge
        } = await import("./guest.js");

        renderGuestList();
        updateGuestBadge();
    }

    updateStillWatchingState();
}

document.addEventListener('DOMContentLoaded', async () => {

    await initI18n();
    await initData();
    
    await checkOnboardingStatus();
    initOSK();
    renderGrid();
    await loadGroups();

    renderGuestList();
    initLocation();
    renderNotifications();
    hideAppLoader();

    timers.setInterval(updateClock, 1000);
    updateClock();

    window.changeAppLanguage = async (lang) => {
        const success = await loadLanguage(lang);
        if (success) {
            import('./data.js').then(m => m.updateSetting('language', lang));
            applyTranslations();
            updateLanguageUI(lang);
            renderGrid();
            renderNotifications();
        }
    };

    function updateLanguageUI(lang) {
        ['en', 'hy', 'ru'].forEach(l => {
            const check = document.getElementById('lang-check-' + l);
            if (check) check.style.display = (l === lang) ? 'block' : 'none';
        });

        const langText = document.getElementById('current-lang-text');
        if (langText) {
            const names = { en: 'English', hy: 'Հայերեն', ru: 'Русский' };
            langText.innerText = names[lang] || lang;
        }
    }

    if (typeof updateLanguageUI === 'function') {
        updateLanguageUI(getCurrentLang());
    }

    let lastDismissTime = 0;

    timers.setInterval(() => {
        let isTvOn = tvState.on;

        if (!config.bleAvailable) {
            isTvOn = true;
        }

        const now = Date.now();
        const cooldownActive = (now - lastDismissTime) < 15000;

        if (!isTvOn) {
            const popover = document.getElementById('critical-popover');
            if (popover) popover.classList.remove('active');
        } else if (!cooldownActive && config.onboardingCompleted) {
            const activeCount = memberData.filter(m => m.active).length;
            const popover = document.getElementById('critical-popover');
            if (activeCount === 0 && popover && !popover.classList.contains('active')) {
                popover.classList.add('active');
            } else if (activeCount > 0 && popover) {
                popover.classList.remove('active');
            }
        }
    }, 5000);

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
    }, 300000);

    window.handleCriticalAction = () => {
        const popover = document.getElementById('critical-popover');
        if (popover) popover.classList.remove('active');
        lastDismissTime = Date.now();
        navTo('home');
    };

    showToast("Indi Meter is ready.", 4000);

    document.addEventListener('', e => e.preventDefault());

    document.addEventListener('keydown', () => {
        resetIdle();
        resetHomeTimer();
    });

    document.addEventListener('click', () => {
        resetIdle();
        resetHomeTimer();
    });

    resetIdle();
    resetHomeTimer();

    initRemote();
    initConnectionMonitor();

    console.log("System initialized.");
});