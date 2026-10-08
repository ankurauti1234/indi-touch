/* js/remote.js — Zone-based TV navigation for remote control */

import { config } from './data.js';
import {
    moveFocus as gridMoveFocus,
    toggleFocused as gridToggleFocused,
    clearGridFocus,
    getFocusedGridIndex,
    getGridCols
} from './grid.js';
import { resetIdle, dismissScreensaver } from './screensaver.js';

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
    // 1. Still Watching popup takes precedence
    const stillWatch = document.getElementById('still-watching-popover');
    if (stillWatch?.classList.contains('visible')) {
        return [...stillWatch.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 2. Active member reminder (critical popover)
    const critical = document.getElementById('critical-popover');
    if (critical?.classList.contains('active')) {
        return [...critical.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 3. Wi-Fi connection warnings
    const wifiWarn = document.getElementById('wifi-warning-overlay');
    if (wifiWarn?.classList.contains('visible')) {
        return [...wifiWarn.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

    // 4. General modals
    const modal = document.getElementById('modal-overlay');
    if (modal?.classList.contains('active')) {
        return [...modal.querySelectorAll('.modal-btn, button:not([disabled])')].filter(isVisible);
    }

    // 5. Wi-Fi password popup
    const wifi = document.getElementById('wifi-password-overlay');
    if (wifi?.classList.contains('active')) {
        return [...wifi.querySelectorAll('button:not([disabled])')].filter(isVisible);
    }

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
    // 1. Overlays take highest priority
    const overlay = getOverlayItems();
    if (overlay !== null) return overlay;

    // 2. OSK open anywhere (wifi password, onboarding, etc.)
    const osk = document.getElementById('osk-container');
    if (osk?.classList.contains('visible')) {
        return [...osk.querySelectorAll('.osk-key')].filter(isVisible);
    }

    // 3. Onboarding
    if (isOnboarding()) {
        const step = document.querySelector('#onboarding-layer .step.active');
        return step
            ? [...step.querySelectorAll('button:not([disabled]), .net-item')].filter(isVisible)
            : [];
    }

    // 4. Screensaver — nothing focusable when no overlay is open
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

    const sel = '.back-btn, .list-item:not(.no-click), .chip, .action-btn, .guest-delete-overlay, button:not([disabled]), input[type="text"], input[type="password"], input[type="number"], textarea';
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
        const cards = getContentItems();
        if (contentFocusIdx >= cards.length) contentFocusIdx = 0;
        return;
    }

    const items = getContentItems();
    if (contentFocusIdx >= items.length) contentFocusIdx = 0;
    if (items[contentFocusIdx]) setFocusEl(items[contentFocusIdx]);
}

// ─── Universal Focus Helper ───────────────────────────────────────────────────
export function focusActiveOverlay() {
    if (!isRemoteMode()) return;
    const overlayItems = getOverlayItems();
    if (overlayItems && overlayItems.length > 0) {
        zone = 'content';
        contentFocusIdx = 0;
        clearGridFocus();
        setFocusEl(overlayItems[0]);
    }
}
window.focusActiveOverlay = focusActiveOverlay;

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(direction) {
    const overlay = getOverlayItems();

    // If screensaver is active AND no overlay is on top, wake & dismiss screensaver
    if (isScreensaverActive() && overlay === null) {
        dismissScreensaver();
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
        return;
    }

    // ── CONTENT ZONE – HOME GRID (2D) ─────────────────────────────────────────
    if (isHomeGrid()) {
        if (direction === 'left') {
            const cols = getGridCols();
            const idx = getFocusedGridIndex();
            if (idx % cols === 0) {
                enterNavZone();
                return;
            }
        }
        if (direction === 'up') {
            const cols = getGridCols();
            const idx = getFocusedGridIndex();
            if (idx < cols) {
                enterNavZone();
                return;
            }
        }
        gridMoveFocus(direction);
        return;
    }

    // ── CONTENT ZONE – LINEAR LIST / OVERLAYS ─────────────────────────────────
    // Left escapes to nav rail ONLY when no overlay and no OSK are open
    if (direction === 'left' && overlay === null && !document.getElementById('osk-container')?.classList.contains('visible')) {
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

    // -- Default Linear / Overlay Navigation --
    // Up / Left → previous; Down / Right → next
    if (direction === 'up' || direction === 'left') {
        contentFocusIdx = (contentFocusIdx - 1 + items.length) % items.length;
    } else {
        contentFocusIdx = (contentFocusIdx + 1) % items.length;
    }

    setFocusEl(items[contentFocusIdx]);
}

// ─── Activation ───────────────────────────────────────────────────────────────
function activate() {
    const overlay = getOverlayItems();

    // Wake screensaver on Enter key ONLY if no overlay is on top
    if (isScreensaverActive() && overlay === null) {
        dismissScreensaver();
        setTimeout(() => enterContentZone(), 100);
        return;
    }

    // Home grid content zone → toggle focused member
    if (isHomeGrid() && zone === 'content') {
        gridToggleFocused();
        return;
    }

    // Fallback: If an overlay is visible but remoteFocusEl wasn't set yet, focus its first button
    if (!remoteFocusEl && overlay && overlay.length > 0) {
        contentFocusIdx = 0;
        setFocusEl(overlay[0]);
    }

    if (remoteFocusEl) {
        const el = remoteFocusEl;

        // If the focused element is a text input, focus it and hand off remote cursor to OSK
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.focus();
            const len = el.value.length;
            try {
                el.setSelectionRange(len, len);
            } catch (_) { }

            setTimeout(() => {
                const osk = document.getElementById('osk-container');
                if (osk && osk.classList.contains('visible')) {
                    const firstKey = osk.querySelector('.osk-key');
                    if (firstKey) {
                        contentFocusIdx = 0;
                        setFocusEl(firstKey);
                    }
                }
            }, 100);
            return;
        }

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
window.resetFocusToFirst = resetFocusToFirst;

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

    // ── Arrow keys & Enter ───────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (!isRemoteMode()) return;

        // Restore highlights if they were cleared
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

    // ── Universal Auto-Focus for ANY Modal / Popover / Overlay ──────────────
    let lastOverlayEl = null;
    const overlayObserver = new MutationObserver(() => {
        if (!isRemoteMode()) return;

        const overlayItems = getOverlayItems();
        if (overlayItems && overlayItems.length > 0) {
            const currentContainer = overlayItems[0].closest('#still-watching-popover, #critical-popover, #wifi-warning-overlay, #modal-overlay, #wifi-password-overlay');
            if (currentContainer !== lastOverlayEl || !remoteFocusEl || !overlayItems.includes(remoteFocusEl)) {
                lastOverlayEl = currentContainer;
                zone = 'content';
                contentFocusIdx = 0;
                clearGridFocus();
                setFocusEl(overlayItems[0]);
            }
        } else {
            // When overlay closes, reset tracker and return focus to content
            if (lastOverlayEl !== null) {
                lastOverlayEl = null;
                setTimeout(() => {
                    zone = 'content';
                    contentFocusIdx = 0;
                    enterContentZone();
                }, 100);
            }
        }
    });

    overlayObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        subtree: true
    });

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
    document.addEventListener('click', (e) => {
        if (!isRemoteMode()) return;

        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
        if (e.target.closest('input, textarea')) return;

        setTimeout(() => {
            if (zone === 'content' && !isHomeGrid()) {
                const curActive = document.activeElement?.tagName;
                if (curActive === 'INPUT' || curActive === 'TEXTAREA') return;

                const items = getContentItems();
                if (remoteFocusEl && !document.body.contains(remoteFocusEl)) {
                    contentFocusIdx = 0;
                    if (items.length) setFocusEl(items[0]);
                }
            }
        }, 200);
    });

    // ── Air Mouse / Mouse Movement ───────────────────────────────────────────
    document.addEventListener('mousemove', (e) => {
        if (!isRemoteMode()) return;
        if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
        if (e.movementX === 0 && e.movementY === 0) return;

        clearFocusEl();
        clearGridFocus();
    });
}