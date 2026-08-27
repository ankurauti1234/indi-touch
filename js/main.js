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

// Current UI-session declaration timestamp.
// This is intentionally not persisted yet.
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
    // Prevent overlapping maintenance executions.
    if (maintenanceResetInProgress) {
        return;
    }

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

    // This scheduled reset has already been decided/processed.
    if (config.lastAutoResetId === resetId) {
        return;
    }

    /*
     * First check whether there are any active members.
     *
     * This applies to ALL reset slots.
     *
     * If nobody is active:
     * - Do not call /undeclare.
     * - Do not publish a member event.
     * - Mark this scheduled slot as handled.
     */
    const activeCount = memberData.filter(m => m.active).length;

    if (activeCount === 0) {
        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;

        console.log(
            `[Maintenance] ${resetSlot} reset skipped: no active members.`
        );

        return;
    }

    /*
     * 02:00:
     * Reset all currently active members.
     *
     * 10:00 / 18:00:
     * Reset only if the current declaration session
     * was already at least one hour old AT THE SCHEDULED TIME.
     *
     * If the session is less than one hour old at 10:00/18:00,
     * that reset slot is skipped completely.
     *
     * It must NOT become eligible later.
     */
    if (resetSlot !== "02:00") {
        /*
         * We only know the declaration time for the current UI session.
         * If it is unavailable, do not perform the scheduled reset.
         */
        if (lastMemberDeclaredAt === null) {
            await updateSetting("lastAutoResetId", resetId);
            config.lastAutoResetId = resetId;

            console.log(
                `[Maintenance] ${resetSlot} reset skipped: declaration time unavailable.`
            );

            return;
        }

        const oneHour = 60 * 60 * 1000;
        const activeDuration = now.getTime() - lastMemberDeclaredAt;

        /*
         * The decision is made at the scheduled reset time only.
         *
         * Example:
         * Declared at 17:15
         * 18:00 = 45 minutes
         * => skip 18:00
         * => do NOT reset at 18:15
         */
        if (activeDuration < oneHour) {
            await updateSetting("lastAutoResetId", resetId);
            config.lastAutoResetId = resetId;

            console.log(
                `[Maintenance] ${resetSlot} reset skipped: declaration session is less than 1 hour old.`
            );

            return;
        }
    }

    maintenanceResetInProgress = true;

    try {
        /*
         * Use the normal /undeclare endpoint so the member event
         * is published through the existing undeclare flow.
         */
        const response = await fetch("/api/members/undeclare", {
            method: "POST"
        });

        if (!response.ok) {
            throw new Error("Failed to automatically undeclare members.");
        }

        // Refresh member state from the backend.
        await loadMembers();

        // End the current Still Watching session.
        updateStillWatchingState();

        // Clear the current declaration timestamp.
        lastMemberDeclaredAt = null;

        // Clear guest data locally.
        const { guests: guestsData } = await import("./data.js");
        guestsData.length = 0;

        const {
            renderGuestList,
            updateGuestBadge
        } = await import("./guest.js");

        renderGuestList();
        updateGuestBadge();

        /*
         * Mark this exact scheduled slot as completed.
         * This prevents the same slot from triggering again.
         */
        await updateSetting("lastAutoResetId", resetId);
        config.lastAutoResetId = resetId;

        console.log(
            `[Maintenance] Automatic reset completed for ${resetSlot}.`
        );
    } catch (err) {
        console.error(
            `[Maintenance] Automatic reset failed for ${resetSlot}:`,
            err
        );
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
    if (!popup) return;

    // Don't create another popup while one is already visible
    if (popup.classList.contains("visible")) {
        return;
    }

    // No need for a pending reminder once the popup is visible
    timers.clearTimeout(stillWatchingReminderTimer);

    popup.classList.add("visible");

    timers.clearTimeout(stillWatchingDismissTimer);

    // If user does nothing for 10 seconds,
    // hide the popup and enter reminder mode.
    stillWatchingDismissTimer = timers.setTimeout(() => {
        popup.classList.remove("visible");

        // Wait 1 minute before showing it again
        timers.clearTimeout(stillWatchingReminderTimer);

        stillWatchingReminderTimer = timers.setTimeout(() => {
            const activeCount = memberData.filter(m => m.active).length;

            // Only continue reminding while someone is still active
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

        document
            .getElementById("still-watching-popover")
            ?.classList.remove("visible");

        return;
    }

    restartStillWatchingTimer();
}

window.updateStillWatchingState = updateStillWatchingState;

async function endViewingSession() {
    // Stop all Still Watching timers immediately.
    timers.clearTimeout(stillWatchingTimer);
    timers.clearTimeout(stillWatchingDismissTimer);
    timers.clearTimeout(stillWatchingReminderTimer);

    // Clear the declaration timestamp for the current UI session.
    lastMemberDeclaredAt = null;

    // Hide the popup immediately.
    document
        .getElementById("still-watching-popover")
        ?.classList.remove("visible");

    try {
        const response = await fetch("/api/members/undeclare", {
            method: "POST"
        });

        if (!response.ok) {
            throw new Error("Failed to end viewing session.");
        }

        await loadMembers();
        // await loadGroups();

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
    } catch (err) {
        console.error("[Still Watching] Failed to end viewing session:", err);
    }
}

import { tvState, memberData, save as legacySave, initData, config, loadMembers, updateSetting } from './data.js';
import { initI18n, loadLanguage, applyTranslations, getCurrentLang } from './i18n.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize Localization
    await initI18n();

    // 2. Initialize Data Layer (from API)
    await initData();

    await runDailyMaintenanceIfNeeded();

    // 3. Initialize Components
    await checkOnboardingStatus();
    initOSK();
    renderGrid();
    renderGuestList();
    initLocation();
    renderNotifications();

    // 4. Finalize - Hide app loader
    hideAppLoader();


    // 3. Start Background Services
    timers.setInterval(updateClock, 1000);
    updateClock();

    // ---------------- Still Watching Popup ----------------
    const continueBtn = document.getElementById('still-watch-continue');
    const endBtn = document.getElementById('still-watch-end');

    continueBtn?.addEventListener('click', () => {
        timers.clearTimeout(stillWatchingDismissTimer);
        timers.clearTimeout(stillWatchingReminderTimer);

        document
            .getElementById('still-watching-popover')
            ?.classList.remove('visible');

        // User confirmed they are watching.
        // Start a fresh 2-hour countdown.
        restartStillWatchingTimer();
    });

    endBtn?.addEventListener('click', async () => {
        await endViewingSession();
    });

    updateStillWatchingState();
    // ------------------------------------------------------

    window.changeAppLanguage = async (lang) => {
        const success = await loadLanguage(lang);
        if (success) {
            import('./data.js').then(m => m.updateSetting('language', lang));
            applyTranslations();
            updateLanguageUI(lang);
            renderGrid(); // Refresh grid for active status texts if any
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
    let activeMemberReminderDismissTimer = null;
    let activeMemberReminderRepeatTimer = null;
    let activeMemberReminderCycleStarted = false;

    function showActiveMemberReminder() {
        const popover = document.getElementById('critical-popover');
        if (!popover) return;

        // Don't show if the TV is off or onboarding isn't complete.
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

        // A member is active, so there is nothing to remind about.
        if (activeCount > 0) {
            popover.classList.remove('active');

            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);

            activeMemberReminderCycleStarted = false;

            return;
        }

        // A valid reminder cycle is now active.
        activeMemberReminderCycleStarted = true;

        // Show the popup.
        popover.classList.add('active');

        // Clear any previous timers before starting a new display timer.
        timers.clearTimeout(activeMemberReminderDismissTimer);
        timers.clearTimeout(activeMemberReminderRepeatTimer);

        // Automatically hide after 10 seconds.
        activeMemberReminderDismissTimer = timers.setTimeout(() => {
            popover.classList.remove('active');

            // Wait 60 seconds before showing it again.
            activeMemberReminderRepeatTimer = timers.setTimeout(() => {
                showActiveMemberReminder();
            }, 60 * 1000);
        }, 10 * 1000);
    }

    // Check the current TV/member state regularly.
    timers.setInterval(() => {
        let isTvOn = tvState.on;

        if (!config.bleAvailable) {
            isTvOn = true;
        }

        // TV is off or onboarding is not complete.
        if (!isTvOn || !config.onboardingCompleted) {
            const popover = document.getElementById('critical-popover');

            if (popover) {
                popover.classList.remove('active');
            }

            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);

            activeMemberReminderCycleStarted = false;

            return;
        }

        const activeCount = memberData.filter(m => m.active).length;

        // A member is active.
        if (activeCount > 0) {
            const popover = document.getElementById('critical-popover');

            if (popover) {
                popover.classList.remove('active');
            }

            timers.clearTimeout(activeMemberReminderDismissTimer);
            timers.clearTimeout(activeMemberReminderRepeatTimer);

            activeMemberReminderCycleStarted = false;

            return;
        }

        const popover = document.getElementById('critical-popover');

        // Start the reminder cycle only if one isn't already running.
        if (
            popover &&
            !popover.classList.contains('active') &&
            !activeMemberReminderCycleStarted
        ) {
            showActiveMemberReminder();
        }
    }, 5000);

    // Automatic member/guest reset scheduler
    // Check every minute for the 02:00, 10:00, and 18:00 reset times.
    timers.setInterval(async () => {
        await runDailyMaintenanceIfNeeded();
    }, 60000);

    window.handleCriticalAction = () => {
        const popover = document.getElementById('critical-popover');

        if (popover) {
            popover.classList.remove('active');
        }

        timers.clearTimeout(activeMemberReminderDismissTimer);
        timers.clearTimeout(activeMemberReminderRepeatTimer);

        // Keep the reminder cycle active so the 5-second monitor
        // does not immediately reopen the popup.
        activeMemberReminderCycleStarted = true;

        // Show the popup again after the required 60-second interval.
        activeMemberReminderRepeatTimer = timers.setTimeout(() => {
            showActiveMemberReminder();
        }, 60 * 1000);

        navTo('home');

        console.log("Critical action: Navigating home.");
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