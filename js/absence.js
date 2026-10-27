// js/absence.js — Absence Calendar & Active Mode Controller

import { syncTvOverlay } from './connection.js';



const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();

let rangeStart = null;
let rangeEnd = null;
let isPickingEnd = false;
let isAwayModeActive = false;
let activeAbsenceRecord = null;

function initAbsenceCalendar() {
    fetchAbsenceStatus();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (!isAwayModeActive) {
        rangeStart = new Date(today);
        rangeStart.setDate(today.getDate() + 1);

        rangeEnd = new Date(today);
        rangeEnd.setDate(today.getDate() + 7);

        viewYear = rangeStart.getFullYear();
        viewMonth = rangeStart.getMonth();
    }

    isPickingEnd = false;
    renderCalendar();
    updateHeroRange();
    applyActiveModeUI();
}

async function fetchAbsenceStatus() {
    try {
        const res = await fetch('/api/household/absence');
        const data = await res.json();
        if (data.active && data.absence) {
            isAwayModeActive = true;
            activeAbsenceRecord = data.absence;

            rangeStart = new Date(data.absence.start_time * 1000);
            rangeStart.setHours(0, 0, 0, 0);

            rangeEnd = new Date(data.absence.end_time * 1000);
            rangeEnd.setHours(0, 0, 0, 0);

            viewYear = rangeStart.getFullYear();
            viewMonth = rangeStart.getMonth();
        } else {
            isAwayModeActive = false;
            activeAbsenceRecord = null;
        }
    } catch (e) {
        console.warn("Could not fetch absence status:", e);
    }
    renderCalendar();
    updateHeroRange();
    applyActiveModeUI();
    updateHomeLockOverlay();
}

function applyActiveModeUI() {
    const rightPane = document.getElementById('cal-right-pane');
    const badgeText = document.getElementById('cal-badge-text');
    const btn = document.getElementById('btn-activate-absence');
    const btnIcon = document.getElementById('btn-absence-icon');
    const btnLabel = document.getElementById('btn-absence-label');
    const subText = document.getElementById('cal-detail-subtext');

    if (!rightPane || !btn) return;

    if (isAwayModeActive) {
        rightPane.classList.add('is-active');
        if (badgeText) badgeText.innerText = 'AWAY MODE ACTIVE';
        if (btnIcon) btnIcon.innerText = 'close';
        if (btnLabel) btnLabel.innerText = 'Cancel Away Mode';
        btn.classList.add('btn-cancel-mode');
        if (subText) subText.innerText = 'All member interactions paused';
    } else {
        rightPane.classList.remove('is-active');
        if (badgeText) badgeText.innerText = 'AWAY MODE';
        if (btnIcon) btnIcon.innerText = 'check';
        if (btnLabel) btnLabel.innerText = 'Activate Away Mode';
        btn.classList.remove('btn-cancel-mode');
        if (subText) subText.innerText = 'Logs resume day after return';
    }
}

function updateHomeLockOverlay() {
    const overlay = document.getElementById('away-lock-overlay');
    const label = document.getElementById('away-lock-range-label');
    const navBtn = document.getElementById('btn-absence');

    if (!overlay) return;

    if (isAwayModeActive && activeAbsenceRecord) {
        overlay.style.display = 'flex';
        if (navBtn) navBtn.classList.add('active');

        const endD = new Date(activeAbsenceRecord.end_time * 1000);
        const dateStr = `${MONTH_FULL[endD.getMonth()].slice(0, 3)} ${endD.getDate()}, ${endD.getFullYear()}`;
        if (label) label.innerText = `Absence scheduled until ${dateStr} (11:59 PM)`;
    } else {
        overlay.style.display = 'none';
        if (navBtn) navBtn.classList.remove('active');
    }
}

function calPrevMonth() {
    if (isAwayModeActive) return;
    const now = new Date();
    if (viewYear === now.getFullYear() && viewMonth <= now.getMonth()) {
        return;
    }
    viewMonth--;
    if (viewMonth < 0) {
        viewMonth = 11;
        viewYear--;
    }
    renderCalendar();
}

function calNextMonth() {
    if (isAwayModeActive) return;
    viewMonth++;
    if (viewMonth > 11) {
        viewMonth = 0;
        viewYear++;
    }
    renderCalendar();
}

function calPrevYear() {
    if (isAwayModeActive) return;
    const now = new Date();
    if (viewYear > now.getFullYear()) {
        viewYear--;
        renderCalendar();
    }
}

function calNextYear() {
    if (isAwayModeActive) return;
    viewYear++;
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('cal-days-grid');
    const monthLabel = document.getElementById('cal-month-label');
    const yearLabel = document.getElementById('cal-year-label');
    if (!grid) return;

    if (monthLabel) monthLabel.innerText = MONTH_FULL[viewMonth];
    if (yearLabel) yearLabel.innerText = viewYear;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
    const lastDayOfMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevMonthLastDay = new Date(viewYear, viewMonth, 0).getDate();

    let cellsHtml = '';

    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const d = prevMonthLastDay - i;
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    for (let day = 1; day <= lastDayOfMonth; day++) {
        const cellDate = new Date(viewYear, viewMonth, day);
        cellDate.setHours(0, 0, 0, 0);

        const isPast = cellDate < today;
        const isToday = cellDate.getTime() === today.getTime();

        const isStart = rangeStart && cellDate.getTime() === rangeStart.getTime();
        const isEnd = rangeEnd && cellDate.getTime() === rangeEnd.getTime();
        const inRange = rangeStart && rangeEnd && cellDate > rangeStart && cellDate < rangeEnd;

        let classes = ['cal-day-cell'];
        if (isPast) classes.push('disabled');
        if (isToday) classes.push('today');
        if (isStart) classes.push('range-start');
        if (isEnd) classes.push('range-end');
        if (inRange) classes.push('in-range');
        if (isAwayModeActive) classes.push('calendar-locked');

        // Block click event if past date or if Away Mode is active
        const onclick = (isPast || isAwayModeActive) ? '' : `onclick="calSelectDay(${viewYear}, ${viewMonth}, ${day})"`;
        cellsHtml += `<div class="${classes.join(' ')}" ${onclick}>${String(day).padStart(2, '0')}</div>`;
    }

    const totalFilled = firstDayIndex + lastDayOfMonth;
    const nextDays = (7 - (totalFilled % 7)) % 7;
    for (let d = 1; d <= nextDays; d++) {
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    grid.innerHTML = cellsHtml;
}

function calSelectDay(year, month, day) {
    if (isAwayModeActive) return;

    const picked = new Date(year, month, day);
    picked.setHours(0, 0, 0, 0);

    if (!isPickingEnd || !rangeStart) {
        rangeStart = picked;
        rangeEnd = null;
        isPickingEnd = true;
    } else {
        if (picked < rangeStart) {
            rangeEnd = rangeStart;
            rangeStart = picked;
        } else {
            rangeEnd = picked;
        }
        isPickingEnd = false;
    }

    renderCalendar();
    updateHeroRange();
}

function updateHeroRange() {
    const startDayEl = document.getElementById('cal-start-day');
    const startWeekdayEl = document.getElementById('cal-start-weekday');
    const startMyEl = document.getElementById('cal-start-month-year');

    const endDayEl = document.getElementById('cal-end-day');
    const endWeekdayEl = document.getElementById('cal-end-weekday');
    const endMyEl = document.getElementById('cal-end-month-year');
    const durEl = document.getElementById('cal-hero-duration');

    if (rangeStart && startDayEl) {
        startDayEl.innerText = rangeStart.getDate();
        startWeekdayEl.innerText = WEEKDAYS[rangeStart.getDay()];
        startMyEl.innerText = `${MONTH_FULL[rangeStart.getMonth()]} ${rangeStart.getFullYear()}`;
    }

    if (rangeEnd && endDayEl) {
        endDayEl.innerText = rangeEnd.getDate();
        endWeekdayEl.innerText = WEEKDAYS[rangeEnd.getDay()];
        endMyEl.innerText = `${MONTH_FULL[rangeEnd.getMonth()]} ${rangeEnd.getFullYear()}`;
    } else if (endDayEl) {
        endDayEl.innerText = '--';
        endWeekdayEl.innerText = 'SELECT RETURN';
        endMyEl.innerText = 'Tap a date on calendar';
    }

    if (rangeStart && rangeEnd && durEl) {
        const diffDays = Math.round((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24)) + 1;
        durEl.innerText = `${diffDays} Day${diffDays > 1 ? 's' : ''} Duration`;
    } else if (durEl) {
        durEl.innerText = 'Picking range...';
    }
}

async function handleAbsenceAction() {
    if (isAwayModeActive) {
        await cancelAbsenceMode();
    } else {
        await activateAbsenceMode();
    }
}

async function activateAbsenceMode() {
    if (!rangeStart) return;

    const btn = document.getElementById('btn-activate-absence');
    if (btn) btn.disabled = true;

    const effectiveEnd = rangeEnd || rangeStart;
    const startTimestamp = Math.floor(rangeStart.getTime() / 1000);
    const endTimestamp = Math.floor(new Date(effectiveEnd).setHours(23, 59, 59, 0) / 1000);

    try {
        const res = await fetch('/api/household/absence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_time: startTimestamp, end_time: endTimestamp })
        });

        if (!res.ok) {
            console.error("Server error:", res.status);
            if (window.showToast) window.showToast(`Server error (${res.status})`);
            return;
        }

        const data = await res.json();

        if (data.success) {
            isAwayModeActive = true;
            activeAbsenceRecord = { start_time: startTimestamp, end_time: endTimestamp };
            applyActiveModeUI();
            updateHomeLockOverlay();
            if (window.showToast) window.showToast("Household Away Mode activated.");
            // Kept on the current calendar view so user sees the updated state
        } else {
            if (window.showToast) window.showToast(data.error || "Failed to set away mode");
        }
    } catch (e) {
        console.error("Absence request failed:", e);
        if (window.showToast) window.showToast("Network error: Could not activate away mode");
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function cancelAbsenceMode() {
    const btn = document.getElementById('btn-activate-absence');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/household/absence', {
            method: 'DELETE'
        });

        if (!res.ok) {
            console.error("Server error:", res.status);
            if (window.showToast) window.showToast(`Server error (${res.status})`);
            return;
        }

        const data = await res.json();

        if (data.success) {
            isAwayModeActive = false;
            activeAbsenceRecord = null;
            applyActiveModeUI();
            updateHomeLockOverlay();
            if (window.showToast) window.showToast("Household Away Mode cancelled.");
            // Kept on the current calendar view so user sees it reset to normal
        } else {
            if (window.showToast) window.showToast(data.error || "Failed to cancel away mode");
        }
    } catch (e) {
        console.error("Failed to cancel absence:", e);
        if (window.showToast) window.showToast("Error cancelling away mode");
    } finally {
        if (btn) btn.disabled = false;
    }
}

window.calPrevMonth = calPrevMonth;
window.calNextMonth = calNextMonth;
window.calPrevYear = calPrevYear;
window.calNextYear = calNextYear;
window.calSelectDay = calSelectDay;
window.handleAbsenceAction = handleAbsenceAction;

export { initAbsenceCalendar, initAbsenceCalendar as initAbsenceManager };