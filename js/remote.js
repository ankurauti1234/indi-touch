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

    focusedElement = el;

    // Never scroll the OSK or popups.
    if (
        el.closest(
            '#osk-container, #critical-popover, #group-alert-modal, #group-delete-confirm'
        )
    ) {
        return;
    }

    // Member selection list: only scroll the list container.
    const memberList = el.closest('#group-members-list');
    if (memberList) {
        el.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            behavior: 'smooth'
        });
        return;
    }

    // Everything else.
    el.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth'
    });
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

    const deleteModal = document.getElementById('group-delete-confirm');
    if (deleteModal && deleteModal.style.display !== 'none') {
        return [...deleteModal.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    const criticalPopover = document.getElementById('critical-popover');
    if (criticalPopover && criticalPopover.classList.contains('active')) {
        return [...criticalPopover.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // THE FIX: Strict class check only. No more invisible traps.
    const osk = document.getElementById('osk-container');
    if (osk && osk.classList.contains('visible')) {
        return [...osk.querySelectorAll('.osk-key, button')].filter(isVisible);
    }

    const overlay = document.querySelector('.safe-overlay.active, .popover-overlay.active, #modal-overlay[style*="display: flex"]');
    if (overlay) {
        return [...overlay.querySelectorAll('input, button:not([disabled]), .g-member-select-item')].filter(isVisible);
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

    const criticalPopover = document.getElementById('critical-popover');
    if (criticalPopover && criticalPopover.classList.contains('active')) return true;

    if (document.getElementById('group-alert-modal')?.style.display !== 'none') return true;
    if (document.getElementById('group-delete-confirm')?.style.display !== 'none') return true;

    // THE FIX: Locks UI swiping ONLY when keyboard is genuinely active
    const osk = document.getElementById('osk-container');
    if (osk && osk.classList.contains('visible')) return true;

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

// PERFECTED SPATIAL ALGORITHM (With List Escape Hatch)
function findNextItem(items, currentEl, direction) {
    if (!currentEl || items.length === 0) return null;

    const current = currentEl.getBoundingClientRect();

    const currentCenter = {
        x: current.left + current.width / 2,
        y: current.top + current.height / 2
    };

    let candidates = [];

    for (const item of items) {
        if (item === currentEl) continue;

        const rect = item.getBoundingClientRect();

        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };

        const dx = center.x - currentCenter.x;
        const dy = center.y - currentCenter.y;

        switch (direction) {
            case "left":
                if (dx >= 0) continue;
                break;

            case "right":
                if (dx <= 0) continue;
                break;

            case "up":
                if (dy >= 0) continue;
                break;

            case "down":
                if (dy <= 0) continue;
                break;
        }

        const primary =
            direction === "left" || direction === "right"
                ? Math.abs(dx)
                : Math.abs(dy);

        const secondary =
            direction === "left" || direction === "right"
                ? Math.abs(dy)
                : Math.abs(dx);

        candidates.push({
            item,
            primary,
            secondary,
            distance: Math.hypot(dx, dy)
        });
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => {

        // Strongly prefer staying in the same row/column.
        if (Math.abs(a.secondary - b.secondary) > 10)
            return a.secondary - b.secondary;

        // Then choose the closest in requested direction.
        if (Math.abs(a.primary - b.primary) > 5)
            return a.primary - b.primary;

        // Final tie breaker.
        return a.distance - b.distance;
    });

    return candidates[0].item;
}

function navigate(dir) {
    if (zone === 'nav') {
        const navItems = getNavItems();

        if (dir === 'right') {
            enterContentZone();
            return;
        }

        if (dir === 'left') {
            return;
        }

        const next = findNextItem(navItems, focusedElement, dir);

        if (next) {
            setFocus(next);
        }

        return;
    }

    // ---------------- CONTENT ----------------

    const locked = isNavLocked();
    const items = getContentItems();

    if (items.length === 0) {
        if (!locked) {
            if (dir === 'left') enterNavZone();
            else if (dir === 'up') switchTab(-1);
            else if (dir === 'down') switchTab(1);
        }
        return;
    }

    if (!focusedElement || !document.body.contains(focusedElement)) {
        setFocus(items[0]);
        return;
    }

    const next = findNextItem(items, focusedElement, dir);

    if (next) {
        setFocus(next);
        return;
    }

    // ---------------- FALLBACKS ----------------

    if (locked) {
        return;
    }

    switch (dir) {
        case 'left':
            enterNavZone();
            break;

        case 'up':
            switchTab(-1);
            break;

        case 'down':
            switchTab(1);
            break;
    }
}

// --- The Master Tiered Back Button ---
function handleBack() {
    const osk = document.getElementById('osk-container');
    if (osk && osk.classList.contains('visible')) {
        // Bulletproof Force Close for Keyboard
        const closeBtn = osk.querySelector('.close-btn, .osk-close, .hide-keyboard');
        if (closeBtn) {
            closeBtn.click();
        } else if (typeof window.closeOSK === 'function') {
            window.closeOSK();
        } else if (typeof window.hideOSK === 'function') {
            window.hideOSK();
        } else {
            osk.classList.remove('visible', 'active');
        }

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
                if (el.id === 'critical-popover' && el.classList?.contains('active')) {
                    requiresFocusReset = true;
                }
                if (el.id === 'osk-container' && el.classList?.contains('visible')) requiresFocusReset = true;
            }
        }

        if (requiresFocusReset) {
            setTimeout(enterContentZone, 150);
        }
    });

    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });

    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;

        // Expanded to include ' ' (Spacebar) and 'Select' for TV click compatibility
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter', ' ', 'Select'].includes(e.key)) {
            e.preventDefault();
        }

        if (['Enter', ' ', 'Select'].includes(e.key) && !e.repeat) {
            isLongPress = false;
            enterPressTimer = setTimeout(() => {
                isLongPress = true;
                handleLongPress();
            }, 600);
            return;
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
            case 'PageUp': if (!isNavLocked()) switchTab(-1); break;
            case 'PageDown': if (!isNavLocked()) switchTab(1); break;
            case 'ContextMenu': handleBack(); break;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (!isRemoteMode()) return;
        if (['Enter', ' ', 'Select'].includes(e.key)) {
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