import { t } from './i18n.js';
import { config, save } from './data.js';

let currentStep = 1;
const totalSteps = 7; 

let selectedSsid = '';
let isSsidLocked = false;
let isAlreadyConnected = false;

export async function nextStep() {
    if (!validateStep(currentStep)) return;

    // Special logic for transitions
    if (currentStep === 2) {
        if (isAlreadyConnected) {
            // If already connected, skip to hardware check (Step 4)
            animateStep(2, 4);
            currentStep = 4;
            handleStepLogic(currentStep);
            return;
        }

        const selected = document.querySelector('.net-item.selected');
        if (!selected) return;
        
        selectedSsid = selected.querySelector('.net-name').innerText;
        isSsidLocked = selected.dataset.locked === 'true';

        if (!isSsidLocked) {
            // Skip Step 3 (Password) if open
            animateStep(2, 4);
            currentStep = 4;
            handleStepLogic(currentStep);
            return;
        }
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

    if (currentStep === 4) {
        if (isAlreadyConnected || !isSsidLocked) {
            animateStep(4, 2);
            currentStep = 2;
            return;
        }
    }

    animateStep(currentStep, currentStep - 1);
    currentStep--;
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
        // First check current connection
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
        
        // Sort: Current connected first, then signal strength
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

        // If connected, auto-select it
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

function validateStep(step) {
    if (step === 2) return document.querySelector('#onboard-wifi-list .net-item.selected') !== null;
    if (step === 3) return document.getElementById('onboard-wifi-pass').value.length >= 8 || !isSsidLocked;
    if (step === 5) return document.getElementById('inp-hhid-digits').value.length === 4;
    if (step === 6) return document.getElementById('inp-otp').value.length === 4;
    return true;
}

async function handleStepLogic(step) {
    // Step 2: WiFi Scan (Auto-load)
    if (step === 2) {
        refreshWifi();
    }

    // Step 4: Hardware & File Checks
    if (step === 4) {
        // If we came from password and NOT already connected
        if (currentStep === 4 && isSsidLocked && !isAlreadyConnected) {
           const pwd = document.getElementById('onboard-wifi-pass').value;
           try {
               await fetch('/api/wifi/connect', {
                   method: 'POST',
                   headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify({ ssid: selectedSsid, password: pwd })
               });
           } catch(e) {}
        }

        // Run connectivity checks loop
        startConnectivityPolling();
    }

    if (step !== 4) {
        stopConnectivityPolling();
    }

    // Step 7: Finalize
    if (step === 7) {
        finalizeSetup();
    }
}

let connInterval = null;
function startConnectivityPolling() {
    if (connInterval) clearInterval(connInterval);
    runConnectivityChecks(); // First run immediate
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
        console.log("[Connectivity Check]", d);

        setCheckState('hw-wifi', d.wifi);
        setCheckState('hw-input', d.jack || d.hdmi);
        
        if (d.hdmi) {
            const videoEl = document.getElementById('hw-video');
            if (videoEl) {
                videoEl.style.display = 'flex';
                setCheckState('hw-video', d.video);
            }
        }

        // wifi required, and either jack OR (hdmi + video)
        const wifiOk = !!d.wifi;
        const inputOk = !!d.jack || (!!d.hdmi && !!d.video);

        const allOk = wifiOk && inputOk;
        console.log("[Connectivity Result]", { wifiOk, inputOk, allOk });

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

async function finalizeSetup() {
    console.log("[Onboard] Finalizing setup...");
    const log = document.getElementById('install-log');
    const hhid = document.getElementById('inp-hhid-digits').value;

    try {
        if(log) log.innerText = `Fetching members for HH${hhid}...`;
        
        // Call the backend proxy instead of direct cloud access or local DB
        const r = await fetch('/api/onboarding/finalize', { method: 'POST' });
        const d = await r.json();
        
        console.log("[Onboard] Finalize Response:", d);

        if (d.success) {
            if(log) log.innerText = `Successfully synced ${d.member_count} members.`;
            
            // Reload members from DB to sync UI
            if (window.loadMembers) await window.loadMembers();
            
            setTimeout(completeSetup, 2000);
        } else {
            if(log) log.innerText = `Error: ${d.error || 'Failed to fetch members'}`;
        }
    } catch(e) {
        console.error("[Onboard] Finalize Error:", e);
        if(log) log.innerText = `Error: ${e.message}`;
    }
}

export function completeSetup() {
    config.onboardingCompleted = true;
    
    const layer = document.getElementById('onboarding-layer');
    if (layer) {
        layer.classList.add('hidden');
        setTimeout(() => layer.style.display = 'none', 600);
    }
    
    // Refresh UI
    if (window.loadMembers) window.loadMembers();
}

export async function checkOnboardingStatus() {
    const layer = document.getElementById('onboarding-layer');
    if (!layer) return;

    // Fix HHID wrapper focus
    const hhidWrapper = document.querySelector('.hhid-input-wrapper');
    if (hhidWrapper) {
        hhidWrapper.onclick = () => {
            const inp = document.getElementById('inp-hhid-digits');
            if (inp) inp.focus();
        };
    }

    try {
        // Real check: /var/lib/self_installation_done
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
        // network auto-load is now handled in handleStepLogic(2)
        return false;
    }

    layer.style.display = 'none';
    return true;
}

window.submitHHID = async () => {
    const digits = document.getElementById('inp-hhid-digits').value;
    const btn = document.getElementById('btn-next-5');
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
    const btn = document.getElementById('btn-next-6');
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
