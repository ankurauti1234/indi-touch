import { t } from './i18n.js';
import { navTo } from './navigation.js';

export function openSurvey(notif) {
    const container = document.getElementById('survey-content');
    if (!container) return;

    // Use survey config from the notification, with sensible defaults
    const surveyConfig = notif.survey || {};

    const surveyData = {
        question: notif.body,
        options: surveyConfig.options || ["Excellent", "Good", "Average", "Poor"],
        hasInput: !!surveyConfig.hasInput   // force boolean
    };

    renderSurveyContent(surveyData);
    navTo('survey');
}

function renderSurveyContent(data) {
    const container = document.getElementById('survey-content');
    
    let html = `
        <div class="survey-card">
            <h3 class="survey-question">${data.question}</h3>
            <div class="survey-options">
    `;

    if (data.hasInput) {
        html += `
            <div class="input-field-v2">
                <input type="text" id="survey-input" placeholder="${t('survey_submit')}..." />
            </div>
        `;
    } else {
        html += data.options.map((opt, i) => `
            <button class="survey-opt-btn" onclick="submitSurveyAnswer('${opt.replace(/'/g, "\\'")}')">
                <span class="opt-label">${String.fromCharCode(65 + i)}</span>
                ${opt}
            </button>
        `).join('');
    }

    html += `
            </div>
            <div class="survey-actions">
                <button class="modal-btn" onclick="navTo('notifications')">${t('survey_skip')}</button>
                ${data.hasInput 
                    ? `<button class="modal-btn primary" onclick="submitSurveyInput()">${t('survey_submit')}</button>` 
                    : `<button class="modal-btn primary" onclick="submitSurveyAnswer('Skipped')">${t('survey_submit')}</button>`
                }
            </div>
        </div>
    `;

    container.innerHTML = html;
}

window.submitSurveyAnswer = (answer) => {
    console.log("Survey Answer:", answer);
    if (window.showToast) window.showToast(t('survey_thanks'));
    navTo('notifications');
};
