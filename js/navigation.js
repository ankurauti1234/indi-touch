import { closeSetting } from './settings.js';

// 1. Define the strict vertical order of tabs for clamping
const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];
let currentTabIndex = 0; // Default to top tab

export function navTo(viewId) {
    // Sync the swipe index if the user manually clicks a button
    const index = TABS.indexOf(viewId);
    if (index !== -1) currentTabIndex = index;

    // 1. Sidebar Buttons Logic
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    let btnId = '';
    if (viewId === 'home') btnId = 'btn-home';
    else if (viewId === 'groups') btnId = 'btn-groups'; // Added groups support
    else if (viewId === 'notifications') btnId = 'btn-notif';
    else if (viewId === 'settings') btnId = 'btn-settings';
    else if (viewId === 'guest-add') btnId = 'btn-guest';

    if (btnId) {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.add('active');
    }

    // 2. Reset Settings if leaving settings view
    if (viewId !== 'settings') {
        closeSetting();
    }

    // 3. Show correct view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById('view-' + viewId);
    if (viewEl) viewEl.classList.add('active');
}

// ==========================================
// VERTICAL SWIPE TAB NAVIGATION LOGIC
// ==========================================

let touchStartY = 0;
let touchEndY = 0;
let touchStartX = 0;
let touchEndX = 0;
const SWIPE_THRESHOLD = 60; // Minimum vertical pixel distance for a valid swipe

function isSwipeLocked(e) {
    // LOCK 1: Are there any popups, alerts, or modals active?
    const hasActiveOverlay = document.querySelector('.safe-overlay.active, .popover-overlay.active');
    const hasLegacyOverlay = document.querySelector('#modal-overlay[style*="display: flex"], #critical-popover[style*="display: flex"]');
    if (hasActiveOverlay || hasLegacyOverlay) return true;

    // LOCK 2: Are we inside deep settings?
    // (If any settings panel is active that is NOT the main menu)
    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0) {
        // If it is NOT exactly the root 'set-main', we are in a sub-menu
        const isRootSetting = activeSettings.length === 1 && activeSettings[0].id === 'set-main';
        if (!isRootSetting) return true;
    }

    // LOCK 3: Is the user touching a scrollable area?
    // We do NOT want to change tabs if they are just trying to scroll a list.
    const scrollableTarget = e.target.closest('[style*="overflow-y: auto"], .list-group, .g-member-select-list, .settings-scroll-area');
    if (scrollableTarget) return true;

    return false;
}

document.addEventListener('touchstart', (e) => {
    if (isSwipeLocked(e)) return;
    touchStartY = e.changedTouches[0].screenY;
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (isSwipeLocked(e)) return;
    touchEndY = e.changedTouches[0].screenY;
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
}, { passive: true });

function handleSwipe() {
    const deltaY = touchEndY - touchStartY;
    const deltaX = touchEndX - touchStartX;

    // Ensure it is primarily a VERTICAL swipe (Y distance must be greater than X distance)
    if (Math.abs(deltaY) > SWIPE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {

        // Negative deltaY = Swiping UP on screen = Move DOWN the tab list
        if (deltaY < 0) {
            if (currentTabIndex < TABS.length - 1) { // Clamped at bottom (Settings)
                currentTabIndex++;
                navTo(TABS[currentTabIndex]);
            }
        }
        // Positive deltaY = Swiping DOWN on screen = Move UP the tab list
        else {
            if (currentTabIndex > 0) { // Clamped at top (Home)
                currentTabIndex--;
                navTo(TABS[currentTabIndex]);
            }
        }
    }
}

// Make sure HTML onclick handlers can still see the function
window.navTo = navTo;