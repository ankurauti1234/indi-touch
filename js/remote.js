/* js/remote.js — Zone-based TV navigation for remote control */

import { config, save } from './data.js';
import {
    moveFocus as gridMoveFocus,
    toggleFocused as gridToggleFocused,
    clearGridFocus,
    getFocusedGridIndex,
    getGridCols
} from './grid.js';
import { resetIdle } from './screensaver.js';
import { getActiveInput } from './keyboard.js';

// ─── Utilities ────────────────────────────────────────────────────────────────
export function isRemoteMode() {
    return document.body.classList.contains('remote-mode');
}

function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

// ─── State ────────────────────────────────────────────────────────────────────
let zone = 'content';
let navFocusIdx = 0;
let contentFocusIdx = 0;
let lastBackgroundIdx = 0; // NEW: Memory for when modals close
let remoteFocusEl = null;

// Long-press state variables
let enterHoldTimer = null;
let wasLongPress = false;
let isKeyLocked = false; // NEW: The hardware ghost-input padlock

// ─── Context detectors ────────────────────────────────────────────────────────
function isOnboarding() {
    const o = document.getElementById('onboarding-layer');
    return !!(o && !o.classList.contains('hidden') && o.style.display !== 'none');
}

function isScreensaverActive() {
    const s = document.getElementById('screensaver');
    return Boolean(s?.classList.contains('active'));
}

function getOverlayItems() {
    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn?.classList.contains('visible'))
        return [...wifiWarn.querySelectorAll('button')].filter(isVisible);

    const critical = document.getElementById('critical-popover');
    if (critical?.classList.contains('active'))
        return [...critical.querySelectorAll('button')].filter(isVisible);

    const alertModal = document.getElementById('alert-modal');
    if (alertModal)
        return [...alertModal.querySelectorAll('button')].filter(isVisible);

    const dupModal = document.getElementById('duplicate-modal');
    if (dupModal)
        return [...dupModal.querySelectorAll('button')].filter(isVisible);

    const deleteModal = document.getElementById('delete-confirm-modal');
    if (deleteModal)
        return [...deleteModal.querySelectorAll('button')].filter(isVisible);

    const wifi = document.getElementById('wifi-password-overlay');
    if (wifi?.classList.contains('active'))
        return [...wifi.querySelectorAll('button:not([disabled])')].filter(isVisible);

    const modal = document.getElementById('group-modal-overlay');
    if (modal?.classList.contains('active')) {
        const sel = 'input, button:not([disabled]), .group-member-item, .modal-btn, #btn-group-delete';
        return [...modal.querySelectorAll(sel)].filter(isVisible);
    }

    return null;
}

// Helper to know if we are in the main UI vs stuck in a popup
function isBackgroundContext() {
    const osk = document.getElementById('osk-container');
    if (osk?.classList.contains('visible')) return false;
    if (getOverlayItems() !== null) return false;
    if (isOnboarding()) return false;
    if (isScreensaverActive()) return false;
    return true;
}

function clearFocusEl() {
    if (remoteFocusEl) {
        remoteFocusEl.classList.remove('remoteFocused');
        remoteFocusEl = null;
    }
}

function getInteractiveRemoteTarget(target) {
    if (!target || target.nodeType !== 1) return null;

    const selector = [
        'button',
        'input',
        'textarea',
        'select',
        'a',
        '.nav-btn',
        '.list-item',
        '.chip',
        '.group-card',
        '.member-card',
        '.wifi-item',
        '.avatar-option',
        '.modal-btn',
        '.action-btn',
        '.osk-key',
        '.group-member-item',
        '.guest-avatar-circle'
    ].join(', ');

    const el = target.closest?.(selector);
    if (!el || el.disabled || !isVisible(el)) return null;
    return el;
}

function syncRemoteFocusFromPointer(target, options = {}) {
    if (!isRemoteMode()) return;

    const focusTarget = getInteractiveRemoteTarget(target);
    if (!focusTarget) return;

    if (remoteFocusEl !== focusTarget) {
        setFocusEl(focusTarget, options);
    }
}

function setFocusEl(el, options = {}) {
    if (!el) return;

    const { scroll = true } = options;

    if (remoteFocusEl === el) {
        if (!el.classList.contains('remoteFocused')) {
            el.classList.add('remoteFocused');
        }
        if (scroll) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
    }

    if (remoteFocusEl && remoteFocusEl !== el) {
        remoteFocusEl.classList.remove('remoteFocused');
    }

    if (!el.classList.contains('remoteFocused')) {
        el.classList.add('remoteFocused');
    }

    if (scroll) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    remoteFocusEl = el;
}

window.resetRemoteFocus = function () {
    setTimeout(() => {
        const items = getContentItems();
        if (items.length) {
            if (!isBackgroundContext()) {
                // Modal opened -> Focus first item in modal
                contentFocusIdx = 0;
            } else {
                // Modal closed -> Restore memory so hover stays where it was!
                contentFocusIdx = Math.max(0, Math.min(lastBackgroundIdx, items.length - 1));
            }
            setFocusEl(items[contentFocusIdx]);
        }
    }, 50);
};

function isHomeGrid() {
    return !isOnboarding() &&
        !isScreensaverActive() &&
        getOverlayItems() === null &&
        !!document.getElementById('view-home')?.classList.contains('active');
}

// ─── Nav rail ─────────────────────────────────────────────────────────────────
function getNavItems() {
    if (isOnboarding() || getOverlayItems() !== null) return [];
    return [...document.querySelectorAll('#app-frame .nav-btn')].filter(isVisible);
}

// ─── HELPER: Tab Switcher ─────────────────────────────────────────────────────
function triggerTabSwitch(dir) {
    const navs = getNavItems();
    if (!navs.length) return;

    let currentIdx = navs.findIndex(n => n.classList.contains('active'));
    if (currentIdx === -1) currentIdx = navFocusIdx;

    let nextIdx = dir === 'prev' ? currentIdx - 1 : currentIdx + 1;

    // Loop from top to bottom and bottom to top
    if (nextIdx < 0) {
        nextIdx = navs.length - 1; // Wrap to bottom (Guest)
    } else if (nextIdx >= navs.length) {
        nextIdx = 0; // Wrap to top (Home)
    }

    navFocusIdx = nextIdx;
    navs[nextIdx].click();

    // Keep focus synced on the nav rail visually if we are in the nav zone
    if (zone === 'nav') {
        setFocusEl(navs[nextIdx]);
    }
}

// ─── Content items for current view ───────────────────────────────────────────
function getContentItems() {
    const osk = document.getElementById('osk-container');
    if (osk?.classList.contains('visible'))
        return [...osk.querySelectorAll('.osk-key')].filter(isVisible);

    const overlay = getOverlayItems();
    if (overlay !== null) return overlay;

    if (isOnboarding()) {
        const step = document.querySelector('#onboarding-layer .step.active');
        return step
            ? [...step.querySelectorAll('button:not([disabled]), .net-item')].filter(isVisible)
            : [];
    }

    if (isScreensaverActive()) return [];

    const activeView = document.querySelector('#app-frame .view.active');
    if (!activeView) return [];

    if (activeView.id === 'view-home') {
        return [...activeView.querySelectorAll('.member-card')].filter(isVisible);
    }

    if (activeView.id === 'view-groups') {
        return [...activeView.querySelectorAll('.group-card')].filter(isVisible);
    }

    if (activeView.id === 'view-settings') {
        const panel = activeView.querySelector('.settings-panel.active') || activeView;
        const sel = '.back-btn, .list-item:not(.no-click), .avatar-option, .wifi-item, .chip, button:not([disabled]), input[type="text"], input[type="password"], input[type="number"], textarea';
        return [...panel.querySelectorAll(sel)].filter(isVisible);
    }

    const sel = '.back-btn, .list-item:not(.no-click), .chip, .action-btn, button:not([disabled]), input[type="text"], input[type="password"], input[type="number"], textarea';
    return [...activeView.querySelectorAll(sel)].filter(isVisible);
}

// ─── Zone: NAV ───────────────────────────────────────────────────────────────
function enterNavZone() {
    const navItems = getNavItems();
    if (!navItems.length) return;

    clearGridFocus();

    if (remoteFocusEl) {
        const curY = remoteFocusEl.getBoundingClientRect().top;
        let bestIdx = 0, bestDist = Infinity;
        navItems.forEach((n, i) => {
            const d = Math.abs(n.getBoundingClientRect().top - curY);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        navFocusIdx = bestIdx;
    }

    zone = 'nav';
    setFocusEl(navItems[navFocusIdx]);
}

// ─── Zone: CONTENT ────────────────────────────────────────────────────────────
function enterContentZone() {
    zone = 'content';
    clearFocusEl();

    if (isHomeGrid()) {
        const cards = getContentItems();
        if (contentFocusIdx >= cards.length) contentFocusIdx = 0;
        return;
    }

    const items = getContentItems();
    if (contentFocusIdx >= items.length) contentFocusIdx = 0;
    if (items[contentFocusIdx]) setFocusEl(items[contentFocusIdx]);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(direction) {
    if (isScreensaverActive()) {
        resetIdle();
        setTimeout(() => enterContentZone(), 100);
        return;
    }

    if (zone === 'nav') {
        const navItems = getNavItems();
        if (!navItems.length) { enterContentZone(); return; }

        if (direction === 'up') {
            navFocusIdx = Math.max(0, navFocusIdx - 1);
            setFocusEl(navItems[navFocusIdx]);
        } else if (direction === 'down') {
            navFocusIdx = Math.min(navItems.length - 1, navFocusIdx + 1);
            setFocusEl(navItems[navFocusIdx]);
        } else if (direction === 'right') {
            enterContentZone();
        }
        return;
    }

    if (isHomeGrid()) {
        const cols = getGridCols();
        const idx = getFocusedGridIndex();
        const homeItems = getContentItems();

        if (direction === 'left' && idx % cols === 0) {
            enterNavZone();
            return;
        }
        if (direction === 'up') {
            if (homeItems.length === 0 || idx < cols) {
                triggerTabSwitch('prev');
                return;
            }
        }
        if (direction === 'down') {
            if (homeItems.length === 0 || idx + cols >= homeItems.length) {
                triggerTabSwitch('next');
                return;
            }
        }

        gridMoveFocus(direction);
        return;
    }

    const activeView = document.querySelector('#app-frame .view.active');
    const isGroupsView = activeView && activeView.id === 'view-groups';

    const osk = document.getElementById('osk-container');
    const isOskVisible = osk?.classList.contains('visible');
    const isOverlayActive = getOverlayItems() !== null;

    if (direction === 'left' && !isOskVisible && !isGroupsView && !isOverlayActive) {
        enterNavZone();
        return;
    }

    const items = getContentItems();

    if (!items.length) {
        if (direction === 'up') triggerTabSwitch('prev');
        else if (direction === 'down') triggerTabSwitch('next');
        else if (direction === 'left') enterNavZone();
        return;
    }

    if (isOskVisible || isGroupsView || isOverlayActive) {
        const curEl = items[contentFocusIdx];
        if (!curEl) { contentFocusIdx = 0; setFocusEl(items[0]); return; }

        const curBox = curEl.getBoundingClientRect();
        let bestIdx = -1;
        let bestDist = Infinity;

        items.forEach((item, i) => {
            if (i === contentFocusIdx) return;
            const box = item.getBoundingClientRect();

            let isCorrectDir = false;
            let dist = 0;

            const curCX = curBox.left + curBox.width / 2;
            const curCY = curBox.top + curBox.height / 2;
            const targetCX = box.left + box.width / 2;
            const targetCY = box.top + box.height / 2;

            if (direction === 'up' && targetCY < curCY - curBox.height / 2) {
                isCorrectDir = true;
                dist = Math.pow(targetCY - curCY, 2) * 2 + Math.pow(targetCX - curCX, 2);
            } else if (direction === 'down' && targetCY > curCY + curBox.height / 2) {
                isCorrectDir = true;
                dist = Math.pow(targetCY - curCY, 2) * 2 + Math.pow(targetCX - curCX, 2);
            } else if (direction === 'left' && targetCX < curBox.left) {
                isCorrectDir = true;
                dist = Math.pow(targetCX - curCX, 2) + Math.pow(targetCY - curCY, 2) * 50;
            } else if (direction === 'right' && targetCX > curBox.right) {
                isCorrectDir = true;
                dist = Math.pow(targetCX - curCX, 2) + Math.pow(targetCY - curCY, 2) * 50;
            }

            if (isCorrectDir && dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        });

        if (bestIdx !== -1) {
            contentFocusIdx = bestIdx;
            setFocusEl(items[contentFocusIdx]);
        } else {
            if (isOskVisible && direction === 'down') {
                const currentInput = getActiveInput();

                osk.classList.remove('visible');
                document.body.classList.remove('osk-open');

                if (currentInput) {
                    currentInput.blur();
                }

                setTimeout(() => {
                    const newItems = getContentItems();
                    let targetIdx = 0;
                    if (currentInput) {
                        const foundIdx = newItems.indexOf(currentInput);
                        if (foundIdx !== -1) targetIdx = foundIdx;
                    }
                    if (newItems.length > 0) {
                        contentFocusIdx = targetIdx;
                        setFocusEl(newItems[contentFocusIdx]);
                    }
                }, 100);

                return;
            }

            if (direction === 'left' && isGroupsView && !isOverlayActive) {
                enterNavZone();
            } else if (direction === 'up' && !isOskVisible && !isOverlayActive) {
                triggerTabSwitch('prev');
            } else if (direction === 'down' && !isOskVisible && !isOverlayActive) {
                triggerTabSwitch('next');
            }
        }
        return;
    }

    // ---- BOTTOM OF navigate() ----

    // We REMOVED the duplicate "const items = getContentItems();" 
    // and "const activeView = ..." because they were already declared higher up in the function!

    // Strict Lock: Only lock tabs if we are actually in the Settings view AND see a back button
    const isSettings = activeView && activeView.id === 'view-settings';
    const isDeepMenu = isSettings && items.some(el => el.classList.contains('back-btn'));

    if (direction === 'up') {
        if (contentFocusIdx === 0) {
            if (!isDeepMenu) triggerTabSwitch('prev');
            return;
        }
        contentFocusIdx = contentFocusIdx - 1;
    } else if (direction === 'down' || direction === 'right') {
        if (direction === 'down' && contentFocusIdx === items.length - 1) {
            if (!isDeepMenu) triggerTabSwitch('next');
            return;
        }
        if (contentFocusIdx < items.length - 1) {
            contentFocusIdx = contentFocusIdx + 1;
        }
    }

    const targetEl = items[contentFocusIdx];
    if (remoteFocusEl !== targetEl) {
        setFocusEl(targetEl);
    }
}

// ─── Activation (Short Press) ─────────────────────────────────────────────────
function activate() {
    if (isScreensaverActive()) return;

    if (isHomeGrid() && zone === 'content') {
        gridToggleFocused();
        return;
    }

    if (remoteFocusEl) {
        const el = remoteFocusEl;
        el.click();

        setTimeout(() => {
            if (zone === 'content') {
                const items = getContentItems();
                if (items.length) {
                    if (contentFocusIdx >= items.length) {
                        contentFocusIdx = Math.max(0, items.length - 1);
                    }
                    // Re-apply focus safely if it got lost in the click event
                    if (!remoteFocusEl || !document.body.contains(remoteFocusEl)) {
                        setFocusEl(items[contentFocusIdx]);
                    }
                }
            } else {
                const navItems = getNavItems();
                if (navFocusIdx >= navItems.length) navFocusIdx = 0;
                if (navItems[navFocusIdx]) setFocusEl(navItems[navFocusIdx]);
            }
        }, 150);
    }
}

// ─── NEW: Long Press Engine ───────────────────────────────────────────────────
function handleLongPress() {
    if (!remoteFocusEl) return;

    if (remoteFocusEl.classList.contains('group-card')) {
        let editBtn = null;

        const elements = remoteFocusEl.querySelectorAll('*');
        for (let el of elements) {
            const onClick = el.getAttribute('onclick') || '';
            if (onClick.includes('openEditGroupModal') || onClick.includes('Edit')) {
                editBtn = el;
                break;
            }
        }

        if (!editBtn) {
            editBtn = remoteFocusEl.querySelector('.edit-btn, .group-edit, [class*="edit"], [id*="edit"]');
        }

        if (editBtn) {
            editBtn.click();
        }
    }
}

// ─── Public: reset focus when view changes ────────────────────────────────────
export function resetFocusToFirst() {
    zone = 'content';
    contentFocusIdx = 0;
    lastBackgroundIdx = 0; // Wipe memory when completely changing tabs
    clearFocusEl();
    clearGridFocus();

    if (isHomeGrid()) {
        gridMoveFocus('up');
        return;
    }

    const items = getContentItems();
    if (items.length) setFocusEl(items[0]);
}

// ─── Public: apply/remove remote mode ────────────────────────────────────────
export function applyRemoteMode(on) {
    if (on) {
        document.body.classList.add('remote-mode');
        setTimeout(() => {
            zone = 'content';
            contentFocusIdx = 0;
            enterContentZone();
        }, 80);
    } else {
        document.body.classList.remove('remote-mode');
        clearFocusEl();
        clearGridFocus();
        zone = 'content';
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initRemote() {
    if (config.remoteMode) applyRemoteMode(true);

    // --- UPDATED: Surgical DOM Observer ---
    const domObserver = new MutationObserver(() => {
        if (!isRemoteMode() || zone !== 'content' || !remoteFocusEl) return;

        if (!document.body.contains(remoteFocusEl)) {
            const items = getContentItems();
            if (items.length > 0) {
                contentFocusIdx = Math.max(0, Math.min(contentFocusIdx, items.length - 1));
                const newEl = items[contentFocusIdx];
                if (newEl) {
                    setFocusEl(newEl, { scroll: false });
                }
            }
        }
    });

    // Targeted observation
    const container = document.getElementById('app-frame');
    if (container) {
        domObserver.observe(container, { childList: true, subtree: true });
    }
    // -----------------------------------------------

    document.addEventListener('pointerdown', (e) => {
        if (!isRemoteMode()) return;
        syncRemoteFocusFromPointer(e.target, { scroll: false });
    }, true);

    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;

        // STOP REPEATS: This is the single biggest cause of navigation throbbing
        if (e.repeat) return;

        if (!remoteFocusEl && !isHomeGrid()) {
            enterContentZone();
        } else if (isHomeGrid() && !document.querySelector('#grid-container .member-card.focused')) {
            import('./grid.js').then(m => m.applyFocus());
        }

        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); navigate('down'); break;
            case 'ArrowUp': e.preventDefault(); navigate('up'); break;
            case 'ArrowRight': e.preventDefault(); navigate('right'); break;
            case 'ArrowLeft': e.preventDefault(); navigate('left'); break;
            case 'Enter':
                e.preventDefault();
                // [Keep your existing Enter/Long-Press logic here]
                wasLongPress = false;
                enterHoldTimer = setTimeout(() => {
                    wasLongPress = true;
                    handleLongPress();
                }, 600);
                break;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (!isRemoteMode()) return;

        if (e.key === 'Enter') {
            e.preventDefault();

            // Instantly unlock the hardware padlock for the next physical press
            isKeyLocked = false;

            clearTimeout(enterHoldTimer);

            if (!wasLongPress) {
                activate();
            }
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isRemoteMode()) setTimeout(() => {
                zone = 'content';
                contentFocusIdx = 0;
                enterContentZone();
            }, 200);
        });
    });

    // document.addEventListener('click', () => {
    //     if (!isRemoteMode()) return;
    //     setTimeout(() => {
    //         if (zone === 'content' && !isHomeGrid()) {
    //             const items = getContentItems();
    //             if (remoteFocusEl && !document.body.contains(remoteFocusEl)) {
    //                 if (contentFocusIdx >= items.length) {
    //                     contentFocusIdx = Math.max(0, items.length - 1);
    //                 }
    //                 if (items.length) setFocusEl(items[contentFocusIdx]);
    //             }
    //         }
    //     }, 200);
    // });

    // --- FIXED: Phantom Mousemove Fix ---
    //     let lastMouseX = -1;
    //     let lastMouseY = -1;

    //     document.addEventListener('mousemove', (e) => {
    //         if (!isRemoteMode()) return;

    //         if (Math.abs(e.clientX - lastMouseX) < 20 && Math.abs(e.clientY - lastMouseY) < 20) {
    //             return;
    //         }

    //         lastMouseX = e.clientX;
    //         lastMouseY = e.clientY;

    //         // Comment these out temporarily!
    //         // clearFocusEl();
    //         // clearGridFocus();
    //     });
}