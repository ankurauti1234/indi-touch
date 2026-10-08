import { navTo } from './navigation.js';
import { renderGrid, toggleMember } from './grid.js';
import { openSetting, closeSetting, toggleTheme, selectAvatarStyle, toggleRemoteMode, toggleAnimations } from './settings.js';
import { selectChip, addGuest, renderGuestList } from './guest.js';
import { resetIdle, updateClock, initLocation, renderScreensaverMembers, refreshWallpaperOnScreensaver } from './screensaver.js';
import { initOSK } from './keyboard.js';
import { checkOnboardingStatus } from './onboarding.js';
import { showToast } from './ui.js';
import { initRemote } from './remote.js';
import { initConnectionMonitor, setUsbState, setWifiState, setInternetState } from './connection.js';
import { timers } from './utils.js';
import { tvState, memberData, initData, config, loadMembers, updateSetting } from './data.js';
import { initI18n, loadLanguage, applyTranslations, getCurrentLang } from './i18n.js';

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

// Expose for Python/integration layer
window.setUsbState = setUsbState;
window.setWifiState = setWifiState;
window.setInternetState = setInternetState;
window.resetIdle = resetIdle;
window.renderScreensaverMembers = renderScreensaverMembers;
window.refreshWallpaperOnScreensaver = refreshWallpaperOnScreensaver;
window.renderGrid = renderGrid;

// ─── Phase 2 Refinements ──────────────────────────────────────────────────────
export function resetHomeTimer() {
    if (typeof homeTimer !== 'undefined') clearTimeout(homeTimer);
    const onboardingLayer = document.getElementById('onboarding-layer');
    const isOnboarding = onboardingLayer && !onboardingLayer.classList.contains('hidden') && onboardingLayer.style.display !== 'none';

    if (config.onboardingCompleted && !isOnboarding && !document.getElementById('view-home').classList.contains('active')) {
        timers.clearTimeout(window.homeTimerId);
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

// Current UI-session declaration timestamp.
let lastMemberDeclaredAt = null;

function recordMemberDeclaration() {
    lastMemberDeclaredAt = Date.now();
    console.log(
        "[Maintenance] Member declaration timestamp updated:",
        new Date(lastMemberDeclaredAt).toLocaleString()
    );
}
window.recordMemberDeclaration = recordMemberDeclaration;

let maintenanceResetInProgress = false;

async function runDailyMaintenanceIfNeeded() {
    if (maintenanceResetInProgress) return;

    const now = new Date();
    const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");

    const currentHour = now.getHours();

    // The automatic reset is only performed at/after 02:00
    if (currentHour < 2) return;

    const resetId = `${today}_02:00`;

    // Only run once per calendar day
    if (config.lastAutoResetId === resetId) return;

    const activeCount = memberData.filter(m => m.active).length;

    if (activeCount === 0) {
        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;
        console.log("[Maintenance] 02:00 reset skipped: no active members.");
        return;
    }

    maintenanceResetInProgress = true;

    try {
        const response = await fetch("/api/members/undeclare", { method: "POST" });
        if (!response.ok) {
            throw new Error("Failed to automatically undeclare members.");
        }

        await loadMembers();
        updateStillWatchingState();

        const { guests: guestsData } = await import("./data.js");
        guestsData.length = 0;

        const { renderGuestList, updateGuestBadge } = await import("./guest.js");
        renderGuestList();
        updateGuestBadge();

        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;

        console.log("[Maintenance] Mandatory 02:00 automatic reset completed.");
    } catch (err) {
        console.error("[Maintenance] Automatic reset failed for 02:00:", err);
    } finally {
        maintenanceResetInProgress = false;
    }
}

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

// ---------------- Still Watching ----------------
let stillWatchingTimer = null;
let stillWatchingDismissTimer = null;
let stillWatchingReminderTimer = null;

function showStillWatchingPopup() {
    const popup = document.getElementById("still-watching-popover");
    if (!popup || popup.classList.contains("visible")) return;

    timers.clearTimeout(stillWatchingReminderTimer);
    popup.classList.add("visible");
    timers.clearTimeout(stillWatchingDismissTimer);

    // Keep popup visible for 20 seconds
    stillWatchingDismissTimer = timers.setTimeout(() => {
        popup.classList.remove("visible");
        timers.clearTimeout(stillWatchingReminderTimer);

        // Wait 5 minutes before showing again
        stillWatchingReminderTimer = timers.setTimeout(() => {
            const activeCount = memberData.filter(m => m.active).length;
            if (activeCount > 0) {
                showStillWatchingPopup();
            }
        }, 5 * 60 * 1000); // 5 minutes
    }, 20 * 1000); // 20 seconds
}

function restartStillWatchingTimer() {
    timers.clearTimeout(stillWatchingTimer);
    timers.clearTimeout(stillWatchingReminderTimer);

    // 3 hours of inactivity before first prompt
    stillWatchingTimer = timers.setTimeout(() => {
        showStillWatchingPopup();
    }, 15 * 1000); // 3 hours
}

function updateStillWatchingState() {
    const activeCount = memberData.filter(m => m.active).length;

    if (activeCount === 0) {
        timers.clearTimeout(stillWatchingTimer);
        timers.clearTimeout(stillWatchingDismissTimer);
        timers.clearTimeout(stillWatchingReminderTimer);
        document.getElementById("still-watching-popover")?.classList.remove("visible");
        return;
    }

    timers.clearTimeout(stillWatchingDismissTimer);
    timers.clearTimeout(stillWatchingReminderTimer);
    document.getElementById("still-watching-popover")?.classList.remove("visible");

    restartStillWatchingTimer();
}
window.updateStillWatchingState = updateStillWatchingState;

async function endViewingSession() {
    timers.clearTimeout(stillWatchingTimer);
    timers.clearTimeout(stillWatchingDismissTimer);
    timers.clearTimeout(stillWatchingReminderTimer);

    document.getElementById("still-watching-popover")?.classList.remove("visible");

    try {
        const response = await fetch("/api/members/undeclare", { method: "POST" });
        if (!response.ok) throw new Error("Failed to end viewing session.");

        await loadMembers();
        renderGrid();

        const r = await fetch("/api/guests/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guests: [] })
        });

        if (r.ok) {
            const { guests: guestsData } = await import("./data.js");
            guestsData.length = 0;
            const { renderGuestList, updateGuestBadge } = await import("./guest.js");
            renderGuestList();
            updateGuestBadge();
        }

        updateStillWatchingState();
    } catch (err) {
        console.error("[Still Watching] Failed to end viewing session:", err);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize Localization
    await initI18n();

    // 2. Initialize Data Layer (from API)
    await initData();

    // Apply Reduce Animations state if persisted in config
    if (config.reduceAnimations) {
        document.body.classList.add('reduce-animations');
    }

    await runDailyMaintenanceIfNeeded();

    // 3. Initialize Components
    await checkOnboardingStatus();
    initOSK();
    renderGrid();
    renderGuestList();
    initLocation();

    // 4. Start Background Clock and Services
    timers.setInterval(updateClock, 1000);
    updateClock();

    // 5. Finalize - Hide app loader
    hideAppLoader();

    // ---------------- Still Watching Popup ----------------
    const continueBtn = document.getElementById('still-watch-continue');
    const endBtn = document.getElementById('still-watch-end');

    continueBtn?.addEventListener('click', () => {
        timers.clearTimeout(stillWatchingDismissTimer);
        timers.clearTimeout(stillWatchingReminderTimer);
        document.getElementById('still-watching-popover')?.classList.remove('visible');
        restartStillWatchingTimer();
    });

    endBtn?.addEventListener('click', async () => {
        await endViewingSession();
    });

    updateStillWatchingState();

    window.changeAppLanguage = async (lang) => {
        const success = await loadLanguage(lang);
        if (success) {
            const dataMod = await import('./data.js');
            dataMod.updateSetting('language', lang);
            applyTranslations();
            updateLanguageUI(lang);
            renderGrid();
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

    // ---------------- Active Member Reminder State Machine ----------------
    let activeMemberReminderDismissTimer = null;
    let activeMemberReminderRepeatTimer = null;
    let activeMemberReminderCycleStarted = false;

    function showActiveMemberReminder() {
        const popover = document.getElementById('critical-popover');
        if (!popover) return;

        let isTvOn = tvState.on;
        if (!config.bleAvailable) {
            isTvOn = true;
        }

        if (!isTvOn || !config.onboardingCompleted) {
            popover.classList.remove('active');
            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);
            activeMemberReminderCycleStarted = false;
            return;
        }

        const activeCount = memberData.filter(m => m.active).length;
        if (activeCount > 0) {
            popover.classList.remove('active');
            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);
            activeMemberReminderCycleStarted = false;
            return;
        }

        activeMemberReminderCycleStarted = true;
        popover.classList.add('active');

        timers.clearTimeout(activeMemberReminderDismissTimer);
        timers.clearTimeout(activeMemberReminderRepeatTimer);

        // Show for 10 seconds
        activeMemberReminderDismissTimer = timers.setTimeout(() => {
            popover.classList.remove('active');

            // Wait 60 seconds before showing again
            activeMemberReminderRepeatTimer = timers.setTimeout(() => {
                showActiveMemberReminder();
            }, 60 * 1000);
        }, 10 * 1000);
    }

    // Monitor TV state and active members every 5 seconds
    timers.setInterval(() => {
        let isTvOn = tvState.on;
        if (!config.bleAvailable) {
            isTvOn = true;
        }

        if (!isTvOn || !config.onboardingCompleted) {
            const popover = document.getElementById('critical-popover');
            if (popover) popover.classList.remove('active');
            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);
            activeMemberReminderCycleStarted = false;
            return;
        }

        const activeCount = memberData.filter(m => m.active).length;
        if (activeCount > 0) {
            const popover = document.getElementById('critical-popover');
            if (popover) popover.classList.remove('active');
            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);
            activeMemberReminderCycleStarted = false;
            return;
        }

        const popover = document.getElementById('critical-popover');
        if (popover && !popover.classList.contains('active') && !activeMemberReminderCycleStarted) {
            showActiveMemberReminder();
        }
    }, 5000);

    // Maintenance scheduler checks every minute
    timers.setInterval(async () => {
        await runDailyMaintenanceIfNeeded();
    }, 60000);

    // User taps "Identify Members Now"
    window.handleCriticalAction = () => {
        const popover = document.getElementById('critical-popover');
        if (popover) popover.classList.remove('active');

        // 1. Defocus input and close OSK cleanly
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
        const osk = document.getElementById('osk-container');
        if (osk) osk.classList.remove('visible');
        document.body.classList.remove('osk-open');

        // 2. Dismiss screensaver if running
        const s = document.getElementById('screensaver');
        if (s) {
            s.classList.remove('active');
            document.body.classList.remove('screensaver-active');
        }
        resetIdle();

        // 3. Clear timers & start 60s cooldown so popup doesn't instantly reappear
        timers.clearTimeout(activeMemberReminderDismissTimer);
        timers.clearTimeout(activeMemberReminderRepeatTimer);
        activeMemberReminderCycleStarted = true;
        activeMemberReminderRepeatTimer = timers.setTimeout(() => {
            showActiveMemberReminder();
        }, 60 * 1000);

        navTo('home');
        console.log("Critical action: Navigating home.");
    };

    showToast("Indi Meter is ready.", 4000);

    // Disable right-click context menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    }, { passive: false });

    // User Interaction Tracking
    const interactionEvents = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];
    interactionEvents.forEach(evt => {
        document.addEventListener(evt, (e) => {
            const s = document.getElementById('screensaver');
            if (!s || !s.classList.contains('active')) {
                resetIdle();
                resetHomeTimer();
            }

            // If the user tapped inside the still-watching card, let the buttons handle it!
            if (e.target && e.target.closest && e.target.closest('#still-watching-popover .conn-card')) {
                return;
            }

            // Only restart Still Watching countdown if members are active
            const activeCount = memberData.filter(m => m.active).length;
            if (activeCount > 0) {
                const stillWatchPopover = document.getElementById('still-watching-popover');
                if (stillWatchPopover && stillWatchPopover.classList.contains('visible')) {
                    stillWatchPopover.classList.remove('visible');
                }
                restartStillWatchingTimer();
            }
        }, { passive: true });
    });

    resetIdle();
    resetHomeTimer();

    // Remote Control System
    initRemote();

    // Connection state monitoring
    initConnectionMonitor();

    console.log("System initialized.");
});