import { renderGrid } from './grid.js';
import { config, save, memberData, updateSetting } from './data.js';
import { applyRemoteMode, isRemoteMode } from './remote.js';
import { t } from './i18n.js';

let currentAvatarStyle = 'local'; // Default

export function openSetting(id) {
    const main = document.getElementById('set-main');
    if (main) main.classList.remove('active');
    
    const panel = document.getElementById('set-' + id);
    if (panel) panel.classList.add('active');
    
    // Trigger specific logic when opening panels
    if (id === 'connectivity') loadWifiList();
    if (id === 'members')      loadMemberSettings();
    if (id === 'location')     loadLocationSettings();
    if (id === 'display')      initDisplaySettings();
    if (id === 'sys-info')     loadSystemInfo();
    if (id === 'system')       loadSystemInfo();
    if (id === 'power')        _initPowerPanel();
    if (id === 'wallpaper')    loadWallpaperSettings();
    if (id === 'wallpaper')    loadWallpaperSettings();
}

function _initPowerPanel() {
    // Highlight the current screen timeout chip
    const ms  = (config && config.screenTimeout) || 300000;
    const min = Math.round(ms / 60000);
    document.querySelectorAll('#set-power .chip').forEach(c => {
        const val = parseInt(c.dataset.min || c.innerText);
        if (val === min) c.classList.add('selected');
        else c.classList.remove('selected');
    });
}

function initDisplaySettings() {
    // Sync theme switch state
    const body = document.body;
    const themeSwitch = document.getElementById('theme-switch');
    if (themeSwitch) {
        if (body.classList.contains('light-mode')) themeSwitch.classList.add('on');
        else themeSwitch.classList.remove('on');
    }

    // Sync remote switch state
    const remoteSwitch = document.getElementById('remote-switch');
    if (remoteSwitch) {
        if (config.remoteMode) remoteSwitch.classList.add('on');
        else remoteSwitch.classList.remove('on');
    }

    // Sync animation switch state
    const animSwitch = document.getElementById('anim-switch');
    if (animSwitch) {
        if (config.reduceAnimations) animSwitch.classList.add('on');
        else animSwitch.classList.remove('on');
    }
}

export function closeSetting() {
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    const main = document.getElementById('set-main');
    if (main) main.classList.add('active');
}

export function toggleTheme() {
    const body = document.body;
    body.classList.toggle('light-mode');
    const isLight = body.classList.contains('light-mode');
    updateSetting('theme', isLight ? 'light' : 'dark');
    
    const switchEl = document.getElementById('theme-switch');
    if (switchEl) {
        if (isLight) switchEl.classList.add('on');
        else switchEl.classList.remove('on');
    }
}

export function toggleRemoteMode() {
    const newVal = !config.remoteMode;
    updateSetting('remoteMode', newVal);
    applyRemoteMode(newVal);

    const remoteSwitch = document.getElementById('remote-switch');
    if (remoteSwitch) {
        if (newVal) remoteSwitch.classList.add('on');
        else remoteSwitch.classList.remove('on');
    }

    if (window.showToast) window.showToast(newVal ? 'Remote Mode enabled' : 'Remote Mode disabled');
}

export function toggleAnimations() {
    const newVal = !config.reduceAnimations;
    updateSetting('reduceAnimations', newVal);
    
    if (newVal) document.body.classList.add('reduce-animations');
    else document.body.classList.remove('reduce-animations');

    const animSwitch = document.getElementById('anim-switch');
    if (animSwitch) {
        if (newVal) animSwitch.classList.add('on');
        else animSwitch.classList.remove('on');
    }

    if (window.showToast) window.showToast(newVal ? 'Animations Reduced' : 'Animations Restored');
}

export async function selectAvatarStyle(style) {
    currentAvatarStyle = style;
    updateSetting('avatarStyle', style);
    
    // Update UI Selection
    document.querySelectorAll('.avatar-option').forEach(opt => opt.classList.remove('selected'));
    const selectedOpt = document.getElementById('avat-' + style);
    if (selectedOpt) {
        selectedOpt.classList.add('selected');
    }
    
    // Save to global state used by Grid
    window.globalAvatarStyle = style; 
    
    // Re-render grid to show new avatars
    renderGrid();
}


// --- NEW SETTINGS LOGIC ---

// ── WIFI (real API) ──────────────────────────────────────────────────────────
let _currentSsid = null;

async function loadWifiList() {
    const list = document.getElementById('available-wifi-list');
    const currEl = document.getElementById('curr-net-name');
    if (!list) return;
    list.innerHTML = '<div class="wifi-skeleton">Scanning for networks...</div>';

    // Show currently connected network first
    try {
        const cr = await fetch('/api/wifi/current');
        const cd = await cr.json();
        _currentSsid = cd.connected ? cd.ssid : null;
        if (currEl) currEl.innerText = _currentSsid || t('Not connected');
        const statusEl = document.getElementById('curr-net-status');
        if (statusEl) {
            statusEl.innerText = _currentSsid ? t('connected_high_sig') : t('Disconnected');
        }
    } catch { 
        if (currEl) currEl.innerText = t('Not connected');
        const statusEl = document.getElementById('curr-net-status');
        if (statusEl) statusEl.innerText = t('Disconnected');
    }

    // Scan available + saved networks
    try {
        const r = await fetch('/api/wifi/networks');
        const data = await r.json();
        if (!data.success) throw new Error(data.error);

        const networks = data.networks || [];
        if (networks.length === 0) {
            list.innerHTML = `<div class="wifi-skeleton">${t('No networks found.')}</div>`;
            return;
        }

        list.innerHTML = networks.map(net => {
            const isCurr = net.ssid === _currentSsid;
            const pwd = net.password || ''; // Assuming API might return password for saved nets
            return `
                <div class="wifi-item ${isCurr ? 'connected' : ''}" onclick="window._connectToWifi('${net.ssid.replace(/'/g, "\\'")}', ${net.open}, ${net.saved}, '${pwd.replace(/'/g, "\\'")}')">
                    <span class="material-symbols-rounded" style="color:${isCurr?'#64d29a':'inherit'}">
                        ${net.open ? 'wifi' : 'wifi_lock'}
                    </span>
                    <div style="flex:1">
                        <div style="font-weight:500">${net.ssid}</div>
                        ${net.saved ? `<span class="wifi-badge saved">${t('Saved')}</span>` : ''}
                        ${isCurr ? `<span class="wifi-badge connected">${t('Connected')}</span>` : ''}
                    </div>
                    <div style="opacity:0.6; font-size:12px">${net.signal}%</div>
                </div>
            `;
        }).join('');
    } catch (e) {
        list.innerHTML = `<div class="wifi-skeleton">Error: ${e.message}</div>`;
    }
}

window.handleWifiClick = function(ssid, open, saved, savedPwd) {
    if (saved && savedPwd) {
        // Auto-reconnect with saved password
        _doConnect(ssid, savedPwd);
    } else if (open) {
        _doConnect(ssid, '');
    } else {
        _showPasswordDialog(ssid);
    }
};

window._connectToWifi = function(ssid, open, saved, savedPwd) {
    if (ssid === _currentSsid) {
        if (window.showToast) window.showToast(`Already connected to ${ssid}`);
        return;
    }

    if (open) {
        _doConnect(ssid, '');
    } else {
        // Use the unified prompt from ui.js
        if (window.showPasswordPrompt) {
            window.showPasswordPrompt(ssid, savedPwd || '');
        } else {
            // Fallback if ui.js not loaded or prompt not available
            const pwd = prompt(`Enter password for ${ssid}`, savedPwd || '');
            if (pwd !== null) _doConnect(ssid, pwd);
        }
    }
};

// Removed _showPasswordDialog and _submitWifiPwd as they are unified in ui.js

window.connectToWifi = _doConnect;
async function _doConnect(ssid, password) {
    const currEl = document.getElementById('curr-net-name');
    const listEl = document.getElementById('available-wifi-list');
    
    if (currEl) currEl.innerText = 'Connecting to ' + ssid + '...';
    if (listEl) listEl.innerHTML = `<div class="wifi-skeleton">Connecting to <b>${ssid}</b>...</div>`;
    if (window.showToast) window.showToast('Connecting to ' + ssid + '...');
    
    try {
        const r = await fetch('/api/wifi/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid, password })
        });
        const d = await r.json();
        if (d.success) {
            _currentSsid = ssid;
            if (currEl) currEl.innerText = ssid;
            const statusEl = document.getElementById('curr-net-status');
            if (statusEl) statusEl.innerText = t('connected_high_sig');
            if (window.showToast) window.showToast(t('Connected') + ' ' + ssid);
            if (window.setWifiState) window.setWifiState(true);
            setTimeout(loadWifiList, 1000);
        } else {
            if (currEl) currEl.innerText = _currentSsid || 'Not connected';
            if (window.showToast) window.showToast('Failed: ' + (d.error || 'Unknown error'));
            loadWifiList();
        }
    } catch(e) {
        if (currEl) currEl.innerText = _currentSsid || 'Not connected';
        if (window.showToast) window.showToast('Error: ' + e.message);
        loadWifiList();
    }
}

// LOCATION SETTINGS
const cities = [
    "Yerevan",
    "Gyumri",
    "Vanadzor",
    "Vagharshapat",
    "Abovyan",
    "Kapan",
    "Hrazdan",
    "Armavir"
];

function loadLocationSettings() {
    const list = document.getElementById('location-list');
    if (!list) return;

    const currentCity = config.location;

    list.innerHTML = cities.map(city => {
        const selected = city === currentCity;
        return `
            <div class="list-item" onclick="selectLocation('${city}')">
                <div class="item-content">
                    <h4>${city}</h4>
                </div>
                ${selected ? '<span class="material-symbols-rounded">check</span>' : ''}
            </div>
        `;
    }).join('');
}

window.selectLocation = function(city) {
    updateSetting('location', city);
    
    // Update text in main settings
    const txt = document.getElementById('current-location-text');
    if(txt) txt.innerText = city;

    // Refresh list to show checkmark
    loadLocationSettings();

    // Update screensaver
    if (window.initLocation) window.initLocation();
}


import { showModal } from './ui.js';

window.confirmPower = function (action) {
    const msg = action === 'shutdown'
        ? 'Are you sure you want to shut down the system?'
        : 'Are you sure you want to reboot the system?';
    const title = action === 'shutdown' ? 'Shut Down' : 'Reboot';

    showModal(title, msg, [
        { text: 'Cancel', primary: false },
        {
            text: action === 'shutdown' ? 'Shut Down' : 'Reboot',
            primary: true,
            callback: async () => {
                let seconds = 3;
                const overlay = document.createElement('div');
                overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.95);backdrop-filter:blur(10px);z-index:999999999;display:flex;align-items:center;justify-content:center;color:#fff;font-family:inherit";
                
                const updateOverlay = () => {
                    const progress = (seconds / 3) * 283; // 2*PI*45 approx 283
                    overlay.innerHTML = `
                        <div style="text-align:center; display:flex; flex-direction:column; align-items:center; gap:24px">
                            <div style="position:relative; width:100px; height:100px">
                                <svg viewBox="0 0 100 100" style="transform: rotate(-90deg); width:100px; height:100px">
                                    <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="4"/>
                                    <circle cx="50" cy="50" r="45" fill="none" stroke="var(--primary)" stroke-width="4" 
                                            stroke-dasharray="283" stroke-dashoffset="${283 - progress}" 
                                            style="transition: stroke-dashoffset 1s linear"/>
                                </svg>
                                <span class="material-symbols-rounded" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:40px; color:var(--primary)">
                                    ${action === 'shutdown' ? 'power_settings_new' : 'restart_alt'}
                                </span>
                            </div>
                            <div>
                                <h1 style="font-size:24px; font-weight:400; margin:0">${action === 'shutdown' ? 'Shutting Down' : 'Rebooting'}</h1>
                                <p style="font-size:16px; opacity:0.6; margin:8px 0 0">System will ${action === 'shutdown' ? 'power off' : 'restart'} in ${seconds}s</p>
                            </div>
                        </div>
                    `;
                };

                document.body.appendChild(overlay);
                updateOverlay();

                const timer = setInterval(async () => {
                    seconds--;
                    if (seconds <= 0) {
                        clearInterval(timer);
                        overlay.innerHTML = `<h1 style="font-size:20px; font-weight:400; opacity:0.8">${action === 'shutdown' ? 'Shutdown Initiated' : 'Reboot Initiated'}</h1>`;
                        try {
                            const route = action === 'shutdown' ? 'shutdown' : 'reboot';
                            await fetch('/api/system/' + route, { method: 'POST' });
                        } catch { /* device will go down */ }
                    } else {
                        updateOverlay();
                    }
                }, 1000);
            }
        }
    ]);
};

window.selectTimeout = function(minutes, el) {
    const parent = el.parentElement;
    if (parent) parent.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    const ms = minutes * 60 * 1000;
    
    updateSetting('screenTimeout', ms);
    
    if (window.setScreensaverTimeout) window.setScreensaverTimeout(ms);
};

window.selectBrightness = function(level, el) {
    const parent = el.parentElement;
    if (parent) parent.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    // Map percentage to 20–255
    const raw = Math.round(20 + (level / 100) * 235);
    fetch('/api/system/brightness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brightness: raw })
    }).then(r => r.json()).then(d => {
        if (d.success) {
            updateSetting('brightness', raw);
            if (window.showToast) window.showToast(`Brightness: ${level}%`);
        } else {
            if (window.showToast) window.showToast('Brightness change failed');
        }
    }).catch(() => { if (window.showToast) window.showToast('Brightness update error'); });
};

// ── MEMBER SETTINGS ───────────────────────────────────────────────────────────
function loadMemberSettings() {
    const list = document.getElementById('member-settings-list');
    if (!list) return;
    list.innerHTML = memberData.map((m, index) => `
        <div class="list-item" style="cursor:default">
            <div class="icon-box"><span class="material-symbols-rounded">person</span></div>
            <div class="item-content" style="flex:1">
                <div style="display:flex;align-items:center;justify-content:space-between">
                    <input type="text" class="input-box"
                        value="${m.name}"
                        style="width:60%;height:40px;font-size:18px"
                        oninput="updateMemberName(${index},this.value)">
                    <span style="font-size:14px;color:var(--text-sub);opacity:0.8">${m.gender}, ${m.age}</span>
                </div>
            </div>
        </div>
    `).join('');
}

window.updateMemberName = async function(index, newName) {
    if (memberData[index]) {
        memberData[index].name = newName;
        renderGrid();
        
        try {
            await fetch('/api/members/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index, name: newName })
            });
        } catch (e) {
            console.error("Member rename failed", e);
        }
    }
};

// ── SYSTEM INFO (real device data) ───────────────────────────────────────────
export async function loadSystemInfo() {
    try {
        const r = await fetch('/api/system/status');
        const d = await r.json();
        const el = document.getElementById('sys-info-content');
        if (!el) return;

        el.innerHTML = `
            <div class="info-group">
                <div class="info-row" style="background:rgba(255,255,255,0.03); border-radius:12px; margin-bottom:12px">
                    <span class="info-label">${t('Device Identifier')}</span>
                    <span class="info-value" style="color:var(--primary); font-family:monospace; font-size:18px">${d.meter_id}</span>
                </div>
                
                <div class="info-row">
                    <span class="info-label">${t('Local IP Address')}</span>
                    <span class="info-value">${d.ip_address}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">${t('MAC Address')}</span>
                    <span class="info-value">${d.mac_address}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">${t('Software Version')}</span>
                    <span class="info-value">v5.2.0-stable</span>
                </div>
            </div>

            <div style="margin:20px 0 10px 4px; font-size:12px; text-transform:uppercase; color:var(--primary); letter-spacing:1px; opacity:0.8">Hardware Status</div>

            <div class="hw-grid">
                <div class="hw-grid-item ${d.wifi ? 'hw-ok' : 'hw-err'}">
                    <span class="material-symbols-rounded">wifi</span>
                    <span class="hw-grid-label">WiFi Module</span>
                    <span class="hw-grid-status">${d.wifi ? 'Connected' : 'Disconnected'}</span>
                </div>
                <div class="hw-grid-item ${d.gsm ? 'hw-ok' : 'hw-err'}">
                    <span class="material-symbols-rounded">cell_tower</span>
                    <span class="hw-grid-label">GSM Modem</span>
                    <span class="hw-grid-status">${d.gsm ? 'Ready' : 'Not detected'}</span>
                </div>
                <div class="hw-grid-item ${d.usb_jack ? 'hw-ok' : 'hw-err'}">
                    <span class="material-symbols-rounded">usb</span>
                    <span class="hw-grid-label">USB Audio</span>
                    <span class="hw-grid-status">${d.usb_jack ? 'Connected' : 'Missing'}</span>
                </div>
                <div class="hw-grid-item ${d.hdmi_vcc ? 'hw-ok' : 'hw-err'}">
                    <span class="material-symbols-rounded">tv</span>
                    <span class="hw-grid-label">HDMI VCC</span>
                    <span class="hw-grid-status">${d.hdmi_vcc ? 'Signal' : 'No Signal'}</span>
                </div>
                <div class="hw-grid-item ${d.video_detection ? 'hw-ok' : 'hw-err'}">
                    <span class="material-symbols-rounded">smart_toy</span>
                    <span class="hw-grid-label">Video AI</span>
                    <span class="hw-grid-status">${d.video_detection ? 'Running' : 'Stopped'}</span>
                </div>
            </div>
        `;
    } catch(e) {
        const el = document.getElementById('sys-info-content');
        if (el) el.innerHTML = '<div class="wifi-skeleton">Could not load system info.</div>';
    }
}

// ── Global exports for HTML onclick handlers ──────────────────────────────────
window.loadWifiList   = () => loadWifiList();
window.loadSystemInfo = () => loadSystemInfo();

// ── WALLPAPER SETTINGS ────────────────────────────────────────────────────────
async function loadWallpaperSettings() {
    try {
        const r = await fetch('/api/wallpaper/status');
        const d = await r.json();

        const noImg = document.getElementById('wp-no-image');
        const hasImg = document.getElementById('wp-has-image');
        const thumb = document.getElementById('wp-thumb');
        const sizeInfo = document.getElementById('wp-size-info');
        const resetBtn = document.getElementById('wp-reset-btn');
        const statusText = document.getElementById('wallpaper-status-text');
        const titleText = document.getElementById('wp-title-text');

        if (d.hasWallpaper) {
            if (noImg) noImg.style.display = 'none';
            if (hasImg) hasImg.style.display = 'flex';
            if (thumb) thumb.src = `${d.url}&t=${Date.now()}`;
            if (sizeInfo) sizeInfo.textContent = `${d.sizeKB} KB • ${d.ext.replace('.', '').toUpperCase()} ${t('Active')}`;
            if (resetBtn) resetBtn.style.display = 'flex';
            if (statusText) statusText.textContent = t('active_bg');
            if (titleText) titleText.textContent = t('active_bg');
        } else {
            if (noImg) noImg.style.display = 'flex';
            if (hasImg) hasImg.style.display = 'none';
            if (resetBtn) resetBtn.style.display = 'none';
            if (sizeInfo) sizeInfo.textContent = t('no_custom_image_uploaded');
            if (statusText) statusText.textContent = t('using_sys_default');
            if (titleText) titleText.textContent = t('sys_default');
        }

        // QR Code
        const qrImg = document.getElementById('wp-qr-image');
        const urlEl = document.getElementById('wp-qr-url');
        if (qrImg) {
            const sr = await fetch('/api/system/status');
            const sd = await sr.json();
            const ip = sd.ip_address || window.location.hostname;
            const port = window.location.port ? `:${window.location.port}` : '';
            const uploadUrl = `http://${ip}${port}/upload`;

            qrImg.src = `/api/wallpaper/qr?content=${encodeURIComponent(uploadUrl)}`;
            if (urlEl) urlEl.textContent = uploadUrl;
        }
    } catch (e) {
        console.error('Failed to load wallpaper settings', e);
    }
}

window.resetWallpaper = async function() {
    try {
        const r = await fetch('/api/wallpaper/reset', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
            if (window.showToast) window.showToast('Wallpaper removed');
            loadWallpaperSettings(); // Refresh panel
            // Update screensaver immediately
            if (window.refreshWallpaperOnScreensaver) window.refreshWallpaperOnScreensaver();
        }
    } catch (e) {
        if (window.showToast) window.showToast('Error: ' + e.message);
    }
};
