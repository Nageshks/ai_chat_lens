// ============================================================
// AiChatLens v1.1 — Content Script
// Floating TOC panel for AI chat conversations (Claude, Meta AI)
// ============================================================

(function () {
  'use strict';

  // Prevent double-injection
  if (document.getElementById('aicl-host')) return;

  // ----------------------------------------------------------
  // Platform Detection
  // ----------------------------------------------------------
  const platform = (() => {
    const host = location.hostname;
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('meta.ai')) return 'meta';
    return 'unknown';
  })();

  // ----------------------------------------------------------
  // Constants
  // ----------------------------------------------------------
  const PANEL_WIDTH = 280;
  const COLLAPSED_WIDTH = 40;
  const HEADER_OFFSET = platform === 'meta' ? 56 : 80; // px to offset for sticky header
  const DEBOUNCE_MS = 300;
  const MAX_DISPLAY_ITEMS = 100;
  const MAX_MESSAGES_WARNING = 200;
  const TRUNCATE_LEN = 120;
  const RETRY_TIMEOUT_MS = 5000;
  const HIGHLIGHT_DURATION_MS = 1500;
  const ACCENT = '#e85d3a';
  const ACCENT_DIM = 'rgba(232, 93, 58, 0.12)';

  // ----------------------------------------------------------
  // Category definitions
  // ----------------------------------------------------------
  const CATEGORIES = [
    {
      name: 'Code',
      color: '#60a5fa',
      keywords: /\b(code|function|bug|error|script|api|debug|fix|implement|class|variable|syntax|compile|runtime|program|algorithm|regex|html|css|javascript|python|typescript|json|sql|git|deploy|refactor|lint|test|npm|webpack|import|export|async|await|promise|array|object|loop|if\s+else|try\s+catch)\b/i,
    },
    {
      name: 'Writing',
      color: '#4ade80',
      keywords: /\b(write|essay|draft|story|article|blog|email|letter|poem|paragraph|sentence|grammar|tone|rewrite|rephrase|summarize|proofread|edit\s+(?:this|my)|copy|headline|caption|slogan)\b/i,
    },
    {
      name: 'Research',
      color: '#c084fc',
      keywords: /\b(research|find|search|compare|analyze|explain|study|difference|between|pros\s+and\s+cons|advantages|disadvantages|history|overview|summary|define|definition|meaning|concept)\b/i,
    },
    {
      name: 'Question',
      color: '#facc15',
      keywords: /^(what|how|why|when|where|who|which|can\s+you|is\s+it|should|could|would|does|do\s+you|are\s+there|is\s+there|tell\s+me)\b/i,
    },
  ];
  const DEFAULT_CATEGORY = { name: 'Other', color: '#9ca3af' };

  // ----------------------------------------------------------
  // Filters
  // ----------------------------------------------------------
  const ACKNOWLEDGEMENTS = /^(thanks|thank\s*you|ok|okay|got\s*it|sure|yes|no|yep|nope|alright|right|cool|nice|great|good|perfect|awesome|agreed|indeed|exactly|correct|understood|ack|ty|thx|kk)[\.\!\?\s]*$/i;
  const CONTINUATIONS = /^(continue|go\s*on|proceed|keep\s*going|next|more|go\s*ahead|carry\s*on|please\s*continue)[\.\!\?\s]*$/i;
  const SINGLE_PUNCT_EMOJI = /^[\p{P}\p{S}\s]+$/u;

  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  let isCollapsed = false;
  let tocItems = []; // { element, text, category, timestamp, id }
  let previousMessageTexts = [];
  let activeItemId = null;
  let retryTimer = null;
  let scanTimer = null;
  let lastUrl = location.href;
  let intersectionObserver = null;

  // ----------------------------------------------------------
  // Shadow DOM styles
  // ----------------------------------------------------------
  const SHADOW_STYLES = `
    :host {
      all: initial;
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      color: #e4e4e7;
      line-height: 1.4;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .aicl-panel {
      position: fixed;
      top: 0;
      right: 0;
      width: ${PANEL_WIDTH}px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: rgba(24, 24, 27, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 9999;
      overflow: hidden;
      pointer-events: auto;
    }

    .aicl-panel.collapsed {
      width: ${COLLAPSED_WIDTH}px;
    }

    /* ---- Header ---- */
    .aicl-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 14px 10px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      min-height: 52px;
      flex-shrink: 0;
    }

    .aicl-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }

    .aicl-logo {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: linear-gradient(135deg, ${ACCENT}, #ff8c42);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
    }

    .aicl-title {
      font-size: 13px;
      font-weight: 600;
      color: #fafafa;
      white-space: nowrap;
      letter-spacing: 0.3px;
    }

    .collapsed .aicl-header-left .aicl-title {
      display: none;
    }

    .aicl-header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .collapsed .aicl-header-actions .aicl-copy-btn {
      display: none;
    }

    .aicl-copy-btn {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #a1a1aa;
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      flex-shrink: 0;
      font-size: 12px;
      line-height: 1;
      position: relative;
    }

    .aicl-copy-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fafafa;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .aicl-copy-btn.copied {
      border-color: rgba(74, 222, 128, 0.4);
      color: #4ade80;
    }

    .aicl-copy-toast {
      position: absolute;
      bottom: -28px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(24, 24, 27, 0.95);
      border: 1px solid rgba(74, 222, 128, 0.3);
      color: #4ade80;
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    .aicl-copy-btn.copied .aicl-copy-toast {
      opacity: 1;
    }

    .aicl-collapse-btn {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #a1a1aa;
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      flex-shrink: 0;
      font-size: 14px;
      line-height: 1;
    }

    .aicl-collapse-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fafafa;
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* ---- Collapsed badge ---- */
    .aicl-collapsed-badge {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 14px 0;
      cursor: pointer;
      flex: 1;
    }

    .collapsed .aicl-collapsed-badge {
      display: flex;
    }

    .aicl-count-badge {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: ${ACCENT};
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .aicl-badge-label {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font-size: 10px;
      color: #71717a;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    /* ---- Search bar ---- */
    .aicl-search {
      padding: 8px 14px;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .collapsed .aicl-search {
      display: none;
    }

    .aicl-search-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }

    .aicl-search-icon {
      position: absolute;
      left: 9px;
      color: #52525b;
      font-size: 13px;
      pointer-events: none;
      line-height: 1;
    }

    .aicl-search-input {
      width: 100%;
      padding: 7px 30px 7px 30px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: #e4e4e7;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: all 0.2s ease;
    }

    .aicl-search-input::placeholder {
      color: #52525b;
    }

    .aicl-search-input:focus {
      border-color: rgba(232, 93, 58, 0.4);
      background: rgba(255, 255, 255, 0.06);
    }

    .aicl-search-clear {
      position: absolute;
      right: 6px;
      background: none;
      border: none;
      color: #52525b;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px;
      border-radius: 4px;
      display: none;
      transition: color 0.15s ease;
    }

    .aicl-search-clear:hover {
      color: #a1a1aa;
    }

    .aicl-search-clear.visible {
      display: block;
    }

    .aicl-search-count {
      font-size: 10px;
      color: #52525b;
      padding: 3px 0 0 2px;
    }

    /* ---- Body (list area) ---- */
    .aicl-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px 0;
    }

    .collapsed .aicl-body {
      display: none;
    }

    .collapsed .aicl-header {
      padding: 10px 7px;
      justify-content: center;
    }

    .collapsed .aicl-collapse-btn {
      width: 26px;
      height: 26px;
    }

    .collapsed .aicl-footer {
      display: none;
    }

    /* Scrollbar */
    .aicl-body::-webkit-scrollbar {
      width: 4px;
    }
    .aicl-body::-webkit-scrollbar-track {
      background: transparent;
    }
    .aicl-body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 4px;
    }
    .aicl-body::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    /* ---- TOC Items ---- */
    .aicl-item {
      display: flex;
      gap: 10px;
      padding: 10px 14px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: all 0.2s ease;
      position: relative;
      animation: aicl-fadeIn 0.3s ease;
    }

    @keyframes aicl-fadeIn {
      from { opacity: 0; transform: translateX(8px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .aicl-item:hover {
      background: rgba(255, 255, 255, 0.04);
      border-left-color: rgba(232, 93, 58, 0.4);
    }

    .aicl-item.active {
      background: ${ACCENT_DIM};
      border-left-color: ${ACCENT};
    }

    .aicl-item-number {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.08);
      color: ${ACCENT};
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .aicl-item.active .aicl-item-number {
      background: ${ACCENT};
      color: #fff;
    }

    .aicl-item-content {
      flex: 1;
      min-width: 0;
    }

    .aicl-item-text {
      font-size: 12.5px;
      color: #d4d4d8;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }

    .aicl-item:hover .aicl-item-text {
      color: #fafafa;
    }

    .aicl-item.active .aicl-item-text {
      color: #fafafa;
    }

    .aicl-item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 5px;
      font-size: 10.5px;
      color: #71717a;
    }

    .aicl-category-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .aicl-category-name {
      font-weight: 500;
    }

    .aicl-item-time {
      margin-left: auto;
      white-space: nowrap;
    }

    /* ---- Footer ---- */
    .aicl-footer {
      padding: 10px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      font-size: 10.5px;
      color: #52525b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .aicl-shortcut {
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      color: #71717a;
      font-family: monospace;
    }

    /* ---- Empty / Warning states ---- */
    .aicl-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
      color: #71717a;
      gap: 12px;
    }

    .aicl-empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .aicl-empty-title {
      font-size: 13px;
      font-weight: 500;
      color: #a1a1aa;
    }

    .aicl-empty-desc {
      font-size: 11.5px;
      line-height: 1.5;
    }

    .aicl-retry-btn {
      margin-top: 6px;
      padding: 6px 16px;
      border-radius: 6px;
      border: 1px solid rgba(232, 93, 58, 0.4);
      background: rgba(232, 93, 58, 0.1);
      color: ${ACCENT};
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .aicl-retry-btn:hover {
      background: rgba(232, 93, 58, 0.2);
      border-color: ${ACCENT};
    }

    .aicl-warning {
      padding: 8px 14px;
      background: rgba(250, 204, 21, 0.08);
      border-left: 3px solid #facc15;
      font-size: 11px;
      color: #facc15;
      margin: 4px 10px;
      border-radius: 0 6px 6px 0;
    }

    /* ---- Highlight flash on scroll target ---- */
    .aicl-highlight-flash {
      border-left: 4px solid ${ACCENT} !important;
      transition: border-left-color ${HIGHLIGHT_DURATION_MS}ms ease !important;
    }
    .aicl-highlight-flash-fade {
      border-left-color: transparent !important;
    }

    /* ---- Responsive ---- */
    @media (max-width: 768px) {
      .aicl-panel {
        width: ${PANEL_WIDTH}px;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.5);
      }
      .aicl-panel.collapsed {
        width: ${COLLAPSED_WIDTH}px;
        box-shadow: none;
      }
    }
  `;

  // ----------------------------------------------------------
  // Utils
  // ----------------------------------------------------------
  function truncate(text, len) {
    if (!text) return '';
    text = text.trim().replace(/\s+/g, ' ');
    return text.length > len ? text.slice(0, len).trimEnd() + '…' : text;
  }

  function categorize(text) {
    if (!text) return DEFAULT_CATEGORY;
    for (const cat of CATEGORIES) {
      if (cat.keywords.test(text)) return cat;
    }
    return DEFAULT_CATEGORY;
  }

  function relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 10) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function shouldFilter(text) {
    if (!text || text.trim().length < 10) return true;
    const trimmed = text.trim();
    if (ACKNOWLEDGEMENTS.test(trimmed)) return true;
    if (CONTINUATIONS.test(trimmed)) return true;
    if (SINGLE_PUNCT_EMOJI.test(trimmed)) return true;
    return false;
  }

  function extractText(element) {
    // Meta AI: text is in span[data-slot="text"]
    if (platform === 'meta') {
      const textSpan = element.querySelector('span[data-slot="text"]');
      if (textSpan && textSpan.textContent.trim()) return textSpan.textContent.trim();
    }
    // Claude: Try first paragraph
    const p = element.querySelector('p');
    if (p && p.textContent.trim()) return p.textContent.trim();
    // Fallback to full text
    return (element.textContent || '').trim();
  }

  function generateId() {
    return 'aicl-' + Math.random().toString(36).slice(2, 10);
  }

  // ----------------------------------------------------------
  // DOM: Find user messages (platform-aware)
  // ----------------------------------------------------------
  function findUserMessages() {
    if (platform === 'meta') return findMetaAIUserMessages();
    return findClaudeUserMessages();
  }

  // ---- Meta AI message detection ----
  function findMetaAIUserMessages() {
    // Strategy 1: data-message-type="user" attribute
    let messages = document.querySelectorAll('[data-message-type="user"]');
    if (messages.length > 0) return Array.from(messages);

    // Strategy 2: data-message-item with _user suffix in message ID
    const messageItems = document.querySelectorAll('[data-message-item="true"]');
    const userMessages = [];
    messageItems.forEach(el => {
      const id = el.getAttribute('data-message-id') || '';
      if (id.includes('_user')) {
        const userDiv = el.querySelector('[data-message-type="user"]');
        userMessages.push(userDiv || el);
      }
    });
    if (userMessages.length > 0) return userMessages;

    return [];
  }

  // ---- Claude message detection ----
  function findClaudeUserMessages() {
    // Strategy 1: data-testid
    let messages = document.querySelectorAll('[data-testid="human-user-message"]');
    if (messages.length > 0) return Array.from(messages);

    // Strategy 2: class-based (Claude uses .font-user-message or similar)
    messages = document.querySelectorAll('.font-user-message');
    if (messages.length > 0) return Array.from(messages);

    // Strategy 3: role-based
    messages = document.querySelectorAll('[data-is-streaming="false"][class*="human"], [class*="user-message"]');
    if (messages.length > 0) return Array.from(messages);

    // Strategy 4: heuristic — look for the conversation turn containers
    // Claude wraps each turn; human turns have a specific structure
    const allTurns = document.querySelectorAll('[class*="conv"], [class*="turn"], [class*="message"]');
    const humanTurns = [];
    allTurns.forEach(el => {
      const text = el.className || '';
      if (/human|user/i.test(text) && el.textContent.trim().length > 0) {
        humanTurns.push(el);
      }
    });
    if (humanTurns.length > 0) return humanTurns;

    return [];
  }

  // ----------------------------------------------------------
  // Create Shadow DOM panel
  // ----------------------------------------------------------
  function createPanel() {
    const host = document.createElement('div');
    host.id = 'aicl-host';

    const shadow = host.attachShadow({ mode: 'closed' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    shadow.appendChild(style);

    // Panel container
    const panel = document.createElement('div');
    panel.className = 'aicl-panel';

    // ---- Header ----
    const header = document.createElement('div');
    header.className = 'aicl-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'aicl-header-left';

    const logo = document.createElement('div');
    logo.className = 'aicl-logo';
    logo.textContent = '≡';

    const title = document.createElement('span');
    title.className = 'aicl-title';
    title.textContent = 'AiChatLens';

    headerLeft.appendChild(logo);
    headerLeft.appendChild(title);

    // Copy all questions button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'aicl-copy-btn';
    copyBtn.title = 'Copy all questions';
    copyBtn.innerHTML = '📋';
    const copyToast = document.createElement('span');
    copyToast.className = 'aicl-copy-toast';
    copyToast.textContent = 'Copied!';
    copyBtn.appendChild(copyToast);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'aicl-collapse-btn';
    collapseBtn.title = 'Toggle panel (Alt+T)';
    collapseBtn.textContent = '›';

    const headerActions = document.createElement('div');
    headerActions.className = 'aicl-header-actions';
    headerActions.appendChild(copyBtn);
    headerActions.appendChild(collapseBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerActions);

    // ---- Collapsed badge ----
    const collapsedBadge = document.createElement('div');
    collapsedBadge.className = 'aicl-collapsed-badge';

    const countBadge = document.createElement('div');
    countBadge.className = 'aicl-count-badge';
    countBadge.textContent = '0';

    const badgeLabel = document.createElement('div');
    badgeLabel.className = 'aicl-badge-label';
    badgeLabel.textContent = 'TOC';

    collapsedBadge.appendChild(countBadge);
    collapsedBadge.appendChild(badgeLabel);

    // ---- Body ----
    const body = document.createElement('div');
    body.className = 'aicl-body';

    // Prevent scroll events from propagating to the main page
    body.addEventListener('wheel', (e) => {
      const atTop = body.scrollTop === 0;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      // Only stop propagation when there's room to scroll in the direction
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
        e.stopPropagation();
      }
    }, { passive: true });

    // ---- Footer ----
    const footer = document.createElement('div');
    footer.className = 'aicl-footer';

    const footerText = document.createElement('span');
    footerText.className = 'aicl-footer-text';
    footerText.textContent = '0 questions';

    const shortcut = document.createElement('span');
    shortcut.className = 'aicl-shortcut';
    shortcut.textContent = 'Alt+T';

    footer.appendChild(footerText);
    footer.appendChild(shortcut);

    // ---- Search bar ----
    const search = document.createElement('div');
    search.className = 'aicl-search';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'aicl-search-wrap';

    const searchIcon = document.createElement('span');
    searchIcon.className = 'aicl-search-icon';
    searchIcon.textContent = '⌕';

    const searchInput = document.createElement('input');
    searchInput.className = 'aicl-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter questions…';
    searchInput.spellcheck = false;

    const searchClear = document.createElement('button');
    searchClear.className = 'aicl-search-clear';
    searchClear.textContent = '✕';
    searchClear.title = 'Clear filter';

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchClear);
    search.appendChild(searchWrap);

    const searchCount = document.createElement('div');
    searchCount.className = 'aicl-search-count';
    search.appendChild(searchCount);

    // ---- Assemble ----
    panel.appendChild(header);
    panel.appendChild(collapsedBadge);
    panel.appendChild(search);
    panel.appendChild(body);
    panel.appendChild(footer);
    shadow.appendChild(panel);
    document.body.appendChild(host);

    return { host, shadow, panel, body, collapseBtn, copyBtn, countBadge, footerText, collapsedBadge, searchInput, searchClear, searchCount };
  }

  // ----------------------------------------------------------
  // Panel state (collapse/expand)
  // ----------------------------------------------------------
  function setCollapsed(dom, collapsed) {
    isCollapsed = collapsed;
    dom.panel.classList.toggle('collapsed', collapsed);
    dom.collapseBtn.textContent = collapsed ? '‹' : '›';
    chrome.storage.local.set({ panelCollapsed: collapsed });
  }

  function togglePanel(dom) {
    setCollapsed(dom, !isCollapsed);
  }

  // ----------------------------------------------------------
  // Render TOC items
  // ----------------------------------------------------------
  function renderItems(dom) {
    const { body, countBadge, footerText, searchInput, searchCount } = dom;
    body.innerHTML = '';

    const allMessages = findUserMessages();
    const totalRaw = allMessages.length;

    // If no messages detected at all
    if (tocItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'aicl-empty';

      const icon = document.createElement('div');
      icon.className = 'aicl-empty-icon';
      icon.textContent = '💬';

      const title = document.createElement('div');
      title.className = 'aicl-empty-title';

      const desc = document.createElement('div');
      desc.className = 'aicl-empty-desc';

      if (totalRaw === 0) {
        title.textContent = 'No questions yet';
        desc.textContent = 'Start a conversation and your questions will appear here.';
      } else {
        title.textContent = 'No substantial questions detected';
        desc.textContent = 'Short messages and acknowledgements are filtered out.';
      }

      empty.appendChild(icon);
      empty.appendChild(title);
      empty.appendChild(desc);

      // Retry button if needed
      if (totalRaw === 0 && retryTimer === null) {
        retryTimer = setTimeout(() => {
          if (tocItems.length === 0) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'aicl-retry-btn';
            retryBtn.textContent = '↻ Retry detection';
            retryBtn.addEventListener('click', () => {
              scanMessages(dom);
            });
            empty.appendChild(retryBtn);
          }
        }, RETRY_TIMEOUT_MS);
      }

      body.appendChild(empty);
      countBadge.textContent = '0';
      footerText.textContent = '0 questions';
      searchCount.textContent = '';
      return;
    }

    // Apply search filter
    const query = (searchInput.value || '').trim().toLowerCase();
    let displayItems = tocItems;

    // Warning for very long chats
    if (tocItems.length > MAX_MESSAGES_WARNING) {
      const warning = document.createElement('div');
      warning.className = 'aicl-warning';
      warning.textContent = `Showing last ${MAX_DISPLAY_ITEMS} of ${tocItems.length} questions.`;
      body.appendChild(warning);
      displayItems = tocItems.slice(-MAX_DISPLAY_ITEMS);
    }

    // Filter by search query
    if (query) {
      displayItems = displayItems.filter(item =>
        item.text.toLowerCase().includes(query) ||
        item.category.name.toLowerCase().includes(query)
      );
    }

    // Show filter result count
    if (query) {
      searchCount.textContent = `${displayItems.length} of ${tocItems.length} match${displayItems.length !== 1 ? 'es' : ''}`;
    } else {
      searchCount.textContent = '';
    }

    // No matches for search
    if (query && displayItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'aicl-empty';

      const icon = document.createElement('div');
      icon.className = 'aicl-empty-icon';
      icon.textContent = '🔍';

      const title = document.createElement('div');
      title.className = 'aicl-empty-title';
      title.textContent = 'No matches';

      const desc = document.createElement('div');
      desc.className = 'aicl-empty-desc';
      desc.textContent = `No questions matching "${searchInput.value.trim()}"`;

      empty.appendChild(icon);
      empty.appendChild(title);
      empty.appendChild(desc);
      body.appendChild(empty);

      countBadge.textContent = tocItems.length.toString();
      footerText.textContent = `${tocItems.length} question${tocItems.length !== 1 ? 's' : ''}`;
      return;
    }

    // Render each item
    displayItems.forEach((item, index) => {
      // Find original index for numbering
      const originalIndex = tocItems.indexOf(item);
      const displayNumber = originalIndex + 1;

      const el = document.createElement('div');
      el.className = 'aicl-item';
      el.dataset.id = item.id;
      if (item.id === activeItemId) el.classList.add('active');

      // Number badge
      const num = document.createElement('div');
      num.className = 'aicl-item-number';
      num.textContent = displayNumber;

      // Content
      const content = document.createElement('div');
      content.className = 'aicl-item-content';

      const text = document.createElement('div');
      text.className = 'aicl-item-text';

      // Highlight matching text
      if (query) {
        const lowerText = item.text.toLowerCase();
        const matchIdx = lowerText.indexOf(query);
        if (matchIdx >= 0) {
          const before = item.text.slice(0, matchIdx);
          const match = item.text.slice(matchIdx, matchIdx + query.length);
          const after = item.text.slice(matchIdx + query.length);
          text.innerHTML = '';
          text.appendChild(document.createTextNode(before));
          const mark = document.createElement('mark');
          mark.style.cssText = 'background: rgba(232, 93, 58, 0.3); color: #fafafa; border-radius: 2px; padding: 0 1px;';
          mark.textContent = match;
          text.appendChild(mark);
          text.appendChild(document.createTextNode(after));
        } else {
          text.textContent = item.text;
        }
      } else {
        text.textContent = item.text;
      }

      const meta = document.createElement('div');
      meta.className = 'aicl-item-meta';

      const dot = document.createElement('span');
      dot.className = 'aicl-category-dot';
      dot.style.backgroundColor = item.category.color;

      const catName = document.createElement('span');
      catName.className = 'aicl-category-name';
      catName.textContent = item.category.name;

      const time = document.createElement('span');
      time.className = 'aicl-item-time';
      time.textContent = relativeTime(item.timestamp);

      meta.appendChild(dot);
      meta.appendChild(catName);
      meta.appendChild(time);

      content.appendChild(text);
      content.appendChild(meta);

      el.appendChild(num);
      el.appendChild(content);

      // Click handler — scroll to message
      el.addEventListener('click', () => {
        scrollToMessage(item, dom);
      });

      body.appendChild(el);
    });

    countBadge.textContent = tocItems.length.toString();
    footerText.textContent = `${tocItems.length} question${tocItems.length !== 1 ? 's' : ''}`;
  }

  // ----------------------------------------------------------
  // Find nearest scrollable ancestor
  // ----------------------------------------------------------
  function findScrollableParent(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  // ----------------------------------------------------------
  // Scroll to message + highlight flash
  // ----------------------------------------------------------
  function scrollToMessage(item, dom) {
    const el = item.element;
    if (!el || !el.isConnected) return;

    // For Meta AI, scroll the parent message-item container
    const scrollTarget = (platform === 'meta')
      ? (el.closest('[data-message-item="true"]') || el)
      : el;

    if (platform === 'meta') {
      // Meta AI uses a nested scroll container with CSS perspective/transform
      // that breaks scrollIntoView — use manual scroll calculation instead
      const scrollContainer = findScrollableParent(scrollTarget);
      if (scrollContainer) {
        const targetRect = scrollTarget.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const desiredScrollTop = scrollContainer.scrollTop + (targetRect.top - containerRect.top) - HEADER_OFFSET;
        scrollContainer.scrollTo({ top: Math.max(0, desiredScrollTop), behavior: 'smooth' });
      } else {
        // Fallback: try scrollIntoView anyway
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      // Claude: standard scrollIntoView + window offset
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => {
        window.scrollBy({ top: -HEADER_OFFSET, behavior: 'smooth' });
      }, 100);
    }

    // Highlight flash
    scrollTarget.classList.add('aicl-highlight-flash');
    setTimeout(() => {
      scrollTarget.classList.add('aicl-highlight-flash-fade');
      setTimeout(() => {
        scrollTarget.classList.remove('aicl-highlight-flash', 'aicl-highlight-flash-fade');
      }, HIGHLIGHT_DURATION_MS);
    }, 50);

    // On mobile, collapse panel after clicking
    if (window.innerWidth < 768) {
      setCollapsed(dom, true);
    }
  }

  // ----------------------------------------------------------
  // Intersection Observer — track active message
  // ----------------------------------------------------------
  function setupIntersectionObserver(dom) {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
    }

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Find the most visible entry that is intersecting
        let bestEntry = null;
        let bestRatio = 0;

        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestEntry = entry;
          }
        });

        if (bestEntry) {
          const matchedItem = tocItems.find((item) => item.element === bestEntry.target);
          if (matchedItem && matchedItem.id !== activeItemId) {
            activeItemId = matchedItem.id;
            updateActiveItem(dom);
          }
        }
      },
      { threshold: 0.3 }
    );

    tocItems.forEach((item) => {
      if (item.element && item.element.isConnected) {
        intersectionObserver.observe(item.element);
      }
    });
  }

  function updateActiveItem(dom) {
    const items = dom.body.querySelectorAll('.aicl-item');
    items.forEach((el) => {
      el.classList.toggle('active', el.dataset.id === activeItemId);
    });

    // Scroll active item into view in the TOC panel
    const activeEl = dom.body.querySelector('.aicl-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ----------------------------------------------------------
  // Scan messages (core detection logic)
  // ----------------------------------------------------------
  function scanMessages(dom) {
    const messageElements = findUserMessages();
    const existingElements = new Set(tocItems.map((item) => item.element));
    let changed = false;

    const newTexts = [];
    const newItems = [];

    messageElements.forEach((el) => {
      const rawText = extractText(el);
      newTexts.push(rawText);

      // Check if element already tracked
      const existing = tocItems.find((item) => item.element === el);
      if (existing) {
        // Update text if message was edited
        const updatedText = truncate(rawText, TRUNCATE_LEN);
        if (existing.text !== updatedText) {
          existing.text = updatedText;
          existing.category = categorize(rawText);
          changed = true;
        }
        newItems.push(existing);
        return;
      }

      // Filter
      if (shouldFilter(rawText)) return;

      // Check duplicate of previous message
      const idx = newTexts.length - 1;
      if (idx > 0 && rawText === newTexts[idx - 1]) return;
      // Also check against previousMessageTexts
      if (previousMessageTexts.includes(rawText)) return;

      // New item
      const item = {
        element: el,
        text: truncate(rawText, TRUNCATE_LEN),
        category: categorize(rawText),
        timestamp: Date.now(),
        id: generateId(),
      };
      newItems.push(item);
      changed = true;
    });

    // Detect removals
    if (newItems.length !== tocItems.length) {
      changed = true;
    }

    if (changed) {
      tocItems = newItems;
      previousMessageTexts = newTexts;
      renderItems(dom);
      setupIntersectionObserver(dom);
    }
  }

  // ----------------------------------------------------------
  // Inject highlight flash styles into main page
  // ----------------------------------------------------------
  function injectHighlightStyles() {
    if (document.getElementById('aicl-highlight-styles')) return;
    const style = document.createElement('style');
    style.id = 'aicl-highlight-styles';
    style.textContent = `
      .aicl-highlight-flash {
        border-left: 4px solid ${ACCENT} !important;
        transition: border-left-color 0.05s ease !important;
      }
      .aicl-highlight-flash-fade {
        border-left-color: transparent !important;
        transition: border-left-color ${HIGHLIGHT_DURATION_MS}ms ease !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------
  // URL change detection (SPA navigation)
  // ----------------------------------------------------------
  function setupUrlWatcher(dom) {
    // Watch for popstate
    window.addEventListener('popstate', () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resetAndRescan(dom);
      }
    });

    // Poll for URL changes (catches pushState)
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resetAndRescan(dom);
      }
    }, 1000);
  }

  function resetAndRescan(dom) {
    tocItems = [];
    previousMessageTexts = [];
    activeItemId = null;
    retryTimer = null;
    if (intersectionObserver) intersectionObserver.disconnect();
    // Clear search filter
    if (dom.searchInput) {
      dom.searchInput.value = '';
      dom.searchClear.classList.remove('visible');
    }
    renderItems(dom);

    // Give DOM time to update after navigation
    setTimeout(() => scanMessages(dom), 500);
    setTimeout(() => scanMessages(dom), 1500);
    setTimeout(() => scanMessages(dom), 3000);
  }

  // ----------------------------------------------------------
  // Update relative timestamps periodically
  // ----------------------------------------------------------
  function startTimestampUpdater(dom) {
    setInterval(() => {
      const timeEls = dom.body.querySelectorAll('.aicl-item-time');
      timeEls.forEach((el, i) => {
        const displayOffset = tocItems.length > MAX_MESSAGES_WARNING
          ? tocItems.length - MAX_DISPLAY_ITEMS
          : 0;
        const item = tocItems[displayOffset + i];
        if (item) {
          el.textContent = relativeTime(item.timestamp);
        }
      });
    }, 30000); // Every 30 seconds
  }

  // ----------------------------------------------------------
  // Responsive behavior
  // ----------------------------------------------------------
  function setupResponsive(dom) {
    const mq = window.matchMedia('(max-width: 768px)');

    function handleResize(e) {
      if (e.matches && !isCollapsed) {
        setCollapsed(dom, true);
      }
    }

    mq.addEventListener('change', handleResize);

    // Initial check
    if (mq.matches) {
      setCollapsed(dom, true);
    }
  }

  // ----------------------------------------------------------
  // Initialize
  // ----------------------------------------------------------
  function init() {
    const dom = createPanel();

    // Load persisted state
    chrome.storage.local.get('panelCollapsed', (result) => {
      if (result.panelCollapsed === true) {
        setCollapsed(dom, true);
      }
    });

    // Collapse button
    dom.collapseBtn.addEventListener('click', () => togglePanel(dom));

    // Copy all questions button
    dom.copyBtn.addEventListener('click', () => {
      if (tocItems.length === 0) return;
      const text = tocItems
        .map((item, i) => `${i + 1}. ${item.text}`)
        .join('\n');
      navigator.clipboard.writeText(text).then(() => {
        dom.copyBtn.classList.add('copied');
        setTimeout(() => dom.copyBtn.classList.remove('copied'), 1500);
      }).catch(() => {
        // Fallback for older browsers/restricted contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        dom.copyBtn.classList.add('copied');
        setTimeout(() => dom.copyBtn.classList.remove('copied'), 1500);
      });
    });

    // Collapsed badge click to expand
    dom.collapsedBadge.addEventListener('click', () => {
      if (isCollapsed) setCollapsed(dom, false);
    });

    // Search input — filter as you type
    let searchDebounce = null;
    dom.searchInput.addEventListener('input', () => {
      const hasValue = dom.searchInput.value.length > 0;
      dom.searchClear.classList.toggle('visible', hasValue);
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => renderItems(dom), 150);
    });

    // Search clear button
    dom.searchClear.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchClear.classList.remove('visible');
      renderItems(dom);
      dom.searchInput.focus();
    });

    // Keyboard shortcut: Alt+T
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        togglePanel(dom);
      }
    });

    // Inject highlight flash styles into main document
    injectHighlightStyles();

    // Initial scan
    scanMessages(dom);

    // MutationObserver for new messages
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => scanMessages(dom), DEBOUNCE_MS);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // URL watcher for SPA navigation
    setupUrlWatcher(dom);

    // Timestamp updater
    startTimestampUpdater(dom);

    // Responsive
    setupResponsive(dom);

    // Retry timer for empty chats
    retryTimer = setTimeout(() => {
      if (tocItems.length === 0) {
        renderItems(dom); // Re-render to show retry button
      }
    }, RETRY_TIMEOUT_MS);

    console.log('[AiChatLens] Initialized.');
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
