/* js/remote.js — Universal Spatial TV Navigation */

import { config } from './data.js';

// --- State ---
let zone = 'content'; // 'nav' (sidebar) or 'content' (main area)
let focusedElement = null;
const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];

export function isRemoteMode() {
    return document.body.classList.contains('remote-mode');
}

// Checks if an element is physically visible on screen
function isVisible(el) {
    if (!el || el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

function clearFocus() {
    if (focusedElement) {
        focusedElement.classList.remove('remoteFocused');
        focusedElement = null;
    }
}

function setFocus(el) {
    clearFocus();
    if (!el) return;

    el.classList.add('remoteFocused');
    // Android TV Style: Keeps the focused item perfectly centered on screen, never half-hidden
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

    focusedElement = el;
}

// --- Context Scanners ---

function getCurrentTabIndex() {
    const activeView = document.querySelector('.view.active');
    if (!activeView) return 0;
    const viewId = activeView.id.replace('view-', '');
    return TABS.indexOf(viewId) !== -1 ? TABS.indexOf(viewId) : 0;
}

function getNavItems() {
    return [...document.querySelectorAll('#app-frame .nav-btn')].filter(isVisible);
}

// Dynamically scans the screen for whatever is currently active
function getContentItems() {
    // 1. Overlays Trap Focus (Highest Priority)
    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay) {
        return [...overlay.querySelectorAll('button:not([disabled]), input, .g-member-select-item')].filter(isVisible);
    }

    // 2. Main View
    const activeView = document.querySelector('.view.active');
    if (!activeView) return [];

    // 3. Deep Settings Trap (Only focus active panel)
    const activePanel = activeView.querySelector('.settings-panel.active') || activeView;

    // Master list of all clickable elements in the app
    const selectors = [
        '.member-card',
        '.group-card',
        '.list-item:not(.no-click)',
        'button:not([disabled])',
        '.g-member-select-item',
        'input',
        '.chip',
        '.action-btn',
        '.group-edit-btn'
    ].join(', ');

    return [...activePanel.querySelectorAll(selectors)].filter(isVisible);
}

// --- Navigation Logic ---

function switchTab(dir) {
    let idx = getCurrentTabIndex() + dir;
    if (idx < 0) idx = 0;
    if (idx >= TABS.length) idx = TABS.length - 1;

    window.navTo(TABS[idx]);

    // Wait for animation, then auto-focus
    setTimeout(() => {
        if (zone === 'nav') {
            const activeNav = document.querySelector('.nav-btn.active');
            if (activeNav) setFocus(activeNav);
        } else {
            enterContentZone();
        }
    }, 250);
}

function enterNavZone() {
    zone = 'nav';
    const activeNav = document.querySelector('.nav-btn.active') || getNavItems()[0];
    setFocus(activeNav);
}

function enterContentZone() {
    zone = 'content';
    const items = getContentItems();
    if (items.length > 0) {
        setFocus(items[0]);
    } else {
        enterNavZone();
    }
}

// --- The Geometric Spatial Engine ---
// Calculates Euclidean distance to find the absolute closest button in a specific direction
function findNextItem(items, currentEl, direction) {
    if (!currentEl || items.length === 0) return null;

    const curRect = currentEl.getBoundingClientRect();
    const curCX = curRect.left + curRect.width / 2;
    const curCY = curRect.top + curRect.height / 2;

    let bestItem = null;
    let bestDist = Infinity;

    items.forEach(item => {
        if (item === currentEl) return;
        const rect = item.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        let valid = false;
        let dist = 0;

        const dx = cx - curCX;
        const dy = cy - curCY;

        // Directional Cone Detection
        if (direction === 'up' && rect.bottom <= curRect.bottom - 5) {
            valid = Math.abs(dx) < Math.abs(dy) * 2;
            dist = Math.abs(dy) * 2 + Math.abs(dx);
        } else if (direction === 'down' && rect.top >= curRect.top + 5) {
            valid = Math.abs(dx) < Math.abs(dy) * 2;
            dist = Math.abs(dy) * 2 + Math.abs(dx);
        } else if (direction === 'left' && rect.right <= curRect.right - 5) {
            valid = Math.abs(dy) < Math.abs(dx) * 2;
            dist = Math.abs(dx) * 2 + Math.abs(dy);
        } else if (direction === 'right' && rect.left >= curRect.left + 5) {
            valid = Math.abs(dy) < Math.abs(dx) * 2;
            dist = Math.abs(dx) * 2 + Math.abs(dy);
        }

        // Strict fallback for overlapping elements
        if (!valid) {
            if (direction === 'up' && rect.bottom < curRect.top) { valid = true; dist = Math.pow(dx, 2) + Math.pow(dy, 2); }
            if (direction === 'down' && rect.top > curRect.bottom) { valid = true; dist = Math.pow(dx, 2) + Math.pow(dy, 2); }
            if (direction === 'left' && rect.right < curRect.left) { valid = true; dist = Math.pow(dx, 2) + Math.pow(dy, 2); }
            if (direction === 'right' && rect.left > curRect.right) { valid = true; dist = Math.pow(dx, 2) + Math.pow(dy, 2); }
        }

        if (valid && dist < bestDist) {
            bestDist = dist;
            bestItem = item;
        }
    });

    return bestItem;
}

function navigate(dir) {
    if (zone === 'nav') {
        const navItems = getNavItems();
        if (dir === 'right') {
            enterContentZone();
            return;
        }
        if (dir === 'left') return; // Edge of screen

        const next = findNextItem(navItems, focusedElement, dir);
        if (next) setFocus(next);
        return;
    }

    if (zone === 'content') {
        // Lock left/right/up/down inside overlays so you don't accidentally leave them
        const isOverlay = document.querySelector('.safe-overlay.active') !== null;

        const items = getContentItems();
        if (!focusedElement || !document.body.contains(focusedElement)) {
            enterContentZone();
            return;
        }

        const next = findNextItem(items, focusedElement, dir);

        if (next) {
            setFocus(next);
        } else {
            // EDGE DETECTION
            if (dir === 'left' && !isOverlay) {
                enterNavZone();
            } else if (dir === 'up' && !isOverlay) {
                switchTab(-1);
            } else if (dir === 'down' && !isOverlay) {
                switchTab(1);
            }
        }
    }
}

// --- The Master Back Button (ContextMenu) ---
function handleBack() {
    // 1. Are we in an Overlay? (e.g. Edit Group)
    const overlay = document.querySelector('.safe-overlay.active');
    if (overlay) {
        // Click the cancel/close button
        const cancelBtn = overlay.querySelector('.close-btn-abs, .modal-btn:not(.primary)');
        if (cancelBtn) {
            cancelBtn.click();
        } else if (window.closeGroupModals) {
            window.closeGroupModals();
        }
        setTimeout(enterContentZone, 200); // Refocus grid
        return;
    }

    // 2. Are we in Deep Settings?
    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0) {
        const mainSet = document.getElementById('set-main');
        if (activeSettings[0] !== mainSet) {
            const backBtn = activeSettings[0].querySelector('.back-btn');
            if (backBtn) {
                backBtn.click();
                setTimeout(enterContentZone, 200); // Refocus main settings
            }
            return;
        }
    }

    // 3. Fallback: Return to Nav Rail
    if (zone !== 'nav') {
        enterNavZone();
    }
}

function activate() {
    if (focusedElement) {
        focusedElement.click();

        if (focusedElement.tagName === 'INPUT') {
            focusedElement.focus();
        }

        // Re-scan context after clicking in case layout changed
        setTimeout(() => {
            if (zone === 'nav') {
                enterContentZone();
            } else {
                if (!document.body.contains(focusedElement) || !isVisible(focusedElement)) {
                    enterContentZone();
                }
            }
        }, 250);
    }
}

export function applyRemoteMode(on) {
    if (on) {
        document.body.classList.add('remote-mode');
        setTimeout(enterContentZone, 100);
    } else {
        document.body.classList.remove('remote-mode');
        clearFocus();
    }
}

// --- Initialization ---
export function initRemote() {
    if (config.remoteMode) applyRemoteMode(true);

    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;

        // Prevent native scrolling behavior when using remote keys
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter'].includes(e.key)) {
            e.preventDefault();
        }

        // Catch lost focus
        if (!focusedElement || !document.body.contains(focusedElement)) {
            enterContentZone();
        }

        switch (e.key) {
            case 'ArrowDown': navigate('down'); break;
            case 'ArrowUp': navigate('up'); break;
            case 'ArrowRight': navigate('right'); break;
            case 'ArrowLeft': navigate('left'); break;
            case 'Enter': activate(); break;
            case 'PageUp': switchTab(-1); break;
            case 'PageDown': switchTab(1); break;
            case 'ContextMenu': handleBack(); break;
        }
    });

    // Air Mouse override (hide focus rings when mouse moves)
    document.addEventListener('mousemove', () => {
        if (isRemoteMode()) clearFocus();
    });
}