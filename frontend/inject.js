// frontend/inject.js
(function() {
    if (document.getElementById('chatWidget')) return;

    const scriptTag = document.currentScript;
    let baseUrl = '';
    if (scriptTag && scriptTag.src) {
        const url = new URL(scriptTag.src);
        baseUrl = url.origin;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = baseUrl + '/styles.css';
    document.head.appendChild(link);

    const widgetHTML = `
        <button class="chat-fab" id="chatFab" aria-label="Open chat assistant">
            <div class="fab-icon open-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
            </div>
            <div class="fab-icon close-icon" style="display:none;">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </div>
        </button>

        <div class="chat-panel" id="chatPanel" style="display:none;">
            <div class="chat-resize-handle" id="chatResizeHandle" aria-hidden="true"></div>
            <div class="chat-header">
                <div class="chat-header-info">
                    <img src="${baseUrl}/gator_avatar.png" alt="Gator" class="chat-avatar">
                    <div>
                        <h4>Gator Game Room Assistant</h4>
                        <span class="chat-status">Online</span>
                    </div>
                </div>
                <div class="chat-header-actions">
                    <button class="chat-reset" id="chatReset" type="button" aria-label="Start a new conversation" title="New conversation">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 8 8 8"/>
                        </svg>
                    </button>
                    <button class="chat-close" id="chatClose" aria-label="Close chat">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="chat-messages" id="chatMessages" role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions">
            </div>
            <form class="chat-input-area" id="chatForm">
                <input type="text" class="chat-input" id="chatInput" placeholder="Ask about Game Room policies..." autocomplete="off">
                <button type="submit" class="chat-send" id="chatSend" aria-label="Send message">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                </button>
            </form>
        </div>
    `;

    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'chat-widget';
    widgetDiv.id = 'chatWidget';
    widgetDiv.innerHTML = widgetHTML;
    document.body.appendChild(widgetDiv);

    window.GATOR_BOT_BASE_URL = baseUrl;

    const appScript = document.createElement('script');
    appScript.src = baseUrl + '/app.js';
    document.body.appendChild(appScript);
})();
