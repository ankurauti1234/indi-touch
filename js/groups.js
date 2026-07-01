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

    // 1. Setup delegation if not already done
    if (!container._delegated) {
        container.addEventListener('click', (e) => {
            // Check if edit button was clicked
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

            // Check if create card was clicked
            const createCard = e.target.closest('.group-card.create-card');
            if (createCard) {
                openCreateGroupModal();
                return;
            }

            // Check if normal group card was clicked
            const card = e.target.closest('.group-card');
            if (card) {
                const id = parseInt(card.dataset.groupId);
                toggleGroup(id);
            }
        });
        container._delegated = true;
    }

    const count = groupsData.length;
    const style = config.avatarStyle || 'local';

    // Same grid size calculation as members grid, but we include 1 extra slot for the "+" card
    const totalSlots = count + 1;
    let rows = 1;
    if (totalSlots > 3) rows = 2;
    if (totalSlots > 8) rows = 3;
    const cols = Math.ceil(totalSlots / rows);

    container.style.setProperty('--cols', cols);
    container.style.setProperty('--rows', rows);

    const avatarStyleClass = style === 'local' ? 'local-avatar' : '';

    // Build the grid HTML
    let html = groupsData.map((g) => {
        const activeClass = g.active ? 'active' : 'inactive';

        // Render stacked avatars
        const maxAvatars = 4;
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

    // Append the special dashed "+" create group card at the end
    html += `
    <div class="group-card create-card">
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    </div>`;

    container.innerHTML = html;

    // Apply translations to the newly generated "+" card and other static text
    applyTranslations();
}

import { renderGrid } from './grid.js';

export async function toggleGroup(groupId) {
    if (!tvState.on) return;
    if (toggleDebounceTimer) return;
    toggleDebounceTimer = timers.setTimeout(() => { toggleDebounceTimer = null; }, 500);

    // --- 1. VISUALLY UPDATE THE GROUP CARDS ---
    // Update the local data so it remembers this group is active
    groupsData.forEach(g => {
        if (g.id === groupId) {
            g.active = true;  // Turn clicked group ON
        } else {
            g.active = false; // Turn others OFF
        }
    });

    // Instantly update the CSS so the card lights up immediately
    const allCards = document.querySelectorAll('.group-card:not(.create-card)');
    allCards.forEach(card => {
        const cardId = parseInt(card.dataset.groupId);
        if (cardId === groupId) {
            card.classList.remove('inactive');
            card.classList.add('active');
        } else {
            card.classList.remove('active');
            card.classList.add('inactive');
        }
    });

    // --- 2. SAFELY ACTIVATE THE MEMBERS ---
    const group = groupsData.find(g => g.id === groupId);
    if (!group) return;

    try {
        for (const groupMember of group.members) {
            // Find this specific member in the main data
            const globalIndex = memberData.findIndex(m => m.member_code === groupMember.member_code);

            if (globalIndex !== -1) {
                const actualMember = memberData[globalIndex];

                // ONLY activate if they are currently OFF. 
                // This guarantees we never accidentally deactivate someone!
                if (!actualMember.active) {

                    actualMember.active = true; // Update local state for speed

                    // Tell backend to flip them ON
                    await fetch('/api/members/toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ index: globalIndex })
                    });
                }
            }
        }

        // --- 3. REFRESH MAIN GRID VISUALS ---
        renderGrid();

        // Fetch final safe state from server
        await loadMembers();

    } catch (e) {
        console.error("Group member activation failed:", e);
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
