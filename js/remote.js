/* js/remote.js — Universal Spatial TV Navigation */

import { config } from './data.js';

// --- State ---
let zone = 'content';
let focusedElement = null;
const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];

export function isRemoteMode() {
    return document.body.classList.contains('remote-mode');
}

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

function getContentItems() {
    // 1. Alert Modals (Highest Priority)
    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && alertModal.style.display !== 'none') {
        return [...alertModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 2. Main Overlays
    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay) {
        return [...overlay.querySelectorAll('button:not([disabled]), input, .g-member-select-item')].filter(isVisible);
    }

    // 3. Main View
    const activeView = document.querySelector('.view.active');
    if (!activeView) return [];

    const activePanel = activeView.querySelector('.settings-panel.active') || activeView;

    // Notice: .group-edit-btn has been explicitly removed from this master list
    const selectors = [
        '.member-card',
        '.group-card',
        '.list-item:not(.no-click)',
        'button:not([disabled]):not(.group-edit-btn)',
        '.g-member-select-item',
        'input',
        '.chip',
        '.action-btn'
    ].join(', ');

    return [...activePanel.querySelectorAll(selectors)].filter(isVisible);
}

// Check if we are trapped inside an overlay or deep settings
function isNavLocked() {
    if (document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]')) return true;

    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0 && activeSettings[0].id !== 'set-main') return true;

    return false;
}

// --- Navigation Logic ---

function switchTab(dir) {
    let idx = getCurrentTabIndex() + dir;
    if (idx < 0) idx = 0;
    if (idx >= TABS.length) idx = TABS.length - 1;

    window.navTo(TABS[idx]);

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
        // If tab is completely empty, stay in content zone but hide cursor
        clearFocus();
    }
}

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
        if (dir === 'left') return;

        const next = findNextItem(navItems, focusedElement, dir);
        if (next) setFocus(next);
        return;
    }

    if (zone === 'content') {
        const locked = isNavLocked();
        const items = getContentItems();

        if (!focusedElement || !document.body.contains(focusedElement)) {
            // Re-acquire focus safely if we were on an empty tab
            if (items.length > 0) setFocus(items[0]);
            else if (dir === 'left' && !locked) enterNavZone();
            return;
        }

        const next = findNextItem(items, focusedElement, dir);

        if (next) {
            setFocus(next);
        } else {
            // EDGE DETECTION - Now respects the lock!
            if (dir === 'left' && !locked) {
                enterNavZone();
            } else if (dir === 'up' && !locked) {
                switchTab(-1);
            } else if (dir === 'down' && !locked) {
                switchTab(1);
            }
        }
    }
}

// --- The Master Tiered Back Button ---
function handleBack() {
    // TIER 1: Keyboard
    const osk = document.getElementById('osk-container');
    if (osk && osk.classList.contains('visible')) {
        if (window.hideOSK) window.hideOSK();
        setTimeout(enterContentZone, 150);
        return;
    }

    // TIER 2: Alert Modals (Info popups)
    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && alertModal.style.display !== 'none') {
        if (window.closeAlertModal) window.closeAlertModal();
        setTimeout(enterContentZone, 150);
        return;
    }

    // TIER 3: Delete Confirm Modals
    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && deleteModal.style.display !== 'none') {
        // Find the cancel button specifically so we don't nuke the editor below it
        const cancel = deleteModal.querySelector('.modal-btn:not(.primary)');
        if (cancel) cancel.click();
        setTimeout(enterContentZone, 150);
        return;
    }

    // TIER 4: Main Overlays (Create/Edit Group Editor)
    const overlay = document.querySelector('.safe-overlay.active');
    if (overlay) {
        const cancelBtn = overlay.querySelector('.close-btn-abs, .modal-btn:not(.primary)');
        if (cancelBtn) {
            cancelBtn.click();
        } else if (window.closeGroupModals) {
            window.closeGroupModals();
        }
        setTimeout(enterContentZone, 200);
        return;
    }

    // TIER 5: Deep Settings Sub-menus
    const activeSettings = document.querySelectorAll('.settings-panel.active');
    if (activeSettings.length > 0) {
        const mainSet = document.getElementById('set-main');
        if (activeSettings[0] !== mainSet) {
            const backBtn = activeSettings[0].querySelector('.back-btn');
            if (backBtn) {
                backBtn.click();
                setTimeout(enterContentZone, 200);
            }
            return;
        }
    }

    // TIER 6: Nav Rail
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

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter'].includes(e.key)) {
            e.preventDefault();
        }

        // Failsafe: if element disappeared, re-scan before moving
        if (zone === 'content' && (!focusedElement || !document.body.contains(focusedElement))) {
            const items = getContentItems();
            if (items.length > 0) focusedElement = items[0]; // Silent re-bind
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

    document.addEventListener('mousemove', () => {
        if (isRemoteMode()) clearFocus();
    });
}