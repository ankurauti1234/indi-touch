import { save, config } from './data.js';

let translations = {};
let currentLang = config.language || 'en';

export async function initI18n() {
    await loadLanguage(currentLang);
    applyTranslations();
}

export async function loadLanguage(lang) {
    try {
        const response = await fetch(`lang/${lang}.json`);
        translations = await response.json();
        currentLang = lang;
        config.language = lang;
        
        // Update document lang attribute
        document.documentElement.lang = lang;
        
        return true;
    } catch (error) {
        console.error("Failed to load language:", lang, error);
        return false;
    }
}

export function t(key) {
    return translations[key] || key;
}

export function applyTranslations() {
    // Helper to display errors visibly on the page for debugging
    function showDevError(msg) {
        console.error(msg);
        try {
            let el = document.getElementById('dev-error-overlay');
            if (!el) {
                el = document.createElement('div');
                el.id = 'dev-error-overlay';
                el.style.cssText = 'position:fixed;right:12px;top:12px;z-index:9999999;background:rgba(51,0,0,0.95);color:#fff;padding:12px;border-radius:8px;max-width:40vw;font-family:monospace;font-size:13px;white-space:pre-wrap;box-shadow:0 6px 18px rgba(0,0,0,0.6);';
                document.body.appendChild(el);
            }
            el.textContent = typeof msg === 'string' ? msg : (msg.stack || String(msg));
        } catch(e) { /* ignore overlay errors */ }
    }
    // Expose for other modules
    window.__showDevError = showDevError;

    const elements = document.querySelectorAll('[data-i18n]');
    try {
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = t(key);
            
            if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
                el.placeholder = translation;
            } else {
                // Preservation of icons if they are inside the element
                const icon = el.querySelector('.material-symbols-rounded');
                if (icon) {
                    const iconClone = icon.cloneNode(true);
                    el.innerText = translation;
                    el.prepend(iconClone);
                } else {
                    el.innerText = translation;
                }
            }
        });
    } catch (e) {
        showDevError('i18n.applyTranslations error:\n' + (e.stack || e.message));
        console.error('i18n.applyTranslations error', e);
    }

    // Update specific dynamic elements if needed
    document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: currentLang } }));
}

export function getCurrentLang() {
    return currentLang;
}
