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
    if (checkOverlayLocks()) {
        activeScrollableElement = null;
        return;
    }

    touchStartY = e.changedTouches[0].screenY;
    touchStartX = e.changedTouches[0].screenX;

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

    if (Math.abs(deltaY) > SWIPE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {

        // STRICT LOCK: Never switch tabs if touching a scrollable list.
        if (activeScrollableElement) {
            return;
        }

        if (deltaY < 0) {
            if (currentTabIndex < TABS.length - 1) {
                currentTabIndex++;
                navTo(TABS[currentTabIndex]);
            }
        }
        else {
            if (currentTabIndex > 0) {
                currentTabIndex--;
                navTo(TABS[currentTabIndex]);
            }
        }
    }
}

window.navTo = navTo;