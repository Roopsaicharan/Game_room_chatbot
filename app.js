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

    // All chat trigger buttons
    const chatTriggers = [
        document.getElementById('navChatBtn'),
        document.getElementById('heroChatBtn'),
        document.getElementById('ctaChatBtn'),
    ].filter(Boolean);

    let isChatOpen = false;
    let hasGreeted = false;

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

    // ============ Message Rendering ============
    function addMessage(content, type) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', type);

        const avatarDiv = document.createElement('div');
        avatarDiv.classList.add('message-avatar');
        avatarDiv.textContent = type === 'bot' ? '🐊' : '👤';

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        contentDiv.innerHTML = content;

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        // Scroll to bottom
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        return messageDiv;
    }

    function addBotMessage(content) {
        return addMessage(content, 'bot');
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
            addBotMessage(data.response);

        } catch (error) {
            console.error("Chat Error:", error);
            removeTypingIndicator();
            addBotMessage("Sorry, I'm having trouble connecting to the server. Please try again later.");
        }

        chatSend.disabled = false;
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
