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
    const elements = document.querySelectorAll('[data-i18n]');
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

    // Update specific dynamic elements if needed
    document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: currentLang } }));
}

export function getCurrentLang() {
    return currentLang;
}
