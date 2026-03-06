import { t } from './i18n.js';
import { showModal } from './ui.js';
import { guests, loadGuests, getAvatarUrl } from './data.js';

let currentDuration = "24 Hour";
let currentGender = "Male";

export function selectChip(el, type) {
    const group = el.parentElement;
    group.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    
    if (type === 'duration') currentDuration = el.innerText;
    if (type === 'gender') currentGender = el.innerText;
}

export async function addGuest() {
    const ageInput = document.getElementById('g-age');
    const age = ageInput.value;
    
    if(!age) { 
        showModal(t('guest_wait') || 'Error', t('guest_age_req') || 'Age required');
        return; 
    }

    const parsedAge = parseInt(age);
    if(parsedAge < 1 || parsedAge > 110) {
        showModal(t('guest_wait') || 'Error', "Age limit is between 1 and 110.");
        return;
    }

    if(guests.length >= 9) {
        showModal(t('guest_wait') || 'Error', "Maximum limit of 9 guests reached.");
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
    
    // Optimistic local update
    guests.push(newGuest);
    
    try {
        const r = await fetch('/api/guests/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guests: guests })
        });
        const res = await r.json();
        if (res.success) {
            // Refresh from backend to get the real IDs if necessary
            await loadGuests();
        }
    } catch (e) {
        console.error("Failed to save guest", e);
    }
    
    updateGuestBadge();
    ageInput.value = "";
    renderGuestList();
}

export function updateGuestBadge() {
    const badge = document.getElementById('guest-badge');
    if (badge) {
        badge.innerText = guests.length;
        if (guests.length > 0) badge.classList.add('visible');
        else badge.classList.remove('visible');
    }
}

export async function deleteGuest(id) {
    const index = guests.findIndex(g => g.id === id);
    if (index !== -1) {
        guests.splice(index, 1);
        
        try {
            await fetch('/api/guests/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ guests: guests })
            });
            await loadGuests();
        } catch (e) {
            console.error("Failed to delete guest", e);
        }

        updateGuestBadge();
        renderGuestList();
    }
}

window.deleteGuest = deleteGuest;

export function renderGuestList() {
    const container = document.getElementById('guest-list-container');
    if (!container) return;
    
    if (guests.length === 0) {
        container.innerHTML = `
            <div style="color:var(--text-sub); opacity:0.6; font-style:italic;">${t('no_guests')}</div>
            <div style="margin-top:24px; color:var(--primary); font-size:0.9rem; opacity:0.8; border:1px solid rgba(208,188,255,0.2); padding:12px; border-radius:12px; background:rgba(208,188,255,0.05);">
                <span class="material-symbols-rounded" style="vertical-align:middle; font-size:18px; margin-right:4px;">info</span>
                Guests are active for 24 hours (2 AM to 2 AM cycle).
            </div>
        `;
        return;
    }

    const style = window.globalAvatarStyle || 'bottts';

    container.innerHTML = guests.map(g => {
        const url = getAvatarUrl(g);
        return `
        <div class="guest-card-m3">
            <div class="guest-avatar-circle" title="${g.name || 'Guest'} (${g.gender}, ${g.age})">
                <img src="${url}" loading="lazy" alt="Guest Avatar">
            </div>
            <div class="guest-info-text">
                ${g.gender.charAt(0)} ${g.age}
            </div>
            <button class="guest-delete-btn" onclick="deleteGuest(${g.id})">
                <span class="material-symbols-rounded">delete</span>
                Delete
            </button>
        </div>`;
    }).join('');
}
