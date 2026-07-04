/**
 * Gator Game Room Assistant - App Controller
 * Handles UI interactions, chat widget, and animations
 */

document.addEventListener('DOMContentLoaded', () => {
    // ============ DOM Elements ============
    const chatWidget = document.getElementById('chatWidget');
    const chatFab = document.getElementById('chatFab');
    const chatPanel = document.getElementById('chatPanel');
    const chatClose = document.getElementById('chatClose');
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

    // ============ Role Banner ============
    const roleBanner = document.getElementById('roleBanner');
    const roleBannerText = document.getElementById('roleBannerText');
    const roleBannerLogout = document.getElementById('roleBannerLogout');
    const ROLE_LABELS = { staff: 'Staff Mode', admin: 'Admin Mode', supervisor: 'Supervisor Mode' };

    async function refreshRoleBanner() {
        if (!roleBanner) return;
        try {
            const res = await fetch('/api/auth/session');
            const data = await res.json();
            if (data.tier && data.tier !== 'public') {
                roleBannerText.textContent = `Logged in — ${ROLE_LABELS[data.tier] || data.tier}`;
                roleBanner.classList.add('visible');
            } else {
                roleBanner.classList.remove('visible');
            }
        } catch (err) {
            // session check is non-critical — fail silently, treat as public
        }
    }

    if (roleBannerLogout) {
        roleBannerLogout.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.reload();
        });
    }

    refreshRoleBanner();

    // ============ Chat Widget Toggle ============
    function openChat() {
        isChatOpen = true;
        chatWidget.classList.add('open');
        chatInput.focus();

        if (!hasGreeted) {
            hasGreeted = true;
            addBotMessage("Good day! 🐊 I'm your Gator Game Room Assistant powered by the UF Navigator LLM API.<br><br>Ask me anything about policies, procedures, or operations based on the Game Room Manual!");
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

    // ============ Message Rendering ============
    function addMessage(content, type, sources) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', type);

        const avatarDiv = document.createElement('div');
        avatarDiv.classList.add('message-avatar');
        avatarDiv.textContent = type === 'bot' ? '🐊' : '👤';

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        contentDiv.innerHTML = content;

        const badge = type === 'bot' ? buildSourceBadge(sources) : null;
        if (badge) contentDiv.appendChild(badge);

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        // Scroll to bottom
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        return messageDiv;
    }

    function addBotMessage(content, sources) {
        return addMessage(content, 'bot', sources);
    }

    function addUserMessage(content) {
        return addMessage(content, 'user');
    }

    function showTypingIndicator() {
        const typingDiv = document.createElement('div');
        typingDiv.classList.add('message', 'bot');
        typingDiv.id = 'typingIndicator';

        const avatarDiv = document.createElement('div');
        avatarDiv.classList.add('message-avatar');
        avatarDiv.textContent = '🐊';

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
    async function sendMessage(text) {
        if (!text || !text.trim()) return;

        const userText = text.trim();
        addUserMessage(userText);
        chatInput.value = '';
        chatSend.disabled = true;

        // Show typing indicator
        showTypingIndicator();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userText })
            });

            const data = await response.json();

            removeTypingIndicator();
            const replyText = data.response || data.error || "Sorry, I couldn't process that request.";
            addBotMessage(renderBotText(replyText), data.sources);

        } catch (error) {
            console.error("Chat Error:", error);
            removeTypingIndicator();
            addBotMessage("Sorry, I'm having trouble connecting to the server. Please try again later.");
        }

        chatSend.disabled = !chatInput.value.trim();
        chatInput.focus();
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

    // Initialize send button state
    chatSend.disabled = true;

    console.log('🐊 Gator Game Room Assistant initialized!');
});
