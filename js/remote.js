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

// ─── State ────────────────────────────────────────────────────────────────────
// Two zones: 'nav' (left rail) and 'content' (active view)
let zone = 'content';
let navFocusIdx = 0;
let contentFocusIdx = 0;
let remoteFocusEl = null; // element holding .remoteFocused (null when home grid is content zone)

// ─── Utilities ────────────────────────────────────────────────────────────────
export function isRemoteMode() {
    return document.body.classList.contains('remote-mode');
}

function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

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
    return !!document.getElementById('screensaver')?.classList.contains('active');
}

function getOverlayItems() {
    // Connection warning popups take highest priority
    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn?.classList.contains('visible'))
        return [...wifiWarn.querySelectorAll('button')].filter(isVisible);

    // USB popup has no buttons — skip (user can't dismiss it by remote)

    const critical = document.getElementById('critical-popover');
    if (critical?.classList.contains('active'))
        return [...critical.querySelectorAll('button')].filter(isVisible);

    const modal = document.getElementById('modal-overlay');
    if (modal?.classList.contains('active'))
        return [...modal.querySelectorAll('.modal-btn')].filter(isVisible);

    const wifi = document.getElementById('wifi-password-overlay');
    if (wifi?.classList.contains('active'))
        return [...wifi.querySelectorAll('button:not([disabled])')].filter(isVisible);

    return null; // null = no overlay open
}

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

// ─── Content items for current view (never includes nav rail) ─────────────────
function getContentItems() {
    // 1. Overlays take priority
    const overlay = getOverlayItems();
    if (overlay !== null) return overlay;

    // 2. OSK open anywhere (wifi password, onboarding, etc.)
    const osk = document.getElementById('osk-container');
    if (osk?.classList.contains('visible'))
        return [...osk.querySelectorAll('.osk-key')].filter(isVisible);

    // 3. Onboarding
    if (isOnboarding()) {
        const step = document.querySelector('#onboarding-layer .step.active');
        return step
            ? [...step.querySelectorAll('button:not([disabled]), .net-item')].filter(isVisible)
            : [];
    }

    // 4. Screensaver — nothing focusable
    if (isScreensaverActive()) return [];

    // 5. Main app
    const activeView = document.querySelector('#app-frame .view.active');
    if (!activeView) return [];

    if (activeView.id === 'view-home') {
        return [...activeView.querySelectorAll('.member-card')].filter(isVisible);
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

    // Clear grid focus if leaving home grid
    clearGridFocus();

    // Pick nav item closest vertically to current position
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
    clearFocusEl(); // grid.js manages its own .focused class

    if (isHomeGrid()) {
        // Grid.js already shows the focused card with .focused class
        // Just make sure contentFocusIdx is within bounds
        const cards = getContentItems();
        if (contentFocusIdx >= cards.length) contentFocusIdx = 0;
        // No remoteFocusEl needed — grid.js handles visuals
        return;
    }

    const items = getContentItems();
    if (contentFocusIdx >= items.length) contentFocusIdx = 0;
    if (items[contentFocusIdx]) setFocusEl(items[contentFocusIdx]);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(direction) {
    // Wake screensaver on any navigation key
    if (isScreensaverActive()) {
        resetIdle();
        // Restore previous focus context
        setTimeout(() => enterContentZone(), 100);
        return;
    }

    // ── NAV ZONE ──────────────────────────────────────────────────────────────
    if (zone === 'nav') {
        const navItems = getNavItems();
        if (!navItems.length) { enterContentZone(); return; }

        if (direction === 'up') {
            navFocusIdx = (navFocusIdx - 1 + navItems.length) % navItems.length;
            setFocusEl(navItems[navFocusIdx]);
        } else if (direction === 'down') {
            navFocusIdx = (navFocusIdx + 1) % navItems.length;
            setFocusEl(navItems[navFocusIdx]);
        } else if (direction === 'right') {
            enterContentZone();
        }
        // Left from nav = edge, do nothing
        return;
    }

    // ── CONTENT ZONE – HOME GRID (2D) ─────────────────────────────────────────
    if (isHomeGrid()) {
        if (direction === 'left') {
            // At leftmost column → jump to nav zone
            const cols = getGridCols();
            const idx = getFocusedGridIndex();
            if (idx % cols === 0) {
                enterNavZone();
                return;
            }
        }
        if (direction === 'up') {
            // At top row → jump to nav zone
            const cols = getGridCols();
            const idx = getFocusedGridIndex();
            if (idx < cols) {
                enterNavZone();
                return;
            }
        }
        // Delegate 2D movement to grid.js
        gridMoveFocus(direction);
        return;
    }

    // ── CONTENT ZONE – LINEAR LIST ────────────────────────────────────────────
    // Left always escapes to nav zone, UNLESS OSK is open
    if (direction === 'left' && !document.getElementById('osk-container')?.classList.contains('visible')) {
        enterNavZone();
        return;
    }

    const items = getContentItems();
    if (!items.length) return;

    // -- 2D OSK Navigation --
    if (document.getElementById('osk-container')?.classList.contains('visible')) {
        const curEl = items[contentFocusIdx];
        if (!curEl) { contentFocusIdx = 0; setFocusEl(items[0]); return; }
        
        const curBox = curEl.getBoundingClientRect();
        let bestIdx = -1;
        let bestDist = Infinity;

        items.forEach((item, i) => {
            if (i === contentFocusIdx) return;
            const box = item.getBoundingClientRect();
            
            // Filter by direction
            let isCorrectDir = false;
            let dist = 0;

            const curCX = curBox.left + curBox.width / 2;
            const curCY = curBox.top + curBox.height / 2;
            const targetCX = box.left + box.width / 2;
            const targetCY = box.top + box.height / 2;

            if (direction === 'up' && targetCY < curCY - curBox.height/2) {
                isCorrectDir = true;
                dist = Math.pow(targetCY - curCY, 2) * 2 + Math.pow(targetCX - curCX, 2);
            } else if (direction === 'down' && targetCY > curCY + curBox.height/2) {
                isCorrectDir = true;
                dist = Math.pow(targetCY - curCY, 2) * 2 + Math.pow(targetCX - curCX, 2);
            } else if (direction === 'left' && targetCX < curBox.left) {
                isCorrectDir = true;
                dist = Math.pow(targetCX - curCX, 2) + Math.pow(targetCY - curCY, 2) * 4;
            } else if (direction === 'right' && targetCX > curBox.right) {
                isCorrectDir = true;
                dist = Math.pow(targetCX - curCX, 2) + Math.pow(targetCY - curCY, 2) * 4;
            }

            if (isCorrectDir && dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        });

        if (bestIdx !== -1) {
            contentFocusIdx = bestIdx;
            setFocusEl(items[contentFocusIdx]);
        }
        return;
    }

    // -- Default Linear List Navigation --
    // Up → previous; Down / Right → next
    if (direction === 'up') {
        contentFocusIdx = (contentFocusIdx - 1 + items.length) % items.length;
    } else {
        contentFocusIdx = (contentFocusIdx + 1) % items.length;
    }

    setFocusEl(items[contentFocusIdx]);
}

// ─── Activation ───────────────────────────────────────────────────────────────
function activate() {
    if (isScreensaverActive()) return; // click event already calls resetIdle

    // Home grid content zone → toggle focused member
    if (isHomeGrid() && zone === 'content') {
        gridToggleFocused();
        return;
    }

    // Everything else → click the focused element
    if (remoteFocusEl) {
        const el = remoteFocusEl;
        el.click();
        // After click, context may have changed (new panel, modal, etc.) — refresh
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

// ─── Public: reset focus when view changes ────────────────────────────────────
export function resetFocusToFirst() {
    zone = 'content';
    contentFocusIdx = 0;
    clearFocusEl();
    clearGridFocus();

    if (isHomeGrid()) {
        // Grid.js will show .focused on first card after next renderGrid
        // Force it now:
        gridMoveFocus('up'); // will clamp to valid index if already at 0
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
    // Restore saved state
    if (config.remoteMode) applyRemoteMode(true);

    // ── Arrow keys ──────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;
        
        // Restore highlights if they were hidden by mouse movement
        if (!remoteFocusEl && !isHomeGrid()) {
            enterContentZone();
        } else if (isHomeGrid() && !document.querySelector('#grid-container .member-card.focused')) {
            import('./grid.js').then(m => m.applyFocus());
        }

        switch (e.key) {
            case 'ArrowDown':  e.preventDefault(); navigate('down');  break;
            case 'ArrowUp':    e.preventDefault(); navigate('up');    break;
            case 'ArrowRight': e.preventDefault(); navigate('right'); break;
            case 'ArrowLeft':  e.preventDefault(); navigate('left');  break;
            case 'Enter':      e.preventDefault(); activate();        break;
        }
    });

    // Touch & click are NEVER intercepted — they always propagate naturally.
    // Remote activation is keyboard-only (Enter key).
    // This ensures touchscreen always works even in Remote Mode.

    // ── Reset focus after view navigation ────────────────────────────────────
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isRemoteMode()) setTimeout(() => {
                zone = 'content';
                contentFocusIdx = 0;
                enterContentZone();
            }, 200);
        });
    });

    // ── Reset focus after settings panel open/close ─────────────────────────
    document.addEventListener('click', () => {
        if (!isRemoteMode()) return;
        // Debounce: check if active panel changed
        setTimeout(() => {
            if (zone === 'content' && !isHomeGrid()) {
                const items = getContentItems();
                // If remoteFocusEl is no longer in DOM, reset
                if (remoteFocusEl && !document.body.contains(remoteFocusEl)) {
                    contentFocusIdx = 0;
                    if (items.length) setFocusEl(items[0]);
                }
            }
        }, 200);
    });

    // ── Air Mouse / Mouse Movement ───────────────────────────────────────────
    document.addEventListener('mousemove', () => {
        if (!isRemoteMode()) return;
        // Hide focus highlights when mouse is being used (Air Mouse mode)
        // This avoids having both a mouse pointer AND a focus highlight visible
        clearFocusEl();
        clearGridFocus();
    });
}
