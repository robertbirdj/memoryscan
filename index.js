// SillyTavern Dynamic Memory Extension
// by Jules

const { extensionSettings, saveSettingsDebounced, getContext, eventSource, event_types } = SillyTavern.getContext();

const MODULE_NAME = 'dynamic-memory';

const defaultSettings = Object.freeze({
    enabled: true,
    pageSize: 2000,
    presentSituationSize: 1000,
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    summarizeModel: 'openai/gpt-3.5-turbo',
});

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    return extensionSettings[MODULE_NAME];
}

let dynamicMemory = [];

// The main interceptor function
globalThis.dynamicMemoryInterceptor = async function(chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || chat.length < 3) { // Don't run on very short chats
        return;
    }

    console.log('Dynamic Memory Interceptor triggered');

    // 1. Find initial system messages to preserve them
    let chatStartIndex = 0;
    for (let i = 0; i < chat.length; i++) {
        // Find the first message that is from the user or the character
        if (chat[i].is_user || (!chat[i].is_system && chat[i].name !== 'System')) {
            chatStartIndex = i;
            break;
        }
        // If we loop through the whole chat and it's all system messages, do nothing.
        if (i === chat.length - 1) {
            return;
        }
    }
    const initialSystemMessages = chat.slice(0, chatStartIndex);
    const workableChat = chat.slice(chatStartIndex);


    // 2. Find the split point in the workable chat between "history" and "present"
    let presentSituationCharCount = 0;
    let splitIndex = workableChat.length;
    // Iterate from the last message backwards
    for (let i = workableChat.length - 1; i >= 0; i--) {
        const message = workableChat[i];
        const messageText = `${message.name}: ${message.mes}\n`;
        if (presentSituationCharCount + messageText.length > settings.presentSituationSize) {
            // We've collected enough for the present, the rest is history
            break;
        }
        presentSituationCharCount += messageText.length;
        splitIndex = i;
    }

    const historyToSummarize = workableChat.slice(0, splitIndex);
    const presentChat = workableChat.slice(splitIndex);

    if (historyToSummarize.length === 0) {
        console.log('Dynamic Memory: No history to summarize.');
        return; // Not enough history to summarize
    }

    // 3. Paginate and summarize the history
    const pages = paginate(historyToSummarize, settings.pageSize);
    const presentSituationText = presentChat.map(m => `${m.name}: ${m.mes}`).join('\n');

    const summarizedPages = [];
    for (const page of pages) {
        const summary = await summarizePage(page, presentSituationText, settings);
        if (summary) {
            summarizedPages.push(summary);
        }
    }

    dynamicMemory = summarizedPages;

    // 4. Reconstruct the chat array if we have a summary
    if (dynamicMemory.length > 0) {
        const memoryString = dynamicMemory.join('\n');
        const memoryMessage = {
            is_user: false,
            name: "System",
            is_system: true,
            send_date: Date.now(),
            mes: `[The following is a summarized history of past events, used for context]\n${memoryString}`
        };

        // Modify the chat array in-place
        chat.length = 0;
        chat.push(...initialSystemMessages);
        chat.push(memoryMessage);
        chat.push(...presentChat);
        console.log('Dynamic Memory: Chat context reconstructed with summary.');
    }
};

function paginate(chat, pageSize) {
    let fullText = '';
    for (const message of chat) {
        fullText += `${message.name}: ${message.mes}\n`;
    }

    if (fullText.length === 0) {
        return [];
    }

    const pages = [];
    let startIndex = 0;
    while (startIndex < fullText.length) {
        pages.push(fullText.substring(startIndex, startIndex + pageSize));
        startIndex += pageSize;
    }

    return pages;
}


async function summarizePage(page, presentSituation, settings) {
    const { apiUrl, apiKey, summarizeModel } = settings;

    if (!apiKey) {
        toastr.error('Dynamic Memory: API key is not set. Please set it in the extension settings.');
        console.error('Dynamic Memory: API key is not set.');
        return null;
    }

    const prompt = `Present Situation:\n${presentSituation}\n\nMemory:\n${page}\n\nBased on the present situation, what details from the memory are relevant? Be brief. If nothing is relevant, respond with a blank message.`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://sillytavern.app', // Or your app's URL
                'X-Title': 'SillyTavern' // Or your app's name
            },
            body: JSON.stringify({
                model: summarizeModel,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            toastr.error(`Dynamic Memory: API request failed with status ${response.status}. See console for details.`);
            console.error(`Dynamic Memory: API request failed with status ${response.status}`);
            console.error('Error details:', errorText);
            return null;
        }

        const data = await response.json();
        if (!data.choices || data.choices.length === 0) {
            toastr.error('Dynamic Memory: Invalid API response. See console for details.');
            console.error('Dynamic Memory: Invalid API response', data);
            return null;
        }
        return data.choices[0].message.content.trim();
    } catch (error) {
        toastr.error('Dynamic Memory: Error during API call. See console for details.');
        console.error('Dynamic Memory: Error during API call', error);
        return null;
    }
}

// Create the settings UI
function onSettingsChange() {
    const settings = getSettings();
    // Update UI elements if needed
}

function createSettingsUI() {
    const settingsHtml = `
        <div class="dynamic-memory-settings">
            <h2>Dynamic Memory Settings</h2>
            <div class="inline-drawer">
                <p>This extension summarizes the chat history and injects it into the context. This can help the AI remember important details from long conversations.</p>
            </div>

            <label for="dm-enabled">Enabled</label>
            <input type="checkbox" id="dm-enabled" ${getSettings().enabled ? 'checked' : ''}>

            <label for="dm-page-size" title="The maximum number of characters per page.">Page Size (characters)</label>
            <input type="number" id="dm-page-size" value="${getSettings().pageSize}" placeholder="e.g., 2000">

            <label for="dm-present-situation-size" title="The number of recent characters to use as the 'present situation'.">Present Situation Size (characters)</label>
            <input type="number" id="dm-present-situation-size" value="${getSettings().presentSituationSize}" placeholder="e.g., 1000">

            <label for="dm-api-url" title="The API endpoint for the summarization service (e.g., OpenRouter).">API URL</label>
            <input type="text" id="dm-api-url" value="${getSettings().apiUrl}" placeholder="https://openrouter.ai/api/v1/chat/completions">

            <label for="dm-summarize-model" title="The model to use for summarization.">Summarizer Model</label>
            <input type="text" id="dm-summarize-model" value="${getSettings().summarizeModel}" placeholder="openai/gpt-3.5-turbo">

            <label for="dm-api-key" title="Your API key for the summarization service.">API Key</label>
            <input type="password" id="dm-api-key" value="${getSettings().apiKey}" placeholder="sk-...">
            <small>Your API key is stored in plain text. Use a dedicated key for this extension and revoke it if you no longer use it.</small>

            <button id="dm-save-settings" class="primary-button">Save Settings</button>

            <h3>Dynamic Memory</h3>
            <div id="dm-memory-view" class="draggable-handle"></div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);

    $('#dm-save-settings').on('click', () => {
        const settings = getSettings();
        settings.enabled = $('#dm-enabled').is(':checked');
        settings.pageSize = parseInt($('#dm-page-size').val());
        settings.presentSituationSize = parseInt($('#dm-present-situation-size').val());
        settings.apiUrl = $('#dm-api-url').val();
        settings.summarizeModel = $('#dm-summarize-model').val();
        settings.apiKey = $('#dm-api-key').val();
        saveSettingsDebounced();
        toastr.success('Dynamic Memory settings saved!');
    });

    // Update memory view
    setInterval(() => {
        const memoryView = $('#dm-memory-view');
        if (memoryView) {
            memoryView.html(dynamicMemory.join('<br>'));
        }
    }, 2000);
}

// Function to initialize the extension
function initialize() {
    // Add the settings UI
    createSettingsUI();

    // Log a message to indicate the extension is loaded
    console.log('Dynamic Memory extension loaded.');
}

// Wait for the DOM to be ready before initializing the extension
$(document).ready(() => {
    // A small delay to ensure other scripts have loaded
    setTimeout(initialize, 500);
});
