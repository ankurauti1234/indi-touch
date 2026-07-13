import { config, memberData, tvState, loadMembers, getAvatarUrl } from './data.js';
import { applyTranslations } from './i18n.js';
import { timers } from './utils.js';
import { renderGrid } from './grid.js';

export let groupsData = [];
let toggleDebounceTimer = null;
let editingGroupId = null;
let syncObserverInitialized = false;

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

// --- TWO-WAY SYNC ENGINE (FIXED RACING CONDITION) ---
function initTwoWaySync() {
    if (syncObserverInitialized) return;
    const gridContainer = document.getElementById('grid-container');
    if (!gridContainer) return;

    const observer = new MutationObserver((mutations) => {
        let needsSync = false;
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'class' && m.target.classList?.contains('member-card')) {
                const oldClass = m.oldValue || '';
                const newClass = m.target.className || '';

                // THE FIX: Strip out the focus classes before comparing.
                // If only the focus ring changed, the clean strings will match, and we IGNORE the change!
                const cleanOld = oldClass.replace(/remoteFocused|focused/g, '').replace(/\s+/g, ' ').trim();
                const cleanNew = newClass.replace(/remoteFocused|focused/g, '').replace(/\s+/g, ' ').trim();

                if (cleanOld !== cleanNew) {
                    needsSync = true;
                    break;
                }
            }
        }

        if (needsSync) {
            if (window._groupSyncTimer) clearTimeout(window._groupSyncTimer);
            window._groupSyncTimer = setTimeout(() => {
                renderGroupsGrid();
            }, 50);
        }
    });

    // We MUST include attributeOldValue: true so we can compare the before and after states
    observer.observe(gridContainer, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class'],
        attributeOldValue: true
    });
    syncObserverInitialized = true;
}

export function renderGroupsGrid() {
    const container = document.getElementById('groups-grid-container');
    if (!container) return;
    container.innerHTML = '';

    initTwoWaySync();

    const maxAvatars = 4;
    const avatarStyleClass = (config.avatarStyle || 'local') === 'local' ? 'local-avatar' : '';

    const activeMemberCodes = memberData.filter(m => m.active).map(m => m.member_code);

    // --- 1. "ALL MEMBERS" CARD ---
    const isAllActive = memberData.length > 0 && activeMemberCodes.length === memberData.length;
    const displayAllMembers = memberData.slice(0, maxAvatars);
    const excessAllCount = memberData.length - maxAvatars;

    let allAvatarsHtml = displayAllMembers.map(m =>
        `<img src="${getAvatarUrl(m)}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`
    ).join('');
    if (excessAllCount > 0) allAvatarsHtml += `<div class="group-avatar-more">+${excessAllCount}</div>`;

    const allMembersCard = document.createElement('button');
    allMembersCard.className = `group-card all-members-card ${isAllActive ? 'active' : 'inactive'} ${avatarStyleClass}`;

    // Strict HTML ID for remote tracking
    allMembersCard.id = 'group-card-all';

    allMembersCard.onclick = () => toggleGroup('all');
    allMembersCard.innerHTML = `
        <div class="group-avatars-container">${allAvatarsHtml}</div>
        <div class="member-overlay">
            <span class="m-name g-name">All Members</span>
            <span class="m-info g-info">${memberData.length} ${memberData.length === 1 ? 'Member' : 'Members'}</span>
        </div>
    `;
    container.appendChild(allMembersCard);

    // --- 2. REGULAR GROUP CARDS ---
    groupsData.forEach((g) => {
        const groupCodes = g.members.map(m => m.member_code);

        const isGroupFullyActive = activeMemberCodes.length > 0 &&
            activeMemberCodes.length === groupCodes.length &&
            groupCodes.every(code => activeMemberCodes.includes(code));

        const activeClass = isGroupFullyActive ? 'active' : 'inactive';
        const bentoClass = g.members.length > 4 ? 'wide-card' : '';
        const displayMembers = g.members.slice(0, maxAvatars);
        const excessCount = g.members.length - maxAvatars;

        let avatarsHtml = displayMembers.map(m =>
            `<img src="${getAvatarUrl(m)}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`
        ).join('');
        if (excessCount > 0) avatarsHtml += `<div class="group-avatar-more">+${excessCount}</div>`;

        const card = document.createElement('button');
        card.className = `group-card ${activeClass} ${avatarStyleClass} ${bentoClass}`;

        // Strict HTML ID for remote tracking
        card.id = `group-card-${g.id}`;

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

    // --- 3. CREATE CARD ---
    const createCard = document.createElement('button');
    createCard.className = 'group-card create-card';
    createCard.onclick = openCreateGroupModal;
    createCard.innerHTML = `
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    `;
    container.appendChild(createCard);

    applyTranslations();

    // THE ASYNC RE-ATTACH FIX
    // After wiping the DOM, gently tell the remote engine to glue the focus ring back on
    requestAnimationFrame(() => {
        const focused = document.querySelector('.remoteFocused');

        if (
            focused &&
            (focused.classList.contains('group-card') ||
                focused.classList.contains('group-edit-btn'))
        ) {
            window.reclaimRemoteFocus?.();
        }
    });
}

export async function toggleGroup(groupId) {
    if (!tvState.on) return;
    if (toggleDebounceTimer) return;
    toggleDebounceTimer = timers.setTimeout(() => { toggleDebounceTimer = null; }, 500);

    try {
        let targetGroupCodes = [];
        const activeMemberCodes = memberData.filter(m => m.active).map(m => m.member_code);

        if (groupId === 'all') {
            const isAllActive = activeMemberCodes.length === memberData.length;
            if (!isAllActive) targetGroupCodes = memberData.map(m => m.member_code);
        } else {
            const group = groupsData.find(g => g.id == groupId);
            if (!group) return;

            const groupCodes = group.members.map(m => m.member_code);
            const isCurrentlyActive = activeMemberCodes.length === groupCodes.length &&
                groupCodes.every(code => activeMemberCodes.includes(code));

            if (!isCurrentlyActive) targetGroupCodes = groupCodes;
        }

        const pendingApiIndexes = [];
        for (let i = 0; i < memberData.length; i++) {
            const shouldBeActive = targetGroupCodes.includes(memberData[i].member_code);
            if (memberData[i].active !== shouldBeActive) {
                memberData[i].active = shouldBeActive;
                pendingApiIndexes.push(i);
            }
        }

        // renderGrid();
        // renderGroupsGrid();

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

// --- MODAL & UI LOGIC ---
export async function openCreateGroupModal() {
    editingGroupId = null;
    document.getElementById('group-modal-title').setAttribute('data-i18n', 'create_group');
    document.getElementById('group-name-input').value = '';
    document.getElementById('btn-group-delete').style.display = 'none';

    await renderMembersSelectionList([]);
    toggleOverlay('group-editor-overlay', true);
    applyTranslations();
}

export async function openEditGroupModal(groupId) {
    editingGroupId = groupId;
    const group = groupsData.find(g => g.id === groupId);
    if (!group) return;

    document.getElementById('group-modal-title').setAttribute('data-i18n', 'edit_group');
    document.getElementById('group-name-input').value = group.name;
    document.getElementById('btn-group-delete').style.display = 'block';

    await renderMembersSelectionList(group.members.map(m => m.member_code) || []);
    toggleOverlay('group-editor-overlay', true);
    applyTranslations();
}

async function renderMembersSelectionList(selectedCodes = []) {
    const listContainer = document.getElementById('group-members-list');
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
            <span class="material-symbols-rounded check-icon" style="font-size: 32px;">
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

export async function submitGroup() {
    const nameInput = document.getElementById('group-name-input');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        showAlertModal("Group Name Required", "Please enter a group name.");
        return;
    }

    const listContainer = document.getElementById('group-members-list');
    const selectedItems = listContainer ? listContainer.querySelectorAll('.g-member-select-item.selected') : [];
    const allItems = listContainer ? listContainer.querySelectorAll('.g-member-select-item') : [];
    const member_codes = Array.from(selectedItems).map(item => item.dataset.code);

    if (member_codes.length < 2) {
        showAlertModal("Invalid Group", "A group must have at least 2 members.");
        return;
    }

    if (member_codes.length === allItems.length) {
        showAlertModal("Invalid Group", "An 'All Members' group already exists. Please select fewer members.");
        return;
    }

    const duplicate = groupsData.find(g =>
        g.id !== editingGroupId &&
        g.members.length === member_codes.length &&
        g.members.every(m => member_codes.includes(m.member_code))
    );

    if (duplicate) {
        showAlertModal("Duplicate Group", `This exact combination already exists as: ${duplicate.name}`);
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
            closeGroupModals();
            await loadMembers();
            await loadGroups();
        } else {
            showAlertModal("Save Failed", res.error || "An unknown error occurred.");
        }
    } catch (e) {
        console.error("Save group failed:", e);
        showAlertModal("Connection Error", "Failed to communicate with the server.");
    }
}

// --- OVERLAY UTILITIES (No Body Appending) ---
export function showAlertModal(title, message) {
    const titleEl = document.getElementById('g-alert-title');
    const msgEl = document.getElementById('g-alert-msg');
    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    toggleOverlay('group-alert-modal', true);
}

export function promptGroupDelete() {
    toggleOverlay('group-delete-confirm', true);
}

export async function executeDelete() {
    if (!editingGroupId) return;
    try {
        const r = await fetch(`/api/groups/${editingGroupId}`, { method: 'DELETE' });
        const res = await r.json();
        if (res.success) {
            closeGroupModals();
            await loadGroups();
        }
    } catch (e) {
        console.error("Delete failed:", e);
    }
}

function toggleOverlay(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (show) {
        el.style.display = 'flex';
        timers.setTimeout(() => el.classList.add('active'), 10);
    } else {
        el.classList.remove('active');
        timers.setTimeout(() => el.style.display = 'none', 200);
    }
}

export function closeGroupModals() {
    toggleOverlay('group-editor-overlay', false);
    toggleOverlay('group-delete-confirm', false);
    toggleOverlay('group-alert-modal', false);
}
export function closeAlertModal() {
    const el = document.getElementById('group-alert-modal');
    if (el) {
        el.classList.remove('active');
        timers.setTimeout(() => el.style.display = 'none', 200);
    }
}

// Expose globals for static HTML event binding
window.submitGroup = submitGroup;
window.saveGroup = submitGroup;
window.closeGroupModals = closeGroupModals;
window.closeAlertModal = closeAlertModal;
window.promptGroupDelete = promptGroupDelete;
window.executeDelete = executeDelete;
window.deleteCurrentGroup = executeDelete;
window.renderGroupsGrid = renderGroupsGrid;