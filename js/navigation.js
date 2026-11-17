// js/navigation.js — Navigation & Universal Stage Synchronization

import { closeSetting } from './settings.js';
import { syncTvOverlay } from './connection.js';

export function navTo(viewId) {
    if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
    }

    // Sidebar Buttons Logic
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    let btnId = '';
    if (viewId === 'home') btnId = 'btn-home';
    else if (viewId === 'notifications') btnId = 'btn-notif';
    else if (viewId === 'settings') btnId = 'btn-settings';
    else if (viewId === 'guest-add') btnId = 'btn-guest';

    if (btnId) {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.add('active');
    }

    if (viewId !== 'settings') {
        closeSetting();
    }

    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });

    const targetView = document.getElementById('view-' + viewId);
    if (targetView) {
        targetView.style.display = 'flex';
        void targetView.offsetWidth;
        targetView.classList.add('active');

        const scroller = targetView.querySelector('.list-group, .settings-scroll-area');
        if (scroller) {
            scroller.scrollTop = 0;
        }
    }

    // Synchronously enforce the universal overlay state across Home and Guest Add tabs
    if (typeof syncTvOverlay === 'function') {
        syncTvOverlay();
    }
}

window.navTo = navTo;