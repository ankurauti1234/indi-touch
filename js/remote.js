/* js/remote.js — Universal Spatial TV Navigation */

import { config } from './data.js';

// --- State ---
let zone = 'content';
let focusedElement = null;
let elementBeforeOverlay = null; // Remembers what you clicked before a popup opened
const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];

// Long press tracking
let enterPressTimer = null;
let isLongPress = false;

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
    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && alertModal.style.display !== 'none') {
        return [...alertModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay) {
        return [...overlay.querySelectorAll('button:not([disabled]), input, .g-member-select-item')].filter(isVisible);
    }

    const activeView = document.querySelector('.view.active');
    if (!activeView) return [];

    const activePanel = activeView.querySelector('.settings-panel.active') || activeView;

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
        // Only override if we don't already have a valid memory target
        if (elementBeforeOverlay && document.body.contains(elementBeforeOverlay) && isVisible(elementBeforeOverlay)) {
            setFocus(elementBeforeOverlay);
            elementBeforeOverlay = null; // Clear memory after use
        } else {
            setFocus(items[0]);
        }
    } else {
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

        // FIX: Empty Tab Escape Hatch
        if (items.length === 0) {
            if (dir === 'left' && !locked) enterNavZone();
            else if (dir === 'up' && !locked) switchTab(-1);
            else if (dir === 'down' && !locked) switchTab(1);
            return;
        }

        if (!focusedElement || !document.body.contains(focusedElement)) {
            if (items.length > 0) setFocus(items[0]);
            return;
        }

        const next = findNextItem(items, focusedElement, dir);

        if (next) {
            setFocus(next);
        } else {
            // EDGE DETECTION
            if (dir === 'left' && !locked) enterNavZone();
            else if (dir === 'up' && !locked) switchTab(-1);
            else if (dir === 'down' && !locked) switchTab(1);
        }
    }
}

// --- The Master Tiered Back Button ---
function handleBack() {
    const osk = document.getElementById('osk-container');
    if (osk && osk.classList.contains('visible')) {
        if (window.hideOSK) window.hideOSK();
        setTimeout(enterContentZone, 150);
        return;
    }

    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && alertModal.style.display !== 'none') {
        if (window.closeAlertModal) window.closeAlertModal();
        setTimeout(enterContentZone, 150);
        return;
    }

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && deleteModal.style.display !== 'none') {
        const cancel = deleteModal.querySelector('.modal-btn:not(.primary)');
        if (cancel) cancel.click();
        setTimeout(enterContentZone, 150);
        return;
    }

    const overlay = document.querySelector('.safe-overlay.active');
    if (overlay) {
        const cancelBtn = overlay.querySelector('.close-btn-abs, .modal-btn:not(.primary)');
        if (cancelBtn) {
            cancelBtn.click();
        } else if (window.closeGroupModals) {
            window.closeGroupModals();
        }
        setTimeout(enterContentZone, 200); // enterContentZone now auto-checks elementBeforeOverlay!
        return;
    }

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

    if (zone !== 'nav') {
        enterNavZone();
    }
}

// Triggered on Long Press of Enter Key
function handleLongPress() {
    if (focusedElement && focusedElement.classList.contains('group-card')) {
        const editBtn = focusedElement.querySelector('.group-edit-btn');
        if (editBtn) {
            elementBeforeOverlay = focusedElement; // Save card memory
            editBtn.click();
        }
    }
}

function activate() {
    if (focusedElement) {
        elementBeforeOverlay = focusedElement; // ALWAYS save memory on click
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

        // Long Press Registration
        if (e.key === 'Enter' && !e.repeat) {
            isLongPress = false;
            enterPressTimer = setTimeout(() => {
                isLongPress = true;
                handleLongPress();
            }, 600); // 600ms hold triggers edit mode
            return; // Stop here, wait for keyup
        }

        if (zone === 'content' && (!focusedElement || !document.body.contains(focusedElement))) {
            const items = getContentItems();
            if (items.length > 0) focusedElement = items[0];
        }

        switch (e.key) {
            case 'ArrowDown': navigate('down'); break;
            case 'ArrowUp': navigate('up'); break;
            case 'ArrowRight': navigate('right'); break;
            case 'ArrowLeft': navigate('left'); break;
            case 'PageUp': switchTab(-1); break;
            case 'PageDown': switchTab(1); break;
            case 'ContextMenu': handleBack(); break;
        }
    });

    // Execute standard click when Enter is released (if not a long press)
    document.addEventListener('keyup', (e) => {
        if (!isRemoteMode()) return;
        if (e.key === 'Enter') {
            clearTimeout(enterPressTimer);
            if (!isLongPress) {
                activate();
            }
        }
    });

    document.addEventListener('mousemove', () => {
        if (isRemoteMode()) clearFocus();
    });
}