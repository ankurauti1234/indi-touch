/* js/remote.js — Universal Spatial TV Navigation */

import { config } from './data.js';

// --- State ---
let zone = 'content';
let focusedElement = null;
let elementBeforeOverlay = null;
const TABS = ['home', 'groups', 'guest-add', 'notifications', 'settings'];

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

    // ANTI-STRETCH FIX: Don't scroll inside fixed overlays
    const isInsidePopup = el.closest('.safe-overlay, .popover-overlay, #critical-popover, #modal-overlay, #osk-container, #group-alert-modal, #group-delete-confirm, #wifi-warning-overlay');
    if (!isInsidePopup) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

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
    // 1. Connection & System Popups
    const criticalPopover = document.getElementById('critical-popover');
    if (criticalPopover && isVisible(criticalPopover)) {
        return [...criticalPopover.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn && isVisible(wifiWarn)) {
        return [...wifiWarn.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 2. Alert & Delete Modals (FIXED VISIBILITY TRAP)
    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && isVisible(alertModal)) {
        return [...alertModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && isVisible(deleteModal)) {
        return [...deleteModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 3. Keyboard
    const osk = document.getElementById('osk-container');
    if (osk && isVisible(osk)) {
        return [...osk.querySelectorAll('.osk-key, button')].filter(isVisible);
    }

    // 4. Creation Overlays
    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay && isVisible(overlay)) {
        return [...overlay.querySelectorAll('input, button:not([disabled]), .g-member-select-item')].filter(isVisible);
    }

    // 5. Main UI
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
    if (isVisible(document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]'))) return true;
    if (isVisible(document.getElementById('group-alert-modal'))) return true;
    if (isVisible(document.getElementById('group-delete-confirm'))) return true;
    if (isVisible(document.getElementById('critical-popover'))) return true;
    if (isVisible(document.getElementById('wifi-warning-overlay'))) return true;
    if (isVisible(document.getElementById('osk-container'))) return true;

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
        if (elementBeforeOverlay && document.body.contains(elementBeforeOverlay) && isVisible(elementBeforeOverlay) && !isNavLocked()) {
            setFocus(elementBeforeOverlay);
            elementBeforeOverlay = null;
        } else {
            setFocus(items[0]);
        }
    } else {
        clearFocus();
    }
}

// PERFECTED SPATIAL ALGORITHM (Weighted Grid Tracking)
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
        let dist = Infinity;

        const dx = cx - curCX;
        const dy = cy - curCY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (direction === 'right' && cx > curCX) {
            valid = true; dist = absDx + (absDy * 4);
        } else if (direction === 'left' && cx < curCX) {
            valid = true; dist = absDx + (absDy * 4);
        } else if (direction === 'down' && cy > curCY) {
            valid = true; dist = absDy + (absDx * 4);
        } else if (direction === 'up' && cy < curCY) {
            valid = true; dist = absDy + (absDx * 4);
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
            if (dir === 'left' && !locked) enterNavZone();
            else if (dir === 'up' && !locked) switchTab(-1);
            else if (dir === 'down' && !locked) switchTab(1);
        }
    }
}

// --- The Master Tiered Back Button ---
function handleBack() {
    const osk = document.getElementById('osk-container');
    if (osk && isVisible(osk)) {
        if (window.hideOSK) window.hideOSK();
        setTimeout(enterContentZone, 150);
        return;
    }

    const critical = document.getElementById('critical-popover');
    if (critical && isVisible(critical)) {
        if (window.handleCriticalAction) window.handleCriticalAction();
        setTimeout(enterContentZone, 150);
        return;
    }

    const wifi = document.getElementById('wifi-warning-overlay');
    if (wifi && isVisible(wifi)) {
        wifi.classList.remove('visible');
        setTimeout(enterContentZone, 150);
        return;
    }

    const alertModal = document.getElementById('group-alert-modal');
    if (alertModal && isVisible(alertModal)) {
        if (window.closeAlertModal) window.closeAlertModal();
        else alertModal.style.display = 'none';
        setTimeout(enterContentZone, 150);
        return;
    }

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && isVisible(deleteModal)) {
        const cancel = deleteModal.querySelector('.modal-btn:not(.primary)');
        if (cancel) cancel.click();
        else deleteModal.style.display = 'none';
        setTimeout(enterContentZone, 150);
        return;
    }

    const overlay = document.querySelector('.safe-overlay.active');
    if (overlay && isVisible(overlay)) {
        const cancelBtn = overlay.querySelector('.close-btn-abs, .modal-btn:not(.primary)');
        if (cancelBtn) {
            cancelBtn.click();
        } else if (window.closeGroupModals) {
            window.closeGroupModals();
        }
        setTimeout(enterContentZone, 200);
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

function handleLongPress() {
    if (focusedElement && focusedElement.classList.contains('group-card')) {
        const editBtn = focusedElement.querySelector('.group-edit-btn');
        if (editBtn) {
            elementBeforeOverlay = focusedElement;
            editBtn.click();
        }
    }
}

function activate() {
    if (focusedElement) {
        elementBeforeOverlay = focusedElement;

        const currentItems = getContentItems();
        const focusedIndex = currentItems.indexOf(focusedElement);

        focusedElement.click();

        if (focusedElement.tagName === 'INPUT') {
            focusedElement.focus();
        }

        setTimeout(() => {
            if (zone === 'nav') {
                enterContentZone();
            } else {
                if (!document.body.contains(focusedElement) || !isVisible(focusedElement)) {
                    const newItems = getContentItems();
                    if (newItems.length > 0 && focusedIndex !== -1 && focusedIndex < newItems.length) {
                        setFocus(newItems[focusedIndex]);
                    } else {
                        enterContentZone();
                    }
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

    const observer = new MutationObserver((mutations) => {
        if (!isRemoteMode()) return;
        let requiresFocusReset = false;

        for (const m of mutations) {
            if (m.type === 'attributes') {
                const el = m.target;
                if (el.classList?.contains('safe-overlay') && el.classList?.contains('active')) requiresFocusReset = true;
                if (el.id === 'group-alert-modal' && el.style.display !== 'none') requiresFocusReset = true;
                if (el.id === 'group-delete-confirm' && el.style.display !== 'none') requiresFocusReset = true;
                if (el.id === 'osk-container' && el.classList?.contains('visible')) requiresFocusReset = true;
                // Added missing critical popups to observer
                if (el.id === 'critical-popover' && el.classList?.contains('active')) requiresFocusReset = true;
                if (el.id === 'wifi-warning-overlay' && el.classList?.contains('visible')) requiresFocusReset = true;
            }
        }

        if (requiresFocusReset) {
            setTimeout(enterContentZone, 150);
        }
    });

    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });

    document.addEventListener('keydown', (e) => {
        const remoteKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter', 'ContextMenu'];

        // AUTO-WAKE: If remote is used, force turn it on
        if (remoteKeys.includes(e.key) && !isRemoteMode()) {
            e.preventDefault();
            applyRemoteMode(true);
            return;
        }

        if (!isRemoteMode()) return;

        if (remoteKeys.includes(e.key)) {
            e.preventDefault();
        }

        if (e.key === 'Enter' && !e.repeat) {
            isLongPress = false;
            enterPressTimer = setTimeout(() => {
                isLongPress = true;
                handleLongPress();
            }, 600);
            return;
        }

        // SILENT ASSIGNMENT REPAIRED: Actually paint the focus ring
        if (zone === 'content' && (!focusedElement || !document.body.contains(focusedElement) || !isVisible(focusedElement))) {
            const items = getContentItems();
            if (items.length > 0) {
                setFocus(items[0]);
                // Stop the arrow key from skipping to the *second* item right away
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            }
        }

        switch (e.key) {
            case 'ArrowDown': navigate('down'); break;
            case 'ArrowUp': navigate('up'); break;
            case 'ArrowRight': navigate('right'); break;
            case 'ArrowLeft': navigate('left'); break;
            case 'PageUp': if (!isNavLocked()) switchTab(-1); break;
            case 'PageDown': if (!isNavLocked()) switchTab(1); break;
            case 'ContextMenu': handleBack(); break;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (!isRemoteMode()) return;
        if (e.key === 'Enter') {
            clearTimeout(enterPressTimer);
            if (!isLongPress) {
                activate();
            }
        }
    });

    // MOUSE JITTER FIX
    let lastX = 0, lastY = 0;
    document.addEventListener('mousemove', (e) => {
        if (!isRemoteMode()) return;
        if (Math.abs(e.screenX - lastX) > 10 || Math.abs(e.screenY - lastY) > 10) {
            clearFocus();
            lastX = e.screenX;
            lastY = e.screenY;
        }
    });
}