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
let remoteFocusEl = null;

// Long-press state variables
let enterPressTimer = null;
let isLongPress = false;

function clearFocusEl() {
    if (remoteFocusEl) {
        remoteFocusEl.classList.remove('remoteFocused');
        remoteFocusEl = null;
    }
}

function setFocusEl(el) {
    clearFocusEl();
    if (!el) return;
    el.classList.add('remoteFocused');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    remoteFocusEl = el;
}

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
window.resetRemoteFocus = function () {
    setTimeout(() => {
        const items = getContentItems();
        if (items.length) {
            contentFocusIdx = 0;
            setFocusEl(items[0]);
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

    const nextIdx = dir === 'prev' ? currentIdx - 1 : currentIdx + 1;

    if (nextIdx < 0 || nextIdx >= navs.length) {
        return;
    }

    navFocusIdx = nextIdx;
    navs[nextIdx].click();
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

            // --- FIXED SPATIAL MATH ---
            // Y-axis multipliers adjusted heavily on Left/Right to lock into horizontal rows.
            // This guarantees Cancel snaps to Delete instead of jumping up to a checkbox.
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

    if (direction === 'up') {
        if (contentFocusIdx === 0) {
            triggerTabSwitch('prev');
            return;
        }
        contentFocusIdx = contentFocusIdx - 1;
    } else if (direction === 'down' || direction === 'right') {
        if (direction === 'down' && contentFocusIdx === items.length - 1) {
            triggerTabSwitch('next');
            return;
        }
        if (contentFocusIdx < items.length - 1) {
            contentFocusIdx = contentFocusIdx + 1;
        }
    }

    setFocusEl(items[contentFocusIdx]);
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
                    if (contentFocusIdx >= items.length) contentFocusIdx = 0;
                    setFocusEl(items[contentFocusIdx]);
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

    // Check if we are long-pressing a Group Card
    if (remoteFocusEl.classList.contains('group-card')) {
        // Find the hidden/visible edit button inside the card and click it
        const editBtn = remoteFocusEl.querySelector('[onclick*="openEditGroupModal"]');
        if (editBtn) {
            editBtn.click();
        }
    }
}

// ─── Public: reset focus when view changes ────────────────────────────────────
export function resetFocusToFirst() {
    zone = 'content';
    contentFocusIdx = 0;
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

    // KEY DOWN: Triggers navigation, and starts Long Press Timer for 'Enter'
    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;

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
                if (e.repeat) return; // Prevent repeating if held down

                isLongPress = false;
                enterPressTimer = setTimeout(() => {
                    isLongPress = true;
                    handleLongPress();
                }, 600); // 600ms hold triggers Edit
                break;
        }
    });

    // KEY UP: Cancels Long Press, triggers Short Press if threshold wasn't met
    document.addEventListener('keyup', (e) => {
        if (!isRemoteMode()) return;

        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(enterPressTimer);
            if (!isLongPress) {
                activate(); // Standard click behavior
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

    document.addEventListener('click', () => {
        if (!isRemoteMode()) return;
        setTimeout(() => {
            if (zone === 'content' && !isHomeGrid()) {
                const items = getContentItems();
                if (remoteFocusEl && !document.body.contains(remoteFocusEl)) {
                    contentFocusIdx = 0;
                    if (items.length) setFocusEl(items[0]);
                }
            }
        }, 200);
    });

    document.addEventListener('mousemove', () => {
        if (!isRemoteMode()) return;
        clearFocusEl();
        clearGridFocus();
    });
}