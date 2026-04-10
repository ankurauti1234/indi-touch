import { renderGrid } from './grid.js';
import { config, save, memberData, updateSetting } from './data.js';
import { applyRemoteMode, isRemoteMode } from './remote.js';
import { t } from './i18n.js';

let currentAvatarStyle = 'local'; // Default
let sysInfoTimer = null;

export function openSetting(id) {
    // Hide ALL panels first to prevent overlaps/overlays
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    
    // Cleanup system info timer if navigating away from system info
    if (sysInfoTimer && id !== 'system' && id !== 'sys-info') {
        clearInterval(sysInfoTimer);
        sysInfoTimer = null;
    }

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
}

export function closeSetting() {
    // Cleanup any running timers
    if (sysInfoTimer) {
        clearInterval(sysInfoTimer);
        sysInfoTimer = null;
    }
    
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    const main = document.getElementById('set-main');
    if (main) main.classList.add('active');
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
        // Switch is ON when it's DARK (default)
        if (!body.classList.contains('light-mode')) themeSwitch.classList.add('on');
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

export function toggleTheme() {
    const body = document.body;
    body.classList.toggle('light-mode');
    const isLight = body.classList.contains('light-mode');
    updateSetting('theme', isLight ? 'light' : 'dark');
    
    const switchEl = document.getElementById('theme-switch');
    if (switchEl) {
        // ON = DARK, OFF = LIGHT
        if (!isLight) switchEl.classList.add('on');
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

// ── WIFI ───────────────────────────────────────────────────────────────────
let _currentSsid = null;
let _currentInternetOk = true;

async function loadWifiList() {
    const list = document.getElementById('available-wifi-list');
    const currEl = document.getElementById('curr-net-name');
    if (!list) return;
    list.innerHTML = '<div class="wifi-skeleton">Scanning for networks...</div>';

    try {
        const cr = await fetch('/api/wifi/current');
        const cd = await cr.json();
        const sysR = await fetch('/api/system/status');
        const sysD = await sysR.json();
        
        _currentSsid = cd.connected ? cd.ssid : null;
        _currentInternetOk = sysD.internet !== false;
        
        if (currEl) currEl.innerText = _currentSsid || t('Not connected');
        const statusEl = document.getElementById('curr-net-status');
        if (statusEl) {
            if (_currentSsid) {
                statusEl.innerText = _currentInternetOk ? (t('connected_high_sig') || 'Connected \u2022 High Signal') : (t('Connected, No Internet') || 'Connected, No Internet');
                statusEl.style.color = _currentInternetOk ? '' : '#FFB866';
            } else {
                statusEl.innerText = t('Disconnected');
                statusEl.style.color = '';
            }
        }
    } catch { }

    try {
        const r = await fetch('/api/wifi/networks');
        const data = await r.json();
        const networks = data.networks || [];
        if (networks.length === 0) {
            list.innerHTML = `<div class="wifi-skeleton">${t('No networks found.')}</div>`;
            return;
        }
        list.innerHTML = networks.map(net => {
            const isCurr = net.ssid === _currentSsid;
            return `
                <div class="wifi-item ${isCurr ? 'connected' : ''}" onclick="window._connectToWifi('${net.ssid.replace(/'/g, "\\'")}', ${net.open}, ${net.saved}, '${(net.password || '').replace(/'/g, "\\'")}')">
                    <span class="material-symbols-rounded">
                        ${net.open ? 'wifi' : 'wifi_lock'}
                    </span>
                    <div style="flex:1">
                        <div style="font-weight:500">${net.ssid}</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) { list.innerHTML = 'Error loading wifi'; }
}

async function _doConnect(ssid, password) {
    if (window.showToast) window.showToast('Connecting to ' + ssid + '...');
    try {
        const r = await fetch('/api/wifi/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid, password })
        });
        const d = await r.json();
        if (d.success) {
            if (window.showToast) window.showToast('Connected to ' + ssid);
            setTimeout(loadWifiList, 1000);
        } else {
            if (window.showToast) window.showToast('Failed: ' + d.error);
        }
    } catch(e) { }
}
window._connectToWifi = (ssid, open, saved, savedPwd) => {
    if (open) _doConnect(ssid, '');
    else {
        const pwd = prompt(`Enter password for ${ssid}`, savedPwd || '');
        if (pwd !== null) _doConnect(ssid, pwd);
    }
};

// ── LOCATION ────────────────────────────────────────────────────────────────
const cities = ["Auto", "Yerevan", "Gyumri", "Vanadzor"];
function loadLocationSettings() {
    const list = document.getElementById('location-list');
    if (!list) return;
    list.innerHTML = cities.map(city => `
        <div class="list-item" onclick="selectLocation('${city}')">
            <div class="item-content"><h4>${city === 'Auto' ? t('auto_detect') : city}</h4></div>
        </div>
    `).join('');
}
window.selectLocation = (city) => {
    updateSetting('location', city);
    loadLocationSettings();
    if (window.initLocation) window.initLocation();
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
        } catch (e) { }
    }
};

// --- SYSTEM INFO (Full Restoration) ---
export async function loadSystemInfo() {
    const el = document.getElementById('sys-info-content');
    if (!el) return;
    if (sysInfoTimer) clearInterval(sysInfoTimer);

    const formatBytes = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
    };

    const renderStatus = (val, label) => `
        <div class="hw-grid-item ${val ? 'hw-ok' : 'hw-err'}">
            <span class="material-symbols-rounded">${val ? 'check_circle' : 'cancel'}</span>
            <span class="hw-grid-label">${label}</span>
            <span class="hw-grid-status">${val ? 'Ready' : 'Not Detected'}</span>
        </div>
    `;

    const updateUI = async () => {
        try {
            const r = await fetch('/api/system/status');
            const d = await r.json();
            
            el.innerHTML = `
                <div class="info-group">
                    <div class="info-row" style="background:rgba(100,210,154,0.05); border-radius:12px; margin-bottom:12px; padding:12px">
                        <span class="info-label" style="color:#64d29a">Device ID</span>
                        <span class="info-value" style="font-family:monospace; font-weight:600">${d.meter_id}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">MAC Address</span>
                        <span class="info-value">${d.mac_address || 'Unavailable'}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">IP Address</span>
                        <span class="info-value">${d.ip_address}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">Firmware</span>
                        <span class="info-value">v5.2.0-stable</span>
                    </div>
                </div>

                <div style="margin:24px 0 12px 4px; font-size:12px; text-transform:uppercase; color:var(--primary); letter-spacing:1px; font-weight:600">Hardware Utilization</div>
                
                <div class="hw-stats" style="margin-bottom: 24px">
                    <div class="stat-card">
                        <div class="stat-info">
                            <span class="stat-label">CPU Load</span>
                            <span class="stat-value">${d.cpu_percent}%</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill" style="width: ${d.cpu_percent}%"></div></div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-info">
                            <span class="stat-label">RAM Usage</span>
                            <span class="stat-value">${formatBytes(d.ram_used)} / ${formatBytes(d.ram_total)}</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill" style="width: ${d.ram_percent}%"></div></div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-info">
                            <span class="stat-label">Core Temp</span>
                            <span class="stat-value" style="color: ${d.temperature > 70 ? '#ff5252' : ''}">${d.temperature}°C</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width:${Math.min(100, (d.temperature / 85) * 100)}%; background:${d.temperature > 70 ? '#ff5252' : ''}"></div>
                        </div>
                    </div>
                </div>

                <div style="margin:24px 0 12px 4px; font-size:12px; text-transform:uppercase; color:var(--primary); letter-spacing:1px; font-weight:600">Interface Diagnostics</div>

                <div class="hw-grid">
                    ${renderStatus(d.wifi, 'WiFi Module')}
                    ${renderStatus(d.gsm, 'GSM Modem')}
                    ${renderStatus(d.usb_jack, 'USB Audio')}
                    ${renderStatus(d.hdmi_vcc, 'HDMI Signal')}
                    ${renderStatus(d.video_detection, 'Video Engine')}
                </div>
            `;
        } catch(e) { 
            console.error("System info refresh failed", e);
            clearInterval(sysInfoTimer); 
        }
    };
    await updateUI();
    sysInfoTimer = setInterval(updateUI, 2000);
}

// ── AVATAR CAPTURE & QR ──────────────────────────────────────────────────────
let cameraStream = null;
let capturedBlob = null;

window.openAvatarCapture = async () => {
    // Check if camera is available first
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (window.showToast) window.showToast("Camera not supported on this device");
        return;
    }

    const overlay = document.getElementById('camera-overlay');
    const video = document.getElementById('camera-video');
    if (!overlay || !video) return;

    overlay.classList.add('active');
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 400, height: 400, facingMode: "user" } });
        video.srcObject = cameraStream;
    } catch (err) { 
        if (window.showToast) window.showToast('Camera access denied');
        closeCamera(); 
    }
};

// Check for camera and hide button if missing
async function checkCameraAvailability() {
    const btn = document.querySelector('[onclick="openAvatarCapture()"]');
    if (!btn) return;
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideo = devices.some(d => d.kind === 'videoinput');
        if (!hasVideo) btn.style.display = 'none';
    } catch (e) {
        btn.style.display = 'none';
    }
}
setTimeout(checkCameraAvailability, 500);

// ── WALLPAPER ───────────────────────────────────────────────────────────────
async function loadWallpaperSettings() {
    const qrImg = document.getElementById('wp-qr-image');
    if (qrImg) {
        const sr = await fetch('/api/system/status');
        const sd = await sr.json();
        const uploadUrl = `http://${sd.ip_address}:${window.location.port}/upload`;
        qrImg.src = `/api/wallpaper/qr?content=${encodeURIComponent(uploadUrl)}`;
    }
}

window.openAvatarQr = () => {
    const select = document.getElementById('qr-member-select');
    if (!select) return;
    select.innerHTML = '<option value="">Select Member...</option>' + 
        memberData.map(m => `<option value="${m.member_code}">${m.name}</option>`).join('');
    document.getElementById('avatar-qr-overlay').classList.add('active');
};

window.closeAvatarQr = () => {
    const overlay = document.getElementById('avatar-qr-overlay');
    if (overlay) overlay.classList.remove('active');
};

window.refreshAvatarQr = async () => {
    const val = document.getElementById('qr-member-select').value;
    if (!val) return;
    try {
        const sr = await fetch('/api/system/status');
        const sd = await sr.json();
        const ip = sd.ip_address || window.location.hostname;
        const port = window.location.port ? `:${window.location.port}` : '';
        const url = `http://${ip}${port}/avatar_upload?m=${val}`;
        
        const img = document.getElementById('avatar-qr-img');
        const container = document.getElementById('avatar-qr-container');
        if (img) img.src = `/api/avatar/qr?content=${encodeURIComponent(url)}`;
        if (container) container.style.display = 'block';
    } catch (e) {
        console.error("QR refresh failed", e);
    }
};

window.closeCamera = () => {
    document.getElementById('camera-overlay').classList.remove('active');
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
};

window.takeSnapshot = () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas) return;
    
    canvas.width = 400;
    canvas.height = 400;
    canvas.getContext('2d').drawImage(video, 0, 0, 400, 400);
    canvas.toBlob(blob => { capturedBlob = blob; }, 'image/jpeg', 0.85);
    
    const preview = document.getElementById('capture-preview');
    const previewImg = document.getElementById('preview-frame');
    if (previewImg) previewImg.src = canvas.toDataURL('image/jpeg');
    if (preview) preview.style.display = 'block';
    
    document.getElementById('btn-snap').style.display = 'none';
    document.getElementById('btn-save-cap').style.display = 'block';
    document.getElementById('btn-retake').style.display = 'block';
};

window.retakePhoto = () => {
    document.getElementById('camera-video').style.display = 'block';
    document.getElementById('capture-preview').style.display = 'none';
    document.getElementById('btn-snap').style.display = 'block';
    document.getElementById('btn-save-cap').style.display = 'none';
    document.getElementById('btn-retake').style.display = 'none';
    capturedBlob = null;
};

window.saveCapturedAvatar = async () => {
    if (!capturedBlob) return;
    const formData = new FormData();
    formData.append('file', capturedBlob, 'avatar.jpg');
    // Default to first member if not specified, but usually we'd want a selection
    formData.append('member_code', memberData[0].member_code);
    
    try {
        const r = await fetch('/api/avatar/upload', { method: 'POST', body: formData });
        const d = await r.json();
        if (d.success) {
            if (window.showToast) window.showToast('Avatar updated');
            closeCamera();
            renderGrid();
        }
    } catch (e) {
        if (window.showToast) window.showToast('Upload failed');
    }
};

// Global exports for navigation.js and HTML
window.openSetting = openSetting;
window.closeSetting = closeSetting;
window.toggleTheme = toggleTheme;
window.toggleRemoteMode = toggleRemoteMode;
window.toggleAnimations = toggleAnimations;
window.selectAvatarStyle = selectAvatarStyle;
window.loadWifiList = loadWifiList;
window.loadSystemInfo = loadSystemInfo;
window.refreshConnectivityUI = () => loadWifiList();
