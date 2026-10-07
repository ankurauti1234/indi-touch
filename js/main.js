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
    let resetSlot = null;

    if (currentHour >= 18) {
        resetSlot = "18:00";
    } else if (currentHour >= 10) {
        resetSlot = "10:00";
    } else if (currentHour >= 2) {
        resetSlot = "02:00";
    } else {
        return;
    }

    const resetId = `${today}_${resetSlot}`;

    if (config.lastAutoResetId === resetId) {
        return;
    }

    const activeCount = memberData.filter(m => m.active).length;

    if (activeCount === 0) {
        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;
        console.log(`[Maintenance] ${resetSlot} reset skipped: no active members.`);
        return;
    }

    if (resetSlot !== "02:00") {
        if (lastMemberDeclaredAt === null) {
            await updateSetting("lastAutoResetId", resetId);
            config.lastAutoResetId = resetId;
            console.log(`[Maintenance] ${resetSlot} reset skipped: declaration time unavailable.`);
            return;
        }

        const oneHour = 60 * 60 * 1000;
        const activeDuration = now.getTime() - lastMemberDeclaredAt;

        if (activeDuration < oneHour) {
            await updateSetting("lastAutoResetId", resetId);
            config.lastAutoResetId = resetId;
            console.log(`[Maintenance] ${resetSlot} reset skipped: declaration session is less than 1 hour old.`);
            return;
        }
    }

    maintenanceResetInProgress = true;

    try {
        const response = await fetch("/api/members/undeclare", {
            method: "POST"
        });

        if (!response.ok) {
            throw new Error("Failed to automatically undeclare members.");
        }

        await loadMembers();
        updateStillWatchingState();

        lastMemberDeclaredAt = null;

        const { guests: guestsData } = await import("./data.js");
        guestsData.length = 0;

        const { renderGuestList, updateGuestBadge } = await import("./guest.js");
        renderGuestList();
        updateGuestBadge();

        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;

        console.log(`[Maintenance] Automatic reset completed for ${resetSlot}.`);
    } catch (err) {
        console.error(`[Maintenance] Automatic reset failed for ${resetSlot}:`, err);
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

    stillWatchingDismissTimer = timers.setTimeout(() => {
        popup.classList.remove("visible");
        timers.clearTimeout(stillWatchingReminderTimer);

        stillWatchingReminderTimer = timers.setTimeout(() => {
            const activeCount = memberData.filter(m => m.active).length;
            if (activeCount > 0) {
                showStillWatchingPopup();
            }
        }, 60 * 1000);
    }, 10 * 1000);
}

function restartStillWatchingTimer() {
    timers.clearTimeout(stillWatchingTimer);
    timers.clearTimeout(stillWatchingReminderTimer);

    stillWatchingTimer = timers.setTimeout(() => {
        showStillWatchingPopup();
    }, 2 * 60 * 60 * 1000); // 2 hours
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

    restartStillWatchingTimer();
}
window.updateStillWatchingState = updateStillWatchingState;

async function endViewingSession() {
    timers.clearTimeout(stillWatchingTimer);
    timers.clearTimeout(stillWatchingDismissTimer);
    timers.clearTimeout(stillWatchingReminderTimer);

    lastMemberDeclaredAt = null;

    document.getElementById("still-watching-popover")?.classList.remove("visible");

    try {
        const response = await fetch("/api/members/undeclare", {
            method: "POST"
        });

        if (!response.ok) {
            throw new Error("Failed to end viewing session.");
        }

        await loadMembers();
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

    // Active Member Reminder State Machine
    let reminderShownAt = 0;
    let reminderDismissedAt = 0;

    function reconcileActiveMemberReminder() {
        const popover = document.getElementById('critical-popover');
        if (!popover) return;

        let isTvOn = tvState.on;
        if (!config.bleAvailable) {
            isTvOn = true;
        }

        const activeCount = memberData.filter(m => m.active).length;
        const needsReminder = isTvOn && config.onboardingCompleted && activeCount === 0;
        const now = Date.now();

        if (!needsReminder) {
            if (popover.classList.contains('active')) {
                popover.classList.remove('active');
            }
            reminderShownAt = 0;
            return;
        }

        if (popover.classList.contains('active')) {
            if (reminderShownAt > 0 && now - reminderShownAt >= 10 * 1000) {
                popover.classList.remove('active');
                reminderShownAt = 0;
                reminderDismissedAt = now;
            }
        } else {
            // Re-show only after 60-second cooldown
            if (now - reminderDismissedAt >= 60 * 1000) {
                // Blur inputs and hide keyboard so the popup has full visibility
                if (document.activeElement && typeof document.activeElement.blur === 'function') {
                    document.activeElement.blur();
                }
                if (window.hideOSK) {
                    window.hideOSK();
                } else {
                    const osk = document.getElementById('osk-container');
                    if (osk) {
                        osk.classList.remove('visible');
                        osk.style.display = 'none';
                    }
                    document.body.classList.remove('osk-open');
                }

                popover.classList.add('active');
                reminderShownAt = now;
            }
        }
    }

    // Reconcile reminder state regularly
    timers.setInterval(reconcileActiveMemberReminder, 2000);

    // Maintenance scheduler checks every minute
    timers.setInterval(async () => {
        await runDailyMaintenanceIfNeeded();
    }, 60000);

    window.handleCriticalAction = () => {
        // 1. Force blur active inputs and hide OSK
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
        if (window.hideOSK) {
            window.hideOSK();
        } else {
            const osk = document.getElementById('osk-container');
            if (osk) {
                osk.classList.remove('visible');
                osk.style.display = 'none';
            }
            document.body.classList.remove('osk-open');
        }

        // 2. Dismiss critical popover
        const popover = document.getElementById('critical-popover');
        if (popover) {
            popover.classList.remove('active');
        }

        // 3. Dismiss screensaver if active
        const s = document.getElementById('screensaver');
        if (s) {
            s.classList.remove('active');
            document.body.classList.remove('screensaver-active');
        }
        resetIdle();

        reminderShownAt = 0;
        reminderDismissedAt = Date.now();

        // 4. Navigate home cleanly
        navTo('home');
        console.log("Critical action: Dismissed OSK, screensaver, and navigated home.");
    };

    showToast("Indi Meter is ready.", 4000);

    // Disable right-click context menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    }, { passive: false });

    // User Interaction Tracking
    // If screensaver is active, screensaver's own capture listener handles dismissal.
    // If screensaver is NOT active, reset idle timer normally.
    const interactionEvents = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];
    interactionEvents.forEach(evt => {
        document.addEventListener(evt, () => {
            const s = document.getElementById('screensaver');
            if (!s || !s.classList.contains('active')) {
                resetIdle();
                resetHomeTimer();
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