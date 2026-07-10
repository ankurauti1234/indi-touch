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

    const isInsidePopup = el.closest('.safe-overlay, .popover-overlay, #critical-popover, #modal-overlay, #osk-container, #group-alert-modal, #group-delete-confirm');

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
    const criticalPopover = document.getElementById('critical-popover');
    if (criticalPopover && (criticalPopover.classList.contains('active') || criticalPopover.style.display === 'flex')) {
        return [...criticalPopover.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn && (wifiWarn.classList.contains('visible') || wifiWarn.classList.contains('active') || wifiWarn.style.display !== 'none')) {
        return [...wifiWarn.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const groupAlert = document.getElementById('group-alert-modal');
    if (groupAlert && groupAlert.style.display !== 'none') {
        return [...groupAlert.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && deleteModal.style.display !== 'none') {
        return [...deleteModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const osk = document.getElementById('osk-container');
    if (osk && (osk.classList.contains('visible') || osk.classList.contains('active') || osk.style.display !== 'none')) {
        return [...osk.querySelectorAll('.osk-key, button')].filter(isVisible);
    }

    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay) {
        return [...overlay.querySelectorAll('input[type="text"], input:not([type="hidden"]), button:not([disabled]), .g-member-select-item')].filter(isVisible);
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
    if (document.getElementById('group-alert-modal')?.style.display !== 'none') return true;
    if (document.getElementById('group-delete-confirm')?.style.display !== 'none') return true;
    if (document.getElementById('critical-popover')?.classList.contains('active')) return true;
    if (document.getElementById('wifi-warning-overlay')?.classList.contains('visible')) return true;

    const osk = document.getElementById('osk-container');
    if (osk && (osk.classList.contains('visible') || osk.style.display !== 'none')) return true;

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
    if (osk && (osk.classList.contains('visible') || osk.style.display !== 'none')) {
        if (window.hideOSK) window.hideOSK();
        setTimeout(enterContentZone, 150);
        return;
    }

    const criticalPopover = document.getElementById('critical-popover');
    if (criticalPopover && criticalPopover.classList.contains('active')) {
        if (window.handleCriticalAction) window.handleCriticalAction();
        else criticalPopover.classList.remove('active');
        setTimeout(enterContentZone, 150);
        return;
    }

    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn && wifiWarn.classList.contains('visible')) {
        wifiWarn.classList.remove('visible');
        setTimeout(enterContentZone, 150);
        return;
    }

    const groupAlert = document.getElementById('group-alert-modal');
    if (groupAlert && groupAlert.style.display !== 'none') {
        if (window.closeAlertModal) window.closeAlertModal();
        else groupAlert.style.display = 'none';
        setTimeout(enterContentZone, 150);
        return;
    }

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && deleteModal.style.display !== 'none') {
        const cancel = deleteModal.querySelector('.modal-btn:not(.primary)');
        if (cancel) cancel.click();
        else deleteModal.style.display = 'none';
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
        if (!isNavLocked() && zone !== 'nav') {
            elementBeforeOverlay = focusedElement;
        }

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
        let closedPopup = false;

        for (const m of mutations) {
            if (m.type === 'attributes') {
                const el = m.target;
                if (el.classList?.contains('safe-overlay') && el.classList?.contains('active')) requiresFocusReset = true;
                if (el.id === 'group-alert-modal' && el.style.display !== 'none') requiresFocusReset = true;
                if (el.id === 'group-delete-confirm' && el.style.display !== 'none') requiresFocusReset = true;
                if (el.id === 'critical-popover' && el.classList?.contains('active')) requiresFocusReset = true;
                if (el.id === 'wifi-warning-overlay' && el.classList?.contains('visible')) requiresFocusReset = true;
                if (el.id === 'osk-container' && el.classList?.contains('visible')) requiresFocusReset = true;

                if (el.id === 'critical-popover' && !el.classList?.contains('active') && focusedElement?.closest('#critical-popover')) closedPopup = true;
                if (el.id === 'wifi-warning-overlay' && !el.classList?.contains('visible') && focusedElement?.closest('#wifi-warning-overlay')) closedPopup = true;
            }
        }

        if (requiresFocusReset || closedPopup) {
            setTimeout(enterContentZone, 150);
        }
    });

    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });

    document.addEventListener('keydown', (e) => {
        const remoteKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter', 'ContextMenu'];

        // --- AUTO WAKE FIX ---
        // If the user presses ANY remote button and remote mode is off, instantly turn it on!
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

        if (zone === 'content' && (!focusedElement || !document.body.contains(focusedElement))) {
            const items = getContentItems();
            if (items.length > 0) {
                setFocus(items[0]);
                // If this is just a recovery wake-up, stop here so we don't accidentally navigate twice
                if (remoteKeys.includes(e.key)) return;
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

    document.addEventListener('mousemove', () => {
        if (isRemoteMode()) clearFocus();
    });
}