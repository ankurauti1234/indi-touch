// js/absence.js — Household Away Mode Toggle & Popover Controller

import { syncTvOverlay } from './connection.js';
import { t } from './i18n.js';

// Exported state for connection.js and main.js sync
export let isAwayModeActive = false;

// Undeclare all members on backend, reload state, and dismiss reminder popover
async function undeclareAllMembersAndGuests() {
    const popover = document.getElementById('critical-popover');
    if (popover) {
        popover.classList.remove('active');
    }

    try {
        console.log("Away Mode: Undeclaring all members & clearing guests...");
        await fetch('/api/members/undeclare', { method: 'POST' });
    } catch (e) {
        console.error("Failed to undeclare via API:", e);
    }

    document.querySelectorAll('.member-btn.active, .member-card.active, .guest-card.active').forEach(el => {
        el.classList.remove('active');
    });

    try {
        const m = await import('./data.js');
        if (Array.isArray(m.guests)) m.guests.length = 0;
        await m.loadMembers();
        if (window.renderGrid) window.renderGrid();
        if (window.renderGuestList) window.renderGuestList();
        if (window.updateGuestBadge) window.updateGuestBadge();
    } catch (e) {
        console.error("Error reloading member/guest data:", e);
    }
}

async function initAbsenceCalendar() {
    await fetchAbsenceStatus();
}

async function fetchAbsenceStatus() {
    try {
        const res = await fetch('/api/household/absence');
        const data = await res.json();
        isAwayModeActive = Boolean(data.active || data.status === 'absent');
    } catch (e) {
        console.warn("Could not fetch absence status:", e);
    }
    applyActiveModeUI();
    if (typeof syncTvOverlay === 'function') syncTvOverlay();
}

export function applyActiveModeUI() {
    const navBtn = document.getElementById('btn-absence');
    const titleEl = document.getElementById('away-modal-title');
    const descEl = document.getElementById('away-modal-desc');
    const iconEl = document.getElementById('away-modal-icon');
    const iconWrap = document.getElementById('away-modal-icon-wrap');
    const confirmBtn = document.getElementById('btn-confirm-away');

    if (navBtn) {
        navBtn.classList.toggle('active', isAwayModeActive);
        navBtn.title = t('away_mode');
    }

    if (isAwayModeActive) {
        if (titleEl) {
            titleEl.innerText = t('deactivate_away_title');
            titleEl.setAttribute('data-i18n', 'deactivate_away_title');
        }
        if (descEl) {
            descEl.innerText = t('deactivate_away_desc');
            descEl.setAttribute('data-i18n', 'deactivate_away_desc');
        }
        if (iconEl) iconEl.innerText = 'home';
        if (iconWrap) {
            iconWrap.style.background = 'var(--primary-container)';
            iconWrap.style.color = 'var(--on-primary-container)';
        }
        if (confirmBtn) {
            confirmBtn.innerText = t('deactivate');
            confirmBtn.setAttribute('data-i18n', 'deactivate');
            confirmBtn.classList.add('danger');
        }
    } else {
        if (titleEl) {
            titleEl.innerText = t('activate_away_title');
            titleEl.setAttribute('data-i18n', 'activate_away_title');
        }
        if (descEl) {
            descEl.innerText = t('activate_away_desc');
            descEl.setAttribute('data-i18n', 'activate_away_desc');
        }
        if (iconEl) iconEl.innerText = 'flight_takeoff';
        if (iconWrap) {
            iconWrap.style.background = 'var(--secondary-container)';
            iconWrap.style.color = 'var(--on-secondary-container)';
        }
        if (confirmBtn) {
            confirmBtn.innerText = t('activate');
            confirmBtn.setAttribute('data-i18n', 'activate');
            confirmBtn.classList.remove('danger');
        }
    }
}

export function openAwayModeModal() {
    applyActiveModeUI();
    const overlay = document.getElementById('away-mode-overlay');
    if (overlay) overlay.classList.add('active');
}

export function closeAwayModeModal() {
    const overlay = document.getElementById('away-mode-overlay');
    if (overlay) overlay.classList.remove('active');
}

async function handleAbsenceAction() {
    if (isAwayModeActive) {
        await cancelAbsenceMode();
    } else {
        await activateAbsenceMode();
    }
}

async function activateAbsenceMode() {
    const btn = document.getElementById('btn-confirm-away');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/household/absence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'absent' })
        });

        if (!res.ok) {
            console.error("Server error:", res.status);
            if (window.showToast) window.showToast(`Server error (${res.status})`);
            return;
        }

        const data = await res.json();

        if (data.success) {
            isAwayModeActive = true;

            await undeclareAllMembersAndGuests();

            applyActiveModeUI();
            closeAwayModeModal();
            if (typeof syncTvOverlay === 'function') syncTvOverlay();
            if (window.showToast) window.showToast(t('away_mode_activated'));
        } else {
            if (window.showToast) window.showToast(data.error || t('away_mode_set_failed'));
        }
    } catch (e) {
        console.error("Absence request failed:", e);
        if (window.showToast) window.showToast(t('away_mode_network_error'));
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function cancelAbsenceMode() {
    const btn = document.getElementById('btn-confirm-away');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/household/absence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'present' })
        });

        if (!res.ok) {
            console.error("Server error:", res.status);
            if (window.showToast) window.showToast(`Server error (${res.status})`);
            return;
        }

        const data = await res.json();

        if (data.success) {
            isAwayModeActive = false;
            applyActiveModeUI();
            closeAwayModeModal();
            if (typeof syncTvOverlay === 'function') syncTvOverlay();
            if (window.showToast) window.showToast(t('away_mode_deactivated'));
        } else {
            if (window.showToast) window.showToast(data.error || t('away_mode_deactivate_failed'));
        }
    } catch (e) {
        console.error("Failed to cancel absence:", e);
        if (window.showToast) window.showToast(t('away_mode_deactivate_error'));
    } finally {
        if (btn) btn.disabled = false;
    }
}

window.openAwayModeModal = openAwayModeModal;
window.closeAwayModeModal = closeAwayModeModal;
window.handleAbsenceAction = handleAbsenceAction;
window.applyActiveModeUI = applyActiveModeUI;

export { initAbsenceCalendar, initAbsenceCalendar as initAbsenceManager };