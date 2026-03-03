import { t } from './i18n.js';

let notificationData = [];

async function fetchNotifications() {
    try {
        const r = await fetch('/api/notifications');
        const d = await r.json();
        if (d.success) {
            notificationData = d.data;
        }
    } catch (e) {
        console.error("Failed to fetch notifications", e);
    }
}

function timeAgo(timestamp) {
    if (!timestamp) return "...";
    const past = new Date(timestamp).getTime();
    if (isNaN(past)) return "...";
    const now = Date.now();
    const diffMs = now - past;
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    const days    = Math.floor(hours / 24);

    if (seconds < 45) return t('just_now');
    if (seconds < 90) return `1 ${t('min_ago')}`;
    if (minutes < 45) return `${minutes} ${t('min_ago')}`;
    if (minutes < 90) return `1 ${t('hr_ago')}`;
    if (hours   < 24) return `${hours} ${t('hr_ago')}`;
    if (days    === 1) return t('yesterday');
    if (days    <  7) return `${days} ${t('days_ago')}`;

    return new Date(past).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const typeIcons = {
    'update': 'update',
    'info': 'info',
    'survey': 'quiz',
    'desomission': 'event_busy'
};

export async function renderNotifications() {
    await fetchNotifications();
    renderPageNotifications();
    renderScreensaverNotifications();
}

function renderPageNotifications() {
    const container = document.querySelector('#view-notifications .list-group');
    if (!container) return;

    if (notificationData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="material-symbols-rounded">notifications_off</span>
                <p>${t('no_notif')}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = notificationData.map(n => `
        <div class="list-item ${n.read ? '' : 'unread'}" onclick="handleNotificationClick(${n.id})">
            <div class="icon-box severity-${n.type}">
                <span class="material-symbols-rounded">${typeIcons[n.type] || 'notifications'}</span>
            </div>
            <div class="item-content">
                <h4>${n.title}</h4>
                <p>${n.message}</p>
            </div>
            <span class="time-stamp" style="font-size: 12px; color: var(--text-sub); margin-left: auto;">
                ${timeAgo(n.created_at)}
            </span>
        </div>
    `).join('');
}

function renderScreensaverNotifications() {
    const container = document.querySelector('.hub-notif-area');
    const saver = document.getElementById('screensaver');
    if (!container || !saver) return;

    // Filter unread for saver
    const unread = notificationData.filter(n => !n.read);

    if (unread.length === 0) {
        container.innerHTML = '';
        saver.classList.add('no-notif');
        return;
    }

    saver.classList.remove('no-notif');
    container.innerHTML = unread.map(n => `
        <div class="hub-notif-card" onclick="handleNotificationClick(${n.id})">
            <div class="hub-notif-icon-v2 severity-${n.type}">
                <span class="material-symbols-rounded">${typeIcons[n.type] || 'notifications'}</span>
            </div>
            <div class="hub-notif-body">
                <div class="hub-notif-top">
                    <span class="hub-notif-title">${n.title}</span>
                    <span class="hub-notif-time">${timeAgo(n.created_at)}</span>
                </div>
                <div class="hub-notif-text">${n.message}</div>
            </div>
        </div>
    `).join('');
}

window.handleNotificationClick = async (id) => {
    const n = notificationData.find(x => x.id === id);
    if (!n) return;
    
    // Mark as read in backend
    try {
        await fetch('/api/notifications/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        n.read = true;
        renderNotifications();
    } catch(e) {}

    if (n.type === 'survey') {
        if (window.openSurvey) window.openSurvey(n);
    }
};