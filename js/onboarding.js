import { t } from './i18n.js';
import { config, save } from './data.js';

let currentStep = 1;
const totalSteps = 9; 

let selectedSsid = '';
let isSsidLocked = false;
let isAlreadyConnected = false;

// ── BLE Smart Plug & Calibration State ──────────────────────────────────────
let selectedPlugMac = '';
let calibStage = 'INIT'; // 'INIT' -> 'SWITCH_PROMPT' -> 'DONE'
let firstCapturedType = null; // 'ON' or 'OFF'
let offBaselineWatt = null;
let onBaselineWatt = null;
let liveWattPollInterval = null;
let isCalibRunning = false; // Abort flag for the 30s sampling loop

export async function nextStep() {
    if (!validateStep(currentStep)) return;

    // Special transition logic for WiFi setup
    if (currentStep === 2) {
        if (isAlreadyConnected) {
            animateStep(2, 4);
            currentStep = 4;
            handleStepLogic(currentStep);
            return;
        }

        const selected = document.querySelector('.net-item.selected');
        if (!selected) return;
        
        selectedSsid = selected.querySelector('.net-name').innerText;
        isSsidLocked = selected.dataset.locked === 'true';

        if (isSsidLocked) {
            animateStep(2, 3);
            currentStep = 3;
            handleStepLogic(currentStep);
            return;
        } else {
            animateStep(2, 4);
            currentStep = 4;
            handleStepLogic(currentStep);
            return;
        }
    }

    if (currentStep === 3) {
        const connected = await connectOnboardWifi();
        if (!connected) return;
    }

    animateStep(currentStep, currentStep + 1);
    currentStep++;
    
    if (currentStep <= totalSteps) {
        handleStepLogic(currentStep);
    } else {
        completeSetup();
    }
}

export function prevStep() {
    if (currentStep <= 1) return;

    // Immediately halt calibration sampling if navigating back from Step 6
    if (currentStep === 6) {
        stopCalibrationMonitor();
    }

    if (currentStep === 4) {
        if (isAlreadyConnected || !isSsidLocked) {
            animateStep(4, 2);
            currentStep = 2;
            return;
        }
    }

    animateStep(currentStep, currentStep - 1);
    currentStep--;
    handleStepLogic(currentStep);
}

function animateStep(from, to) {
    const fromEl = document.getElementById(`step-${from}`);
    const toEl = document.getElementById(`step-${to}`);
    
    if (fromEl) {
        fromEl.classList.remove('active');
        fromEl.classList.add('prev');
    }
    
    if (toEl) {
        toEl.classList.remove('prev');
        toEl.classList.add('active');
    }
}

export function selectNet(el) {
    document.querySelectorAll('#onboard-wifi-list .net-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    
    const nextBtn = document.getElementById('btn-next-2');
    if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.innerText = el.classList.contains('connected') ? 'Proceed' : 'Next';
    }

    const ssid = el.querySelector('.net-name').innerText;
    const targetHeader = document.getElementById('onboard-target-ssid');
    if (targetHeader) targetHeader.innerText = ssid;
    
    isAlreadyConnected = el.classList.contains('connected');
}

export async function refreshWifi() {
    const list = document.getElementById('onboard-wifi-list');
    if (!list) return;
    
    list.innerHTML = '<div class="wifi-skeleton">Searching for networks...</div>';
    list.style.pointerEvents = 'none';
    
    try {
        let currentSsid = '';
        try {
            const cr = await fetch('/api/wifi/current');
            const cd = await cr.json();
            if (cd.connected) currentSsid = cd.ssid;
        } catch(e) {}

        const r = await fetch('/api/wifi/networks');
        const data = await r.json();
        if (!data.success) throw new Error(data.error);

        let nets = data.networks || [];
        nets.sort((a, b) => {
            if (a.ssid === currentSsid) return -1;
            if (b.ssid === currentSsid) return 1;
            return b.signal - a.signal;
        });

        if (nets.length === 0 && !currentSsid) {
            list.innerHTML = '<div class="wifi-skeleton">No networks found.</div>';
            return;
        }

        list.innerHTML = nets.map(n => {
            const isCurr = n.ssid === currentSsid;
            return `
                <div class="net-item ${isCurr ? 'connected' : ''}" onclick="selectNet(this)" data-locked="${!n.open}">
                    <div class="net-signal">
                        <span class="material-symbols-rounded" style="${isCurr ? 'color:var(--primary)' : ''}">wifi</span>
                        <span class="net-name">${n.ssid}</span>
                        ${isCurr ? '<span class="onboard-wifi-badge">Connected</span>' : ''}
                    </div>
                    <span class="material-symbols-rounded">${isCurr ? 'check_circle' : (n.open ? 'lock_open' : 'lock')}</span>
                </div>
            `;
        }).join('');

        if (currentSsid) {
            const currEl = list.querySelector('.net-item.connected');
            if (currEl) selectNet(currEl);
        }
    } catch (e) {
        list.innerHTML = `<div class="wifi-skeleton">Error: ${e.message}</div>`;
    } finally {
        list.style.pointerEvents = 'all';
    }
}

export function toggleOnboardPass() {
    const input = document.getElementById('onboard-wifi-pass');
    const eye = document.getElementById('onboard-pass-eye');
    if (!input || !eye) return;
    
    if (input.type === 'password') {
        input.type = 'text';
        eye.innerText = 'visibility_off';
    } else {
        input.type = 'password';
        eye.innerText = 'visibility';
    }
}

async function connectOnboardWifi() {
    const pwd = document.getElementById('onboard-wifi-pass').value;
    const btn = document.getElementById('btn-next-3');

    if (btn) {
        btn.classList.add('loading');
        btn.disabled = true;
    }

    try {
        const r = await fetch('/api/wifi/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid: selectedSsid, password: pwd })
        });
        const d = await r.json();
        
        if (d.success) {
            return true;
        } else {
            if (window.showToast) window.showToast(d.error || "Failed to initiate connection");
            return false;
        }
    } catch (e) {
        if (window.showToast) window.showToast("Network error: " + e.message);
        return false;
    } finally {
        if (btn) {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }
}

function validateStep(step) {
    if (step === 2) return document.querySelector('#onboard-wifi-list .net-item.selected') !== null;
    if (step === 3) return document.getElementById('onboard-wifi-pass').value.length >= 8 || !isSsidLocked;
    if (step === 5) return !!selectedPlugMac;
    if (step === 6) return calibStage === 'DONE';
    if (step === 7) return document.getElementById('inp-hhid-digits').value.length === 4;
    if (step === 8) return document.getElementById('inp-otp').value.length === 4;
    return true;
}

async function handleStepLogic(step) {
    if (step === 2) refreshWifi();

    if (step === 4) startConnectivityPolling();
    else stopConnectivityPolling();

    if (step === 5) refreshBlePlugs();

    if (step === 6) startCalibrationMonitor();
    else stopCalibrationMonitor();

    if (step === 9) window.finalizeSetup();
}

let connInterval = null;
function startConnectivityPolling() {
    if (connInterval) clearInterval(connInterval);
    runConnectivityChecks();
    connInterval = setInterval(runConnectivityChecks, 2000);
}

function stopConnectivityPolling() {
    if (connInterval) {
        clearInterval(connInterval);
        connInterval = null;
    }
}

async function runConnectivityChecks() {
    try {
        const r = await fetch('/api/onboarding/connectivity');
        const d = await r.json();

        setCheckState('hw-wifi', d.wifi);
        setCheckState('hw-input', d.jack || d.hdmi);
        
        if (d.hdmi) {
            const videoEl = document.getElementById('hw-video');
            if (videoEl) {
                videoEl.style.display = 'flex';
                setCheckState('hw-video', d.video);
            }
        }

        const wifiOk = !!d.wifi;
        const inputOk = !!d.jack || (!!d.hdmi && !!d.video);
        const allOk = wifiOk && inputOk;

        const nextBtn = document.getElementById('btn-next-4');
        if (nextBtn) {
            nextBtn.disabled = !allOk;
        }
    } catch(e) {
        console.error("Connectivity check failed", e);
    }
}

function setCheckState(id, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pending', 'done', 'fail');
    el.classList.add(ok ? 'done' : 'pending');
}

// ── Step 5: BLE Discovery & Selection ─────────────────────────────────────────
export async function refreshBlePlugs() {
    const list = document.getElementById('onboard-ble-list');
    if (!list) return;

    list.innerHTML = '<div class="wifi-skeleton">Searching for Smart Plugs...</div>';
    list.style.pointerEvents = 'none';

    try {
        const r = await fetch('/api/onboarding/ble/scan');
        const d = await r.json();
        const devices = d.devices || [];

        if (devices.length === 0) {
            list.innerHTML = '<div class="wifi-skeleton">No Smart Plugs found. Ensure plug is powered ON.</div>';
            return;
        }

        list.innerHTML = devices.map(dev => `
            <div class="net-item ${dev.is_paired ? 'selected' : ''}" onclick="selectPlug(this, '${dev.mac}')">
                <div class="net-signal">
                    <span class="material-symbols-rounded">power</span>
                    <span class="net-name">${dev.name}</span>
                    <span style="font-size:12px; opacity:0.6; font-family:monospace;">${dev.mac}</span>
                    ${dev.is_paired ? '<span class="onboard-wifi-badge">Paired</span>' : ''}
                </div>
                <span class="material-symbols-rounded">${dev.is_paired ? 'check_circle' : 'radio_button_unchecked'}</span>
            </div>
        `).join('');

        if (d.paired_mac) {
            selectedPlugMac = d.paired_mac;
            const btn = document.getElementById('btn-next-5');
            if (btn) btn.disabled = false;
        }
    } catch (e) {
        list.innerHTML = `<div class="wifi-skeleton">Scan error: ${e.message}</div>`;
    } finally {
        list.style.pointerEvents = 'all';
    }
}

export async function selectPlug(el, mac) {
    document.querySelectorAll('#onboard-ble-list .net-item').forEach(i => {
        i.classList.remove('selected');
        const icon = i.querySelector('.material-symbols-rounded:last-child');
        if (icon) icon.innerText = 'radio_button_unchecked';
    });

    el.classList.add('selected');
    const icon = el.querySelector('.material-symbols-rounded:last-child');
    if (icon) icon.innerText = 'check_circle';

    selectedPlugMac = mac;
    const btn = document.getElementById('btn-next-5');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('loading');
    }

    try {
        await fetch('/api/onboarding/ble/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac })
        });
        if (btn) btn.disabled = false;
    } catch (_) {
        if (btn) btn.disabled = false;
    } finally {
        if (btn) btn.classList.remove('loading');
    }
}

// ── Step 6: Power Calibration (30-Second Adaptive Workflow) ───────────────────
export function startCalibrationMonitor() {
    stopCalibrationMonitor();
    calibStage = 'INIT';
    firstCapturedType = null;
    offBaselineWatt = null;
    onBaselineWatt = null;
    isCalibRunning = false;

    resetCalibItem('chk-calib-off', 'tv_off', 'TV Standby (OFF) Load', 'Awaiting capture (30s test)');
    resetCalibItem('chk-calib-on', 'tv', 'TV Active (ON) Load', 'Awaiting capture (30s test, Max Volume)');

    const nextBtn = document.getElementById('btn-next-6');
    if (nextBtn) nextBtn.disabled = true;

    const prog = document.getElementById('calib-progress-container');
    if (prog) prog.style.display = 'none';

    const actionBtn = document.getElementById('btn-calib-action');
if (actionBtn) {
    actionBtn.style.display = 'flex';
    actionBtn.onclick = (e) => {
        e.preventDefault();
        if (!actionBtn.disabled && !isCalibRunning) {
            triggerCalibrationStep();
        }
    };
}

    pollLiveWatt();
    liveWattPollInterval = setInterval(pollLiveWatt, 1000);
}

export function stopCalibrationMonitor() {
    isCalibRunning = false; // Immediately halts any active sampling loop
    if (liveWattPollInterval) {
        clearInterval(liveWattPollInterval);
        liveWattPollInterval = null;
    }
    const prog = document.getElementById('calib-progress-container');
    if (prog) prog.style.display = 'none';
}

function resetCalibItem(elemId, iconName, title, sub) {
    const el = document.getElementById(elemId);
    if (!el) return;
    el.className = 'calib-pill pending';
    const spinner = el.querySelector('.chk-spinner');
    if (spinner) spinner.style.display = 'none';
    const icon = el.querySelector('.calib-pill-icon');
    if (icon) {
        icon.style.display = 'block';
        icon.innerText = iconName;
    }
    const statusIcon = document.getElementById(`${elemId}-status`);
    if (statusIcon) {
        statusIcon.style.display = 'block';
        statusIcon.innerText = 'radio_button_unchecked';
    }
    const subEl = document.getElementById(`${elemId}-sub`);
    if (subEl) subEl.innerText = sub;
}

function markCalibItemRunning(elemId) {
    const el = document.getElementById(elemId);
    if (!el) return;
    el.className = 'calib-pill running';
    const spinner = el.querySelector('.chk-spinner');
    if (spinner) spinner.style.display = 'block';
    const statusIcon = document.getElementById(`${elemId}-status`);
    if (statusIcon) statusIcon.style.display = 'none';
}

function markCalibItemDone(elemId, iconName, measuredWatt) {
    const el = document.getElementById(elemId);
    if (!el) return;
    el.className = 'calib-pill done';
    const spinner = el.querySelector('.chk-spinner');
    if (spinner) spinner.style.display = 'none';
    const icon = el.querySelector('.calib-pill-icon');
    if (icon) {
        icon.style.display = 'block';
        icon.innerText = iconName;
    }
    const statusIcon = document.getElementById(`${elemId}-status`);
    if (statusIcon) {
        statusIcon.style.display = 'block';
        statusIcon.innerText = 'check_circle';
    }
    const subEl = document.getElementById(`${elemId}-sub`);
    if (subEl) subEl.innerText = `Captured: ${measuredWatt.toFixed(1)} W`;
}

function updatePrompt(mainText, detailText = '') {
    const promptEl = document.getElementById('calib-prompt-box');
    if (!promptEl) return;
    promptEl.innerHTML = `
        <div class="calib-prompt-main">${mainText}</div>
        <div class="calib-prompt-detail">${detailText}</div>
    `;
}

function setButtonState(btn, enabled, text) {
    if (!btn) return;
    btn.disabled = !enabled;
    if (enabled) {
        btn.removeAttribute('disabled');
    } else {
        btn.setAttribute('disabled', 'true');
    }
    // Never set pointerEvents = 'none' inline on the element;
    // let native button disabled handle state so click/touch hitboxes don't corrupt
    btn.style.pointerEvents = 'auto';

    const textSpan = document.getElementById('btn-calib-text');
    if (textSpan && text) textSpan.innerText = text;
}

async function pollLiveWatt() {
    // If 30s test is currently sampling, do not alter button or prompts
    if (isCalibRunning) return;

    try {
        const r = await fetch('/api/onboarding/ble/live-watt');
        if (!r.ok) return;
        const d = await r.json();

        const wattEl = document.getElementById('calib-live-watt');
        const stateEl = document.getElementById('calib-live-state');
        const actionBtn = document.getElementById('btn-calib-action');

        const liveWatt = (typeof d.watt === 'number') ? d.watt : 0.0;
        if (wattEl) wattEl.innerText = `${liveWatt.toFixed(1)} W`;

        // >= 10.0W is defined as physically ON
        const isTvOn = liveWatt >= 10.0;

        if (stateEl) {
            stateEl.innerText = d.connected ? (isTvOn ? 'TV IS ON' : 'TV IS OFF / STANDBY') : 'DISCONNECTED';
            stateEl.style.background = d.connected ? (isTvOn ? 'rgba(100,210,154,0.2)' : 'rgba(255,255,255,0.1)') : 'rgba(255,100,100,0.2)';
            stateEl.style.color = d.connected ? (isTvOn ? '#64d29a' : '#fff') : '#ff8080';
        }

        if (!d.connected) {
            updatePrompt("Smart Plug not communicating.", "Please ensure the wall outlet switch is ON.");
            if (actionBtn) {
                actionBtn.style.display = 'flex';
                setButtonState(actionBtn, false, "Plug Disconnected");
            }
            return;
        }

        // ── STAGE 1: Initial Detection & Setup ──
        if (calibStage === 'INIT') {
            if (actionBtn) actionBtn.style.display = 'flex';

            if (isTvOn) {
                firstCapturedType = 'ON';
                updatePrompt("TV is ON", "Please set the TV volume to MAXIMUM, then tap below.");
                setButtonState(actionBtn, true, "Capture TV ON Baseline (30s)");
            } else {
                firstCapturedType = 'OFF';
                updatePrompt("TV is in Standby / OFF", "Ensure screen is dark, then tap below to begin.");
                setButtonState(actionBtn, true, "Capture TV OFF Baseline (30s)");
            }
        } 
        // ── STAGE 2: Validate Physical State Flip Before Unlocking Second Test ──
        else if (calibStage === 'SWITCH_PROMPT') {
            if (actionBtn) actionBtn.style.display = 'flex';

            if (firstCapturedType === 'ON') {
                // Must be physically turned OFF (< 10W or dropped by at least 12W from ON baseline)
                const isReadyOff = !isTvOn || (onBaselineWatt !== null && (onBaselineWatt - liveWatt) >= 12.0);

                if (isReadyOff) {
                    updatePrompt("TV Standby Detected", "Tap below to capture the TV Standby baseline.");
                    setButtonState(actionBtn, true, "Capture TV OFF Baseline (30s)");
                } else {
                    updatePrompt("Please turn the TV OFF", "Waiting for TV to turn off...");
                    setButtonState(actionBtn, false, "Waiting for TV to turn OFF...");
                }
            } else {
                // Must be physically turned ON (>= 10W or rose by at least 10W above OFF baseline)
                const isReadyOn = isTvOn || (offBaselineWatt !== null && (liveWatt - offBaselineWatt) >= 10.0);

                if (isReadyOn) {
                    updatePrompt("TV Active Load Detected", "Set volume to MAXIMUM, then tap below.");
                    setButtonState(actionBtn, true, "Capture TV ON Baseline (30s)");
                } else {
                    updatePrompt("Please turn the TV ON", "Waiting for TV to turn on...");
                    setButtonState(actionBtn, false, "Waiting for TV to turn ON...");
                }
            }
        }
    } catch (err) {
        console.error("[Calibration] pollLiveWatt error:", err);
    }
}

export async function triggerCalibrationStep() {
    const actionBtn = document.getElementById('btn-calib-action');
    const progContainer = document.getElementById('calib-progress-container');
    const progBar = document.getElementById('calib-progress-bar');
    const progLabel = document.getElementById('calib-progress-label');

    // 1. Hide the action button completely during the 30-second measurement
    if (actionBtn) {
        setButtonState(actionBtn, false);
        actionBtn.style.display = 'none';
    }

    // 2. Show the animated progress bar
    if (progContainer) progContainer.style.display = 'flex';
    if (progBar) progBar.style.width = '0%';

    const targetType = (calibStage === 'INIT') ? firstCapturedType : (firstCapturedType === 'ON' ? 'OFF' : 'ON');
    const currentChkId = (targetType === 'ON') ? 'chk-calib-on' : 'chk-calib-off';

    markCalibItemRunning(currentChkId);
    updatePrompt(
        `Measuring ${targetType} Baseline...`, 
        targetType === 'ON' ? "Keep volume at MAXIMUM for full 30 seconds." : "Keep TV in standby mode."
    );

    isCalibRunning = true;
    const totalSeconds = 30;
    const updateIntervalMs = 100;
    const totalStepsCount = (totalSeconds * 1000) / updateIntervalMs;
    let stepCount = 0;
    let samples = [];

    // 3. Sampling loop with instantaneous navigation abort
    while (stepCount <= totalStepsCount) {
        if (!isCalibRunning) {
            if (progContainer) progContainer.style.display = 'none';
            resetCalibItem(currentChkId, targetType === 'ON' ? 'tv' : 'tv_off', `${targetType} Load`, 'Cancelled');
            return;
        }

        const pct = (stepCount / totalStepsCount) * 100;
        if (progBar) progBar.style.width = `${pct}%`;
        const remainingSec = Math.max(0, Math.ceil(totalSeconds - (stepCount * (updateIntervalMs / 1000))));
        if (progLabel) progLabel.innerText = `Sampling ${targetType} (${remainingSec}s remaining)`;

        // Query live wattage once every second
        if (stepCount % 10 === 0) {
            try {
                const r = await fetch('/api/onboarding/ble/live-watt');
                if (r.ok) {
                    const d = await r.json();
                    if (d.connected && typeof d.watt === 'number') samples.push(d.watt);
                }
            } catch (_) {}
        }

        stepCount++;
        await new Promise(r => setTimeout(r, updateIntervalMs));
    }

    isCalibRunning = false;
    if (progContainer) progContainer.style.display = 'none';

    const avg = samples.length ? (samples.reduce((a, b) => a + b, 0) / samples.length) : 0;

    // 4. Advance State Machine
    if (calibStage === 'INIT') {
        if (firstCapturedType === 'ON') {
            onBaselineWatt = avg;
            markCalibItemDone('chk-calib-on', 'tv', avg);
            calibStage = 'SWITCH_PROMPT';
            updatePrompt("Active Load Verified", "Please turn the TV OFF.");
        } else {
            offBaselineWatt = avg;
            markCalibItemDone('chk-calib-off', 'tv_off', avg);
            calibStage = 'SWITCH_PROMPT';
            updatePrompt("Standby Load Verified", "Please turn the TV ON and set volume to MAXIMUM.");
        }

        // Re-display button in disabled state until TV state physically flips
        if (actionBtn) {
            actionBtn.style.display = 'flex';
            setButtonState(actionBtn, false, firstCapturedType === 'ON' ? "Waiting for TV to turn OFF..." : "Waiting for TV to turn ON...");
        }
        pollLiveWatt();
    } else if (calibStage === 'SWITCH_PROMPT') {
        if (firstCapturedType === 'ON') {
            offBaselineWatt = avg;
            markCalibItemDone('chk-calib-off', 'tv_off', avg);
        } else {
            onBaselineWatt = avg;
            markCalibItemDone('chk-calib-on', 'tv', avg);
        }

        calibStage = 'DONE';
        if (actionBtn) actionBtn.style.display = 'none';

        updatePrompt(
            "✔ Calibration Complete", 
            `Standby: ${offBaselineWatt.toFixed(1)} W  |  Active: ${onBaselineWatt.toFixed(1)} W`
        );

        // Commit thresholds to the backend
        await fetch('/api/onboarding/ble/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on_baseline: onBaselineWatt, off_baseline: offBaselineWatt })
        });

        const nextBtn = document.getElementById('btn-next-6');
        if (nextBtn) nextBtn.disabled = false;
    }
}

window.finalizeSetup = async () => {
    console.log("[Onboard] Finalizing setup...");
    const log = document.getElementById('install-log');
    const hhid = document.getElementById('inp-hhid-digits').value;
    const retryBtn = document.getElementById('retry-finalize-btn');

    if (retryBtn) retryBtn.style.display = 'none';

    try {
        if(log) log.innerText = `Fetching members for HH${hhid}...`;
        
        const r = await fetch('/api/onboarding/finalize', { method: 'POST' });
        const d = await r.json();
        
        console.log("[Onboard] Finalize Response:", d);

        if (d.success) {
            if(log) log.innerText = `Successfully synced ${d.member_count} members.`;
            if (window.loadMembers) await window.loadMembers();
            setTimeout(completeSetup, 2000);
        } else {
            if(log) log.innerText = `Cloud request error: ${d.error || 'Timed out'}`;
            if (retryBtn) retryBtn.style.display = 'flex';
        }
    } catch(e) {
        console.error("[Onboard] Finalize Error:", e);
        if(log) log.innerText = `Network error: ${e.message}`;
        if (retryBtn) retryBtn.style.display = 'flex';
    }
};

export function completeSetup() {
    config.onboardingCompleted = true;
    
    const layer = document.getElementById('onboarding-layer');
    if (layer) {
        layer.classList.add('hidden');
        setTimeout(() => layer.style.display = 'none', 600);
    }
    
    if (window.loadMembers) {
        window.loadMembers().then(() => {
            if (window.renderGrid) window.renderGrid();
        });
    }
}

export async function checkOnboardingStatus() {
    const layer = document.getElementById('onboarding-layer');
    if (!layer) return;

    const hhidWrapper = document.querySelector('.hhid-input-wrapper');
    if (hhidWrapper) {
        hhidWrapper.onclick = () => {
            const inp = document.getElementById('inp-hhid-digits');
            if (inp) inp.focus();
        };
    }

    try {
        const r = await fetch('/api/onboarding/status');
        const d = await r.json();
        
        if (d.installed) {
            config.onboardingCompleted = true;
            layer.style.display = 'none';
            return true;
        }
    } catch(e) {
        console.warn("Could not check onboarding status on disk", e);
    }

    if (config.onboardingCompleted === false) {
        layer.style.display = 'flex';
        layer.classList.remove('hidden');
        return false;
    }

    layer.style.display = 'none';
    layer.classList.add('hidden');
    return true;
}

window.submitHHID = async () => {
    const digits = document.getElementById('inp-hhid-digits').value;
    const btn = document.getElementById('btn-next-7');
    const meter_id = config.meter_id || 'M123456';

    if (btn) btn.classList.add('loading');

    try {
        const r = await fetch('/api/onboarding/initiate-assignment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meter_id: meter_id, hhid: digits })
        });
        const d = await r.json();
        if (d.success) {
            nextStep();
        } else {
            if (window.showToast) window.showToast(d.message || d.error || "Failed to initiate assignment");
        }
    } catch(e) {
        if (window.showToast) window.showToast("Network error: " + e.message);
    } finally {
        if (btn) btn.classList.remove('loading');
    }
};

window.submitOTP = async () => {
    const otp = document.getElementById('inp-otp').value;
    const digits = document.getElementById('inp-hhid-digits').value;
    const btn = document.getElementById('btn-next-8');
    const meter_id = config.meter_id || 'M123456';

    if (btn) btn.classList.add('loading');

    try {
        const r = await fetch('/api/onboarding/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meter_id: meter_id, hhid: digits, otp: otp })
        });
        const d = await r.json();
        if (d.success) {
            nextStep();
        } else {
            if (window.showToast) window.showToast(d.message || d.error || "Invalid OTP");
        }
    } catch(e) {
        if (window.showToast) window.showToast("Network error: " + e.message);
    } finally {
        if (btn) btn.classList.remove('loading');
    }
};

window.toggleOnboardInfo = async () => {
    const el = document.getElementById('onboard-info-popover');
    if (!el) return;
    
    const isActive = el.classList.toggle('active');
    if (isActive) {
        try {
            const r = await fetch('/api/system/status');
            const d = await r.json();
            
            document.getElementById('onboard-info-id').innerText = d.meter_id || '...';
            
            const netSec = document.getElementById('onboard-info-net-section');
            if (d.internet) {
                netSec.style.display = 'block';
                document.getElementById('onboard-info-ip').innerText = d.ip_address || '...';
                
                try {
                    const wr = await fetch('/api/wifi/current');
                    const wd = await wr.json();
                    document.getElementById('onboard-info-ssid').innerText = wd.ssid || 'Not connected';
                } catch {
                    document.getElementById('onboard-info-ssid').innerText = 'Unknown';
                }
            } else {
                netSec.style.display = 'none';
            }
        } catch (e) {
            console.error("Failed to load onboard info", e);
        }
    }
};

// ── Expose Handlers Explicitly to Window ──────────────────────────────────────
window.nextStep = nextStep;
window.prevStep = prevStep;
window.selectNet = selectNet;
window.refreshWifi = refreshWifi;
window.toggleOnboardPass = toggleOnboardPass;
window.refreshBlePlugs = refreshBlePlugs;
window.selectPlug = selectPlug;
window.triggerCalibrationStep = triggerCalibrationStep;