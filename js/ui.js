/* js/ui.js */
import { t } from './i18n.js';

export function showModal(title, msg, actions = []) {
    const overlay = document.getElementById('modal-overlay');
    const titleEl = document.getElementById('modal-title');
    const msgEl = document.getElementById('modal-msg');
    const actionsEl = document.getElementById('modal-actions');

    titleEl.innerText = title;
    msgEl.innerText = msg;
    actionsEl.innerHTML = '';

    // If no actions provided, add a default 'OK'
    if (actions.length === 0) {
        actions = [{ text: t('ok'), primary: true, callback: closeModal }];
    }

    actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = `modal-btn ${action.primary ? 'primary' : ''}`;
        btn.innerText = action.text;
        btn.onclick = () => {
            if (action.callback) action.callback();
            closeModal();
        };
        actionsEl.appendChild(btn);
    });

    overlay.classList.add('active');
}

export function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('active');
}

export function showToast(message, duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast-card';
    toast.innerHTML = `<span class="material-symbols-rounded">info</span>`;
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message;
    toast.appendChild(span);

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('visible'), 10);

    // Remove
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

let pendingNetwork = null;

export function showPasswordPrompt(networkName, initialPassword = '') {
    pendingNetwork = networkName;
    const overlay = document.getElementById('wifi-password-overlay');
    const desc = document.getElementById('net-password-desc');
    const input = document.getElementById('wifi-pass-input');
    
    if (desc) desc.innerText = `${t('connecting_to')} ${networkName}`;
    if (input) {
        input.value = initialPassword;
        input.type = 'password';
    }
    
    const eyeIcon = document.getElementById('pass-eye-icon');
    if (eyeIcon) eyeIcon.innerText = 'visibility';

    overlay.classList.add('active');
    setTimeout(() => input?.focus(), 150);
}

export function closePassPopover() {
    const overlay = document.getElementById('wifi-password-overlay');
    overlay.classList.remove('active');
    pendingNetwork = null;
}

export function togglePassVisibility() {
    const input = document.getElementById('wifi-pass-input');
    const eyeIcon = document.getElementById('pass-eye-icon');
    if (!input || !eyeIcon) return;

    if (input.type === 'password') {
        input.type = 'text';
        eyeIcon.innerText = 'visibility_off';
    } else {
        input.type = 'password';
        eyeIcon.innerText = 'visibility';
    }
}

export function submitPass() {
    const input = document.getElementById('wifi-pass-input');
    if (!input || !input.value) {
        showToast(t('enter_wifi_pass') || 'Please enter password');
        return;
    }

    if (pendingNetwork) {
        if (window.connectToWifi) {
            window.connectToWifi(pendingNetwork, input.value);
        } else {
            console.error("connectToWifi not found");
        }
        closePassPopover();
    }
}

window.showModal = showModal;
window.closeModal = closeModal;
window.showToast = showToast;
window.showPasswordPrompt = showPasswordPrompt;
window.closePassPopover = closePassPopover;
window.togglePassVisibility = togglePassVisibility;
window.submitPass = submitPass;
