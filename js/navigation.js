import { closeSetting } from './settings.js';

export function navTo(viewId) {
    // 1. Sidebar Buttons Logic
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    let btnId = '';
    if(viewId === 'home') btnId = 'btn-home';
    else if(viewId === 'notifications') btnId = 'btn-notif';
    else if(viewId === 'settings') btnId = 'btn-settings';
    else if(viewId === 'guest-add') btnId = 'btn-guest';
    
    if(btnId) document.getElementById(btnId).classList.add('active');

    // 2. Reset Settings if leaving settings view
    if (viewId !== 'settings') {
        closeSetting();
    }

    // 3. Show correct view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId).classList.add('active');
}