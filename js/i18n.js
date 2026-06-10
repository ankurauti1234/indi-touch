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

        try {
            if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
                el.placeholder = translation;
                return;
            }

            // If there's an explicit container for i18n text, use it.
            const textContainer = el.querySelector('.i18n-text');
            if (textContainer) {
                textContainer.textContent = translation;
                return;
            }

            // Use a TreeWalker to find the first visible text node child and replace it.
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode: function(node) {
                    if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
                    const txt = node.nodeValue.trim();
                    if (!txt) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });

            const firstText = walker.nextNode();
            if (firstText) {
                firstText.nodeValue = translation;
                return;
            }

            // No text node found — append a dedicated span for translation to preserve structure
            const span = document.createElement('span');
            span.className = 'i18n-text';
            span.textContent = translation;
            el.appendChild(span);

        } catch (e) {
            // Fail silently but log — avoid breaking the UI flow
            console.error('applyTranslations error for key', key, e);
        }
    });

    // Update specific dynamic elements if needed
    document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: currentLang } }));
}

export function getCurrentLang() {
    return currentLang;
}
