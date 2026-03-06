/* js/data.js */

// Live state objects that components can reference
export let memberData = [];
export let guests = [];
export const tvState = { on: false };
export let config = {
    language: 'en',
    screenTimeout: 300000,
    meter_id: 'HUB-IM0000',
    location: 'Yerevan',
    remoteMode: false,
    onboardingCompleted: false,
    avatarStyle: 'local',
    reduceAnimations: false,
    bleAvailable: true
};

// --- API Sync Helpers ---

export async function initData() {
    await loadConfig();
    await loadMembers();
    await loadGuests();
}

export async function loadConfig() {
    try {
        const rStatus = await fetch('/api/system/status');
        const dStatus = await rStatus.json();
        if (dStatus.success) {
            config.meter_id = dStatus.meter_id || config.meter_id;
            config.onboardingCompleted = dStatus.installation_done;
        }
        
        const rSettings = await fetch('/api/system/settings');
        const dSettings = await rSettings.json();
        
        config.language = dSettings.language || 'en';
        config.remoteMode = dSettings.remoteMode === true;
        config.screenTimeout = dSettings.screenTimeout || 300000;
        config.location = dSettings.location || 'Yerevan';
        config.avatarStyle = dSettings.avatarStyle || 'local';
        config.reduceAnimations = dSettings.reduceAnimations === true;
        config.brightness = dSettings.brightness !== undefined ? dSettings.brightness : 255;

        // Bluetooth / TV availability — strict: only true if explicitly true
        config.bleAvailable = dStatus.ble_available === true;
        tvState.on = dStatus.tv_on === true;

        // Hide all TV-related elements if bluetooth is not available
        const tvElements = document.querySelectorAll('.tv-only');
        tvElements.forEach(el => {
            if (!config.bleAvailable) {
                el.style.display = 'none';
            } else {
                // Restore natural display (flex for most, inline for span etc.)
                el.style.display = '';
            }
        });

        // Apply initial TV UI state
        toggleTv(tvState.on);

        // Apply saved brightness
        fetch('/api/system/brightness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brightness: config.brightness })
        }).catch(e => console.error("Failed to apply brightness on boot", e));

        // Sync UI labels
        const langText = document.getElementById('current-lang-text');
        if (langText) {
            const names = { en: 'English', hy: 'Armenian', ru: 'Russian' };
            langText.innerText = names[config.language] || config.language;
        }
        const locText = document.getElementById('current-location-text');
        if (locText) locText.innerText = config.location;

    } catch (e) {
        console.error("Failed to load config", e);
    }
}

export async function loadMembers() {
    try {
        const r = await fetch('/api/members');
        const d = await r.json();
        if (d.success) {
            updateMemberData(d.data.members || d.members);
            return memberData;
        }
    } catch (e) {
        console.error("Failed to load members", e);
    }
    return memberData;
}

export function updateMemberData(newList) {
    if (!newList) return;
    memberData.length = 0;
    memberData.push(...newList);
    if (window.renderGrid) window.renderGrid();
    if (window.renderScreensaverMembers) window.renderScreensaverMembers();
}
window.updateMemberData = updateMemberData;
window.loadMembers = loadMembers;

export async function loadGuests() {
    try {
        const r = await fetch('/api/guests');
        const d = await r.json();
        if (d.success) {
            guests.length = 0;
            guests.push(...d.guests);
            return guests;
        }
    } catch (e) {
        console.error("Failed to load guests", e);
    }
    return guests;
}

export async function updateSetting(key, value) {
    config[key] = value;
    try {
        await fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value })
        });
    } catch (e) {
        console.error("Failed to save setting", key, e);
    }
}

export async function save(type, data) {
    // Legacy helper - removed localStorage
}

export function toggleTv(state) {
    tvState.on = state;
    if (window.updateTvUI) window.updateTvUI(state);
    
    // Optimistic clear for immediate UI feedback before API confirms
    if (!state) {
        memberData.forEach(m => m.active = false);
        guests.length = 0;
        if (window.renderGrid) window.renderGrid();
        if (window.renderGuestList) window.renderGuestList();
        if (window.renderScreensaverMembers) window.renderScreensaverMembers();
    }
}

export function getAvatarUrl(m) {
    const style = config.avatarStyle || 'local';
    
    if (style === 'custom') {
        if (m.offline_avatar && !m.offline_avatar.includes('data:image')) {
            return `/api/wallpaper/avatar_image?code=${m.member_code}&t=${Date.now()}`;
        }
        // Fallback to local if no custom image
        return getAvatarUrl({...m, avatarStyle: 'local'});
    }

    if (style === 'local') {
        const gender = (m.gender || 'Male').toLowerCase();
        const age = parseInt(m.age) || 30;
        let category = 'middle';
        
        if (age < 13) category = 'kid';
        else if (age < 20) category = 'teen';
        else if (age < 45) category = 'middle';
        else if (age < 65) category = 'aged';
        else category = 'elder';
        
        return `assets/images/avatar/${gender}-${category}.png`;
    }
    
    // Dicebear Fallback
    const seed = m.seed || (m.gender + (m.name || 'User'));
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${seed}&backgroundColor=c0aede,b6e3f4,ffdfbf`;
}