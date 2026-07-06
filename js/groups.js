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
                if (card) openEditGroupModal(parseInt(card.dataset.groupId));
                return;
            }

            const createCard = e.target.closest('.group-card.create-card');
            if (createCard) {
                openCreateGroupModal();
                return;
            }

            const card = e.target.closest('.group-card');
            if (card) {
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
    <button class="group-card all-members-card ${allActiveClass} ${avatarStyleClass}" data-group-id="all" tabindex="0">
        <div class="group-avatars-container">
            ${allAvatarsHtml}
            ${allExcessHtml}
        </div>
        <div class="member-overlay">
            <span class="m-name g-name" style="font-size:1.2rem; font-weight:500;">All Members</span>
            <span class="m-info g-info" style="font-size:0.9rem; opacity:0.8;">${memberData.length} ${memberData.length === 1 ? 'Member' : 'Members'}</span>
        </div>
    </button>`;

    // --- APPEND REGULAR GROUPS ---
    html += groupsData.map((g) => {
        // 1. Get all member codes for this specific group
        const groupMemberCodes = g.members.map(m => m.member_code);

        // 2. Check the real truth in memberData: are ALL of these specific members active right now?
        const isGroupFullyActive = groupMemberCodes.length > 0 && groupMemberCodes.every(code => {
            const actualMember = memberData.find(m => m.member_code === code);
            return actualMember && actualMember.active;
        });

        // 3. If the 'All Members' card is active, regular groups should visually dim out to avoid confusion.
        // Otherwise, this group is active ONLY IF every single member inside it is currently active.
        const activeClass = (isGroupFullyActive && !isAllActive) ? 'active' : 'inactive';

        // BENTO LOGIC: If more than 4 members, make the card span 2 columns!
        const bentoClass = g.members.length > 4 ? 'wide-card' : '';

        const displayMembers = g.members.slice(0, maxAvatars);
        const excessCount = g.members.length - maxAvatars;

        const avatarsHtml = displayMembers.map(m => {
            const url = getAvatarUrl(m);
            return `<img src="${url}" class="group-avatar-stacked" onerror="this.src='/img/avatars/default.png'" loading="lazy">`;
        }).join('');

        const excessHtml = excessCount > 0 ? `<div class="group-avatar-more">+${excessCount}</div>` : '';

        return `
        <button class="group-card ${activeClass} ${avatarStyleClass} ${bentoClass}" data-group-id="${g.id}" tabindex="0">
            <div class="group-edit-btn" title="Edit Group" tabindex="-1">
                <span class="material-symbols-rounded">edit</span>
            </div>
            <div class="group-avatars-container">
                ${avatarsHtml}
                ${excessHtml}
            </div>
            <div class="member-overlay">
                <span class="m-name g-name" style="font-size:1.2rem; font-weight:500;">${g.name}</span>
                <span class="m-info g-info" style="font-size:0.9rem; opacity:0.8;">${g.members.length} ${g.members.length === 1 ? 'Member' : 'Members'}</span>
            </div>
        </button>`;
    }).join('');

    // --- APPEND CREATE CARD ---
    html += `
    <button class="group-card create-card" tabindex="0">
        <span class="material-symbols-rounded">group_add</span>
        <div class="create-label" data-i18n="create_group">Create Group</div>
    </button>`;

    container.innerHTML = html;
    applyTranslations();
}


export async function toggleGroup(groupId) {
    if (!tvState.on) return;
    if (toggleDebounceTimer) return;
    toggleDebounceTimer = timers.setTimeout(() => { toggleDebounceTimer = null; }, 500);

    try {
        // --- 1. DETERMINE CURRENT STATE ---
        let isCurrentlyActive = false;
        let targetGroupCodes = [];

        // Check if the entire board is currently active
        const isAllActive = memberData.length > 0 && memberData.every(m => m.active);

        if (groupId === 'all') {
            isCurrentlyActive = isAllActive;
            if (!isCurrentlyActive) {
                // If it wasn't active, target is EVERYONE
                targetGroupCodes = memberData.map(m => m.member_code);
            }
        } else {
            const group = groupsData.find(g => g.id == groupId);
            if (!group) return;

            const groupMemberCodes = group.members.map(m => m.member_code);

            // Are this specific group's members fully active right now?
            const isGroupFullyActive = groupMemberCodes.length > 0 && groupMemberCodes.every(code => {
                const actualMember = memberData.find(m => m.member_code === code);
                return actualMember && actualMember.active;
            });

            // THE FIX: A custom group is only "active" (ready to be toggled off) 
            // if 'All Members' is NOT currently active.
            isCurrentlyActive = isGroupFullyActive && !isAllActive;

            if (!isCurrentlyActive) {
                // If it wasn't active, target is ONLY THIS GROUP
                targetGroupCodes = groupMemberCodes;
            }
        }

        // --- 2. PREPARE CHANGES & OPTIMISTIC UI UPDATE ---
        const pendingApiIndexes = [];

        for (let i = 0; i < memberData.length; i++) {
            const shouldBeActive = targetGroupCodes.includes(memberData[i].member_code);

            if (memberData[i].active !== shouldBeActive) {
                memberData[i].active = shouldBeActive;
                pendingApiIndexes.push(i);
            }
        }

        // Force the UI to instantly snap to the new state
        if (window.renderGrid) window.renderGrid();
        renderGroupsGrid();

        // --- 3. SAFE BACKGROUND SYNC (BULK) ---
        if (pendingApiIndexes.length > 0) {
            await fetch('/api/members/toggle_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ indexes: pendingApiIndexes })
            });
        }

        // --- 4. FINAL VERIFICATION ---
        await loadMembers();

    } catch (e) {
        console.error("Group toggle failed:", e);
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

    // Snap remote focus to modal
    window.resetRemoteFocus();
}

export function closeGroupModal() {
    const overlay = document.getElementById('group-modal-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }

    // Snap remote focus back to grid
    window.resetRemoteFocus();
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
        showAlertModal("Group Name Required", "Please enter a group name.");
        return;
    }

    // 1. Get selected and total items
    const listContainer = document.getElementById('group-members-list');
    const selectedItems = listContainer ? listContainer.querySelectorAll('.group-member-item.selected') : [];
    const allItems = listContainer ? listContainer.querySelectorAll('.group-member-item') : [];
    const member_codes = Array.from(selectedItems).map(item => item.dataset.code);

    // --- NEW VALIDATIONS ---
    if (member_codes.length < 2) {
        showAlertModal("Invalid Group", "A group must have at least 2 members.");
        return;
    }

    if (member_codes.length === allItems.length) {
        showAlertModal("Invalid Group", "An 'All Members' group already exists. Please select fewer members.");
        return;
    }
    // -----------------------

    // 2. Check for duplicates
    const duplicate = groupsData.find(g =>
        g.id !== editingGroupId &&
        g.members.length === member_codes.length &&
        g.members.every(m => member_codes.includes(m.member_code))
    );

    if (duplicate) {
        showDuplicateModal(duplicate.name);
        return;
    }

    // 3. Save the group
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

export function showAlertModal(title, message) {
    if (document.getElementById('alert-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'alert-modal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; font-family: 'Roboto', sans-serif;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-surface-container-high);
            border-radius: var(--radius-card);
            padding: 32px;
            width: 360px;
            text-align: center;
            border: 1px solid var(--outline-variant);
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        ">
            <span class="material-symbols-rounded" style="font-size: 48px; color: var(--error);">error</span>
            <h2 style="color: var(--text-main); font-size: 1.4rem; font-weight: 500; margin: 16px 0 8px 0;">${title}</h2>
            <p style="color: var(--text-sub); font-size: 1rem; margin: 0; line-height: 1.5;">${message}</p>
            
            <button class="modal-btn" onclick="this.closest('#alert-modal').remove(); window.resetRemoteFocus();" style="
                margin-top: 24px; width: 100%; padding: 14px; border-radius: var(--radius-pill);
                background: var(--surface-variant); color: var(--text-main);
                border: none; font-size: 1rem; font-weight: 500; cursor: pointer;
            ">OK</button>
        </div>
    `;
    document.body.appendChild(modal);
    window.resetRemoteFocus(); // Snap remote focus to this new modal
}

// Find Duplicate Group 
export function showDuplicateModal(groupName) {
    if (document.getElementById('duplicate-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'duplicate-modal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; font-family: 'Roboto', sans-serif;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-surface-container-high);
            border-radius: var(--radius-card);
            padding: 32px;
            width: 360px;
            text-align: center;
            border: 1px solid var(--outline-variant);
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        ">
            <span class="material-symbols-rounded" style="font-size: 48px; color: var(--primary);">info</span>
            <h2 style="color: var(--text-main); font-size: 1.4rem; font-weight: 500; margin: 16px 0 8px 0;">Duplicate Group</h2>
            <p style="color: var(--text-sub); font-size: 1rem; margin: 0; line-height: 1.5;">This exact combination already exists as:<br><b style="color: var(--text-main);">${groupName}</b></p>
            
            <button class="modal-btn" onclick="this.closest('#duplicate-modal').remove(); window.resetRemoteFocus();" style="
                margin-top: 24px; width: 100%; padding: 14px; border-radius: var(--radius-pill);
                background: var(--primary); color: var(--on-primary);
                border: none; font-size: 1rem; font-weight: 500; cursor: pointer;
            ">OK</button>
        </div>
    `;
    document.body.appendChild(modal);
    window.resetRemoteFocus(); // Triggers when modal OPENS
}

// Delete group logic
export function deleteGroup() {
    if (!editingGroupId) return;
    if (document.getElementById('delete-confirm-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'delete-confirm-modal';

    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; font-family: 'Roboto', sans-serif;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-surface-container-high);
            border-radius: var(--radius-card);
            padding: 32px;
            width: 360px;
            text-align: center;
            border: 2px solid rgba(179, 38, 30, 0.4);
            box-shadow: 0 8px 24px rgba(179, 38, 30, 0.15);
            display: flex; flex-direction: column; gap: 16px;
        ">
            <div style="
                background: rgba(179, 38, 30, 0.1);
                width: 64px; height: 64px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                margin: 0 auto;
            ">
                <span class="material-symbols-rounded" style="font-size: 32px; color: #ff5252; font-weight: bold;">delete</span>
            </div>
            
            <h2 style="color: var(--text-main); font-size: 1.4rem; font-weight: 500; margin: 0;">Delete Group</h2>
            <p style="color: var(--text-sub); font-size: 1rem; margin: 0; line-height: 1.5;">Are you sure? This action cannot be undone.</p>
            
            <div style="display: flex; gap: var(--gap); margin-top: 16px;">
                <button class="modal-btn" onclick="closeDeleteModal()" style="
                    flex: 1; padding: 14px; border-radius: var(--radius-pill);
                    background: var(--surface-variant); color: var(--text-main);
                    border: none; font-size: 1rem; font-weight: 500; cursor: pointer;
                ">Cancel</button>
                
                <button class="modal-btn" onclick="executeDelete()" style="
                    flex: 1; padding: 14px; border-radius: var(--radius-pill);
                    background: rgba(179, 38, 30, 0.8); color: #fff;
                    border: none; font-size: 1rem; font-weight: 500; cursor: pointer;
                ">Delete</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

export function closeDeleteModal() {
    const modal = document.getElementById('delete-confirm-modal');
    if (modal) {
        modal.remove();
        window.resetRemoteFocus(); // Triggers when modal CLOSES (via cancel)
    }
}

export async function executeDelete() {
    if (!editingGroupId) return;

    try {
        const r = await fetch(`/api/groups/${editingGroupId}`, { method: 'DELETE' });
        const res = await r.json();

        if (res.success) {
            closeDeleteModal();
            closeGroupModal();
            await loadGroups();
            window.resetRemoteFocus(); // Triggers after successful deletion
        } else {
            console.error("Failed to delete group: " + res.error);
            closeDeleteModal();
        }
    } catch (e) {
        console.error("Delete group failed:", e);
        closeDeleteModal();
    }
}

// Window/global exposed triggers
window.renderGroupsGrid = renderGroupsGrid;
window.closeGroupModal = closeGroupModal;
window.submitGroup = submitGroup;
window.deleteGroup = deleteGroup;
window.closeDeleteModal = closeDeleteModal;
window.executeDelete = executeDelete;

window.updateTvUI_groups = function (tvOn) {
    const overlay = document.getElementById('tv-off-overlay-groups');
    if (overlay) {
        overlay.style.display = tvOn ? 'none' : 'flex';
    }
}