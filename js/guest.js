import { t } from './i18n.js';
import { showModal } from './ui.js';
import { guests, loadGuests, getAvatarUrl } from './data.js';

let currentDuration = "24 Hour";
let currentGender = "Male";

export function selectChip(el, type) {
    const group = el.parentElement;

    group.querySelectorAll('.chip').forEach(c => {
        c.classList.remove('selected');
    });

    el.classList.add('selected');

    if (type === 'duration') {
        currentDuration = el.innerText;
    }

    if (type === 'gender') {
        currentGender = el.innerText;
    }
}

export async function addGuest() {
    const ageInput = document.getElementById('g-age');
    const age = ageInput.value;

    if (!age) {
        showModal(
            t('guest_wait') || 'Error',
            t('guest_age_req') || 'Age required'
        );
        return;
    }

    const parsedAge = parseInt(age);

    if (parsedAge < 1 || parsedAge > 110) {
        showModal(
            t('guest_wait') || 'Error',
            'Age limit is between 1 and 110.'
        );
        return;
    }

    if (guests.length >= 9) {
        showModal(
            t('guest_wait') || 'Error',
            'Maximum limit of 9 guests reached.'
        );
        return;
    }

    const newGuest = {
        name: `Guest #${guests.length + 1}`,
        age: parsedAge,
        gender: currentGender,
        duration: currentDuration,
        seed: Math.random().toString(36).substring(7),
        active: true,
        created_at: new Date().toISOString()
    };

    try {
        console.log("Adding guest:", newGuest);

        const r = await fetch('/api/guests/add', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                guest: newGuest
            })
        });

        const res = await r.json();

        console.log("Add guest response:", res);

        if (!res.success) {
            throw new Error(res.error || "Failed to add guest");
        }

        // Add backend-generated guest with ID
        guests.push(res.guest);

        await loadGuests();

        updateGuestBadge();
        renderGuestList();

        ageInput.blur();
        ageInput.value = "";

    } catch (e) {
        console.error("Failed to add guest:", e);

        showModal(
            'Error',
            e.message || 'Failed to add guest'
        );
    }
}

export async function deleteGuest(id) {
    if (id === undefined || id === null) {
        console.error("Invalid guest ID:", id);
        return;
    }

    try {
        console.log("Deleting guest:", id);

        const r = await fetch('/api/guests/remove', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                id
            })
        });

        const res = await r.json();

        console.log("Delete guest response:", res);

        if (!res.success) {
            throw new Error(res.error || "Failed to delete guest");
        }

        // Remove locally
        const index = guests.findIndex(g => g.id === id);

        if (index !== -1) {
            guests.splice(index, 1);
        }

        await loadGuests();

        updateGuestBadge();
        renderGuestList();

        setTimeout(() => {
            const guests = document.querySelectorAll('#guest-list-container .guest-avatar-circle.guest-item');

            if (guests.length > 0) {
                const next = guests[Math.min(index, guests.length - 1)];

                window.setRemoteRestoreElement?.(next);
                window.restoreRemoteFocus?.();
            } else {
                const addBtn = document.querySelector('#view-guest-add .action-btn');

                if (addBtn) {
                    window.setRemoteRestoreElement?.(addBtn);
                    window.restoreRemoteFocus?.();
                }
            }
        }, 0);

    } catch (e) {
        console.error("Failed to delete guest:", e);

        showModal(
            'Error',
            e.message || 'Failed to delete guest'
        );
    }
}

window.deleteGuest = deleteGuest;

export function updateGuestBadge() {
    const badge = document.getElementById('guest-badge');

    if (!badge) return;

    badge.innerText = guests.length;

    if (guests.length > 0) {
        badge.classList.add('visible');
    } else {
        badge.classList.remove('visible');
    }
}

export function renderGuestList() {
    const container = document.getElementById('guest-list-container');

    if (!container) return;

    if (guests.length === 0) {
        container.innerHTML = `
            <div style="color:var(--text-sub); opacity:0.6; font-style:italic;">
                ${t('no_guests')}
            </div>

            <div style="
                margin-top:24px;
                color:var(--primary);
                font-size:0.9rem;
                opacity:0.8;
                border:1px solid rgba(208,188,255,0.2);
                padding:12px;
                border-radius:12px;
                background:rgba(208,188,255,0.05);
            ">
                <span class="material-symbols-rounded"
                    style="
                        vertical-align:middle;
                        font-size:18px;
                        margin-right:4px;
                    ">
                    info
                </span>

                Guests are active for 24 hours (2 AM to 2 AM cycle).
            </div>
        `;

        return;
    }

    container.innerHTML = guests.map(g => {
        const url = getAvatarUrl(g);

        return `
        <div style="
            display:flex;
            flex-direction:column;
            align-items:center;
            gap:8px;
        ">
            <div
                class="guest-avatar-circle guest-item"
                onclick="deleteGuest(${g.id})"
                title="${g.name || 'Guest'} (${g.gender}, ${g.age})"
            >
                <img src="${url}" loading="lazy">

                <div
                    class="guest-delete-overlay"
                >
                    <span class="material-symbols-rounded">
                        close
                    </span>
                </div>
            </div>

            <div style="
                color:var(--text-sub);
                font-size:14px;
                font-weight:500;
            ">
                ${g.gender.charAt(0)} ${g.age}
            </div>
        </div>
        `;
    }).join('');
}