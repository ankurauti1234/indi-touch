/* js/connection.js — USB, WiFi and internet connection warning popups */

import { openSetting } from './settings.js';
import { timers } from './utils.js';
import { config } from './data.js';

const WIFI_COOLDOWN = 2 * 60_000; // 2 min

let _usbConnected = true;
let _wifiConnected = true;
let _internetConnected = true;

function isOnboarding() {
    if (config.onboardingCompleted === false) return true;

    const layer = document.getElementById('onboarding-layer');
    if (!layer) return false;

    // Layer is visible and doesn't have 'hidden' class
    return !layer.classList.contains('hidden') &&
        layer.style.display !== 'none' &&
        layer.style.opacity !== '0';
}


// ─── USB Popup ────────────────────────────────────────────────────────────────

function injectUsbPopup() {
    if (isOnboarding()) return;
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

    if (el) {
        el.classList.remove('visible');
        timers.setTimeout(() => el.remove(), 400);
    }
}

export function setUsbState(connected) {
    _usbConnected = connected;

    if (connected) {
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

    // Don't show if we are in the middle of connecting or entering password
    const pwdOverlay = document.getElementById('wifi-password-overlay');

    if (pwdOverlay && pwdOverlay.classList.contains('active')) return;

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
            <button class="conn-btn-primary" id="wifi-warn-connect">Connect to WiFi</button>
        </div>
    </div>`;

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));

    document
        .getElementById('wifi-warn-dismiss')
        .addEventListener('click', _dismissWifi);

    document
        .getElementById('wifi-warn-connect')
        .addEventListener('click', () => {
            _dismissWifi();

            if (window.navTo) {
                window.navTo('settings');
            }

            timers.setTimeout(() => {
                if (window.openSetting) {
                    window.openSetting('connectivity');
                }
            }, 200);
        });
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

        if (!_wifiConnected) {
            injectWifiPopup();
        }
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
    _wifiConnected = connected;

    if (connected) {
        hideWifiPopup();
    } else {
        injectWifiPopup();
    }

    _updateSidebarWifiIcon();

    if (window.refreshConnectivityUI) {
        window.refreshConnectivityUI();
    }
}


// ─── Internet Popup ───────────────────────────────────────────────────────────

let _internetCooldownTimer = null;
let _internetPopupVisible = false;

function injectInternetPopup() {
    if (isOnboarding()) return;
    if (_internetPopupVisible || _internetCooldownTimer) return;

    // Don't show if we are in the middle of connecting or entering password
    const pwdOverlay = document.getElementById('wifi-password-overlay');

    if (pwdOverlay && pwdOverlay.classList.contains('active')) return;

    if (document.getElementById('internet-warning-overlay')) return;

    _internetPopupVisible = true;

    const el = document.createElement('div');
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
            <button class="conn-btn-primary" id="internet-warn-settings">Check Network</button>
        </div>
    </div>`;

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));

    document
        .getElementById('internet-warn-dismiss')
        .addEventListener('click', _dismissInternet);

    document
        .getElementById('internet-warn-settings')
        .addEventListener('click', () => {
            _dismissInternet();

            if (window.navTo) {
                window.navTo('settings');
            }

            timers.setTimeout(() => {
                if (window.openSetting) {
                    window.openSetting('connectivity');
                }
            }, 200);
        });
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

        if (!_internetConnected) {
            injectInternetPopup();
        }
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
    _internetConnected = connected;

    if (connected) {
        hideInternetPopup();
    } else {
        injectInternetPopup();
    }

    _updateSidebarWifiIcon();

    if (window.refreshConnectivityUI) {
        window.refreshConnectivityUI();
    }
}


// ─── Sidebar WiFi Icon ─────────────────────────────────────────────────────────

function _updateSidebarWifiIcon() {
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


// ─── Unified Device State ─────────────────────────────────────────────────────

/**
 * Single entry point for connection state supplied by the Qt/Python layer.
 *
 * app.py provides:
 *   - usb_jack
 *   - hdmi_vcc
 *   - wifi
 *   - internet
 *   - tv_on
 *
 * There is intentionally no independent HTTP polling here.
 */
window.applyDeviceState = function (state) {
    if (!state || typeof state !== 'object') {
        return;
    }

    // USB: either jack or HDMI counts as connected.
    const usbOk = Boolean(state.usb_jack || state.hdmi_vcc);

    if (usbOk !== _usbConnected) {
        setUsbState(usbOk);
    }

    if (Boolean(state.wifi) !== _wifiConnected) {
        setWifiState(Boolean(state.wifi));
    } else if (state.wifi && document.getElementById('wifi-warning-overlay')) {
        hideWifiPopup();
    }

    if (Boolean(state.internet) !== _internetConnected) {
        setInternetState(Boolean(state.internet));
    } else if (
        state.internet &&
        document.getElementById('internet-warning-overlay')
    ) {
        hideInternetPopup();
    }

    // Keep the sidebar icon synchronized even when only USB/TV changes.
    _updateSidebarWifiIcon();

    // TV status icon.
    const tvIcon = document.getElementById('tv-status-icon');

    if (tvIcon) {
        if (state.tv_on) {
            tvIcon.classList.add('online');
            tvIcon.classList.remove('offline');
        } else {
            tvIcon.classList.add('offline');
            tvIcon.classList.remove('online');
        }
    }

    // Handle TV state changes and the associated application behavior.
    import('./data.js').then(async m => {
        if (m.tvState.on === state.tv_on) {
            return;
        }

        console.log(`[TV Status Change] ${m.tvState.on} -> ${state.tv_on}`);

        m.toggleTv(state.tv_on);

        // If TV just went off, call undeclare API FIRST.
        if (state.tv_on === false) {
            try {
                console.log("TV Off: Undeclaring members...");
                await fetch('/api/members/undeclare', {
                    method: 'POST'
                });
            } catch (e) {
                console.error("Undeclare failed", e);
            }
        }

        // THEN force data reload and UI refresh.
        Promise.all([
            m.loadMembers(),
            m.loadGuests()
        ]).then(() => {
            console.log("Data reloaded after TV status change.");

            if (window.renderGrid) {
                window.renderGrid();
            }

            if (window.renderGuestList) {
                window.renderGuestList();
            }
        });

        // Reset idle timer to wake up or restart screensaver.
        if (window.resetIdle) {
            const isOff = state.tv_on === false;

            console.log(
                `Triggering resetIdle (priority=${isOff}) due to TV status change`
            );

            window.resetIdle(isOff);
        }

        // Refresh screensaver if active.
        const screensaver = document.getElementById('screensaver');

        if (
            screensaver &&
            screensaver.classList.contains('active') &&
            window.renderScreensaverMembers
        ) {
            window.renderScreensaverMembers();
        }
    });
};


// ─── Initialization ────────────────────────────────────────────────────────────

export function initConnectionMonitor() {
    /*
     * Connection state is now supplied by app.py through
     * window.applyDeviceState().
     *
     * No HTTP polling is started here.
     */
}