/* js/connection.js — USB and WiFi connection warning popups */

import { openSetting } from './settings.js';
import { timers } from './utils.js';
import { config, tvState, toggleTv, loadMembers, loadGuests } from './data.js';

const API_STATUS_URL = '/api/system/status';
const POLL_INTERVAL = 8000;       // 8 s
const WIFI_COOLDOWN = 2 * 60_000; // 2 min

let _usbConnected = true;
let _wifiConnected = true;
let _internetConnected = true;

let _lastRenderedWifiState = null;
let _lastRenderedInternetState = null;

function isOnboarding() {
    if (config.onboardingCompleted === false) return true;
    const layer = document.getElementById('onboarding-layer');
    if (!layer) return false;
    return !layer.classList.contains('hidden') &&
        layer.style.display !== 'none' &&
        layer.style.opacity !== '0';
}

// ─── USB Popup ────────────────────────────────────────────────────────────────
function injectUsbPopup() {
    if (isOnboarding()) return;
    let el = document.getElementById('usb-warning-overlay');
    if (!el) {
        el = document.createElement('div');
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
    }
    requestAnimationFrame(() => el.classList.add('visible'));
}

function hideUsbPopup() {
    const el = document.getElementById('usb-warning-overlay');
    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
}

export function setUsbState(connected) {
    const nextState = Boolean(connected);
    if (_usbConnected === nextState) return;
    _usbConnected = nextState;

    if (_usbConnected) {
        hideUsbPopup();
    } else {
        injectUsbPopup();
    }
}

// ─── WiFi Popup ───────────────────────────────────────────────────────────────
let _wifiCooldownTimer = null;
let _wifiPopupVisible = false;

function injectWifiPopup() {
    if (isOnboarding()) return;
    if (_wifiPopupVisible || _wifiCooldownTimer) return;

    const pwdOverlay = document.getElementById('wifi-password-overlay');
    if (pwdOverlay && pwdOverlay.classList.contains('active')) return;

    let el = document.getElementById('wifi-warning-overlay');
    if (!el) {
        el = document.createElement('div');
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
        document.getElementById('wifi-warn-dismiss').addEventListener('click', _dismissWifi);
        document.getElementById('wifi-warn-connect').addEventListener('click', () => {
            _dismissWifi();
            if (window.navTo) window.navTo('settings');
            timers.setTimeout(() => { if (window.openSetting) window.openSetting('connectivity'); }, 200);
        });
    }

    _wifiPopupVisible = true;
    requestAnimationFrame(() => el.classList.add('visible'));
}

function _dismissWifi() {
    const el = document.getElementById('wifi-warning-overlay');
    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
    _wifiPopupVisible = false;
    _wifiCooldownTimer = timers.setTimeout(() => {
        _wifiCooldownTimer = null;
        if (!_wifiConnected) injectWifiPopup();
    }, WIFI_COOLDOWN);
}

function hideWifiPopup() {
    const el = document.getElementById('wifi-warning-overlay');
    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
    _wifiPopupVisible = false;
    timers.clearTimeout(_wifiCooldownTimer);
    _wifiCooldownTimer = null;
}

export function setWifiState(connected) {
    const nextState = Boolean(connected);
    const changed = (_wifiConnected !== nextState);
    _wifiConnected = nextState;

    if (changed) {
        if (_wifiConnected) {
            hideWifiPopup();
        } else {
            injectWifiPopup();
        }
    }

    _updateSidebarWifiIcon();
    if (changed && window.refreshConnectivityUI) {
        window.refreshConnectivityUI();
    }
}

// ─── Internet Popup ───────────────────────────────────────────────────────────
let _internetCooldownTimer = null;
let _internetPopupVisible = false;

function injectInternetPopup() {
    if (isOnboarding()) return;
    if (_internetPopupVisible || _internetCooldownTimer) return;

    const pwdOverlay = document.getElementById('wifi-password-overlay');
    if (pwdOverlay && pwdOverlay.classList.contains('active')) return;

    let el = document.getElementById('internet-warning-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'internet-warning-overlay';
        el.className = 'conn-overlay';
        el.innerHTML = `
        <div class="conn-card">
            <div class="conn-icon" style="background:rgba(255,184,102,0.15)">
                <span class="material-symbols-rounded" style="color:#FFB866;font-size:40px">cloud_off</span>
            </div>
            <h3 class="conn-title">No Internet Connection</h3>
            <p class="conn-body">The system is connected to a network but cannot reach the internet. Please check your router.</p>
            <div class="conn-actions">
                <button class="conn-btn-secondary" id="internet-warn-dismiss">Dismiss</button>
                <button class="conn-btn-primary"   id="internet-warn-settings">Check Network</button>
            </div>
        </div>`;
        document.body.appendChild(el);
        document.getElementById('internet-warn-dismiss').addEventListener('click', _dismissInternet);
        document.getElementById('internet-warn-settings').addEventListener('click', () => {
            _dismissInternet();
            if (window.navTo) window.navTo('settings');
            timers.setTimeout(() => { if (window.openSetting) window.openSetting('connectivity'); }, 200);
        });
    }

    _internetPopupVisible = true;
    requestAnimationFrame(() => el.classList.add('visible'));
}

function _dismissInternet() {
    const el = document.getElementById('internet-warning-overlay');
    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
    _internetPopupVisible = false;
    _internetCooldownTimer = timers.setTimeout(() => {
        _internetCooldownTimer = null;
        if (!_internetConnected) injectInternetPopup();
    }, WIFI_COOLDOWN);
}

function hideInternetPopup() {
    const el = document.getElementById('internet-warning-overlay');
    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
    _internetPopupVisible = false;
    timers.clearTimeout(_internetCooldownTimer);
    _internetCooldownTimer = null;
}

export function setInternetState(connected) {
    const nextState = Boolean(connected);
    const changed = (_internetConnected !== nextState);
    _internetConnected = nextState;

    if (changed) {
        if (_internetConnected) {
            hideInternetPopup();
        } else {
            injectInternetPopup();
        }
    }

    _updateSidebarWifiIcon();
    if (changed && window.refreshConnectivityUI) {
        window.refreshConnectivityUI();
    }
}

function _updateSidebarWifiIcon() {
    if (_lastRenderedWifiState === _wifiConnected && _lastRenderedInternetState === _internetConnected) {
        return;
    }
    _lastRenderedWifiState = _wifiConnected;
    _lastRenderedInternetState = _internetConnected;

    const wifiIcon = document.getElementById('wifi-status-icon');
    if (!wifiIcon) return;

    wifiIcon.innerText = _wifiConnected ? 'wifi' : 'wifi_off';
    wifiIcon.classList.remove('online', 'offline', 'no-internet');

    if (_wifiConnected) {
        if (!_internetConnected) {
            wifiIcon.classList.add('no-internet');
            wifiIcon.title = 'No Internet';
            wifiIcon.style.color = '#FFB866';
        } else {
            wifiIcon.classList.add('online');
            wifiIcon.title = 'Connected';
            wifiIcon.style.color = '';
        }
    } else {
        wifiIcon.classList.add('offline');
        wifiIcon.title = 'Disconnected';
        wifiIcon.style.color = '';
    }
}

// ─── Unified Device State Handler ─────────────────────────────────────────────
export function applyDeviceState(d) {
    if (!d) return;

    // 1. USB State
    const usbOk = Boolean(d.usb_jack || d.hdmi_vcc || d.usb);
    setUsbState(usbOk);

    // 2. Wi-Fi State
    if (d.wifi !== undefined) {
        setWifiState(Boolean(d.wifi));
    }

    // 3. Internet State
    if (d.internet !== undefined) {
        setInternetState(Boolean(d.internet));
    }

    // 4. TV Status Icon
    const tvIcon = document.getElementById('tv-status-icon');
    if (tvIcon && d.tv_on !== undefined) {
        const isCurrentlyOnline = tvIcon.classList.contains('online');
        if (Boolean(d.tv_on) !== isCurrentlyOnline) {
            if (d.tv_on) {
                tvIcon.classList.add('online');
                tvIcon.classList.remove('offline');
            } else {
                tvIcon.classList.add('offline');
                tvIcon.classList.remove('online');
            }
        }
    }

    // 5. TV State Side Effects (members undeclare, screensaver, etc.)
    if (isOnboarding()) return;

    if (d.tv_on !== undefined && tvState.on !== Boolean(d.tv_on)) {
        const nextTvOn = Boolean(d.tv_on);
        console.log(`[TV Status Change] ${tvState.on} -> ${nextTvOn}`);
        toggleTv(nextTvOn);

        if (!nextTvOn) {
            fetch('/api/members/undeclare', { method: 'POST' }).catch(e => {
                console.error("Undeclare failed", e);
            });
        }

        Promise.all([loadMembers(), loadGuests()]).then(() => {
            console.log("Data reloaded after TV status change.");
            if (window.renderGrid) window.renderGrid();
            if (window.renderGuestList) window.renderGuestList();
        });

        if (window.resetIdle) {
            window.resetIdle(!nextTvOn);
        }

        const s = document.getElementById('screensaver');
        if (s && s.classList.contains('active')) {
            if (window.renderScreensaverMembers) window.renderScreensaverMembers();
        }
    }
}

// Expose globally for QtWebEngine push
window.applyDeviceState = applyDeviceState;

export function initConnectionMonitor() {
    // Polling removed: Qt now pushes state via window.applyDeviceState(state)
}