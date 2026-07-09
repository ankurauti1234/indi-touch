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
    else if (viewId === 'groups') btnId = 'btn-groups';
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

// Tracks the exact element the user started touching so we can check its scroll position
let activeScrollableElement = null;

function getScrollableParent(element) {
    if (!element || element === document.body) return null;

    // Check if the element is designed to scroll (has overflow-y: auto or scroll)
    const style = window.getComputedStyle(element);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        // Only return it if it actually has content that overflows
        if (element.scrollHeight > element.clientHeight) {
            return element;
        }
    }
    return getScrollableParent(element.parentElement);
}

function checkOverlayLocks() {
    // LOCK 1: Are there any popups, alerts, or modals active?
    const hasActiveOverlay = document.querySelector('.safe-overlay.active, .popover-overlay.active');
    const hasLegacyOverlay = document.querySelector('#modal-overlay[style*="display: flex"], #critical-popover[style*="display: flex"]');
    if (hasActiveOverlay || hasLegacyOverlay) return true;

    // LOCK 2: Are we inside deep settings?
    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0) {
        const isRootSetting = activeSettings.length === 1 && activeSettings[0].id === 'set-main';
        if (!isRootSetting) return true;
    }
    return false;
}

document.addEventListener('touchstart', (e) => {
    // 1. Immediately abort if overlays or sub-menus are active
    if (checkOverlayLocks()) {
        activeScrollableElement = null;
        return;
    }

    touchStartY = e.changedTouches[0].screenY;
    touchStartX = e.changedTouches[0].screenX;

    // Find if the user started their touch inside a list/grid that can scroll
    activeScrollableElement = getScrollableParent(e.target);

}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (checkOverlayLocks()) return;

    touchEndY = e.changedTouches[0].screenY;
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
}, { passive: true });

function handleSwipe() {
    const deltaY = touchEndY - touchStartY;
    const deltaX = touchEndX - touchStartX;

    // Ensure it is primarily a VERTICAL swipe
    if (Math.abs(deltaY) > SWIPE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {

        // --- SCROLL EDGE DETECTION ---
        if (activeScrollableElement) {
            const scrollTop = activeScrollableElement.scrollTop;
            const maxScroll = activeScrollableElement.scrollHeight - activeScrollableElement.clientHeight;

            // Swiping UP on screen (deltaY < 0) means the user wants to scroll DOWN the list.
            // If they are not at the absolute bottom of the list, abort the tab change.
            if (deltaY < 0 && scrollTop < maxScroll - 2) {
                return; // Let the native scroll happen
            }

            // Swiping DOWN on screen (deltaY > 0) means the user wants to scroll UP the list.
            // If they are not at the absolute top of the list, abort the tab change.
            if (deltaY > 0 && scrollTop > 2) {
                return; // Let the native scroll happen
            }
        }

        // --- TAB SWITCHING ---
        // Negative deltaY = Swiping UP on screen = Move DOWN the tab list
        if (deltaY < 0) {
            if (currentTabIndex < TABS.length - 1) {
                currentTabIndex++;
                navTo(TABS[currentTabIndex]);
            }
        }
        // Positive deltaY = Swiping DOWN on screen = Move UP the tab list
        else {
            if (currentTabIndex > 0) {
                currentTabIndex--;
                navTo(TABS[currentTabIndex]);
            }
        }
    }
}

// Make sure HTML onclick handlers can still see the function
window.navTo = navTo;