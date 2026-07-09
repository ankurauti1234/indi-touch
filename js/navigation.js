import { closeSetting } from './settings.js';

const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];
let currentTabIndex = 0;

export function navTo(viewId) {
    const index = TABS.indexOf(viewId);
    if (index !== -1) currentTabIndex = index;

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

    if (viewId !== 'settings') {
        closeSetting();
    }

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
const SWIPE_THRESHOLD = 60;

let activeScrollableElement = null;
let initialScrollTop = 0;

// ANTI-THRASHING COOLDOWN LOCK
let isNavigating = false;
const TRANSITION_SPEED = 250; // Milliseconds to lock touch after a swipe

function getScrollableParent(element) {
    if (!element || element === document.body) return null;

    const style = window.getComputedStyle(element);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        if (element.scrollHeight > element.clientHeight) {
            return element;
        }
    }
    return getScrollableParent(element.parentElement);
}

function checkOverlayLocks() {
    const hasActiveOverlay = document.querySelector('.safe-overlay.active, .popover-overlay.active');
    const hasLegacyOverlay = document.querySelector('#modal-overlay[style*="display: flex"], #critical-popover[style*="display: flex"]');
    if (hasActiveOverlay || hasLegacyOverlay) return true;

    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0) {
        const isRootSetting = activeSettings.length === 1 && activeSettings[0].id === 'set-main';
        if (!isRootSetting) return true;
    }
    return false;
}

document.addEventListener('touchstart', (e) => {
    // Abort if already transitioning or overlay is open
    if (isNavigating || checkOverlayLocks()) {
        activeScrollableElement = null;
        return;
    }

    touchStartY = e.changedTouches[0].screenY;
    touchStartX = e.changedTouches[0].screenX;

    activeScrollableElement = getScrollableParent(e.target);
    if (activeScrollableElement) {
        initialScrollTop = activeScrollableElement.scrollTop;
    }

}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (isNavigating || checkOverlayLocks()) return;

    touchEndY = e.changedTouches[0].screenY;
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
}, { passive: true });

// Fire navigation and lock the engine until animation finishes
function triggerSwipeNav(newIndex) {
    isNavigating = true;
    currentTabIndex = newIndex;
    navTo(TABS[currentTabIndex]);

    setTimeout(() => {
        isNavigating = false;
    }, TRANSITION_SPEED);
}

function handleSwipe() {
    const deltaY = touchEndY - touchStartY;
    const deltaX = touchEndX - touchStartX;

    if (Math.abs(deltaY) > SWIPE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {

        if (activeScrollableElement) {
            const finalScrollTop = activeScrollableElement.scrollTop;
            const maxScroll = activeScrollableElement.scrollHeight - activeScrollableElement.clientHeight;

            // If it scrolled even a tiny bit, kill the tab switch
            if (Math.abs(finalScrollTop - initialScrollTop) > 2) {
                return;
            }

            if (deltaY < 0 && initialScrollTop < maxScroll - 2) return;
            if (deltaY > 0 && initialScrollTop > 2) return;
        }

        // --- TAB SWITCHING ---
        if (deltaY < 0) {
            if (currentTabIndex < TABS.length - 1) {
                triggerSwipeNav(currentTabIndex + 1);
            }
        }
        else {
            if (currentTabIndex > 0) {
                triggerSwipeNav(currentTabIndex - 1);
            }
        }
    }
}

window.navTo = navTo;