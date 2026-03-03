import { config, memberData, tvState, save as legacySave, loadMembers, getAvatarUrl } from './data.js';

// --- Focus State ---
let focusedIndex = 0;

function isRemoteMode() {
    return document.body.classList.contains('remote-mode');
}

export async function renderGrid() {
    const container = document.getElementById('grid-container');
    if (!container) return;

    // Refresh data from API if needed, or use cached memberData
    const data = memberData.length > 0 ? memberData : await loadMembers();
    const count = data.length;
    const style = window.globalAvatarStyle || 'notionists';

    let rows = 1;
    if (count > 3) rows = 2;
    if (count > 8) rows = 3;
    const cols = Math.ceil(count / rows);

    container.style.setProperty('--cols', cols);
    container.style.setProperty('--rows', rows);
    container._gridCols = cols;
    container._gridRows = rows;

    container.innerHTML = data.map((m, index) => {
        const url = getAvatarUrl(m);
        const activeClass = m.active ? 'active' : 'inactive';
        const avatarStyleClass = config.avatarStyle === 'local' ? 'local-avatar' : '';

        return `
        <div class="member-card ${activeClass} ${avatarStyleClass}" data-index="${index}" onclick="toggleMember(${index})">
            <img src="${url}" class="member-img" loading="lazy">
            <div class="member-overlay">
                <span style="font-size:1.2rem; font-weight:500;">${m.name}</span>
                <span style="font-size:0.9rem; opacity:0.8;">${m.gender}, ${m.age}</span>
            </div>
        </div>`;
    }).join('');

    if (isRemoteMode()) applyFocus();
}

window.updateTvUI = function(tvOn) {
    const overlay = document.getElementById('tv-off-overlay');
    if (overlay) {
        overlay.style.display = tvOn ? 'none' : 'flex';
    }
    // If TV is off, clear focus to prevent accidental toggles
    if (!tvOn) clearGridFocus();
}

export function applyFocus() {
    const cards = document.querySelectorAll('#grid-container .member-card');
    cards.forEach(c => c.classList.remove('focused'));
    if (!isRemoteMode() || !tvState.on) return; // Don't focus if TV is off
    if (cards[focusedIndex]) {
        cards[focusedIndex].classList.add('focused');
    }
}

export function clearGridFocus() {
    document.querySelectorAll('#grid-container .member-card').forEach(c => c.classList.remove('focused'));
}

export function getFocusedGridIndex() {
    return focusedIndex;
}

export function getGridCols() {
    const container = document.getElementById('grid-container');
    return container?._gridCols || 1;
}

export function moveFocus(direction) {
    if (!isRemoteMode() || !tvState.on) return;
    const container = document.getElementById('grid-container');
    if (!container) return;
    const cards = document.querySelectorAll('#grid-container .member-card');
    const count = cards.length;
    if (count === 0) return;

    const cols = container._gridCols || 1;
    let next = focusedIndex;

    switch (direction) {
        case 'right':  next = (focusedIndex + 1) % count; break;
        case 'left':   next = (focusedIndex - 1 + count) % count; break;
        case 'down':
            next = focusedIndex + cols;
            if (next >= count) next = focusedIndex % cols;
            break;
        case 'up':
            next = focusedIndex - cols;
            if (next < 0) {
                const col = focusedIndex % cols;
                const lastRow = Math.floor((count - 1) / cols);
                next = lastRow * cols + col;
                if (next >= count) next -= cols;
            }
            break;
    }

    focusedIndex = next;
    applyFocus();
}

export function toggleFocused() {
    if (!tvState.on) return;
    toggleMember(focusedIndex);
}

let toggleDebounceTimer = null;
export async function toggleMember(index) {
    if (!tvState.on) {
        console.warn("Toggle member ignored: TV is OFF");
        return;
    }
    if (toggleDebounceTimer) return;
    toggleDebounceTimer = setTimeout(() => { toggleDebounceTimer = null; }, 500); // 500ms debounce
    if (memberData[index]) {
        try {
            const r = await fetch('/api/members/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: index })
            });
            const res = await r.json();
            if (res.success) {
                // Update local state and redraw
                memberData[index].active = res.active;
                renderGrid();
                
                // Also update saver if active
                if (window.renderSaverMembers) window.renderSaverMembers();
            }
        } catch (e) {
            console.error("Toggle member failed", e);
        }
    }
}
