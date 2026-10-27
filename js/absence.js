// js/absence.js — Full Screen Absence Calendar Range View Controller

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();

let rangeStart = null;
let rangeEnd = null;
let isPickingEnd = false;

function initAbsenceCalendar() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Default: Departing tomorrow, returning in 7 days
    rangeStart = new Date(today);
    rangeStart.setDate(today.getDate() + 1);

    rangeEnd = new Date(today);
    rangeEnd.setDate(today.getDate() + 7);

    isPickingEnd = false;
    viewYear = rangeStart.getFullYear();
    viewMonth = rangeStart.getMonth();

    renderCalendar();
    updateHeroRange();
}

function calPrevMonth() {
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
    viewMonth++;
    if (viewMonth > 11) {
        viewMonth = 0;
        viewYear++;
    }
    renderCalendar();
}

function calPrevYear() {
    const now = new Date();
    if (viewYear > now.getFullYear()) {
        viewYear--;
        renderCalendar();
    }
}

function calNextYear() {
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

    // Leading padding days from previous month
    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const d = prevMonthLastDay - i;
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    // Days in current view month
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

        const onclick = isPast ? '' : `onclick="calSelectDay(${viewYear}, ${viewMonth}, ${day})"`;
        cellsHtml += `<div class="${classes.join(' ')}" ${onclick}>${String(day).padStart(2, '0')}</div>`;
    }

    // Trailing padding days
    const totalFilled = firstDayIndex + lastDayOfMonth;
    const nextDays = (7 - (totalFilled % 7)) % 7;
    for (let d = 1; d <= nextDays; d++) {
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    grid.innerHTML = cellsHtml;
}

function calSelectDay(year, month, day) {
    const picked = new Date(year, month, day);
    picked.setHours(0, 0, 0, 0);

    if (!isPickingEnd || !rangeStart) {
        // Step 1: Picking Start Date
        rangeStart = picked;
        rangeEnd = null;
        isPickingEnd = true;
    } else {
        // Step 2: Picking End Date
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
    // Start elements
    const startDayEl = document.getElementById('cal-start-day');
    const startWeekdayEl = document.getElementById('cal-start-weekday');
    const startMyEl = document.getElementById('cal-start-month-year');

    // End elements
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

async function confirmAbsenceCalendar() {
    if (!rangeStart) return;

    const btn = document.getElementById('btn-activate-absence');
    if (btn) btn.disabled = true;

    // Use rangeEnd if selected, otherwise fallback to rangeStart (single day)
    const effectiveEnd = rangeEnd || rangeStart;

    // Start of the departure day, end of the return day (23:59:59)
    const startTimestamp = Math.floor(rangeStart.getTime() / 1000);
    const endTimestamp = Math.floor(new Date(effectiveEnd).setHours(23, 59, 59, 0) / 1000);

    const payload = {
        start_time: startTimestamp,
        end_time: endTimestamp
    };

    try {
        const res = await fetch('/api/household/absence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            const luggageBtn = document.getElementById('btn-absence');
            if (luggageBtn) luggageBtn.classList.add('active');
            if (window.showToast) window.showToast("Household Away Mode activated.");
            if (window.navTo) window.navTo('home');
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

// Bind handlers to window
window.calPrevMonth = calPrevMonth;
window.calNextMonth = calNextMonth;
window.calPrevYear = calPrevYear;
window.calNextYear = calNextYear;
window.calSelectDay = calSelectDay;
window.confirmAbsenceCalendar = confirmAbsenceCalendar;

export { initAbsenceCalendar, initAbsenceCalendar as initAbsenceManager };