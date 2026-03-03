/* js/keyboard.js */

const keysEN = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
    ["?123", "lang", "space", ".", "enter"]
];

const keysHY = [
    ["ք", "ո", "ե", "ռ", "տ", "ը", "ւ", "ի", "օ", "պ"],
    ["ա", "ս", "դ", "ֆ", "գ", "հ", "յ", "կ", "լ"],
    ["shift", "զ", "ղ", "ց", "վ", "բ", "ն", "մ", "backspace"],
    ["?123", "lang", "space", ".", "enter"]
];

const keysRU = [
    ["й", "ц", "у", "к", "е", "н", "г", "ш", "щ", "з", "х", "ъ"],
    ["ф", "ы", "в", "а", "п", "р", "о", "л", "д", "ж", "э"],
    ["shift", "я", "ч", "с", "м", "и", "т", "ь", "б", "ю", "backspace"],
    ["?123", "lang", "space", ".", "enter"]
];

const keysSymbol = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "$", "_", "&", "-", "+", "(", ")", "/"],
    ["shift", "*", "\"", "'", ":", ";", "!", "?", "backspace"],
    ["ABC", "lang", "space", ".", "enter"]
];

const keysNumber = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["+", "x", "÷", "=", "/", "_", "<", ">", "[", "]"],
    ["!", "@", "#", "₹", "%", "^", "&", "*", "backspace"],
    ["ABC", "(", ")", ",", "space", ".", "enter"]
];

import { config } from './data.js';

let isShift = false;
let isSymbol = false;
let isNumberMode = false;
let activeInput = null;
let inputLang = config.language || 'en'; // Current keyboard language (independent of app lang)

export function initOSK() {
    // 1. Create Container
    const container = document.createElement('div');
    container.id = 'osk-container';
    document.body.appendChild(container);
    
    // 2. Render Initial Layout
    renderKeys();

    // 3. Global Input Listener
    // Use delegation to handle inputs created dynamically (like in onboarding)
    document.addEventListener('focusin', (e) => {
        if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'TEXTAREA') {
            activeInput = e.target;
            
            // Check for custom numeric mode attribute
            isNumberMode = (e.target.type === 'number' || e.target.dataset.oskMode === 'number');
            
            showOSK();
        }
    });

    // Fallback for click if focusin is missed or blocked
    document.addEventListener('click', (e) => {
        if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'TEXTAREA') {
            activeInput = e.target;
            showOSK();
        }
    });

    // Optional: Hide on click outside (careful not to hide when clicking keys)
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#osk-container') && !e.target.closest('input') && !e.target.closest('.remoteFocused')) {
            hideOSK();
        }
    });
}

function renderKeys() {
    const container = document.getElementById('osk-container');
    container.innerHTML = ''; // Clear
    
    let layout;
    if (isNumberMode) {
        layout = keysNumber;
        container.classList.add('numeric-mode');
    } else {
        container.classList.remove('numeric-mode');
        if (isSymbol) {
            layout = keysSymbol;
        } else {
            if (inputLang === 'hy') layout = keysHY;
            else if (inputLang === 'ru') layout = keysRU;
            else layout = keysEN;
        }
    }

    layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'osk-row';

        row.forEach(key => {
            const btn = document.createElement('button');
            btn.className = 'osk-key';
            
            // Text / Label Logic
            let display = key;
            if (key === 'shift') {
                display = '⇧';
                btn.classList.add('wide');
                if (isShift && !isSymbol) btn.classList.add('shift-active');
            } else if (key === 'backspace') {
                display = '⌫';
                btn.classList.add('wide');
            } else if (key === 'enter') {
                display = 'Done';
                btn.classList.add('action');
            } else if (key === 'space') {
                display = '';
                btn.classList.add('space');
            } else if (key === '?123' || key === 'ABC') {
                btn.classList.add('wide');
            } else if (key === 'lang') {
                display = inputLang.toUpperCase();
                btn.classList.add('wide');
            } else {
                // Normal Letter: Handle Case
                if (!isSymbol && isShift) display = key.toUpperCase();
            }

            btn.innerText = display;
            
            // Interaction
            btn.onclick = (e) => {
                e.stopPropagation(); // Prevent "click outside" listener from firing
                e.preventDefault(); 
                handleKey(key);
                if (activeInput && key !== 'enter') activeInput.focus(); // Skip focus if closing
            };

            rowDiv.appendChild(btn);
        });

        container.appendChild(rowDiv);
    });
}

function handleKey(key) {
    if (!activeInput) return;

    if (key === 'shift') {
        if (isSymbol) return; 
        isShift = !isShift;
        renderKeys();
        return;
    }

    if (key === 'lang') {
        const langs = ['en', 'hy', 'ru'];
        let idx = langs.indexOf(inputLang);
        inputLang = langs[(idx + 1) % langs.length];
        renderKeys();
        return;
    }

    if (key === '?123') {
        isSymbol = true;
        renderKeys();
        return;
    }

    if (key === 'ABC') {
        isSymbol = false;
        isNumberMode = false; // Allow returning to alpha even if input was type="number"
        renderKeys();
        return;
    }

    if (key === 'backspace') {
        activeInput.value = activeInput.value.slice(0, -1);
    } else if (key === 'enter') {
        hideOSK();
        activeInput.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
        activeInput.blur();
    } else if (key === 'space') {
        activeInput.value += ' ';
    } else {
        // Normal Char
        const char = (isShift && !isSymbol) ? key.toUpperCase() : key;
        activeInput.value += char;
        
        if (isShift) {
            isShift = false;
            renderKeys();
        }
    }
    
    // Trigger input event so frameworks/listeners know value changed
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
}

export function showOSK() {
    document.getElementById('osk-container').classList.add('visible');
    document.body.classList.add('osk-open');
    setTimeout(() => {
        if (activeInput) activeInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

export function hideOSK() {
    document.getElementById('osk-container').classList.remove('visible');
    document.body.classList.remove('osk-open');
}