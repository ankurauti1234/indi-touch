// js/absence.js — Household Absence / Vacation Mode Controller

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let selectedReturnDate = new Date();

export function initAbsenceManager() {
    setDaysFromNow(7);
}

function setDaysFromNow(days) {
    const target = new Date();
    target.setDate(target.getDate() + days);
    target.setHours(23, 59, 59, 0);
    selectedReturnDate = target;
    renderDatePickers();
}

function renderDatePickers() {
    const dayEl = document.getElementById('absence-val-day');
    const monthEl = document.getElementById('absence-val-month');
    const yearEl = document.getElementById('absence-val-year');
    const summaryEl = document.getElementById('absence-summary-text');

    if (dayEl) dayEl.innerText = String(selectedReturnDate.getDate()).padStart(2, '0');
    if (monthEl) monthEl.innerText = MONTH_NAMES[selectedReturnDate.getMonth()];
    if (yearEl) yearEl.innerText = selectedReturnDate.getFullYear();

    if (summaryEl) {
        const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
        summaryEl.innerHTML = `Returning on <strong>${selectedReturnDate.toLocaleDateString('en-US', options)}</strong>`;
    }
}

export function openAbsenceModal() {
    const modal = document.getElementById('absence-modal');
    if (!modal) return;
    setDaysFromNow(7);
    updateActivePresetChip(7);
    modal.style.display = 'flex';
}

export function closeAbsenceModal() {
    const modal = document.getElementById('absence-modal');
    if (modal) modal.style.display = 'none';
}

export function selectAbsencePreset(days) {
    setDaysFromNow(days);
    updateActivePresetChip(days);
}

function updateActivePresetChip(days) {
    document.querySelectorAll('.absence-preset-btn').forEach(btn => btn.classList.remove('active'));
    const target = document.getElementById(`preset-${days}`);
    if (target) target.classList.add('active');
}

export function adjustAbsenceDay(delta) {
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + 1);

    const next = new Date(selectedReturnDate);
    next.setDate(next.getDate() + delta);

    if (next >= minDate) {
        selectedReturnDate = next;
        document.querySelectorAll('.absence-preset-btn').forEach(btn => btn.classList.remove('active'));
        renderDatePickers();
    }
}

export function adjustAbsenceMonth(delta) {
    const minDate = new Date();
    const next = new Date(selectedReturnDate);
    next.setMonth(next.getMonth() + delta);

    if (next > minDate) {
        selectedReturnDate = next;
        document.querySelectorAll('.absence-preset-btn').forEach(btn => btn.classList.remove('active'));
        renderDatePickers();
    }
}

export function adjustAbsenceYear(delta) {
    const minDate = new Date();
    const next = new Date(selectedReturnDate);
    next.setFullYear(next.getFullYear() + delta);

    if (next >= minDate && next.getFullYear() <= minDate.getFullYear() + 2) {
        selectedReturnDate = next;
        document.querySelectorAll('.absence-preset-btn').forEach(btn => btn.classList.remove('active'));
        renderDatePickers();
    }
}

export async function confirmAbsence() {
    const btn = document.getElementById('btn-confirm-absence');
    if (btn) btn.disabled = true;

    const payload = {
        start_time: Math.floor(Date.now() / 1000),
        end_time: Math.floor(selectedReturnDate.getTime() / 1000)
    };

    try {
        const res = await fetch('/api/household/absence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            closeAbsenceModal();
            const luggageBtn = document.getElementById('btn-absence');
            if (luggageBtn) luggageBtn.classList.add('active');
            if (window.showToast) window.showToast("Household Away Mode activated.");
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

// Attach explicitly to window for inline HTML onclick handlers
window.openAbsenceModal = openAbsenceModal;
window.closeAbsenceModal = closeAbsenceModal;
window.selectAbsencePreset = selectAbsencePreset;
window.adjustAbsenceDay = adjustAbsenceDay;
window.adjustAbsenceMonth = adjustAbsenceMonth;
window.adjustAbsenceYear = adjustAbsenceYear;
window.confirmAbsence = confirmAbsence;