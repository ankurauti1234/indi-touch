/* js/connection.js — USB and WiFi connection warning popups */

import { openSetting } from './settings.js';
import { timers } from './utils.js';

const API_STATUS_URL = '/api/system/status';
const POLL_INTERVAL  = 8000;       // 8 s
const WIFI_COOLDOWN  = 2 * 60_000; // 2 min

let _usbConnected  = true;
let _wifiConnected = true;

// ─── USB Popup ────────────────────────────────────────────────────────────────
function injectUsbPopup() {
    if (document.getElementById('usb-warning-overlay')) return;
    const el = document.createElement('div');
    el.id = 'usb-warning-overlay';
    el.className = 'conn-overlay';
    el.innerHTML = `
    <div class="conn-card">
        <div class="conn-icon" style="background:rgba(255,180,171,0.15)">
            <span class="material-symbols-rounded" style="color:#FFB4AB;font-size:40px">usb_off</span>
        </div>
        <h3 class="conn-title">USB Not Connected</h3>
        <p class="conn-body">Please check the USB connection between the hub and the device. The system will resume automatically once connected.</p>
        <div class="conn-loader">
            <div class="conn-loader-dot"></div>
            <div class="conn-loader-dot"></div>
            <div class="conn-loader-dot"></div>
        </div>
    </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
}

function hideUsbPopup() {
    const el = document.getElementById('usb-warning-overlay');
    if (el) { el.classList.remove('visible'); timers.setTimeout(() => el.remove(), 400); }
}

/** Called by main.py Qt layer and by the internal poller */
export function setUsbState(connected) {
    _usbConnected = connected;
    if (connected) { hideUsbPopup(); }
    else           { injectUsbPopup(); }
}

// ─── WiFi Popup ───────────────────────────────────────────────────────────────
let _wifiCooldownTimer = null;
let _wifiPopupVisible  = false;

function injectWifiPopup() {
    if (_wifiPopupVisible || _wifiCooldownTimer) return;
    if (document.getElementById('wifi-warning-overlay')) return;
    _wifiPopupVisible = true;
    const el = document.createElement('div');
    el.id = 'wifi-warning-overlay';
    el.className = 'conn-overlay';
    el.innerHTML = `
    <div class="conn-card">
        <div class="conn-icon" style="background:rgba(255,184,102,0.15)">
            <span class="material-symbols-rounded" style="color:#FFB866;font-size:40px">wifi_off</span>
        </div>
        <h3 class="conn-title">No WiFi Connection</h3>
        <p class="conn-body">This hub is not connected to a WiFi network. Some features may be limited.</p>
        <div class="conn-actions">
            <button class="conn-btn-secondary" id="wifi-warn-dismiss">Dismiss</button>
            <button class="conn-btn-primary"   id="wifi-warn-connect">Connect to WiFi</button>
        </div>
    </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    document.getElementById('wifi-warn-dismiss').addEventListener('click', _dismissWifi);
    document.getElementById('wifi-warn-connect').addEventListener('click', () => {
        _dismissWifi();
        if (window.navTo) window.navTo('settings');
        timers.setTimeout(() => { if (window.openSetting) window.openSetting('connectivity'); }, 200);
    });
}

function _dismissWifi() {
    const el = document.getElementById('wifi-warning-overlay');
    if (el) { el.classList.remove('visible'); timers.setTimeout(() => el.remove(), 400); }
    _wifiPopupVisible = false;
    _wifiCooldownTimer = timers.setTimeout(() => {
        _wifiCooldownTimer = null;
        if (!_wifiConnected) injectWifiPopup();
    }, WIFI_COOLDOWN);
}

function hideWifiPopup() {
    const el = document.getElementById('wifi-warning-overlay');
    if (el) { el.classList.remove('visible'); timers.setTimeout(() => el.remove(), 400); }
    _wifiPopupVisible = false;
    timers.clearTimeout(_wifiCooldownTimer);
    _wifiCooldownTimer = null;
}

/** Called by main.py Qt layer and by the internal poller */
export function setWifiState(connected) {
    _wifiConnected = connected;
    if (connected) { hideWifiPopup(); }
    else           { injectWifiPopup(); }
}

// ─── Real-API Poller ──────────────────────────────────────────────────────────
async function _pollStatus() {
    try {
        const r = await fetch(API_STATUS_URL);
        if (!r.ok) return;
        const d = await r.json();
        
        // USB: either jack or hdmi counts as "connected"
        const usbOk = d.usb_jack || d.hdmi_vcc;
        if (usbOk  !== _usbConnected)  setUsbState(usbOk);
        
        // WiFi: auto-dismiss and update icon
        const wifiIcon = document.getElementById('wifi-status-icon');
        if (wifiIcon) {
            wifiIcon.innerText = d.wifi ? 'wifi' : 'wifi_off';
            if (d.wifi) wifiIcon.classList.add('online'), wifiIcon.classList.remove('offline');
            else wifiIcon.classList.add('offline'), wifiIcon.classList.remove('online');
        }

        if (d.wifi !== _wifiConnected) {
            setWifiState(d.wifi);
        } else if (d.wifi && document.getElementById('wifi-warning-overlay')) {
            hideWifiPopup();
        }

        // TV Status Icon
        const tvIcon = document.getElementById('tv-status-icon');
        if (tvIcon) {
            if (d.tv_on) tvIcon.classList.add('online'), tvIcon.classList.remove('offline');
            else tvIcon.classList.add('offline'), tvIcon.classList.remove('online');
        }

        import('./data.js').then(async m => {
            if (m.tvState.on !== d.tv_on) {
                console.log(`[TV Status Change] ${m.tvState.on} -> ${d.tv_on}`);
                m.toggleTv(d.tv_on);
                
                // If TV just went off, call undeclare API FIRST
                if (d.tv_on === false) {
                    try {
                        console.log("TV Off: Undeclaring members...");
                        await fetch('/api/members/undeclare', { method: 'POST' });
                    } catch(e) { console.error("Undeclare failed", e); }
                }

                // THEN force data reload and UI refresh
                Promise.all([m.loadMembers(), m.loadGuests()]).then(() => {
                    console.log("Data reloaded after TV status change.");
                    if (window.renderGrid) window.renderGrid();
                    if (window.renderGuestList) window.renderGuestList();
                });

                // Reset idle timer to wake up or restart screensaver
                if (window.resetIdle) {
                    const isOff = d.tv_on === false;
                    console.log(`Triggering resetIdle (priority=${isOff}) due to TV status change`);
                    window.resetIdle(isOff);
                }
                
                // Refresh screensaver if active
                const s = document.getElementById('screensaver');
                if (s && s.classList.contains('active')) {
                    if (window.renderScreensaverMembers) window.renderScreensaverMembers();
                }
            }
        });

    } catch { /* network not available yet */ }
}

export function initConnectionMonitor() {
    // Run immediately (with small delay for app to render)
    timers.setTimeout(_pollStatus, 1500);
    // Then poll every POLL_INTERVAL
    timers.setInterval(_pollStatus, POLL_INTERVAL);
}
