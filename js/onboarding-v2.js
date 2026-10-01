import { config, memberData, updateSetting } from './data.js';
import { applyTranslations, loadLanguage, t } from './i18n.js';

const TOTAL_STEPS = 7;
const CONSENT_VERSION = '2026-10-v1';
const LOCAL_STEP_KEY = 'indi-onboarding-step-v2';
const CHECK_LABELS = {
    storage: 'check_storage',
    clock: 'check_clock',
    input: 'check_input',
    usb_audio: 'check_usb_audio',
    gsm: 'check_gsm',
    wifi_radio: 'check_wifi_radio'
};
const TUTORIAL = [
    ['group', 'tutorial_members_title', 'tutorial_members_copy'],
    ['person_add', 'tutorial_guest_title', 'tutorial_guest_copy'],
    ['notifications', 'tutorial_notifications_title', 'tutorial_notifications_copy']
];

let currentStep = 1;
let selectedNetwork = null;
let networkReady = false;
let householdConfirmed = false;
let maskedHouseholdName = '';
let maskedPhone = '';
let resendTimer = null;
let lockoutTimer = null;
let resendSeconds = 0;
let otpLocked = false;
let otpAlreadyVerified = false;
let memberSyncDone = false;
let memberCount = 0;
let deviceStatus = {};
let qrStream = null;
let qrFrame = null;
let tutorialIndex = 0;
let remoteTestActive = false;
let initialized = false;

const byId = (id) => document.getElementById(id);

function setStatus(id, message, type = '') {
    const element = byId(id);
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('error', type === 'error');
    element.classList.toggle('success', type === 'success');
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.error) data.error = `Request failed (${response.status})`;
    return { response, data };
}

function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('loading', busy);
}

function getSavedStep() {
    const value = Number(localStorage.getItem(LOCAL_STEP_KEY));
    return Number.isInteger(value) && value >= 1 && value <= TOTAL_STEPS ? value : null;
}

async function persistStep(step, progressMetadata = {}) {
    currentStep = step;
    localStorage.setItem(LOCAL_STEP_KEY, String(step));
    const progress = byId('onboard-progress-fill');
    const progressLabel = byId('onboard-progress-label');
    if (progress) progress.style.width = `${(step / TOTAL_STEPS) * 100}%`;
    if (progressLabel) {
        progressLabel.textContent = t('onboard_progress_step')
            .replace('{current}', String(step))
            .replace('{total}', String(TOTAL_STEPS));
    }
    document.querySelectorAll('.onboard-v2-step').forEach((section) => {
        const active = section.id === `v2-step-${step}`;
        section.classList.toggle('active', active);
        section.hidden = !active;
        if (active) section.setAttribute('aria-current', 'step');
        else section.removeAttribute('aria-current');
    });
    const progressTrack = document.querySelector('.onboard-progress-track');
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(step));
    try {
        await fetch('/api/onboarding/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                step,
                ...progressMetadata,
                ...(step === 7 ? { roster_confirmed: true } : {})
            })
        });
    } catch (error) {
        console.warn('Could not sync setup progress to the local service', error);
    }
    if (step === 2) await runSelfCheck();
    if (step === 3) await refreshWifi();
    if (step === 5) renderOtpStep();
    if (step === 6) await loadMembersForConfirmation();
    if (step === 7) await renderSummary();
}

async function chooseLanguage(lang) {
    if (!['en', 'hy', 'ru'].includes(lang)) return;
    if (!await loadLanguage(lang)) return;
    config.language = lang;
    applyTranslations();
    await updateSetting('language', lang);
    document.querySelectorAll('[data-onboard-language]').forEach((button) => {
        const selected = button.dataset.onboardLanguage === lang;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    updateProgressText();
}

function updateProgressText() {
    const label = byId('onboard-progress-label');
    if (label) {
        label.textContent = t('onboard_progress_step')
            .replace('{current}', String(currentStep))
            .replace('{total}', String(TOTAL_STEPS));
    }
}

async function runSelfCheck() {
    const list = byId('selfcheck-list');
    const next = byId('selfcheck-next-btn');
    if (!list || !next) return;
    next.disabled = true;
    setStatus('selfcheck-status', t('selfcheck_running'));
    list.innerHTML = `<div class="onboard-check-row"><span class="material-symbols-rounded">sync</span><span>${t('selfcheck_running')}</span></div>`;
    try {
        const { response, data } = await requestJson('/api/onboarding/self-check');
        if (!response.ok || !data.success || !Array.isArray(data.checks)) throw new Error(data.error || 'Device check failed');
        list.replaceChildren();
        for (const check of data.checks) {
            const row = document.createElement('div');
            row.className = 'onboard-check-row';
            row.dataset.status = check.status;
            const icon = document.createElement('span');
            icon.className = 'material-symbols-rounded check-status-icon';
            icon.textContent = check.status === 'pass' ? 'check_circle' : check.status === 'fail' ? 'error' : 'info';
            const copy = document.createElement('span');
            copy.className = 'onboard-check-copy';
            const title = document.createElement('strong');
            title.textContent = t(CHECK_LABELS[check.id] || check.id);
            const detail = document.createElement('small');
            const detailKey = {
                clock: check.status === 'pass' ? 'clock_synced' : 'clock_after_network',
                input: check.status === 'pass' ? 'input_detected' : 'input_missing',
                usb_audio: check.status === 'pass' ? 'usb_audio_detected' : 'usb_audio_missing',
                gsm: check.status === 'pass' ? 'gsm_detected' : 'gsm_missing',
                wifi_radio: check.status === 'pass' ? 'wifi_radio_enabled' : 'wifi_radio_disabled'
            }[check.id];
            if (check.id === 'storage') {
                const freeMb = check.detail?.match(/(\d+)\s*MB/i)?.[1];
                detail.textContent = freeMb
                    ? t('storage_available').replace('{mb}', freeMb)
                    : t('storage_unavailable');
            } else {
                detail.textContent = t(detailKey || `status_${check.status}`);
            }
            copy.append(title, detail);
            const requirement = document.createElement('span');
            requirement.className = 'onboard-requirement';
            requirement.textContent = t(check.required ? 'required' : 'optional');
            row.append(icon, copy, requirement);
            list.appendChild(row);
        }
        const blocked = !data.can_proceed;
        next.disabled = blocked;
        setStatus('selfcheck-status', blocked ? t('selfcheck_blocked') : '', blocked ? 'error' : 'success');
    } catch (error) {
        list.replaceChildren();
        setStatus('selfcheck-status', error.message || t('selfcheck_blocked'), 'error');
        next.disabled = true;
    }
}

function renderWifiNetworks(networks) {
    const list = byId('onboard-wifi-list');
    if (!list) return;
    list.replaceChildren();
    if (!networks.length) {
        const empty = document.createElement('p');
        empty.className = 'onboard-inline-status';
        empty.textContent = t('network_empty');
        list.appendChild(empty);
        return;
    }
    networks.forEach((network) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'onboard-network-row';
        button.setAttribute('aria-pressed', 'false');
        const main = document.createElement('span');
        main.className = 'onboard-network-main';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = network.open ? 'wifi' : 'wifi_lock';
        const copy = document.createElement('span');
        copy.className = 'onboard-network-copy';
        const name = document.createElement('strong');
        name.textContent = network.ssid;
        const detail = document.createElement('small');
        detail.textContent = `${network.open ? t('wifi_open') : network.security || t('password')}${network.saved ? ` · ${t('wifi_saved')}` : ''}`;
        copy.append(name, detail);
        main.append(icon, copy);
        const signal = document.createElement('span');
        signal.className = 'onboard-network-signal';
        signal.textContent = t('wifi_signal').replace('{percent}', String(network.signal || 0));
        button.append(main, signal);
        button.addEventListener('click', () => selectNetwork(network, button));
        list.appendChild(button);
    });
}

async function refreshWifi() {
    const list = byId('onboard-wifi-list');
    const refresh = byId('onboard-wifi-refresh');
    if (!list) return;
    setStatus('network-status', t('network_searching'));
    list.innerHTML = `<p class="onboard-inline-status">${t('network_searching')}</p>`;
    setBusy(refresh, true);
    try {
        const currentResult = await requestJson('/api/wifi/current');
        const currentSsid = currentResult.data.connected ? currentResult.data.ssid : '';
        const { response, data } = await requestJson('/api/wifi/networks');
        if (!response.ok || !data.success) throw new Error(data.error || t('network_empty'));
        const networks = Array.isArray(data.networks) ? data.networks : [];
        networks.sort((a, b) => Number(b.ssid === currentSsid) - Number(a.ssid === currentSsid) || (b.signal || 0) - (a.signal || 0));
        renderWifiNetworks(networks);
        if (currentSsid) {
            const current = networks.find((network) => network.ssid === currentSsid);
            if (current) {
                current.connected = true;
                selectNetwork(current, [...list.children].find((row) => row.querySelector('strong')?.textContent === currentSsid));
            }
        }
        if (!networks.length) setStatus('network-status', t('network_empty'));
        else setStatus('network-status', '');
    } catch (error) {
        list.innerHTML = '';
        setStatus('network-status', error.message || t('network_empty'), 'error');
    } finally {
        setBusy(refresh, false);
    }
}

function selectNetwork(network, button) {
    selectedNetwork = { ...network, hidden: false };
    networkReady = false;
    document.querySelectorAll('.onboard-network-row').forEach((row) => {
        const selected = row === button;
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-pressed', String(selected));
    });
    byId('hidden-network-form').hidden = true;
    byId('network-password-form').hidden = Boolean(network.open || network.saved || network.connected);
    byId('network-connect-btn').disabled = false;
    byId('onboard-wifi-pass').value = '';
    byId('onboard-wifi-pass').required = !network.open && !network.saved && !network.connected;
    setStatus('network-status', network.connected ? t('connect_checking') : '');
    if (network.connected) connectAndVerify(true);
}

async function connectAndVerify(alreadyConnected = false) {
    if (!selectedNetwork) return;
    const button = byId('network-connect-btn');
    const password = byId('onboard-wifi-pass').value;
    if (!selectedNetwork.open && !selectedNetwork.saved && !selectedNetwork.hidden && password.length < 8) {
        setStatus('network-status', t('enter_wifi_pass'), 'error');
        byId('onboard-wifi-pass').focus();
        return;
    }
    setBusy(button, true);
    setStatus('network-status', t('connect_checking'));
    try {
        if (!alreadyConnected) {
            const connectResult = await requestJson('/api/wifi/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ssid: selectedNetwork.ssid,
                    password,
                    hidden: selectedNetwork.hidden === true,
                    saved: selectedNetwork.saved === true
                })
            });
            if (!connectResult.response.ok || !connectResult.data.success) {
                throw new Error(connectResult.data.error || t('connect_failed'));
            }
        }
        const { response, data } = await requestJson('/api/onboarding/network-check');
        if (!response.ok || !data.can_proceed) {
            const message = data.failure_reason === 'time_not_synced'
                ? t('time_not_synced')
                : t('connect_failed');
            throw new Error(message);
        }
        networkReady = true;
        const signal = data.signal ?? selectedNetwork.signal ?? 0;
        setStatus('network-status', t('connect_success')
            .replace('{signal}', `${signal}%`)
            .replace('{latency}', String(data.latency_ms ?? '—')), 'success');
        setBusy(button, false);
        button.disabled = false;
        button.querySelector('span[data-i18n]').textContent = t('next');
        localStorage.setItem('indi-onboarding-network-ready', '1');
    } catch (error) {
        networkReady = false;
        setStatus('network-status', error.message || t('connect_failed'), 'error');
        setBusy(button, false);
    }
}

function useHiddenNetwork() {
    const ssid = byId('hidden-ssid').value.trim();
    if (!ssid) {
        setStatus('network-status', t('network_name'), 'error');
        byId('hidden-ssid').focus();
        return;
    }
    selectedNetwork = { ssid, open: false, saved: false, hidden: true, signal: 0 };
    document.querySelectorAll('.onboard-network-row').forEach((row) => row.classList.remove('selected'));
    byId('network-password-form').hidden = false;
    byId('onboard-wifi-pass').required = false;
    byId('onboard-wifi-pass').value = '';
    byId('network-connect-btn').disabled = false;
    byId('network-connect-btn').querySelector('span[data-i18n]').textContent = t('connect');
    setStatus('network-status', '');
}

function setOtpBoxes(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 4);
    const boxes = [...document.querySelectorAll('[data-otp-digit]')];
    boxes.forEach((box, index) => { box.value = digits[index] || ''; });
    boxes[Math.min(digits.length, boxes.length - 1)]?.focus();
}

function readOtp() {
    return [...document.querySelectorAll('[data-otp-digit]')].map((box) => box.value).join('');
}

function renderOtpStep() {
    byId('otp-box-group').hidden = otpAlreadyVerified;
    byId('otp-resend-btn').hidden = otpAlreadyVerified;
    byId('otp-back-btn').hidden = otpAlreadyVerified;
    byId('otp-verify-btn').querySelector('span[data-i18n]').textContent = t(otpAlreadyVerified ? 'continue' : 'verify');
    if (otpAlreadyVerified) setStatus('otp-status', t('household_verified'), 'success');
}

function startResendCountdown(seconds = 60) {
    clearInterval(resendTimer);
    resendSeconds = Math.max(0, seconds);
    const button = byId('otp-resend-btn');
    const countdown = byId('otp-resend-countdown');
    if (!button || !countdown) return;
    button.disabled = resendSeconds > 0 || otpLocked;
    countdown.textContent = String(resendSeconds);
    resendTimer = setInterval(() => {
        resendSeconds = Math.max(0, resendSeconds - 1);
        countdown.textContent = String(resendSeconds);
        button.disabled = resendSeconds > 0 || otpLocked;
        if (resendSeconds === 0) clearInterval(resendTimer);
    }, 1000);
}

function applyOtpLockout(seconds) {
    otpLocked = true;
    const boxes = [...document.querySelectorAll('[data-otp-digit]')];
    boxes.forEach((box) => { box.disabled = true; });
    byId('otp-verify-btn').disabled = true;
    byId('otp-resend-btn').disabled = true;
    clearInterval(lockoutTimer);
    const unlockAt = Date.now() + seconds * 1000;
    const updateLockMessage = () => {
        const remaining = Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
        setStatus('otp-status', t('otp_locked').replace('{minutes}', String(Math.ceil(remaining / 60))), 'error');
        if (!remaining) {
            clearInterval(lockoutTimer);
            otpLocked = false;
            boxes.forEach((box) => { box.disabled = false; });
            byId('otp-verify-btn').disabled = false;
            byId('otp-resend-btn').disabled = resendSeconds > 0;
            setStatus('otp-status', '');
        }
    };
    updateLockMessage();
    lockoutTimer = setInterval(updateLockMessage, 1000);
}

async function linkHousehold() {
    const input = byId('inp-household-id');
    const hhid = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(hhid)) {
        setStatus('household-status', t('household_id'), 'error');
        input.focus();
        return;
    }
    const button = byId('household-link-btn');
    if (householdConfirmed) {
        if (!byId('household-confirm-check').checked) {
            setStatus('household-status', t('confirm_household'), 'error');
            return;
        }
        setStatus('otp-destination', maskedPhone ? `${t('otp_sent_desc')} ${maskedPhone}` : t('otp_sent_desc'));
        await persistStep(5, { household_confirmed: true });
        const { data } = await requestJson('/api/onboarding/status');
        startResendCountdown(Number(data.otp_resend_after) || 0);
        return;
    }
    setBusy(button, true);
    setStatus('household-status', '');
    try {
        const { response, data } = await requestJson('/api/onboarding/initiate-assignment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hhid })
        });
        if (!response.ok || !data.success) throw new Error(data.error || t('connect_failed'));
        maskedPhone = data.masked_phone || '';
        maskedHouseholdName = data.household_name || hhid.replace(/.(?=.{2})/g, '*');
        byId('masked-household-name').textContent = maskedHouseholdName;
        byId('household-confirmation').hidden = false;
        byId('household-confirm-check').checked = false;
        householdConfirmed = true;
        button.querySelector('span[data-i18n]').textContent = t('next');
        setStatus('household-status', data.message || '', 'success');
    } catch (error) {
        setStatus('household-status', error.message, 'error');
    } finally {
        setBusy(button, false);
    }
}

async function verifyOtp() {
    if (otpAlreadyVerified) {
        await persistStep(6);
        return;
    }
    const otp = readOtp();
    if (!/^\d{4}$/.test(otp)) {
        setStatus('otp-status', t('otp_sent_desc'), 'error');
        return;
    }
    const button = byId('otp-verify-btn');
    setBusy(button, true);
    try {
        const { response, data } = await requestJson('/api/onboarding/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp })
        });
        if (!response.ok || !data.success) {
            if (data.locked) {
                const seconds = Number(data.retry_after) || 600;
                applyOtpLockout(seconds);
                return;
            }
            const remaining = Number(data.attempts_remaining);
            const message = Number.isFinite(remaining)
                ? t('otp_invalid').replace('{remaining}', String(remaining))
                : data.error || t('otp_invalid').replace('{remaining}', '');
            setStatus('otp-status', message, 'error');
            setOtpBoxes('');
            return;
        }
        otpLocked = false;
        otpAlreadyVerified = true;
        clearInterval(resendTimer);
        await persistStep(6);
    } catch (error) {
        setStatus('otp-status', error.message, 'error');
    } finally {
        setBusy(button, false);
        if (otpLocked) button.disabled = true;
    }
}

async function resendOtp() {
    if (otpLocked || resendSeconds > 0) return;
    const button = byId('otp-resend-btn');
    setBusy(button, true);
    try {
        const { response, data } = await requestJson('/api/onboarding/resend-otp', { method: 'POST' });
        if (!response.ok || !data.success) {
            if (data.locked) applyOtpLockout(Number(data.retry_after) || 600);
            startResendCountdown(Number(data.retry_after) || 60);
            throw new Error(data.error || t('connect_failed'));
        }
        maskedPhone = data.masked_phone || maskedPhone;
        setStatus('otp-status', maskedPhone ? `${t('otp_sent_desc')} ${maskedPhone}` : '', 'success');
        startResendCountdown(Number(data.retry_after) || 60);
    } catch (error) {
        setStatus('otp-status', error.message, 'error');
    } finally {
        setBusy(button, false);
        button.disabled = resendSeconds > 0 || otpLocked;
    }
}

async function loadMembersForConfirmation() {
    if (!memberSyncDone) {
        const status = byId('members-sync-status');
        if (status) status.textContent = t('syncing_members');
        try {
            const { response, data } = await requestJson('/api/onboarding/finalize', { method: 'POST' });
            if (!response.ok || !data.success) throw new Error(data.error || t('members_sync_failed'));
            const members = await window.loadMembers?.();
            memberCount = Array.isArray(members) ? members.length : memberData.length;
            memberSyncDone = true;
        } catch (error) {
            if (status) {
                status.textContent = `${t('members_sync_failed')} ${error.message || ''}`;
                status.classList.add('error');
            }
            byId('members-retry-btn').hidden = false;
            byId('members-next-btn').disabled = true;
            return;
        }
    }
    byId('members-retry-btn').hidden = true;
    renderMemberList();
    const status = byId('members-sync-status');
    if (status) {
        status.textContent = `${memberCount} ${t('summary_members').toLowerCase()}`;
        status.classList.remove('error');
    }
    byId('onboard-location').value = config.location || 'auto';
    updateMembersNext();
}

function renderMemberList() {
    const list = byId('onboard-member-list');
    if (!list) return;
    list.replaceChildren();
    memberData.forEach((member, index) => {
        const row = document.createElement('div');
        row.className = 'onboard-member-row';
        const avatar = document.createElement('span');
        avatar.className = 'material-symbols-rounded';
        avatar.textContent = 'person';
        const name = document.createElement('input');
        name.type = 'text';
        name.value = member.name || member.member_code || '';
        name.setAttribute('aria-label', `${t('members')} ${index + 1}`);
        name.addEventListener('change', async () => {
            const value = name.value.trim();
            if (!value || value === member.name) return;
            if (window.updateMemberName) await window.updateMemberName(index, value);
            member.name = value;
        });
        const meta = document.createElement('span');
        meta.className = 'onboard-member-meta';
        meta.textContent = [member.gender, member.age].filter(Boolean).join(' · ');
        row.append(avatar, name, meta);
        list.appendChild(row);
    });
}

function updateMembersNext() {
    const button = byId('members-next-btn');
    if (button) button.disabled = !memberSyncDone || !byId('members-confirmed').checked;
}

async function updateLocation() {
    const value = byId('onboard-location').value;
    if (window.selectLocation) {
        await window.selectLocation(value);
        return;
    }
    await updateSetting('location', value);
    config.location = value;
}

function startRemoteTest() {
    remoteTestActive = true;
    byId('remote-test-status').textContent = t('remote_test_waiting');
    document.addEventListener('keydown', onRemoteTestKey, true);
}

function onRemoteTestKey(event) {
    if (!remoteTestActive || !['Enter', 'Select', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    remoteTestActive = false;
    document.removeEventListener('keydown', onRemoteTestKey, true);
    byId('remote-test-status').textContent = t('remote_test_passed');
    byId('remote-test-status').classList.add('success');
}

async function renderSummary() {
    const summary = byId('onboard-summary');
    if (!summary) return;
    const [systemResult, wifiResult] = await Promise.allSettled([
        requestJson('/api/system/status'),
        requestJson('/api/wifi/current')
    ]);
    deviceStatus = systemResult.status === 'fulfilled' ? systemResult.value.data : {};
    const wifi = wifiResult.status === 'fulfilled' && wifiResult.value.data.connected
        ? wifiResult.value.data.ssid
        : t('summary_offline');
    const rows = [
        [t('summary_household'), maskedHouseholdName || '—'],
        [t('summary_members'), String(memberCount || memberData.length)],
        [t('summary_meter'), deviceStatus.meter_id || config.meter_id || '—'],
        [t('summary_network'), wifi],
        [t('summary_version'), deviceStatus.sw_versions?.app || deviceStatus.sw_versions?.version || '—'],
        [t('summary_status'), networkReady || localStorage.getItem('indi-onboarding-network-ready') === '1' ? t('summary_ready') : t('summary_offline')]
    ];
    summary.replaceChildren();
    rows.forEach(([label, value]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        summary.append(dt, dd);
    });
    byId('finish-setup-btn').disabled = !byId('onboard-consent').checked;
}

async function finishSetup() {
    const button = byId('finish-setup-btn');
    if (!byId('onboard-consent').checked) return;
    setBusy(button, true);
    setStatus('finish-status', '');
    try {
        const { response, data } = await requestJson('/api/onboarding/mark_done', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accepted: true, consent_version: CONSENT_VERSION })
        });
        if (!response.ok || !data.success) throw new Error(data.error || t('connect_failed'));
        config.onboardingCompleted = true;
        localStorage.removeItem(LOCAL_STEP_KEY);
        byId('onboard-tutorial-scrim').hidden = false;
        renderTutorial(0);
    } catch (error) {
        setStatus('finish-status', error.message, 'error');
    } finally {
        setBusy(button, false);
    }
}

function renderTutorial(index) {
    tutorialIndex = index;
    const [icon, title, copy] = TUTORIAL[index];
    byId('tutorial-icon').textContent = icon;
    byId('tutorial-title').textContent = t(title);
    byId('tutorial-copy').textContent = t(copy);
    byId('tutorial-count').textContent = `${index + 1} / ${TUTORIAL.length}`;
    byId('tutorial-next').textContent = index === TUTORIAL.length - 1 ? t('done') : t('next');
}

function closeTutorial() {
    byId('onboard-tutorial-scrim').hidden = true;
    byId('onboarding-layer').classList.add('hidden');
    setTimeout(() => { byId('onboarding-layer').style.display = 'none'; }, 450);
    window.loadMembers?.();
}

function closeQrScanner() {
    if (qrFrame) cancelAnimationFrame(qrFrame);
    qrFrame = null;
    qrStream?.getTracks().forEach((track) => track.stop());
    qrStream = null;
    byId('household-qr-video').srcObject = null;
    byId('onboard-qr-scrim').hidden = true;
}

async function scanHouseholdQr() {
    const scrim = byId('onboard-qr-scrim');
    const status = byId('qr-scan-status');
    scrim.hidden = false;
    if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in window)) {
        status.textContent = t('qr_camera_hint');
        setStatus('household-status', t('qr_camera_hint'));
        return;
    }
    try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = byId('household-qr-video');
        video.srcObject = qrStream;
        await video.play();
        const scan = async () => {
            if (!qrStream) return;
            try {
                const codes = await detector.detect(video);
                if (codes.length) {
                    let raw = codes[0].rawValue.trim();
                    try {
                        const parsed = new URL(raw);
                        raw = parsed.searchParams.get('householdId') || parsed.searchParams.get('hhid') || raw;
                    } catch (_) {}
                    byId('inp-household-id').value = raw.toUpperCase();
                    closeQrScanner();
                    byId('inp-household-id').focus();
                    return;
                }
            } catch (_) {}
            qrFrame = requestAnimationFrame(scan);
        };
        qrFrame = requestAnimationFrame(scan);
    } catch (error) {
        status.textContent = error.name === 'NotAllowedError' ? t('qr_camera_hint') : (error.message || t('qr_camera_hint'));
    }
}

function openHelp() {
    byId('onboard-help-scrim').hidden = false;
}

function closeHelp() {
    byId('onboard-help-scrim').hidden = true;
}

function bindOtpInputs() {
    const boxes = [...document.querySelectorAll('[data-otp-digit]')];
    boxes.forEach((box, index) => {
        box.addEventListener('input', () => {
            box.value = box.value.replace(/\D/g, '').slice(-1);
            if (box.value && boxes[index + 1]) boxes[index + 1].focus();
        });
        box.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' && !box.value && boxes[index - 1]) boxes[index - 1].focus();
            if (event.key === 'ArrowLeft' && boxes[index - 1]) boxes[index - 1].focus();
            if (event.key === 'ArrowRight' && boxes[index + 1]) boxes[index + 1].focus();
        });
        box.addEventListener('paste', (event) => {
            event.preventDefault();
            setOtpBoxes(event.clipboardData?.getData('text') || '');
        });
    });
}

function bindControls() {
    document.querySelectorAll('[data-onboard-language]').forEach((button) => {
        button.addEventListener('click', () => chooseLanguage(button.dataset.onboardLanguage));
    });
    byId('onboard-start-btn').addEventListener('click', () => persistStep(2));
    byId('selfcheck-retry-btn').addEventListener('click', runSelfCheck);
    byId('selfcheck-next-btn').addEventListener('click', () => persistStep(3));
    byId('onboard-wifi-refresh').addEventListener('click', refreshWifi);
    byId('hidden-network-toggle').addEventListener('click', () => {
        byId('hidden-network-form').hidden = !byId('hidden-network-form').hidden;
    });
    byId('hidden-network-use-btn').addEventListener('click', useHiddenNetwork);
    byId('network-connect-btn').addEventListener('click', () => {
        if (networkReady) persistStep(4);
        else connectAndVerify(false);
    });
    byId('onboard-pass-toggle').addEventListener('click', () => {
        const input = byId('onboard-wifi-pass');
        input.type = input.type === 'password' ? 'text' : 'password';
    });
    byId('network-back-btn').addEventListener('click', () => persistStep(2));
    byId('household-link-btn').addEventListener('click', linkHousehold);
    byId('household-back-btn').addEventListener('click', () => persistStep(3));
    byId('household-scan-btn').addEventListener('click', scanHouseholdQr);
    byId('qr-scan-cancel').addEventListener('click', closeQrScanner);
    byId('otp-verify-btn').addEventListener('click', verifyOtp);
    byId('otp-resend-btn').addEventListener('click', resendOtp);
    byId('otp-back-btn').addEventListener('click', () => persistStep(4));
    byId('members-back-btn').addEventListener('click', () => persistStep(5));
    byId('members-retry-btn').addEventListener('click', () => {
        memberSyncDone = false;
        loadMembersForConfirmation();
    });
    byId('members-next-btn').addEventListener('click', async () => {
        await updateLocation();
        await persistStep(7, { roster_confirmed: true });
    });
    byId('members-confirmed').addEventListener('change', updateMembersNext);
    byId('onboard-location').addEventListener('change', updateLocation);
    byId('remote-test-btn').addEventListener('click', startRemoteTest);
    byId('remote-test-skip').addEventListener('click', () => {
        remoteTestActive = false;
        document.removeEventListener('keydown', onRemoteTestKey, true);
        byId('remote-test-status').textContent = t('skip');
    });
    byId('finish-back-btn').addEventListener('click', () => persistStep(6));
    byId('onboard-consent').addEventListener('change', () => {
        byId('finish-setup-btn').disabled = !byId('onboard-consent').checked;
    });
    byId('finish-setup-btn').addEventListener('click', finishSetup);
    byId('onboard-help-btn').addEventListener('click', openHelp);
    byId('onboard-help-close').addEventListener('click', closeHelp);
    byId('onboard-help-scrim').addEventListener('click', (event) => {
        if (event.target === byId('onboard-help-scrim')) closeHelp();
    });
    byId('tutorial-skip').addEventListener('click', closeTutorial);
    byId('tutorial-next').addEventListener('click', () => {
        if (tutorialIndex + 1 >= TUTORIAL.length) closeTutorial();
        else renderTutorial(tutorialIndex + 1);
    });
    bindOtpInputs();
}

export function initOnboarding() {
    if (initialized) return;
    initialized = true;
    bindControls();
}

export async function checkOnboardingStatus() {
    const layer = byId('onboarding-layer');
    if (!layer) return true;
    initOnboarding();
    let startupState = {};
    try {
        const { data } = await requestJson('/api/onboarding/status');
        startupState = data;
        if (data.meter_id) {
            byId('onboard-device-id').textContent = data.meter_id;
            byId('onboard-support-code').textContent = data.support_code || data.meter_id;
            byId('onboard-support-phone').textContent = data.support_phone || t('support_not_configured');
        }
        maskedPhone = data.masked_phone || '';
        maskedHouseholdName = data.masked_household_name || '';
        otpAlreadyVerified = data.otp_verified === true;
        if (data.pending_household_confirmation) {
            householdConfirmed = true;
            byId('masked-household-name').textContent = maskedHouseholdName;
            byId('household-confirmation').hidden = false;
            byId('household-confirm-check').checked = false;
            byId('inp-household-id').disabled = true;
            byId('household-link-btn').querySelector('span[data-i18n]').textContent = t('next');
        }
        if (data.installed) {
            config.onboardingCompleted = true;
            layer.style.display = 'none';
            return true;
        }
        const localStep = getSavedStep();
        const serverStep = Number(data.step);
        currentStep = localStep && Number.isInteger(serverStep)
            ? Math.min(localStep, serverStep)
            : (Number.isInteger(serverStep) && serverStep >= 1 && serverStep <= TOTAL_STEPS ? serverStep : localStep || 1);
    } catch (error) {
        console.warn('Could not load onboarding status; resuming local progress', error);
        currentStep = getSavedStep() || 1;
    }
    await loadLanguage(config.language || 'en');
    applyTranslations();
    document.querySelector(`[data-onboard-language="${config.language || 'en'}"]`)?.classList.add('selected');
    layer.style.display = 'flex';
    layer.classList.remove('hidden');
    await persistStep(currentStep);
    if (currentStep === 5) {
        byId('otp-destination').textContent = maskedPhone ? `${t('otp_sent_desc')} ${maskedPhone}` : t('otp_sent_desc');
        if (startupState.otp_locked) applyOtpLockout(Number(startupState.otp_retry_after) || 600);
        else startResendCountdown(Number(startupState.otp_resend_after) || 0);
    }
    return false;
}

document.addEventListener('input', (event) => {
    if (event.target.id === 'inp-household-id') {
        event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    }
});
