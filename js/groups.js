import { config, memberData, tvState, loadMembers, getAvatarUrl } from './data.js';
import { applyTranslations } from './i18n.js';
import { timers } from './utils.js';

// --- STATE ---
export let customGroups = [];
let isToggling = false;
let currentEditId = null;

// --- INITIALIZATION ---
export async function loadGroups() {
    try {
        const response = await fetch('/api/groups');
        const data = await response.json();
        if (data.success) {
            customGroups = data.groups || [];
            renderGroupCards();
        }
    } catch (err) {
        console.error("[Groups] Failed to fetch groups:", err);
    }
}

// --- RENDER UI ---
export function renderGroupCards() {
    const container = document.getElementById('groups-grid-container');
    if (!container) return;

    // Clear safely
    container.innerHTML = '';

    const maxAvatars = 4;
    const avatarStyleClass = (config.avatarStyle || 'local') === 'local' ? 'local-avatar' : '';

    // 1. "All Members" Card
    const allMembersActive = memberData.length > 0 && memberData.every(m => m.active);
    const allMembersCard = buildCardElement(
        'all',
        'All Members',
        memberData,
        allMembersActive,
        avatarStyleClass,
        maxAvatars,
        false // cannot edit 'All Members'
    );
    container.appendChild(allMembersCard);

    // 2. Custom Group Cards
    customGroups.forEach(group => {
        // Map member codes to actual member objects to check status
        const groupMembers = group.members.map(gMem =>
            memberData.find(m => m.member_code === gMem.member_code)
        ).filter(Boolean);

        // Group is active ONLY if all its members are active AND 'All Members' is NOT active
        const isGroupActive = groupMembers.length > 0 && groupMembers.every(m => m.active) && !allMembersActive;
        const isWide = group.members.length > 4;

        const card = buildCardElement(
            group.id,
            group.name,
            groupMembers,
            isGroupActive,
            avatarStyleClass,
            maxAvatars,
            true, // is editable
            isWide
        );
        container.appendChild(card);
    });

    // 3. "Create Group" Card
    const createCard = document.createElement('button');
    createCard.className = 'group-card create-card';
    createCard.onclick = openCreateGroup;
    createCard.innerHTML = `
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    `;
    container.appendChild(createCard);

    applyTranslations();
}

// --- DOM BUILDER UTILITY ---
function buildCardElement(id, name, members, isActive, styleClass, maxAvatars, isEditable, isWide = false) {
    const card = document.createElement('button');
    card.className = `group-card ${isActive ? 'active' : 'inactive'} ${styleClass} ${isWide ? 'wide-card' : ''}`;

    // Direct click handler prevents event bubbling bugs
    card.onclick = (e) => {
        // If clicking the edit button, open modal instead of toggling
        if (e.target.closest('.group-edit-btn')) {
            openEditGroup(id);
            return;
        }
        executeGroupToggle(id, members);
    };

    const displayMembers = members.slice(0, maxAvatars);
    const excess = members.length - maxAvatars;

    let avatarsHtml = displayMembers.map(m =>
        `<img src="${getAvatarUrl(m)}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`
    ).join('');

    if (excess > 0) {
        avatarsHtml += `<div class="group-avatar-more">+${excess}</div>`;
    }

    const editBtnHtml = isEditable ? `
        <div class="group-edit-btn" title="Edit Group">
            <span class="material-symbols-rounded">edit</span>
        </div>` : '';

    card.innerHTML = `
        ${editBtnHtml}
        <div class="group-avatars-container">
            ${avatarsHtml}
        </div>
        <div class="member-overlay">
            <span class="m-name g-name" style="font-size:1.2rem; font-weight:500;">${name}</span>
            <span class="m-info g-info" style="font-size:0.9rem; opacity:0.8;">${members.length} ${members.length === 1 ? 'Member' : 'Members'}</span>
        </div>
    `;

    return card;
}

// --- CORE LOGIC ---
async function executeGroupToggle(groupId, groupMembers) {
    if (!tvState.on || isToggling) return;

    isToggling = true;
    timers.setTimeout(() => { isToggling = false; }, 500); // 500ms debounce

    try {
        const allMembersActive = memberData.length > 0 && memberData.every(m => m.active);
        let targetCodes = [];

        if (groupId === 'all') {
            if (!allMembersActive) targetCodes = memberData.map(m => m.member_code);
        } else {
            const isGroupActive = groupMembers.length > 0 && groupMembers.every(m => m.active) && !allMembersActive;
            if (!isGroupActive) targetCodes = groupMembers.map(m => m.member_code);
        }

        const pendingUpdates = [];
        memberData.forEach((member, index) => {
            const shouldBeActive = targetCodes.includes(member.member_code);
            if (member.active !== shouldBeActive) {
                member.active = shouldBeActive;
                pendingUpdates.push(index);
            }
        });

        // Optimistic UI update
        if (window.renderGrid) window.renderGrid();
        renderGroupCards();

        if (pendingUpdates.length > 0) {
            await fetch('/api/members/toggle_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ indexes: pendingUpdates })
            });
            await loadMembers();
        }
    } catch (err) {
        console.error("[Groups] Toggle failed:", err);
    }
}

// --- MODAL TRIGGERS ---
function openCreateGroup() {
    currentEditId = null;
    setupGroupModal('Create Group', '', false);
    renderMemberSelectionList([]);
    toggleOverlay('group-editor-overlay', true);
}

function openEditGroup(groupId) {
    currentEditId = groupId;
    const group = customGroups.find(g => g.id === groupId);
    if (!group) return;

    setupGroupModal('Edit Group', group.name, true);
    renderMemberSelectionList(group.members.map(m => m.member_code));
    toggleOverlay('group-editor-overlay', true);
}

// --- SAFE MODAL RENDERING ---
function setupGroupModal(title, inputValue, showDelete) {
    const titleEl = document.getElementById('g-modal-title');
    const inputEl = document.getElementById('g-modal-input');
    const deleteBtn = document.getElementById('g-modal-delete-btn');

    if (titleEl) titleEl.innerText = title;
    if (inputEl) inputEl.value = inputValue;
    if (deleteBtn) deleteBtn.style.display = showDelete ? 'block' : 'none';
}

function renderMemberSelectionList(selectedCodes) {
    const list = document.getElementById('g-modal-member-list');
    if (!list) return;
    list.innerHTML = '';

    memberData.forEach(member => {
        const isSelected = selectedCodes.includes(member.member_code);
        const item = document.createElement('div');
        item.className = `g-member-select-item ${isSelected ? 'selected' : ''}`;
        item.dataset.code = member.member_code;

        item.onclick = () => {
            const nowSelected = item.classList.toggle('selected');
            const icon = item.querySelector('.check-icon');
            if (icon) {
                icon.textContent = nowSelected ? 'check_box' : 'check_box_outline_blank';
                icon.style.color = nowSelected ? 'var(--primary)' : 'var(--text-sub)';
            }
        };

        item.innerHTML = `
            <img src="${getAvatarUrl(member)}" class="g-member-avatar" onerror="this.src='/img/avatars/default.png'" />
            <span class="g-member-name">${member.name}</span>
            <span class="material-symbols-rounded check-icon" style="color: ${isSelected ? 'var(--primary)' : 'var(--text-sub)'}">
                ${isSelected ? 'check_box' : 'check_box_outline_blank'}
            </span>
        `;
        list.appendChild(item);
    });
}

// --- API ACTIONS ---
export async function saveGroup() {
    const input = document.getElementById('g-modal-input');
    const name = input ? input.value.trim() : '';

    if (!name) return triggerSafeAlert("Name Required", "Please enter a group name.");

    const list = document.getElementById('g-modal-member-list');
    const selectedNodes = list ? list.querySelectorAll('.g-member-select-item.selected') : [];
    const member_codes = Array.from(selectedNodes).map(node => node.dataset.code);

    if (member_codes.length < 2) return triggerSafeAlert("Invalid", "Select at least 2 members.");
    if (member_codes.length === memberData.length) return triggerSafeAlert("Invalid", "'All Members' already exists.");

    const isDuplicate = customGroups.some(g =>
        g.id !== currentEditId &&
        g.members.length === member_codes.length &&
        g.members.every(m => member_codes.includes(m.member_code))
    );

    if (isDuplicate) return triggerSafeAlert("Duplicate", "This exact group already exists.");

    const url = currentEditId ? `/api/groups/${currentEditId}` : '/api/groups';
    const method = currentEditId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, member_codes })
        });
        const data = await res.json();

        if (data.success) {
            toggleOverlay('group-editor-overlay', false);
            await loadGroups();
        } else {
            triggerSafeAlert("Error", data.error);
        }
    } catch (err) {
        triggerSafeAlert("Error", "Server connection failed.");
    }
}

export async function deleteCurrentGroup() {
    if (!currentEditId) return;
    try {
        const res = await fetch(`/api/groups/${currentEditId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            toggleOverlay('group-delete-confirm', false);
            toggleOverlay('group-editor-overlay', false);
            await loadGroups();
        }
    } catch (err) {
        triggerSafeAlert("Error", "Deletion failed.");
    }
}

// --- OVERLAY UTILITIES (No body.appendChild!) ---
function toggleOverlay(id, show) {
    const el = document.getElementById(id);
    if (el) {
        if (show) el.classList.add('active');
        else el.classList.remove('active');
    }
}

export function closeGroupModals() {
    toggleOverlay('group-editor-overlay', false);
    toggleOverlay('group-delete-confirm', false);
    toggleOverlay('group-alert-modal', false);
}

function triggerSafeAlert(title, msg) {
    const titleEl = document.getElementById('g-alert-title');
    const msgEl = document.getElementById('g-alert-msg');
    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = msg;
    toggleOverlay('group-alert-modal', true);
}

// Attach to window for static HTML buttons
window.saveGroup = saveGroup;
window.deleteCurrentGroup = deleteCurrentGroup;
window.closeGroupModals = closeGroupModals;
window.promptGroupDelete = () => toggleOverlay('group-delete-confirm', true);