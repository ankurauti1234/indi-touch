import { closeSetting } from './settings.js';

export function navTo(viewId) {
    // 1. Drop active focus/caret locks that freeze touch scrolling
    if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
    }

    // 2. Sidebar Buttons Logic
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

    // 3. Reset Settings if leaving settings view
    if (viewId !== 'settings') {
        closeSetting();
    }

    // 4. Show correct view and reset scroller state
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });

    const targetView = document.getElementById('view-' + viewId);
    if (targetView) {
        targetView.style.display = 'flex';
        // Force reflow
        void targetView.offsetWidth;
        targetView.classList.add('active');

        // Reset scroll position on active view
        const scroller = targetView.querySelector('.list-group, .settings-scroll-area');
        if (scroller) {
            scroller.scrollTop = 0;
        }
    }
}