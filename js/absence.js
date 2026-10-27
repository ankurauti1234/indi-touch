// js/absence.js — Full Screen Absence Calendar View Controller

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0 - 11
let selectedDate = new Date();

export function initAbsenceCalendar() {
    // Default selection: 7 days from today
    const def = new Date();
    def.setDate(def.getDate() + 7);
    def.setHours(23, 59, 59, 0);
    selectedDate = def;
    viewYear = selectedDate.getFullYear();
    viewMonth = selectedDate.getMonth();

    renderMonthsRibbon();
    renderCalendar();
    updateHeroCard();
}

function renderMonthsRibbon() {
    const container = document.getElementById('cal-months-ribbon');
    if (!container) return;

    container.innerHTML = MONTH_SHORT.map((m, idx) => `
        <span class="cal-month-tab ${idx === viewMonth ? 'active' : ''}" 
              onclick="calSelectMonth(${idx})">
            ${m}
        </span>
    `).join('');
}

export function calSelectMonth(monthIndex) {
    viewMonth = monthIndex;
    renderMonthsRibbon();
    renderCalendar();
}

export function calPrevYear() {
    const now = new Date();
    if (viewYear > now.getFullYear()) {
        viewYear--;
        document.getElementById('cal-year-label').innerText = viewYear;
        renderCalendar();
    }
}

export function calNextYear() {
    viewYear++;
    document.getElementById('cal-year-label').innerText = viewYear;
    renderCalendar();
}

export function renderCalendar() {
    const grid = document.getElementById('cal-days-grid');
    const yearLabel = document.getElementById('cal-year-label');
    if (!grid) return;

    if (yearLabel) yearLabel.innerText = viewYear;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
    const lastDayOfMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevMonthLastDay = new Date(viewYear, viewMonth, 0).getDate();

    let cellsHtml = '';

    // Prev month padding days
    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const d = prevMonthLastDay - i;
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    // Current month days
    for (let day = 1; day <= lastDayOfMonth; day++) {
        const cellDate = new Date(viewYear, viewMonth, day);
        cellDate.setHours(0, 0, 0, 0);

        const isPast = cellDate <= today; // Cannot set absence in the past or today
        const isToday = cellDate.getTime() === today.getTime();
        const isSelected = selectedDate &&
            cellDate.getFullYear() === selectedDate.getFullYear() &&
            cellDate.getMonth() === selectedDate.getMonth() &&
            cellDate.getDate() === selectedDate.getDate();

        let classes = ['cal-day-cell'];
        if (isPast) classes.push('disabled');
        if (isToday) classes.push('today');
        if (isSelected) classes.push('selected');

        const onclick = isPast ? '' : `onclick="calSelectDay(${viewYear}, ${viewMonth}, ${day})"`;
        cellsHtml += `<div class="${classes.join(' ')}" ${onclick}>${String(day).padStart(2, '0')}</div>`;
    }

    // Trailing days padding for 7-column balance
    const totalFilled = firstDayIndex + lastDayOfMonth;
    const nextDays = (7 - (totalFilled % 7)) % 7;
    for (let d = 1; d <= nextDays; d++) {
        cellsHtml += `<div class="cal-day-cell other-month disabled">${String(d).padStart(2, '0')}</div>`;
    }

    grid.innerHTML = cellsHtml;
}

export function calSelectDay(year, month, day) {
    const picked = new Date(year, month, day, 23, 59, 59, 0);
    selectedDate = picked;
    renderCalendar();
    updateHeroCard();
}

function updateHeroCard() {
    const dayEl = document.getElementById('cal-hero-day');
    const weekdayEl = document.getElementById('cal-hero-weekday');
    const myEl = document.getElementById('cal-hero-month-year');
    const durEl = document.getElementById('cal-hero-duration');

    if (!selectedDate || !dayEl) return;

    dayEl.innerText = selectedDate.getDate();
    weekdayEl.innerText = WEEKDAYS[selectedDate.getDay()];
    myEl.innerText = `${MONTH_FULL[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`;

    // Calculate days duration
    const now = new Date();
    const diffTime = selectedDate.getTime() - now.getTime();
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    if (durEl) durEl.innerText = `${diffDays} Day${diffDays > 1 ? 's' : ''} Duration`;
}

export async function confirmAbsenceCalendar() {
    const btn = document.getElementById('btn-activate-absence');
    if (btn) btn.disabled = true;

    const payload = {
        start_time: Math.floor(Date.now() / 1000),
        end_time: Math.floor(selectedDate.getTime() / 1000)
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

// Global window mappings for markup click handlers
window.calSelectMonth = calSelectMonth;
window.calSelectDay = calSelectDay;
window.calPrevYear = calPrevYear;
window.calNextYear = calNextYear;
window.confirmAbsenceCalendar = confirmAbsenceCalendar;