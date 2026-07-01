/* js/groups.js */

import { config, memberData, tvState, loadMembers, getAvatarUrl } from './data.js';
import { t, applyTranslations } from './i18n.js';
import { timers } from './utils.js';
import { renderGrid } from './grid.js';

export let groupsData = [];
let toggleDebounceTimer = null;
let editingGroupId = null;

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

export function renderGroupsGrid() {
    const container = document.getElementById('groups-grid-container');
    if (!container) return;

    if (!container._delegated) {
        container.addEventListener('click', (e) => {
            const editBtn = e.target.closest('.group-edit-btn');
            if (editBtn) {
                e.stopPropagation();
                const card = editBtn.closest('.group-card');
                if (card) {
                    const id = parseInt(card.dataset.groupId);
                    openEditGroupModal(id);
                }
                return;
            }

            const createCard = e.target.closest('.group-card.create-card');
            if (createCard) {
                openCreateGroupModal();
                return;
            }

            const card = e.target.closest('.group-card');
            if (card) {
                // Check if it's the "all" string, otherwise parse it as an ID
                let id = card.dataset.groupId;
                if (id !== 'all') id = parseInt(id);
                toggleGroup(id);
            }
        });
        container._delegated = true;
    }

    const style = config.avatarStyle || 'local';
    const avatarStyleClass = style === 'local' ? 'local-avatar' : '';

    // --- BUILD THE "ALL MEMBERS" CARD FIRST ---
    // Check if every single member is active
    const isAllActive = memberData.length > 0 && memberData.every(m => m.active);
    const allActiveClass = isAllActive ? 'active' : 'inactive';

    const maxAvatars = 4;
    const displayAllMembers = memberData.slice(0, maxAvatars);
    const excessAllCount = memberData.length - maxAvatars;

    const allAvatarsHtml = displayAllMembers.map(m => {
        const url = getAvatarUrl(m);
        return `<img src="${url}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`;
    }).join('');

    const allExcessHtml = excessAllCount > 0 ? `<div class="group-avatar-more">+${excessAllCount}</div>` : '';

    let html = `
    <div class="group-card all-members-card ${allActiveClass} ${avatarStyleClass}" data-group-id="all">
        <div class="group-avatars-container">
            ${allAvatarsHtml}
            ${allExcessHtml}
        </div>
        <div class="member-overlay">
            <span class="m-name g-name" style="font-size:1.2rem; font-weight:500;">All Members</span>
            <span class="m-info g-info" style="font-size:0.9rem; opacity:0.8;">${memberData.length} ${memberData.length === 1 ? 'Member' : 'Members'}</span>
        </div>
    </div>`;

    // --- APPEND REGULAR GROUPS ---
    html += groupsData.map((g) => {
        // If the 'All' card is active, regular groups should visually appear inactive
        const activeClass = (g.active && !isAllActive) ? 'active' : 'inactive';

        const displayMembers = g.members.slice(0, maxAvatars);
        const excessCount = g.members.length - maxAvatars;

        const avatarsHtml = displayMembers.map(m => {
            const url = getAvatarUrl(m);
            return `<img src="${url}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`;
        }).join('');

        const excessHtml = excessCount > 0 ? `<div class="group-avatar-more">+${excessCount}</div>` : '';

        return `
        <div class="group-card ${activeClass} ${avatarStyleClass}" data-group-id="${g.id}">
            <button class="group-edit-btn" title="Edit Group">
                <span class="material-symbols-rounded">edit</span>
            </button>
            <div class="group-avatars-container">
                ${avatarsHtml}
                ${excessHtml}
            </div>
            <div class="member-overlay">
                <span class="m-name g-name" style="font-size:1.2rem; font-weight:500;">${g.name}</span>
                <span class="m-info g-info" style="font-size:0.9rem; opacity:0.8;">${g.members.length} ${g.members.length === 1 ? 'Member' : 'Members'}</span>
            </div>
        </div>`;
    }).join('');

    // --- APPEND CREATE CARD ---
    html += `
    <div class="group-card create-card">
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    </div>`;

    container.innerHTML = html;
    applyTranslations();
}


export async function toggleGroup(groupId) {
    if (!tvState.on) return;
    if (toggleDebounceTimer) return;
    toggleDebounceTimer = timers.setTimeout(() => { toggleDebounceTimer = null; }, 500);

    // --- 1. VISUALLY UPDATE ALL GROUP CARDS INSTANTLY ---
    groupsData.forEach(g => {
        g.active = (g.id === groupId);
    });

    const allCards = document.querySelectorAll('.group-card:not(.create-card)');
    allCards.forEach(card => {
        // Use double equals (==) so the string 'all' or integer IDs match easily
        if (card.dataset.groupId == groupId) {
            card.classList.remove('inactive');
            card.classList.add('active');
        } else {
            card.classList.remove('active');
            card.classList.add('inactive');
        }
    });

    // --- 2. LOGICAL MATCHING & SYNCING ---
    try {
        if (groupId === 'all') {
            // "ALL MEMBERS" LOGIC: Turn every single member ON
            for (let globalIndex = 0; globalIndex < memberData.length; globalIndex++) {
                const actualMember = memberData[globalIndex];
                if (!actualMember.active) {
                    actualMember.active = true;
                    await fetch('/api/members/toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ index: globalIndex })
                    });
                }
            }
        } else {
            // REGULAR GROUP LOGIC: Isolate the group
            const group = groupsData.find(g => g.id == groupId);
            if (!group) return;
            const groupMemberCodes = group.members.map(m => m.member_code);

            for (let globalIndex = 0; globalIndex < memberData.length; globalIndex++) {
                const actualMember = memberData[globalIndex];
                const isMemberInGroup = groupMemberCodes.includes(actualMember.member_code);

                if (isMemberInGroup && !actualMember.active) {
                    actualMember.active = true;
                    await fetch('/api/members/toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ index: globalIndex })
                    });
                } else if (!isMemberInGroup && actualMember.active) {
                    actualMember.active = false;
                    await fetch('/api/members/toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ index: globalIndex })
                    });
                }
            }
        }

        // --- 3. REFRESH MAIN GRID VISUALS ---
        if (window.renderGrid) window.renderGrid();

        // Final truth sync from the database to ensure UI is perfect
        await loadMembers();

    } catch (e) {
        console.error("Group exclusive alignment failed:", e);
    }
}

// Modal management
export async function openCreateGroupModal() {
    editingGroupId = null;

    const titleEl = document.getElementById('group-modal-title');
    const nameInput = document.getElementById('group-name-input');
    const deleteBtn = document.getElementById('btn-group-delete');

    if (titleEl) titleEl.setAttribute('data-i18n', 'create_group');
    if (nameInput) nameInput.value = '';
    if (deleteBtn) deleteBtn.style.display = 'none';

    await renderMembersSelectionList([]);

    const overlay = document.getElementById('group-modal-overlay');
    if (overlay) {
        overlay.classList.add('active');
    }
    applyTranslations();
}

export async function openEditGroupModal(groupId) {
    editingGroupId = groupId;
    const group = groupsData.find(g => g.id === groupId);
    if (!group) return;

    const titleEl = document.getElementById('group-modal-title');
    const nameInput = document.getElementById('group-name-input');
    const deleteBtn = document.getElementById('btn-group-delete');

    if (titleEl) titleEl.setAttribute('data-i18n', 'edit_group');
    if (nameInput) nameInput.value = group.name;
    if (deleteBtn) deleteBtn.style.display = 'block';

    await renderMembersSelectionList(group.member_codes || []);

    const overlay = document.getElementById('group-modal-overlay');
    if (overlay) {
        overlay.classList.add('active');
    }
    applyTranslations();
}

export function closeGroupModal() {
    const overlay = document.getElementById('group-modal-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

async function renderMembersSelectionList(selectedCodes = []) {
    const listContainer = document.getElementById('group-members-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const allMembers = memberData.length > 0 ? memberData : await loadMembers();

    allMembers.forEach(member => {
        const isSelected = selectedCodes.includes(member.member_code);
        const item = document.createElement('div');
        item.className = `group-member-item ${isSelected ? 'selected' : ''}`;
        item.dataset.code = member.member_code;

        const avatarUrl = getAvatarUrl(member);
        item.innerHTML = `
            <img src="${avatarUrl}" class="group-member-avatar" onerror="this.src='/img/avatars/default.png'" />
            <span class="group-member-name">${member.name}</span>
            <span class="material-symbols-rounded check-icon">${isSelected ? 'check_box' : 'check_box_outline_blank'}</span>
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
        alert("Please enter a group name");
        return;
    }

    const listContainer = document.getElementById('group-members-list');
    const selectedItems = listContainer ? listContainer.querySelectorAll('.group-member-item.selected') : [];
    const member_codes = Array.from(selectedItems).map(item => item.dataset.code);

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
            closeGroupModal();
            // Reload all members just in case (updates dynamic state)
            await loadMembers();
            // Reload and render groups grid
            await loadGroups();
        } else {
            alert("Failed to save group: " + res.error);
        }
    } catch (e) {
        console.error("Save group failed:", e);
    }
}

export async function deleteGroup() {
    if (!editingGroupId) return;

    if (!confirm("Are you sure you want to delete this group?")) {
        return;
    }

    try {
        const r = await fetch(`/api/groups/${editingGroupId}`, {
            method: 'DELETE'
        });
        const res = await r.json();
        if (res.success) {
            closeGroupModal();
            // Reload and render groups grid
            await loadGroups();
        } else {
            alert("Failed to delete group: " + res.error);
        }
    } catch (e) {
        console.error("Delete group failed:", e);
    }
}

// Window/global exposed triggers
window.renderGroupsGrid = renderGroupsGrid;
window.closeGroupModal = closeGroupModal;
window.submitGroup = submitGroup;
window.deleteGroup = deleteGroup;

window.updateTvUI_groups = function (tvOn) {
    const overlay = document.getElementById('tv-off-overlay-groups');
    if (overlay) {
        overlay.style.display = tvOn ? 'none' : 'flex';
    }
}
