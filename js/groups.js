import { config, memberData, tvState, loadMembers, getAvatarUrl } from './data.js';
import { applyTranslations } from './i18n.js';
import { timers } from './utils.js';

export let groupsData = [];
let toggleDebounceTimer = null;
let editingGroupId = null;

// --- INITIALIZER ---
export async function loadGroups() {
    try {
        const r = await fetch('/api/groups');
        const d = await r.json();
        if (d.success) {
            groupsData = d.groups || [];
            renderGroupsGrid();
        }
    } catch (e) {
        console.error("Failed to load groups:", e);
    }
}

// --- CORE GRID BUILDER ---
export function renderGroupsGrid() {
    const container = document.getElementById('groups-grid-container');
    if (!container) return;

    container.innerHTML = '';
    const maxAvatars = 4;
    const avatarStyleClass = (config.avatarStyle || 'local') === 'local' ? 'local-avatar' : '';

    // 1. "All Members" Card (Always spans 2 columns at the top)
    const isAllActive = memberData.length > 0 && memberData.every(m => m.active);
    const displayAllMembers = memberData.slice(0, maxAvatars);
    const excessAllCount = memberData.length - maxAvatars;

    let allAvatarsHtml = displayAllMembers.map(m =>
        `<img src="${getAvatarUrl(m)}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`
    ).join('');
    if (excessAllCount > 0) allAvatarsHtml += `<div class="group-avatar-more">+${excessAllCount}</div>`;

    const allMembersCard = document.createElement('button');
    allMembersCard.className = `group-card all-members-card ${isAllActive ? 'active' : 'inactive'} ${avatarStyleClass}`;
    allMembersCard.onclick = () => toggleGroup('all');
    allMembersCard.innerHTML = `
        <div class="group-avatars-container">${allAvatarsHtml}</div>
        <div class="member-overlay">
            <span class="m-name g-name">All Members</span>
            <span class="m-info g-info">${memberData.length} ${memberData.length === 1 ? 'Member' : 'Members'}</span>
        </div>
    `;
    container.appendChild(allMembersCard);

    // 2. Custom Rendered Groups
    groupsData.forEach((g) => {
        const groupMemberCodes = g.members.map(m => m.member_code);
        const isGroupFullyActive = groupMemberCodes.length > 0 && groupMemberCodes.every(code => {
            const actualMember = memberData.find(m => m.member_code === code);
            return actualMember && actualMember.active;
        });

        const activeClass = (isGroupFullyActive && !isAllActive) ? 'active' : 'inactive';
        const bentoClass = g.members.length > 4 ? 'wide-card' : '';
        const displayMembers = g.members.slice(0, maxAvatars);
        const excessCount = g.members.length - maxAvatars;

        let avatarsHtml = displayMembers.map(m =>
            `<img src="${getAvatarUrl(m)}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`
        ).join('');
        if (excessCount > 0) avatarsHtml += `<div class="group-avatar-more">+${excessCount}</div>`;

        const card = document.createElement('button');
        card.className = `group-card ${activeClass} ${avatarStyleClass} ${bentoClass}`;
        card.onclick = (e) => {
            if (e.target.closest('.group-edit-btn')) {
                openEditGroupModal(g.id);
                return;
            }
            toggleGroup(g.id);
        };

        card.innerHTML = `
            <div class="group-edit-btn" title="Edit Group">
                <span class="material-symbols-rounded">edit</span>
            </div>
            <div class="group-avatars-container">${avatarsHtml}</div>
            <div class="member-overlay">
                <span class="m-name g-name">${g.name}</span>
                <span class="m-info g-info">${g.members.length} ${g.members.length === 1 ? 'Member' : 'Members'}</span>
            </div>
        `;
        container.appendChild(card);
    });

    // 3. "Create Group" Card
    const createCard = document.createElement('button');
    createCard.className = 'group-card create-card';
    createCard.onclick = () => openCreateGroupModal();
    createCard.innerHTML = `
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    `;
    container.appendChild(createCard);

    applyTranslations();
}

// --- TOGGLE ACTIONS ---
export async function toggleGroup(groupId) {
    if (!tvState.on || toggleDebounceTimer) return;
    toggleDebounceTimer = timers.setTimeout(() => { toggleDebounceTimer = null; }, 500);

    try {
        let isCurrentlyActive = false;
        let targetGroupCodes = [];
        const isAllActive = memberData.length > 0 && memberData.every(m => m.active);

        if (groupId === 'all') {
            isCurrentlyActive = isAllActive;
            if (!isCurrentlyActive) targetGroupCodes = memberData.map(m => m.member_code);
        } else {
            const group = groupsData.find(g => g.id == groupId);
            if (!group) return;

            const groupMemberCodes = group.members.map(m => m.member_code);
            const isGroupFullyActive = groupMemberCodes.length > 0 && groupMemberCodes.every(code => {
                const actualMember = memberData.find(m => m.member_code === code);
                return actualMember && actualMember.active;
            });

            isCurrentlyActive = isGroupFullyActive && !isAllActive;
            if (!isCurrentlyActive) targetGroupCodes = groupMemberCodes;
        }

        const pendingApiIndexes = [];
        for (let i = 0; i < memberData.length; i++) {
            const shouldBeActive = targetGroupCodes.includes(memberData[i].member_code);
            if (memberData[i].active !== shouldBeActive) {
                memberData[i].active = shouldBeActive;
                pendingApiIndexes.push(i);
            }
        }

        if (window.renderGrid) window.renderGrid();
        renderGroupsGrid();

        if (pendingApiIndexes.length > 0) {
            await fetch('/api/members/toggle_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ indexes: pendingApiIndexes })
            });
        }
        await loadMembers();
    } catch (e) {
        console.error("Group toggle failed:", e);
    }
}

// --- MODAL MANAGEMENT ---
export async function openCreateGroupModal() {
    editingGroupId = null;
    setupStaticModalState("create_group", "", false);
    await renderMembersSelectionList([]);
    toggleOverlay('group-editor-overlay', true);
}

export async function openEditGroupModal(groupId) {
    editingGroupId = groupId;
    const group = groupsData.find(g => g.id === groupId);
    if (!group) return;

    setupStaticModalState("edit_group", group.name, true);
    const checkedCodes = group.members ? group.members.map(m => m.member_code) : [];
    await renderMembersSelectionList(checkedCodes);
    toggleOverlay('group-editor-overlay', true);
}

function setupStaticModalState(i18nKey, nameVal, showDelete) {
    const titleEl = document.getElementById('g-modal-title');
    const nameInput = document.getElementById('g-modal-input');
    const deleteBtn = document.getElementById('g-modal-delete-btn');

    if (titleEl) titleEl.setAttribute('data-i18n', i18nKey);
    if (nameInput) nameInput.value = nameVal;
    if (deleteBtn) deleteBtn.style.display = showDelete ? 'block' : 'none';
    applyTranslations();
}

async function renderMembersSelectionList(selectedCodes = []) {
    const listContainer = document.getElementById('g-modal-member-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const allMembers = memberData.length > 0 ? memberData : await loadMembers();

    allMembers.forEach(member => {
        const isSelected = selectedCodes.includes(member.member_code);
        const item = document.createElement('div');
        item.className = `g-member-select-item ${isSelected ? 'selected' : ''}`;
        item.dataset.code = member.member_code;

        item.innerHTML = `
            <img src="${getAvatarUrl(member)}" class="g-member-avatar" onerror="this.src='/img/avatars/default.png'" />
            <span class="g-member-name">${member.name}</span>
            <span class="material-symbols-rounded check-icon">
                ${isSelected ? 'check_box' : 'check_box_outline_blank'}
            </span>
        `;

        item.onclick = () => {
            const nowSelected = item.classList.toggle('selected');
            const icon = item.querySelector('.check-icon');
            if (icon) {
                icon.textContent = nowSelected ? 'check_box' : 'check_box_outline_blank';
            }
        };
        listContainer.appendChild(item);
    });
}

// --- SUBMIT / VALIDATIONS ---
export async function saveGroup() {
    const nameInput = document.getElementById('g-modal-input');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        showFeedbackAlert("Name Required", "Please enter a group name.");
        return;
    }

    const listContainer = document.getElementById('g-modal-member-list');
    const selectedItems = listContainer ? listContainer.querySelectorAll('.g-member-select-item.selected') : [];
    const allItems = listContainer ? listContainer.querySelectorAll('.g-member-select-item') : [];
    const member_codes = Array.from(selectedItems).map(item => item.dataset.code);

    // CRITICAL CONDITIONAL VALIDATIONS
    if (member_codes.length < 2) {
        showFeedbackAlert("Invalid Group", "A group must have at least 2 members.");
        return;
    }
    if (member_codes.length === allItems.length) {
        showFeedbackAlert("Invalid Group", "An 'All Members' group already exists. Please select fewer members.");
        return;
    }

    // DUPLICATE MEMBER COMBINATION DETECTION
    const duplicate = groupsData.find(g =>
        g.id !== editingGroupId &&
        g.members.length === member_codes.length &&
        g.members.every(m => member_codes.includes(m.member_code))
    );
    if (duplicate) {
        showFeedbackAlert("Duplicate Group", `This exact combination already exists as: ${duplicate.name}`);
        return;
    }

    const url = editingGroupId ? `/api/groups/${editingGroupId}` : '/api/groups';
    const method = editingGroupId ? 'PUT' : 'POST';

    try {
        const r = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, member_codes })
        });
        const res = await r.json();
        if (res.success) {
            toggleOverlay('group-editor-overlay', false);
            await loadMembers();
            await loadGroups();
        } else {
            showFeedbackAlert("Save Failed", res.error || "An unknown error occurred.");
        }
    } catch (e) {
        showFeedbackAlert("Connection Error", "Failed to communicate with the server.");
    }
}

// --- DESTRUCTION TRIGGERS ---
export function promptGroupDelete() {
    toggleOverlay('group-delete-confirm', true);
}

export async function deleteCurrentGroup() {
    if (!editingGroupId) return;
    try {
        const r = await fetch(`/api/groups/${editingGroupId}`, { method: 'DELETE' });
        const res = await r.json();
        if (res.success) {
            toggleOverlay('group-delete-confirm', false);
            toggleOverlay('group-editor-overlay', false);
            await loadGroups();
        }
    } catch (e) {
        console.error("Delete tracking failure", e);
    }
}

// --- FEEDBACK LAYER ---
function showFeedbackAlert(title, message) {
    const titleEl = document.getElementById('g-alert-title');
    const msgEl = document.getElementById('g-alert-msg');
    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    toggleOverlay('group-alert-modal', true);
}

function toggleOverlay(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (show) el.classList.add('active');
    else el.classList.remove('active');
}

export function closeGroupModals() {
    toggleOverlay('group-editor-overlay', false);
    toggleOverlay('group-delete-confirm', false);
    toggleOverlay('group-alert-modal', false);
}

// Expose safely for template execution
window.saveGroup = saveGroup;
window.closeGroupModals = closeGroupModals;
window.promptGroupDelete = promptGroupDelete;
window.deleteCurrentGroup = deleteCurrentGroup;
window.renderGroupsGrid = renderGroupsGrid;