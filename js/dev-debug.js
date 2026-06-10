// Development debug overlay: shows uncaught errors and unhandled rejections
function createOverlay() {
    let el = document.getElementById('dev-error-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'dev-error-overlay';
    el.style.cssText = [
        'position:fixed',
        'right:12px',
        'top:12px',
        'z-index:9999999',
        'background:rgba(51,0,0,0.95)',
        'color:#fff',
        'padding:12px',
        'border-radius:8px',
        'max-width:40vw',
        'font-family:monospace',
        'font-size:13px',
        'white-space:pre-wrap',
        'box-shadow:0 6px 18px rgba(0,0,0,0.6)'
    ].join(';');

    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Close';
    close.style.cssText = 'position:absolute;left:8px;top:6px;background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer';
    close.onclick = () => el.style.display = 'none';
    el.appendChild(close);

    const content = document.createElement('div');
    content.id = 'dev-error-content';
    content.style.marginLeft = '18px';
    el.appendChild(content);

    document.body.appendChild(el);
    return el;
}

function showDevError(msg) {
    try {
        const el = createOverlay();
        const content = document.getElementById('dev-error-content');
        content.textContent = typeof msg === 'string' ? msg : (msg && msg.stack) || String(msg);
        el.style.display = 'block';
        console.error('DEV ERROR:', msg);
    } catch (e) {
        console.error('Failed to show dev error overlay', e, msg);
    }
}

window.__showDevError = showDevError;

window.addEventListener('error', function (ev) {
    try {
        const msg = `Error: ${ev.message}\n${ev.filename || ''}:${ev.lineno || ''}\n${ev.error && ev.error.stack ? ev.error.stack : ''}`;
        showDevError(msg);
    } catch (e) { console.error(e); }
});

window.addEventListener('unhandledrejection', function (ev) {
    try {
        const reason = ev.reason;
        const msg = 'Unhandled Rejection: ' + (reason && reason.stack ? reason.stack : String(reason));
        showDevError(msg);
    } catch (e) { console.error(e); }
});

// Small helper for modules to call when catching errors
export function devError(msg) { showDevError(msg); }
