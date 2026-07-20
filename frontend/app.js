/**
 * Gator Game Room Assistant - App Controller
 * Handles UI interactions, chat widget, and animations
 */

const API_BASE = window.GATOR_BOT_BASE_URL || '';

const initGatorBot = () => {
    // ============ DOM Elements ============
    const chatWidget = document.getElementById('chatWidget');
    const chatFab = document.getElementById('chatFab');
    const chatPanel = document.getElementById('chatPanel');
    const chatClose = document.getElementById('chatClose');
    const chatReset = document.getElementById('chatReset');
    const chatMessages = document.getElementById('chatMessages');
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');
    const chatSend = document.getElementById('chatSend');
    const chatResizeHandle = document.getElementById('chatResizeHandle');

    // All chat trigger buttons
    const chatTriggers = [
        document.getElementById('navChatBtn'),
        document.getElementById('heroChatBtn'),
        document.getElementById('ctaChatBtn'),
    ].filter(Boolean);

    let isChatOpen = false;
    let hasGreeted = false;
    // Set by refreshRoleBanner() before restoreHistory()/feedback buttons need it. Only ever
    // read from the server session (never trusted from anything the user can edit client-side) —
    // this is purely a UI-visibility toggle (feedback buttons for logged-in roles); the actual
    // access control lives entirely server-side regardless of what this variable holds.
    let currentTier = 'public';

    // ============ Role Banner ============
    const roleBanner = document.getElementById('roleBanner');
    const roleBannerText = document.getElementById('roleBannerText');
    const roleBannerLogout = document.getElementById('roleBannerLogout');
    const heroChatBtn = document.getElementById('heroChatBtn');
    const heroChatBtnDefaultText = heroChatBtn ? heroChatBtn.textContent.trim() : '';
    const ROLE_LABELS = { staff: 'Staff Mode', admin: 'Admin Mode', supervisor: 'Supervisor Mode' };
    const HERO_BTN_LABELS = { staff: 'Chat as Staff', admin: 'Chat as Admin', supervisor: 'Chat as Supervisor' };

    async function refreshRoleBanner() {
        try {
            const res = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                currentTier = data.tier || 'public';
                if (!roleBanner) return;
                if (currentTier !== 'public') {
                    roleBannerText.textContent = `Logged in — ${ROLE_LABELS[currentTier] || currentTier}`;
                    roleBanner.classList.add('visible');
                    if (heroChatBtn) heroChatBtn.textContent = HERO_BTN_LABELS[currentTier] || heroChatBtnDefaultText;
                } else {
                    roleBanner.classList.remove('visible');
                    if (heroChatBtn) heroChatBtn.textContent = heroChatBtnDefaultText;
                }
            }
        } catch (err) {
            // session check is non-critical — fail silently, treat as public
        }
    }

    if (roleBannerLogout) {
        roleBannerLogout.addEventListener('click', async () => {
            await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
            window.location.reload();
        });
    }

    // ============ Facility Status Banner ============
    async function checkFacilityStatus() {
        try {
            const res = await fetch(`${API_BASE}/api/chat/status`, { credentials: 'include' });
            const data = await res.json();
            if (data.hasClosure && data.notice) {
                const banner = document.createElement('div');
                banner.className = 'status-banner closure';
                banner.innerHTML = `<strong>Closure Notice:</strong> ${escapeHtml(data.notice)}`;
                chatMessages.parentNode.insertBefore(banner, chatMessages);
            }
        } catch (err) {}
    }

    // ============ Chat Widget Toggle ============
    function addGreeting() {
        hasGreeted = true;
        const msg = addBotMessage("Good day! 🐊 I'm your Gator Game Room Assistant powered by the UF Navigator LLM API.<br><br>Ask me anything about policies, procedures, or operations based on the Game Room Manual!");

        const chipsDiv = document.createElement('div');
        chipsDiv.className = 'suggestion-chips';
        chipsDiv.style.marginTop = '10px';

        const questions = currentTier === 'public' 
            ? ["What are the hours?", "How much does bowling cost?", "Can I bring food?"]
            : ["How do I close the register at night?", "Procedure for a broken pinsetter", "Guest alcohol policy"];

        questions.forEach(q => {
            const chip = document.createElement('div');
            chip.className = 'suggestion-chip';
            chip.dataset.question = q;
            chip.textContent = q;
            chipsDiv.appendChild(chip);
        });

        msg.querySelector('.message-content').appendChild(chipsDiv);

        chipsDiv.querySelectorAll('.suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                sendMessage(chip.dataset.question);
            });
        });
    }

    function openChat() {
        isChatOpen = true;
        chatWidget.classList.add('open');
        chatInput.focus();

        if (!hasGreeted) {
            addGreeting();
        }
    }

    function closeChat() {
        isChatOpen = false;
        chatWidget.classList.remove('open');
    }

    function toggleChat() {
        if (isChatOpen) {
            closeChat();
        } else {
            openChat();
        }
    }

    chatFab.addEventListener('click', toggleChat);
    chatClose.addEventListener('click', closeChat);

    if (chatReset) {
        chatReset.addEventListener('click', async () => {
            chatReset.disabled = true;
            try {
                await fetch(`${API_BASE}/api/chat/reset`, { method: 'POST', credentials: 'include' });
            } catch (err) {
                // Best-effort — even if the server call fails, clearing the visible transcript
                // below still gives the user a fresh-looking chat; worst case the server still
                // has old history until the session naturally expires.
            }
            chatMessages.innerHTML = '';
            hasGreeted = false;
            addGreeting();
            chatReset.disabled = false;
            chatInput.focus();
        });
    }

    chatTriggers.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openChat();
        });
    });

    // ============ Chat Panel Resize ============
    // The panel is anchored by bottom+right (see styles.css), so growing it extends the box
    // up and to the left — the handle sits in that same top-left corner as the natural grab
    // point. Size is clamped to the CSS min/max and remembered across visits via localStorage.
    const CHAT_SIZE_KEY = 'gatorChatSize';
    const MIN_CHAT_WIDTH = 320;
    const MIN_CHAT_HEIGHT = 400;

    function isMobileLayout() {
        return window.innerWidth <= 768;
    }

    function applyChatSize(width, height) {
        const maxWidth = window.innerWidth - 32;
        const maxHeight = window.innerHeight - 120;
        const clampedWidth = Math.max(MIN_CHAT_WIDTH, Math.min(width, maxWidth));
        const clampedHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(height, maxHeight));
        chatPanel.style.width = `${clampedWidth}px`;
        chatPanel.style.height = `${clampedHeight}px`;
        return { width: clampedWidth, height: clampedHeight };
    }

    function restoreSavedChatSize() {
        if (isMobileLayout()) return;
        try {
            const saved = JSON.parse(localStorage.getItem(CHAT_SIZE_KEY) || 'null');
            if (saved && saved.width && saved.height) {
                applyChatSize(saved.width, saved.height);
            }
        } catch (err) {
            // Ignore a malformed/corrupted saved value — default CSS size still applies.
        }
    }
    restoreSavedChatSize();

    if (chatResizeHandle) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;

        function onResizeMove(e) {
            if (!dragging) return;
            // Dragging toward the top-left must INCREASE size (the handle moves toward the
            // pointer, but the panel's bottom-right corner stays anchored in place).
            const deltaX = startX - e.clientX;
            const deltaY = startY - e.clientY;
            applyChatSize(startWidth + deltaX, startHeight + deltaY);
        }

        function onResizeEnd() {
            if (!dragging) return;
            dragging = false;
            chatPanel.classList.remove('resizing');
            document.removeEventListener('pointermove', onResizeMove);
            document.removeEventListener('pointerup', onResizeEnd);
            const rect = chatPanel.getBoundingClientRect();
            localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({ width: rect.width, height: rect.height }));
        }

        chatResizeHandle.addEventListener('pointerdown', (e) => {
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = chatPanel.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            chatPanel.classList.add('resizing');
            document.addEventListener('pointermove', onResizeMove);
            document.addEventListener('pointerup', onResizeEnd);
            e.preventDefault();
        });
    }

    // Re-clamp (or hand back control to the mobile CSS) whenever the browser window itself
    // is resized, so a saved/dragged size never overflows the viewport.
    window.addEventListener('resize', () => {
        if (isMobileLayout()) {
            chatPanel.style.width = '';
            chatPanel.style.height = '';
            return;
        }
        if (chatWidget.classList.contains('open')) {
            const rect = chatPanel.getBoundingClientRect();
            applyChatSize(rect.width, rect.height);
        }
    });

    // ============ Safe Markdown Rendering ============
    // Model output is plain text (possibly with **bold** / "- " bullets / blank-line
    // paragraphs). We escape HTML entities FIRST, then apply a small allow-listed set of
    // transforms — so injection is impossible by construction, and no raw "**" leaks through.
    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderBotText(text) {
        const escaped = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        const lines = escaped.split('\n');

        let html = '';
        let paragraphLines = [];
        let listItems = [];
        let showMap = false;

        function flushParagraph() {
            if (paragraphLines.length) {
                html += `<p>${paragraphLines.join('<br>')}</p>`;
                paragraphLines = [];
            }
        }
        function flushList() {
            if (listItems.length) {
                html += `<ul>${listItems.join('')}</ul>`;
                listItems = [];
            }
        }

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line === '[SHOW_MAP]') {
                showMap = true;
                continue;
            }
            const bulletMatch = line.match(/^-\s+(.*)/);
            if (!line) {
                flushParagraph();
                flushList();
            } else if (bulletMatch) {
                flushParagraph();
                listItems.push(`<li>${bulletMatch[1]}</li>`);
            } else {
                flushList();
                paragraphLines.push(line);
            }
        }
        flushParagraph();
        flushList();
        
        if (showMap) {
            html += `<div class="map-container" style="margin-top: 12px; background: #eef0f4; padding: 12px; border-radius: 8px; text-align: center; border: 1px solid #e2e5ea;">
                <div style="font-weight: 600; margin-bottom: 4px;">🗺️ Reitz Union Game Room</div>
                <div style="font-size: 0.85rem; color: #5b6472; margin-bottom: 10px;">Ground floor (Room G100)</div>
                <a href="https://campusmap.ufl.edu/#/index/0311" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 6px 12px; background: #0021A5; color: white; text-decoration: none; border-radius: 6px; font-size: 0.85rem; font-weight: 500;">Open in UF Campus Map ↗</a>
            </div>`;
        }

        return html;
    }

    // Builds a compact source badge (ⓘ) that reveals where the answer came from on hover, in
    // place of the long "Source: ..." footer. Supports one or more sources (manual + live).
    function buildSourceBadge(sources) {
        if (!Array.isArray(sources) || sources.length === 0) return null;
        const lines = sources.map((s) => {
            if (s.type === 'live') {
                const when = s.lastChecked ? ` — checked ${escapeHtml(s.lastChecked)}` : '';
                return `Live: ${escapeHtml(s.label || 'union.ufl.edu')}${when}`;
            }
            return `${escapeHtml(s.label || 'Game Room Manual')}${s.detail ? ' — ' + escapeHtml(s.detail) : ''}`;
        });
        const wrap = document.createElement('span');
        wrap.className = 'source-badge';
        wrap.setAttribute('tabindex', '0'); // keyboard/focus reveal for accessibility
        wrap.setAttribute('aria-label', 'Source: ' + lines.join('; ').replace(/<[^>]*>/g, ''));
        wrap.innerHTML = `<span class="source-icon">ⓘ</span><span class="source-tooltip"><strong>Source</strong><br>${lines.join('<br>')}</span>`;
        return wrap;
    }

    // Thumbs up/down, staff/supervisor/admin sessions only (currentTier !== 'public') — posts
    // to the already-built POST /api/chat/feedback endpoint. One-shot: both buttons disable
    // after a click rather than allowing the rating to be changed, keeping the log simple.
    function buildFeedbackButtons(question, answer) {
        const wrap = document.createElement('span');
        wrap.className = 'feedback-buttons';

        function makeButton(rating, label, glyph) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'feedback-btn';
            btn.setAttribute('aria-label', label);
            btn.textContent = glyph;
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                wrap.querySelectorAll('.feedback-btn').forEach((b) => { b.disabled = true; });
                btn.classList.add('selected');
                try {
                    await fetch(`${API_BASE}/api/chat/feedback`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rating, question, answer }),
                        credentials: 'include'
                    });
                } catch (err) {
                    // Best-effort — a failed feedback POST shouldn't disrupt the chat.
                }
            });
            return btn;
        }

        wrap.appendChild(makeButton('up', 'Helpful answer', 'Helpful'));
        wrap.appendChild(makeButton('down', 'Unhelpful answer', 'Not helpful'));
        return wrap;
    }

    // ============ Message Rendering ============
    // Uses the existing gator_avatar.png asset (already used in the chat header) instead of an
    // emoji character - some clients render emoji as a broken placeholder box instead of the
    // intended glyph, an image always renders the same way regardless.
    function createAvatar(type) {
        const avatarDiv = document.createElement('div');
        avatarDiv.classList.add('message-avatar');
        if (type === 'bot') {
            const img = document.createElement('img');
            img.src = `${API_BASE}/gator_avatar.png`;
            img.alt = 'Gator';
            avatarDiv.appendChild(img);
        } else {
            avatarDiv.textContent = 'U';
        }
        return avatarDiv;
    }

    function addMessage(content, type, sources, feedbackCtx) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', type);

        const avatarDiv = createAvatar(type);

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        contentDiv.innerHTML = content;

        if (type === 'bot') {
            const badge = buildSourceBadge(sources);
            if (badge) contentDiv.appendChild(badge);
            if (feedbackCtx) {
                const feedback = buildFeedbackButtons(feedbackCtx.question, feedbackCtx.answer);
                if (feedback) contentDiv.appendChild(feedback);
            }
        }

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        // Scroll to bottom
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        return messageDiv;
    }

    // Creates an empty bot message bubble to be filled incrementally as stream chunks arrive
    // (see sendMessage). Kept separate from addMessage() because the text needs its own node
    // that gets re-rendered on every chunk, without disturbing a source badge / feedback buttons
    // appended once at the end.
    function addStreamingBotMessage() {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', 'bot');

        const avatarDiv = createAvatar('bot');

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        contentDiv.appendChild(textDiv);

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        return { messageDiv, contentDiv, textDiv };
    }

    function addBotMessage(content, sources, feedbackCtx) {
        return addMessage(content, 'bot', sources, feedbackCtx);
    }

    // Escaped here (not passed raw into addMessage's innerHTML) — this is a fix for a real gap:
    // user-typed text used to go straight into innerHTML unescaped, so typing e.g. an <img
    // onerror=...> tag would execute it in the sender's own browser. Bot text never had this
    // problem (renderBotText already escapes first), only the user bubble did.
    function addUserMessage(content) {
        return addMessage(escapeHtml(content), 'user');
    }

    function showTypingIndicator() {
        const typingDiv = document.createElement('div');
        typingDiv.classList.add('message', 'bot');
        typingDiv.id = 'typingIndicator';

        const avatarDiv = createAvatar('bot');

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

        typingDiv.appendChild(avatarDiv);
        typingDiv.appendChild(contentDiv);
        chatMessages.appendChild(typingDiv);

        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) indicator.remove();
    }

    // ============ Send Message ============
    // The server streams the answer as newline-delimited JSON events (routes/chat.js's
    // startStream/writeEvent) instead of one JSON blob — {type:'chunk'|'blocked'|'error'|'done'}.
    // We read the response body incrementally so the bot bubble fills in as text is generated,
    // rather than staying blank until the whole reply is ready.
    let isStreaming = false;

    async function sendMessage(text) {
        if (!text || !text.trim()) return;
        if (isStreaming) return;
        isStreaming = true;

        const userText = text.trim();
        addUserMessage(userText);
        chatInput.value = '';
        chatSend.disabled = true;

        showTypingIndicator();

        let botEntry = null;
        let rendered = '';
        let finalSources = [];
        let ended = false;

        let typewriterQueue = '';
        let flushInterval = null;
        let streamDone = false;

        function ensureBotEntry() {
            if (!botEntry) {
                removeTypingIndicator();
                botEntry = addStreamingBotMessage();
            }
            return botEntry;
        }

        function renderInto(entry, textToRender) {
            entry.textDiv.innerHTML = renderBotText(textToRender);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function finalizeEntry() {
            const entry = ensureBotEntry();
            if (!rendered) {
                rendered = "Sorry, I couldn't process that request.";
                renderInto(entry, rendered);
            }
            if (!ended && !entry.hasFinalized) {
                entry.hasFinalized = true;
                const badge = buildSourceBadge(finalSources);
                if (badge) entry.contentDiv.appendChild(badge);
                const feedback = buildFeedbackButtons(userText, rendered);
                if (feedback) entry.contentDiv.appendChild(feedback);
            }
            chatSend.disabled = !chatInput.value.trim();
            chatInput.focus();
            isStreaming = false;
        }

        function processQueue() {
            if (typewriterQueue.length === 0) {
                if (streamDone) {
                    clearInterval(flushInterval);
                    finalizeEntry();
                }
                return;
            }
            // Dynamic typing speed: if queue is large, pop more chars to catch up
            const charsToPop = Math.max(1, Math.floor(typewriterQueue.length / 25));
            rendered += typewriterQueue.slice(0, charsToPop);
            typewriterQueue = typewriterQueue.slice(charsToPop);
            renderInto(ensureBotEntry(), rendered);
        }

        try {
            const response = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userText }),
                credentials: 'include'
            });

            if (!response.ok) {
                let data = {};
                try { data = await response.json(); } catch (err) { /* ignore parse failure */ }
                removeTypingIndicator();
                const replyText = data.response || data.error || "Sorry, I couldn't process that request.";
                addBotMessage(renderBotText(replyText));
                chatSend.disabled = !chatInput.value.trim();
                chatInput.focus();
                isStreaming = false;
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            flushInterval = setInterval(processQueue, 40); // type every 40ms

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    if (!line) continue;

                    let event;
                    try { event = JSON.parse(line); } catch (err) { continue; }

                    if (event.type === 'chunk') {
                        typewriterQueue += event.text;
                    } else if (event.type === 'blocked') {
                        ended = true;
                        typewriterQueue = '';
                        rendered = event.text || 'That information is restricted. Please contact your supervisor or the Game Room admin directly for it.';
                        renderInto(ensureBotEntry(), rendered);
                    } else if (event.type === 'error') {
                        ended = true;
                        typewriterQueue = '';
                        rendered = event.message || 'Sorry, I ran into a problem answering that. Please try again in a moment.';
                        renderInto(ensureBotEntry(), rendered);
                    } else if (event.type === 'done') {
                        finalSources = Array.isArray(event.sources) ? event.sources : [];
                    }
                }
            }
            streamDone = true;
        } catch (error) {
            console.error("Chat Error:", error);
            removeTypingIndicator();
            if (!botEntry) {
                addBotMessage("Sorry, I'm having trouble connecting to the server. Please try again later.");
            }
            if (flushInterval) clearInterval(flushInterval);
            chatSend.disabled = !chatInput.value.trim();
            chatInput.focus();
            isStreaming = false;
        }
    }

    // Form submit
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage(chatInput.value);
    });

    // Enable/disable send button
    chatInput.addEventListener('input', () => {
        chatSend.disabled = !chatInput.value.trim();
    });

    // ============ Suggestion Chips ============
    document.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const question = chip.dataset.question;
            sendMessage(question);
        });
    });

    // ============ Topic Chips (main page) ============
    document.querySelectorAll('.topic-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const question = chip.dataset.question;
            openChat();
            // Small delay so chat opens first
            setTimeout(() => {
                sendMessage(question);
            }, 300);
        });
    });

    // ============ Smooth Scroll for Nav Links ============
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                const offsetTop = target.offsetTop - 80;
                window.scrollTo({
                    top: offsetTop,
                    behavior: 'smooth'
                });
            }
        });
    });

    // ============ Intersection Observer for Animations ============
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    // Observe animatable elements
    document.querySelectorAll('.feature-card, .link-card, .contact-card, .topic-chip').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(el);
    });

    // Add stagger delay
    document.querySelectorAll('.features-grid .feature-card').forEach((card, i) => {
        card.style.transitionDelay = `${i * 100}ms`;
    });

    document.querySelectorAll('.links-grid .link-card').forEach((card, i) => {
        card.style.transitionDelay = `${i * 80}ms`;
    });

    document.querySelectorAll('.topics-grid .topic-chip').forEach((chip, i) => {
        chip.style.transitionDelay = `${i * 30}ms`;
    });

    // CSS class for animation trigger
    const style = document.createElement('style');
    style.textContent = `
        .animate-in {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }
    `;
    document.head.appendChild(style);

    // ============ Mobile Menu ============
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navLinks = document.querySelector('.nav-links');

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            navLinks.classList.toggle('mobile-open');
            mobileMenuBtn.classList.toggle('active');
        });
    }

    // Add mobile menu styles
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = `
        @media (max-width: 768px) {
            .nav-links.mobile-open {
                display: flex !important;
                flex-direction: column;
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: rgba(10, 11, 15, 0.98);
                backdrop-filter: blur(20px);
                padding: 24px;
                gap: 16px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .mobile-menu-btn.active span:nth-child(1) {
                transform: rotate(45deg) translate(5px, 5px);
            }
            .mobile-menu-btn.active span:nth-child(2) {
                opacity: 0;
            }
            .mobile-menu-btn.active span:nth-child(3) {
                transform: rotate(-45deg) translate(5px, -5px);
            }
        }
    `;
    document.head.appendChild(mobileStyle);

    // ============ Keyboard Shortcut ============
    document.addEventListener('keydown', (e) => {
        // Escape to close chat
        if (e.key === 'Escape' && isChatOpen) {
            closeChat();
        }
        // Ctrl/Cmd + K to open chat
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            openChat();
        }
    });

    // ============ Close chat when clicking outside ============
    document.addEventListener('click', (e) => {
        if (isChatOpen && !chatWidget.contains(e.target) && !chatTriggers.some(btn => btn && btn.contains(e.target))) {
            // Don't close if clicking a topic chip
            if (!e.target.closest('.topic-chip')) {
                closeChat();
            }
        }
    });

    // ============ Restore conversation on page load ============
    // The server already keeps recent turns in the (file-backed) session and feeds them to the
    // router/model regardless of what's on screen — so without this, a page refresh mid-chat
    // showed a blank widget while the bot still "remembered" the conversation underneath,
    // which read as inconsistent. This just mirrors that server-side memory into the UI.
    // Sources aren't restored (req.session.history only stores role/content, not citations —
    // see routes/chat.js's recordTurn), so restored bot turns show plain text with no badge.
    async function restoreHistory() {
        try {
            const res = await fetch('/api/chat/history', { credentials: 'include' });
            const data = await res.json();
            const history = Array.isArray(data.history) ? data.history : [];
            if (history.length === 0) return;

            hasGreeted = true; // don't also show the canned intro above real restored turns
            let lastUserMessage = '';
            for (const turn of history) {
                if (turn.role === 'user') {
                    lastUserMessage = turn.content;
                    addUserMessage(turn.content);
                } else if (turn.role === 'assistant') {
                    addBotMessage(renderBotText(turn.content), [], { question: lastUserMessage, answer: turn.content });
                }
            }
        } catch (err) {
            // History restore is non-critical — fail silently, chat just starts fresh.
        }
    }

    // Initialize send button state
    chatSend.disabled = true;

    // currentTier must be known BEFORE restoreHistory renders feedback buttons on restored
    // bot turns, so these run in sequence rather than in parallel.
    refreshRoleBanner().then(restoreHistory);
    checkFacilityStatus();

    console.log('🐊 Gator Game Room Assistant initialized!');
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGatorBot);
} else {
    initGatorBot();
}
