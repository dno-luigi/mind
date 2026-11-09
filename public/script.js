// Same-origin: the Worker serves this page and /api/chat, so there is no CORS.
const DEFAULT_PROXY_URL = "/api/chat";

/**
 * A path-less URL POSTs to "/", which static assets answer with a bare 405 — so
 * a bare origin saved in Settings looks exactly like a broken app. Anything that
 * already carries a path is left alone.
 */
function normalizeChatUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    try {
        const url = new URL(value, window.location.href);
        if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/chat';
        return url.href;
    } catch {
        return '';
    }
}
const STORAGE_KEY = "ai_ndraft_data_v2";
const PRESETS_KEY = "ai_ncards_presets_v1";

// Chat is text-only on purpose. Styling and board changes live behind the menus
// (AI Stylist, Card Styles, Clear All), so a reply can never repaint the app or
// wipe the board by accident. Teaching the directive grammar here is exactly
// what made the model emit !theme: / !action: in ordinary conversation.
const SYSTEM_PROMPT_BASE = `You are a helpful, casual AI assistant. Answer in plain text only.

Never emit styling directives, hex colour palettes, or app commands such as
!theme:..., !bg:... or !action:.... Colours and layout are handled by the app's
own menus, not by you.

User requests are natural language. Be efficient.`;

// Default presets - these reference OpenRouter presets by their slug
// Configure your presets at: https://openrouter.ai/presets
const DEFAULT_PRESETS = {
    'none': {
        name: 'No preset',
        key: null
    },
    'truth': {
        name: 'Truth',
        key: 'truth' // OpenRouter preset slug
    },
    'operator': {
        name: 'Operator',
        key: 'operator' // OpenRouter preset slug
    },
    'mnl': {
        name: 'MNL',
        key: 'mnl' // OpenRouter preset slug
    }
};

// Every preset is an OpenRouter preset. Truth is also the fallback the Worker
// uses when neither the user nor the decision model picks one, so it is the one
// entry that cannot be deleted.
const FALLBACK_PRESET_KEY = 'truth';

// Selecting "No preset" sends this sentinel: no preset prompt, no @preset/ slug.
const NO_PRESET_KEY = 'none';

class App {
    constructor() {
        this.cards = [];
        this.history = [];
        this.sessionId = "sess_" + Date.now();
        this.presets = this.loadPresets();
        this.currentPresetKey = FALLBACK_PRESET_KEY;
        this.theme = {
            name: 'ai-Ncards',
            primary: '#c41e3a',
            bg: '#121212',
            cardBg: '#1e1e1e',
            text: '#f5f5f5',
            border: '#333',
            locked: false
        };
        this.settings = {
            view: 'list',
            autoTTS: false,
            asrEnabled: false,
            proxyUrl: '',
            // The bar and the fullscreen answer's size are both preferences:
            // a session with nothing to type keeps them, and so does a reload.
            inputHidden: false,
            fsSize: null
        };

        // Attachments waiting to be sent with the next prompt, cleared on send.
        this.attachments = [];
        this.mediaRecorder = null;
        this.recordChunks = [];
        this.user = null;

        this.streamingId = null;
        this.selectedIds = new Set();
        this.contextMenuTargetId = null;
        this.fullscreenId = null;
        this.fsFlipped = false;
        this.editingId = null;
        this.editingField = null;
        this.stylingId = null;
        this.promptContext = null;
        this.presetToApply = null;
        // True only once the preset menu has been used, so the Worker can tell a
        // deliberate pick (pin it) from the truth default (let clef route).
        this.presetChosen = false;

        // Dictation aims at the last field that had focus, so one mic can fill a
        // menu's text box as well as the chat bar.
        this.lastTextField = null;
        this.dictationTarget = null;
        this.dictationBtn = null;
        this.lastThemePrompt = '';

        this.recognizer = null;
        this.isListening = false;

        this.decoder = new TextDecoder();
        this.abortController = null;

        // A stored answer arrives as one large delta; these drive the reveal that
        // makes it read like a reply instead of appearing all at once.
        this.reveal = null;
        this.revealTimer = null;
        this.pendingFinalize = null;
    }

    loadPresets() {
        // Storage is the source of truth. Defaults fill in what storage does not
        // have — they never replace an entry that is already saved, whatever
        // shape it was saved in.
        const merged = {};

        try {
            const saved = localStorage.getItem(PRESETS_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                for (const [key, preset] of Object.entries(parsed || {})) {
                    if (!preset || typeof preset !== 'object') continue;

                    const copy = { ...preset, name: preset.name || key };
                    if (copy.key === null) {
                        // "No preset" is the one entry that deliberately has no slug.
                    } else if (typeof copy.key === 'string' && copy.key) {
                        // Already the current shape.
                    } else if (typeof copy.prompt === 'string' && copy.prompt) {
                        // Old shape: the map key was the OpenRouter slug.
                        copy.key = key;
                    } else {
                        copy.key = key;
                    }
                    delete copy.prompt;
                    merged[key] = copy;
                }
            }
        } catch (e) {
            console.warn("Cannot read saved presets:", e);
        }

        for (const [key, preset] of Object.entries(DEFAULT_PRESETS)) {
            if (!merged[key]) merged[key] = { ...preset };
        }
        return merged;
    }

    savePresets() {
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(this.presets));
        } catch (e) {
            console.warn("Cannot save presets:", e);
        }
    }

    getCurrentPreset() {
        return this.presets[this.currentPresetKey] || this.presets['truth'];
    }

    getCurrentSystemPrompt() {
        // The base prompt carries the card directive grammar, so it always goes
        // out. The Worker strips it on the OpenRouter rung, where the preset owns
        // the prompt, and keeps it on the Workers AI rung — which cannot read a
        // prompt that lives in the OpenRouter account.
        return SYSTEM_PROMPT_BASE;
    }

    init() {
        this.loadState();
        this.loadEngine();
        this.loadSession();
        this.applyTheme();
        this.applyView();
        this.applyInputBar();
        this.bindEvents();
        this.initASR();
        this.renderAll();
        this.updateToggles();
        this.updatePresetButtonLabel();
        
        const proxyInput = document.getElementById('proxyUrlInput');
        if (proxyInput) {
            // Show the address that will be used, so nobody has to know it or type it:
            // whatever was saved, else this site's own /api/chat.
            proxyInput.value = this.settings.proxyUrl || new URL(DEFAULT_PROXY_URL, window.location.href).href;
        }

        document.getElementById('stylePadding').addEventListener('input', (e) => document.getElementById('valPad').textContent = e.target.value + 'px');
        document.getElementById('styleRadius').addEventListener('input', (e) => document.getElementById('valRad').textContent = e.target.value + 'px');
        document.getElementById('styleWidth').addEventListener('input', (e) => document.getElementById('valWid').textContent = e.target.value + 'px');
        
        // Check for shared cards in URL hash
        if (window.location.hash && window.location.hash.startsWith('#share=')) {
            const loaded = this.loadFromShareHash(window.location.hash);
            if (loaded) {
                // Clear the hash without reloading
                history.replaceState(null, '', window.location.pathname);
                this.showToast("Shared cards loaded!");
            }
        }
    }

    updatePresetButtonLabel() {
        const label = document.getElementById('currentPresetLabel');
        if (label) {
            const preset = this.presets[this.currentPresetKey];
            label.textContent = preset ? preset.name : 'Default';
        }
    }

    /**
     * One tap, next preset, wrapping at the end. The bar never opens a list: a
     * preset is chosen by stepping, and presets themselves are managed in the
     * menu, where the prompt and the slug live.
     */
    cyclePreset() {
        const keys = [NO_PRESET_KEY, ...Object.keys(this.presets).filter(key => key !== NO_PRESET_KEY)];
        const at = keys.indexOf(this.currentPresetKey);
        const next = keys[(at + 1) % keys.length];
        this.selectPresetForNextQuery(next);
    }

    /** The bar is optional: a session with nothing to type gives the cards the screen. */
    toggleInputBar(force) {
        const hidden = typeof force === 'boolean' ? force : !this.settings.inputHidden;
        this.settings.inputHidden = hidden;
        this.applyInputBar();
        this.saveState();
    }

    applyInputBar() {
        document.body.classList.toggle('input-hidden', Boolean(this.settings.inputHidden));
    }

    managePresets() {
        this.closeModal('settingsModal');
        this.renderPresetsList();
        this.openModal('presetsManageModal');
    }

    renderPresetsList() {
        const container = document.getElementById('presetsList');
        if (!container) return;
        
        let html = '';
        Object.entries(this.presets).forEach(([key, preset]) => {
            const isDefault = key === FALLBACK_PRESET_KEY;
            const isProtected = isDefault || key === NO_PRESET_KEY;
            html += `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--bg); border-radius: 8px; margin-bottom: 8px;">
                    <div>
                        <strong>${this.escapeHtml(preset.name)}</strong>
                        ${isDefault ? '<span style="font-size: 11px; opacity: 0.6; margin-left: 6px;">(default)</span>' : ''}
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        ${key === this.currentPresetKey
                            ? '<span style="font-size: 11px; opacity: 0.6;">selected</span>'
                            : `<button class="btn btn-ghost" onclick="app.selectPresetForNextQuery('${key}')" style="padding: 4px 8px; font-size: 12px;">Select</button>`}
                        ${!isProtected ? `<button class="btn btn-danger" onclick="app.deletePreset('${key}')" style="padding: 4px 8px; font-size: 12px;">Delete</button>` : ''}
                    </div>
                </div>
            `;
        });
        container.innerHTML = html || '<p style="opacity: 0.6;">No presets yet</p>';
    }

    saveNewPreset() {
        const name = document.getElementById('newPresetName').value.trim();
        const prompt = document.getElementById('newPresetPrompt').value.trim();
        
        if (!name) {
            this.showToast('Enter a preset name');
            return;
        }
        
        const key = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (this.presets[key]) {
            this.showToast('Preset already exists');
            return;
        }
        
        // Store both name and OpenRouter preset key
        this.presets[key] = {
            name: name,
            key: prompt || key // Use prompt as the preset slug, or fallback to key
        };
        
        this.savePresets();
        document.getElementById('newPresetName').value = '';
        document.getElementById('newPresetPrompt').value = '';
        this.renderPresetsList();
        this.updatePresetButtonLabel();
        this.showToast(`Preset "${name}" added`);
    }

    deletePreset(key) {
        if (!this.presets[key]) return;
        if (!confirm(`Delete preset "${this.presets[key].name}"?`)) return;
        
        delete this.presets[key];
        
        // If the deleted preset was current, fall back to the protected one.
        if (key === this.currentPresetKey) {
            this.currentPresetKey = FALLBACK_PRESET_KEY;
        }
        
        this.savePresets();
        this.renderPresetsList();
        this.updatePresetButtonLabel();
        this.showToast('Preset deleted');
    }

    openInputPresetSelector() {
        // Create a simple dropdown menu for selecting preset for next query
        const existingDropdown = document.getElementById('presetDropdown');
        if (existingDropdown) {
            existingDropdown.remove();
            return;
        }

        const btn = document.getElementById('presetSelectorBtn');
        const rect = btn.getBoundingClientRect();

        const dropdown = document.createElement('div');
        dropdown.id = 'presetDropdown';
        dropdown.style.cssText = `
            position: fixed;
            bottom: ${rect.bottom + 5}px;
            left: ${rect.left}px;
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 6px;
            z-index: 2000;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            min-width: 180px;
            max-height: 300px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 2px;
        `;

        Object.entries(this.presets).forEach(([key, preset]) => {
            const item = document.createElement('button');
            item.className = 'menu-item';
            item.style.padding = '10px 12px';
            item.innerHTML = `<i class="fas fa-sliders-h" style="width: 20px;"></i>${this.escapeHtml(preset.name)}`;
            if (key === this.currentPresetKey) {
                item.innerHTML += ' <i class="fas fa-check" style="margin-left: auto;"></i>';
                item.style.background = 'rgba(255,255,255,0.1)';
            }
            item.addEventListener('click', () => {
                this.selectPresetForNextQuery(key);
                dropdown.remove();
            });
            dropdown.appendChild(item);
        });

        // Add option to create new preset
        const divider = document.createElement('div');
        divider.className = 'menu-separator';
        dropdown.appendChild(divider);

        const newItem = document.createElement('button');
        newItem.className = 'menu-item';
        newItem.style.padding = '10px 12px';
        newItem.innerHTML = '<i class="fas fa-plus" style="width: 20px;"></i>Create Preset Card';
        newItem.addEventListener('click', () => {
            dropdown.remove();
            this.managePresets();
        });
        dropdown.appendChild(newItem);

        document.body.appendChild(dropdown);

        // Close dropdown when clicking outside
        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && e.target !== btn) {
                dropdown.remove();
                document.removeEventListener('click', closeDropdown);
            }
        };
        setTimeout(() => document.addEventListener('click', closeDropdown), 0);
    }

    selectPresetForNextQuery(presetKey) {
        if (!this.presets[presetKey]) return;
        
        this.currentPresetKey = presetKey;
        // A pick from the menu is a choice: the Worker pins it rather than
        // letting the decision model swap the preset out.
        this.presetChosen = true;
        
        // Update button label
        const label = document.getElementById('currentPresetLabel');
        if (label) {
            label.textContent = this.presets[presetKey].name;
        }
        
        const btn = document.getElementById('presetSelectorBtn');
        if (btn) {
            btn.classList.add('active');
        }
        
        // Always confirm: selecting No preset changes nothing visible otherwise,
        // which reads as the option being unselectable.
        const preset = this.presets[presetKey];
        this.updatePresetButtonLabel();
        this.saveState();
        this.renderPresetsList();
        this.showToast(`Preset set: ${preset.name}`);
    }

    openPresetSelectModal() {
        const container = document.getElementById('presetList');
        if (!container) return;
        
        let html = '';
        Object.entries(this.presets).forEach(([key, preset]) => {
            html += `
                <button class="btn btn-ghost" style="justify-content: flex-start; text-align: left;" onclick="app.applyPresetToSelected('${key}')">
                    <i class="fas fa-cog" style="width: 20px;"></i>
                    ${this.escapeHtml(preset.name)}
                </button>
            `;
        });
        container.innerHTML = html;
        this.openModal('presetSelectModal');
    }

    applyPresetToSelected(presetKey) {
        const preset = this.presets[presetKey];
        if (!preset) return;
        
        if (this.selectedIds.size === 0) {
            this.showToast('Select a card first');
            this.closeModal('presetSelectModal');
            return;
        }
        
        this.selectedIds.forEach(id => {
            const card = this.cards.find(c => c.id === id);
            if (card) {
                card.preset = presetKey;
            }
        });
        
        this.saveState();
        this.renderAll();
        this.closeModal('presetSelectModal');
        this.showToast(`Applied "${preset.name}" preset`);
    }

    createPresetCard(presetKey) {
        const preset = this.presets[presetKey];
        if (!preset) return false;
        
        const id = crypto.randomUUID();
        const card = {
            id: id,
            q: `Preset: ${preset.name}`,
            r: `OpenRouter Preset: ${preset.key || 'none'}\n\nThis card uses the OpenRouter preset configuration.`,
            preset: presetKey,
            styles: {},
            isPresetCard: true
        };
        
        this.cards.unshift(card);
        this.saveState();
        this.renderAll();
        this.showToast(`Created "${preset.name}" preset card`);
        return true;
    }

    getProxyUrl() {
        const inputVal = document.getElementById('proxyUrlInput')?.value.trim();
        const url = normalizeChatUrl(inputVal || this.settings.proxyUrl) || DEFAULT_PROXY_URL;
        // Persist the normalized form so a bare origin stops being sent as "/".
        if (url !== this.settings.proxyUrl) {
            this.settings.proxyUrl = url;
            this.saveState();
        }
        return url;
    }

    /**
     * The Worker that serves this page also serves /api/shot, so a card's page
     * image comes from wherever chat comes from — no key, no third party.
     */
    shotUrl(raw, full = false) {
        const base = this.getProxyUrl().replace(/\/api\/chat$/, '');
        const query = new URLSearchParams({ url: String(raw || '') });
        if (full) query.set('full', '1');
        return `${base}/api/shot?${query}`;
    }

    /** The first http(s) URL in a prompt — the page a card is about, if any. */
    urlIn(text) {
        const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
        return match ? match[0].replace(/[),.;:]+$/, '') : '';
    }

    /** The page as a linking thumbnail, or nothing when the card has no page. */
    shotHtml(card) {
        if (!card || !card.url) return '';
        const href = encodeURI(card.url);
        return `<a class="card-shot" href="${href}" target="_blank" rel="noopener noreferrer" title="${href}">
                    <img loading="lazy" src="${this.shotUrl(card.url, card.shotFull)}" alt="Screenshot of ${href}">
                </a>`;
    }

    bindEvents() {
        const sendBtn = document.getElementById('sendBtn');
        sendBtn.addEventListener('click', () => this.handleSendClick());

        // Attach and record, both of which put something into the next prompt.
        const attachBtn = document.getElementById('attachBtn');
        const attachInput = document.getElementById('attachInput');
        if (attachBtn && attachInput) {
            attachBtn.addEventListener('click', () => attachInput.click());
            attachInput.addEventListener('change', (e) => {
                this.addFiles(e.target.files);
                e.target.value = '';
            });
        }

        // Remember the last text field that had focus: the mic types into it, so
        // it works for a menu's textarea and not just the chat bar.
        document.addEventListener('focusin', (e) => {
            const el = e.target;
            if (!el || !el.matches) return;
            if (el.matches('textarea, input[type="text"], input[type="search"], input[type="url"]')) {
                this.lastTextField = el;
            }
        });

        const micBtn = document.getElementById('micBtn');
        if (micBtn) {
            // Keep the caret where it was instead of moving focus to the button.
            micBtn.addEventListener('mousedown', (e) => e.preventDefault());
            micBtn.addEventListener('click', () => this.dictateInto(null, micBtn));
        }

        const attachTray = document.getElementById('attachTray');
        if (attachTray) {
            attachTray.addEventListener('click', (e) => {
                const remove = e.target.closest('[data-remove]');
                if (!remove) return;
                this.attachments.splice(Number(remove.dataset.remove), 1);
                this.renderAttachments();
            });
        }
        
        const input = document.getElementById('userInput');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendClick();
            }
        });

        // One tap steps to the next preset; shift-tap still opens the full list.
        // Which presets exist is a menu job (Settings → Manage Presets).
        const gridFsFab = document.getElementById('gridFsFab');
        if (gridFsFab) gridFsFab.addEventListener('click', () => this.toggleNativeFullscreen());

        document.getElementById('presetSelectorBtn').addEventListener('click', (e) => {
            if (e.shiftKey) {
                this.openInputPresetSelector();
                return;
            }
            this.cyclePreset();
        });

        const collapseInput = document.getElementById('collapseInput');
        if (collapseInput) collapseInput.addEventListener('click', () => this.toggleInputBar(true));
        const showInput = document.getElementById('showInput');
        if (showInput) showInput.addEventListener('click', () => this.toggleInputBar(false));

        const fsGrip = document.getElementById('fsGrip');
        if (fsGrip) {
            fsGrip.addEventListener('pointerdown', (e) => this.beginFsResize(e));
            fsGrip.addEventListener('dblclick', () => {
                this.settings.fsSize = null;
                this.applyFsSize(null);
                this.saveState();
                this.showToast('Fullscreen restored');
            });
        }

        document.getElementById('menuFab').addEventListener('click', () => this.openModal('settingsModal'));
        document.getElementById('viewFab').addEventListener('click', () => this.cycleView());
        document.getElementById('undoFabTop').addEventListener('click', () => this.undo());

        document.getElementById('cancelSelect').addEventListener('click', () => this.clearSelection());
        document.getElementById('mergeSelected').addEventListener('click', () => this.promptAction('merge'));
        document.getElementById('deleteSelected').addEventListener('click', () => this.bulkDelete());
        document.getElementById('splitSelected').addEventListener('click', () => this.promptAction('split'));

        document.getElementById('cardMenu').addEventListener('click', (e) => {
            const btn = e.target.closest('.menu-item');
            if (btn && this.contextMenuTargetId) {
                const action = btn.dataset.action;
                if (action === 'undo') {
                    this.undo();
                } else {
                    this.handleCardAction(action, this.contextMenuTargetId);
                }
                this.closeCardMenu();
            }
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    const id = overlay.id;
                    this.closeModal(id);
                }
            });
        });

        document.getElementById('promptConfirmBtn').addEventListener('click', () => this.executePromptAction());

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#cardMenu') && !e.target.closest('.card-actions') && !e.target.closest('.flip-card')) {
                this.closeCardMenu();
            }
        });
    }

    saveState() {
        try {
            const data = {
                cards: this.cards,
                theme: this.theme,
                settings: this.settings,
                // Without this the chosen preset is forgotten on every reload
                // and the app silently falls back to the default preset.
                currentPresetKey: this.currentPresetKey,
                sessionId: this.sessionId
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn("Cannot save state:", e);
        }
    }

    loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    this.cards = data.cards || [];
                    this.theme = { ...this.theme, ...data.theme };
                    this.settings = { ...this.settings, ...data.settings };
                    this.sessionId = data.sessionId || this.sessionId;

                    // Restore the selected preset, but only if it still exists.
                    if (data.currentPresetKey && this.presets[data.currentPresetKey]) {
                        this.currentPresetKey = data.currentPresetKey;
                    }
                    if (!this.presets[this.currentPresetKey]) {
                        this.currentPresetKey = FALLBACK_PRESET_KEY;
                    }
                } catch (e) {
                    console.error("Load failed", e);
                }
            }
        } catch (e) {
            console.warn("Cannot load state:", e);
        }
    }

    pushHistory(actionType) {
        if (this.history.length > 10) this.history.shift();
        this.history.push({
            cards: JSON.parse(JSON.stringify(this.cards)),
            theme: { ...this.theme },
            timestamp: Date.now(),
            action: actionType
        });
    }

    undo() {
        if (this.history.length === 0) {
            this.showToast("Nothing to undo");
            return;
        }
        const lastState = this.history.pop();
        this.cards = lastState.cards;
        if (!this.theme.locked) this.theme = lastState.theme;
        
        this.saveState();
        this.renderAll();
        this.applyTheme();
        this.showToast(`Undid: ${lastState.action}`);
    }

    exportData() {
        try {
            const timestamp = new Date();
            const dateStr = timestamp.toISOString().split('T')[0];
            const timeStr = timestamp.toTimeString().split(' ')[0].replace(/:/g, '-');
            const cardCount = this.cards.length;
            
            console.log("Exporting", cardCount, "cards");
            
            const data = {
                version: '1.0',
                exportDate: timestamp.toISOString(),
                name: `ai-Ncards Export - ${dateStr}`,
                cards: this.cards,
                theme: this.theme,
                settings: this.settings,
                presets: this.presets
            };
            
            const jsonStr = JSON.stringify(data, null, 2);
            console.log("Export data size:", jsonStr.length, "bytes");
            
            const blob = new Blob([jsonStr], { type: 'application/json' });
            console.log("Blob created, size:", blob.size, "bytes");
            
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aincards_${dateStr}_${timeStr}_${cardCount}cards.json`;
            
            console.log("Starting download...");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            setTimeout(() => {
                URL.revokeObjectURL(url);
                console.log("Download triggered, blob URL revoked");
            }, 1000);
            
            this.showToast(`Exported ${cardCount} cards`);
        } catch (err) {
            console.error("Export failed:", err);
            this.showToast("Export failed: " + err.message);
        }
    }

    shareSelectedCards() {
        try {
            if (this.selectedIds.size === 0) {
                this.showToast("Select cards to share");
                return;
            }
            
            const cardsToShare = this.cards.filter(c => this.selectedIds.has(c.id));
            const timestamp = new Date();
            const dateStr = timestamp.toISOString().split('T')[0];
            
            const shareData = {
                version: '1.0',
                sharedDate: timestamp.toISOString(),
                name: `Shared Cards - ${dateStr}`,
                cards: cardsToShare
            };
            
            const jsonStr = JSON.stringify(shareData, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aincards_shared_${dateStr}_${cardsToShare.length}cards.json`;
            
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            
            this.showToast(`Shared ${cardsToShare.length} cards`);
        } catch (err) {
            console.error("Share failed:", err);
            this.showToast("Share failed: " + err.message);
        }
    }

    copyShareableLink() {
        if (this.selectedIds.size === 0) {
            this.showToast("Select cards to share");
            return;
        }
        
        const cardsToShare = this.cards.filter(c => this.selectedIds.has(c.id));
        
        // Create a compact shareable format
        const shareData = {
            v: 1,
            c: cardsToShare.map(c => ({
                q: c.q,
                r: c.r,
                p: c.preset || null
            }))
        };
        
        try {
            const jsonStr = JSON.stringify(shareData);
            const compressed = btoa(encodeURIComponent(jsonStr));
            
            // Create a shareable URL (using hash to avoid server storage)
            const shareUrl = `${window.location.origin}${window.location.pathname}#share=${compressed}`;
            
            navigator.clipboard.writeText(shareUrl).then(() => {
                this.showToast("Share link copied to clipboard");
            }).catch(() => {
                // Fallback: copy the JSON data
                navigator.clipboard.writeText(jsonStr).then(() => {
                    this.showToast("Shared cards JSON copied");
                }).catch(() => {
                    this.showToast("Failed to copy");
                });
            });
        } catch (err) {
            this.showToast("Failed to create share link");
            console.error(err);
        }
    }

    loadFromShareHash(hash) {
        try {
            // Decode the share data from URL hash
            const compressed = hash.replace('#share=', '');
            const jsonStr = decodeURIComponent(atob(compressed));
            const shareData = JSON.parse(jsonStr);
            
            if (shareData.v !== 1 || !shareData.c) {
                throw new Error("Invalid share format");
            }
            
            // Import the shared cards
            const importedCards = shareData.c.map((c, index) => ({
                id: crypto.randomUUID(),
                q: c.q,
                r: c.r,
                preset: c.p || null,
                styles: {},
                isPresetCard: false
            }));
            
            this.pushHistory("Import Shared Cards");
            this.cards = [...importedCards, ...this.cards];
            this.saveState();
            this.renderAll();
            this.showToast(`Added ${importedCards.length} shared cards`);
            return true;
        } catch (err) {
            console.error("Failed to load shared cards:", err);
            return false;
        }
    }

    exportToPDF() {
        try {
            const cardsToExport = this.selectedIds.size > 0 
                ? this.cards.filter(c => this.selectedIds.has(c.id))
                : this.cards;

            if (cardsToExport.length === 0) {
                this.showToast("No cards to export");
                return;
            }

            let content = `
                <div style="font-family: Arial, sans-serif; padding: 20px; background: ${this.theme.bg}; color: ${this.theme.text};">
                    <h1 style="color: ${this.theme.primary}; margin-bottom: 20px;">ai-Ncards Export</h1>
                    <p style="color: #888; margin-bottom: 30px;">Exported on ${new Date().toLocaleString()}</p>
            `;

            cardsToExport.forEach((card, index) => {
                const preset = card.preset ? this.presets[card.preset] : null;
                content += `
                    <div style="background: ${this.theme.cardBg}; border: 1px solid ${this.theme.border}; border-radius: 12px; padding: 20px; margin-bottom: 20px; page-break-inside: avoid;">
                        <div style="border-bottom: 1px solid ${this.theme.border}; padding-bottom: 10px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                            <strong style="color: ${this.theme.primary};">Card ${index + 1}</strong>
                            <div style="display: flex; gap: 6px;">
                                ${preset ? `<span style="background: ${this.theme.primary}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px;">${this.escapeHtml(preset.name)}</span>` : ''}
                                ${card.styles && card.styles.locked ? '<span style="background: #c41e3a; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px;">LOCKED</span>' : ''}
                            </div>
                        </div>
                        <div style="margin-bottom: 15px;">
                            <strong style="display: block; margin-bottom: 5px; font-size: 12px; color: #888;">REQUEST:</strong>
                            <div style="white-space: pre-wrap;">${this.escapeHtml(card.q)}</div>
                        </div>
                        <div>
                            <strong style="display: block; margin-bottom: 5px; font-size: 12px; color: #888;">RESPONSE:</strong>
                            <div style="white-space: pre-wrap;">${this.escapeHtml(card.r)}</div>
                        </div>
                    </div>
                `;
            });

            content += '</div>';

            // Check if html2pdf is available
            if (typeof html2pdf !== 'function') {
                throw new Error("PDF library not loaded");
            }

            const opt = {
                margin: 10,
                filename: `aincards_export_${new Date().toISOString().split('T')[0]}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            this.showToast("Generating PDF...");
            
            html2pdf().set(opt).from(content).save().then(() => {
                this.showToast("PDF downloaded");
            }).catch(err => {
                console.error("PDF generation failed:", err);
                this.showToast("PDF failed: " + err.message);
            });
        } catch (err) {
            console.error("PDF export error:", err);
            this.showToast("PDF export failed: " + err.message);
        }
    }

    importData(input) {
        const file = input.files[0];
        if (!file) return;
        
        // Check file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
            this.showToast("File too large (max 10MB)");
            input.value = '';
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const rawData = JSON.parse(e.target.result);
                
                // Validate import data structure
                if (!rawData.cards || !Array.isArray(rawData.cards)) {
                    throw new Error("Invalid file format: missing cards array");
                }
                
                // Create backup before importing
                this.pushHistory("Pre-Import Backup");
                
                // Import cards
                this.cards = rawData.cards;
                
                // Import presets if present
                if (rawData.presets) {
                    // Merge imported presets with existing ones
                    this.presets = { ...this.presets, ...rawData.presets };
                    this.savePresets();
                }
                
                // Import theme if present and valid
                if (rawData.theme) {
                    this.theme = { ...this.theme, ...rawData.theme };
                }
                
                // Import settings if present
                if (rawData.settings) {
                    this.settings = { ...this.settings, ...rawData.settings };
                }
                
                this.renderAll();
                this.applyTheme();
                this.applyView();
                this.saveState();
                
                const cardCount = rawData.cards.length;
                this.showToast(`Imported ${cardCount} cards successfully`);
                this.closeModal('settingsModal');
            } catch (err) {
                console.error("Import error:", err);
                this.showToast("Import failed: " + err.message);
            }
            input.value = '';
        };
        reader.onerror = () => {
            this.showToast("Failed to read file");
            input.value = '';
        };
        reader.readAsText(file);
    }

    clearAll() {
        if (confirm("Are you sure you want to delete ALL cards? This cannot be undone.")) {
            this.pushHistory("Clear All");
            this.cards = [];
            this.saveState();
            this.renderAll();
            this.closeModal('settingsModal');
            this.showToast("Grid Cleared");
        }
    }

    resetApp() {
        if (confirm("WARNING: This will delete ALL data, settings, and history. The app will restart to the welcome screen. Are you sure?")) {
            try {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(PRESETS_KEY);
            } catch (e) {
                console.warn("Cannot clear storage:", e);
            }
            window.location.reload();
        }
    }

    addCard(q, r, styles = {}, url = '', attachments = []) {
        const id = crypto.randomUUID();
        const card = { 
            id, 
            q, 
            r, 
            styles,
            preset: this.currentPresetKey,
            // Optional page this card is about. Only the URL is stored; the
            // screenshot is rendered by /api/shot when the card is drawn.
            url,
            // Metadata only: the extracted text belongs to the turn, not to
            // localStorage, which has a few megabytes for everything.
            attachments: attachments.map(file => ({
                name: file.name,
                url: file.url,
                contentType: file.contentType,
                image: Boolean(file.image)
            }))
        };
        this.cards.push(card);
        this.pushHistory("Add Card");
        this.renderCard(card, true);
        return id;
    }

    deleteCard(id) {
        this.cards = this.cards.filter(c => c.id !== id);
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (el) el.remove();
        if (this.fullscreenId === id) this.closeFullscreen();
        this.saveState();
    }

    updateCardContent(id, q, r) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;
        if (q !== null) card.q = q;
        if (r !== null) card.r = r;
        
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (el) {
            if (q !== null) el.querySelector('.card-face:first-child .content').innerHTML = this.md(q);
            if (r !== null) {
                const rEl = el.querySelector('.response-content');
                if (rEl) rEl.innerHTML = this.md(r);
            }
        }
        this.saveState();
    }

    renderAll() {
        const grid = document.getElementById('grid');
        const empty = document.getElementById('emptyState');
        grid.innerHTML = '';
        
        if (this.cards.length === 0) {
            // renderCard removes the empty state when a card appears, so a later
            // clear-all leaves nothing to re-append.
            if (empty) {
                grid.appendChild(empty);
                empty.style.display = 'flex';
            }
        } else {
            // The empty state is removed the moment a card arrives, so a later
            // full re-render has nothing to hide — and must not dereference it.
            if (empty) empty.style.display = 'none';
            this.cards.forEach(c => this.renderCard(c, false));
        }
    }

    renderCard(card, isNew) {
        const grid = document.getElementById('grid');
        const empty = document.getElementById('emptyState');
        if (empty && empty.parentNode) empty.remove();

        const div = document.createElement('div');
        div.className = `flip-card ${isNew ? 'new' : ''}`;
        div.dataset.id = card.id;
        div.tabIndex = 0;
        
        if (card.styles && card.styles.locked) {
            div.classList.add('locked');
        }

        // Show preset badge if card has a preset
        const preset = card.preset ? this.presets[card.preset] : null;
        const presetBadge = preset ? `<span style="background: ${this.theme.primary}; color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px;">${this.escapeHtml(preset.name)}</span>` : '';

        let rHtml;
        if (card.r === '...') {
            if (this.streamingId === card.id) {
                rHtml = '<div class="streaming"><span class="thinking-indicator">Thinking...</span><button class="stop-stream-btn" onclick="app.stopStream()">Stop</button></div>';
            } else {
                rHtml = '<div class="streaming"><span class="thinking-indicator">Thinking...</span></div>';
            }
        } else {
            rHtml = this.renderAnswer(card.r);
        }

        div.innerHTML = `
            <div class="flip-card-inner">
                <div class="card-face">
                    <div class="card-header">
                        <div class="card-head-left">
                            <span class="card-grip" title="Drag to rearrange"><i class="fas fa-grip-vertical"></i></span>
                            <span style="font-size:11px; opacity:0.5;">REQ${presetBadge}</span>
                        </div>
                        <div class="card-actions">
                            <button onclick="app.openCardMenu('${card.id}', event)"><i class="fas fa-ellipsis-v"></i></button>
                            <button onclick="app.toggleSelect('${card.id}', event)"><i class="fas fa-check-circle"></i></button>
                        </div>
                    </div>
                    <div class="content">${this.md(card.q)}</div>
                    ${this.shotHtml(card)}
                    ${this.attachmentsHtml(card)}
                </div>
                <div class="card-face card-back">
                    <div class="card-header">
                        <span style="font-size:11px; opacity:0.5;">RESPONSE</span>
                        <div class="card-actions">
                            <button onclick="app.readCard('${card.id}', event)"><i class="fas fa-volume-up"></i></button>
                            <button onclick="app.openCardMenu('${card.id}', event)"><i class="fas fa-ellipsis-v"></i></button>
                        </div>
                    </div>
                    <div class="response-content">${rHtml}</div>
                </div>
            </div>
            <button class="card-resize" type="button" title="Drag to resize" aria-label="Resize card"></button>
        `;

        if (card.styles) this.applyCardStyleToEl(div, card.styles);
        if (card.span) this.applySpan(div, card.span);

        this.attachCardEvents(div, card.id);
        grid.appendChild(div);
    }

    attachCardEvents(div, id) {
        div.addEventListener('click', (e) => {
            // Quick filters keep links, and the page shot, working as links.
            if (e.target.closest('button') || e.target.closest('.card-actions') || e.target.closest('a') || e.target.closest('.card-grip')) return;
            if (this.selectedIds.size > 0) {
                e.stopPropagation();
                this.toggleSelect(id, e);
                return;
            }
            div.classList.toggle('flipped');
        });

        let lastTap = 0;
        div.addEventListener('touchend', (e) => {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTap;
            if (tapLength < 300 && tapLength > 0) {
                if (e.target.closest('button') || e.target.closest('.card-actions') || e.target.closest('a') || e.target.closest('.card-grip')) return;
                this.openFullscreen(id);
                e.preventDefault();
            }
            lastTap = currentTime;
        });
        div.addEventListener('dblclick', (e) => {
            if (!e.target.closest('button') && !e.target.closest('a')) this.openFullscreen(id);
        });

        let pressTimer;
        div.addEventListener('touchstart', (e) => {
            if (this.selectedIds.size > 0) return;
            if (e.target.closest('.card-grip') || e.target.closest('.card-resize')) return;
            pressTimer = setTimeout(() => {
                this.openCardMenu(id, e);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 400);
        });
        div.addEventListener('touchend', () => clearTimeout(pressTimer));
        div.addEventListener('touchmove', () => clearTimeout(pressTimer));

        div.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') div.classList.toggle('flipped');
            if (e.key === ' ' && e.shiftKey) {
                e.preventDefault();
                this.openCardMenu(id);
            }
        });

        this.attachCardGestures(div, id);
    }

    /**
     * Grid rearranging. The grip in a card's header moves its place in the order;
     * the corner grip changes how many cells it covers. Both are grid-only, and
     * both are saved with the card, because an arrangement is part of the work.
     */
    attachCardGestures(div, id) {
        const grip = div.querySelector('.card-grip');
        const resizer = div.querySelector('.card-resize');
        if (grip) grip.addEventListener('pointerdown', (e) => this.beginCardDrag(e, div, id));
        if (resizer) resizer.addEventListener('pointerdown', (e) => this.beginCardResize(e, div, id));
    }

    beginCardDrag(event, div, id) {
        if (!document.body.classList.contains('view-grid')) return;
        event.preventDefault();
        event.stopPropagation();

        const grid = document.getElementById('grid');
        if (!grid) return;
        div.classList.add('dragging');

        const move = (e) => {
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const target = under ? under.closest('.flip-card') : null;
            if (!target || target === div || !grid.contains(target)) return;
            const rect = target.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            grid.insertBefore(div, after ? target.nextSibling : target);
        };
        const end = () => {
            div.classList.remove('dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            this.syncCardOrder();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    /** The DOM now holds the order; copy it back so a reload keeps the arrangement. */
    syncCardOrder() {
        const grid = document.getElementById('grid');
        if (!grid) return;
        const byId = new Map(this.cards.map(card => [card.id, card]));
        const next = [...grid.querySelectorAll('.flip-card')]
            .map(el => byId.get(el.dataset.id))
            .filter(Boolean);
        if (next.length !== this.cards.length) return;
        if (next.every((card, i) => card === this.cards[i])) return;
        this.cards = next;
        this.saveState();
        this.showToast('Cards rearranged');
    }

    beginCardResize(event, div, id) {
        if (!document.body.classList.contains('view-grid')) return;
        event.preventDefault();
        event.stopPropagation();

        const card = this.cards.find(c => c.id === id);
        const grid = document.getElementById('grid');
        if (!card || !grid) return;

        const styles = getComputedStyle(grid);
        const columns = Math.max(1, (styles.gridTemplateColumns || '').split(' ').filter(Boolean).length);
        const gap = parseFloat(styles.columnGap) || 0;
        const cellWidth = (grid.clientWidth - gap * (columns - 1)) / columns;
        const startCols = (card.span && card.span.cols) || 1;
        const startRows = (card.span && card.span.rows) || 1;
        const cellHeight = div.getBoundingClientRect().height / startRows;
        const start = { x: event.clientX, y: event.clientY };

        div.classList.add('resizing');
        const move = (e) => {
            const cols = Math.min(columns, Math.max(1, startCols + Math.round((e.clientX - start.x) / (cellWidth + gap))));
            const rows = Math.min(6, Math.max(1, startRows + Math.round((e.clientY - start.y) / (cellHeight + gap))));
            card.span = { cols, rows };
            this.applySpan(div, card.span);
        };
        const end = () => {
            div.classList.remove('resizing');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            this.saveState();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    /** How many cells a card covers. CSS variables, so other views ignore it. */
    applySpan(el, span) {
        const cols = Math.max(1, Math.min(6, (span && span.cols) || 1));
        const rows = Math.max(1, Math.min(6, (span && span.rows) || 1));
        el.style.setProperty('--span-cols', cols);
        el.style.setProperty('--span-rows', rows);
    }

    handleSendClick() {
        const input = document.getElementById('userInput');
        const val = input.value.trim();
        if (!val) return;

        if (this.isListening) {
            this.recognition.stop();
            return;
        }

        if (this.settings.asrEnabled && this.recognition) {
            this.recognition.start();
            return;
        }

        this.sendRequest(val);
        input.value = '';
    }

    scrollToStreamingContent(element) {
        if (!element) return;
        const isNearBottom = (element.scrollHeight - element.scrollTop - element.clientHeight) < 150;
        if (isNearBottom) {
            element.scrollTop = element.scrollHeight;
        }
    }

    checkForPresetCommand(text) {
        // Match "open [preset_name] card" or "[preset_name] card"
        const match = text.match(/^(?:open\s+)?([a-zA-Z][a-zA-Z0-9_]*)\s+card$/i);
        if (match) {
            const presetName = match[1].toLowerCase();
            // Find matching preset
            const presetKey = Object.keys(this.presets).find(key => 
                key === presetName || 
                this.presets[key].name.toLowerCase().replace(/\s+/g, '_') === presetName ||
                this.presets[key].name.toLowerCase() === presetName
            );
            if (presetKey) {
                return this.createPresetCard(presetKey);
            }
        }

        // Match "apply preset [preset_name]" - sets preset for next query
        const applyMatch = text.match(/^apply\s+preset\s+([a-zA-Z][a-zA-Z0-9_]*)$/i);
        if (applyMatch) {
            const presetName = applyMatch[1].toLowerCase();
            const presetKey = Object.keys(this.presets).find(key => 
                key === presetName || 
                this.presets[key].name.toLowerCase().replace(/\s+/g, '_') === presetName ||
                this.presets[key].name.toLowerCase() === presetName
            );
            if (presetKey) {
                this.selectPresetForNextQuery(presetKey);
                return true;
            }
        }

        return false;
    }

    async sendRequest(prompt, contextCardId = null) {
        // Check for preset command first
        if (!contextCardId && this.checkForPresetCommand(prompt)) {
            return;
        }

        // Whatever was attached belongs to this turn only: the card keeps a
        // record of it, the tray empties, and the model gets the text and the
        // pictures. A document's text is appended so it reads as the source.
        const files = this.attachments.slice();
        this.attachments = [];
        this.renderAttachments();
        const imageUrls = files.filter(file => file.image).map(file => this.fileUrl(file));
        const documents = files
            .filter(file => file.text)
            .map(file => `Attached document "${file.name}" (${file.contentType}):\n${file.text}`)
            .join('\n\n');
        const asked = documents ? `${prompt}\n\n${documents}` : prompt;

        // Naming a page in the prompt gives the card that page: the thumbnail is
        // part of the card, so the answer and what it is about stay together.
        const pageUrl = contextCardId ? '' : this.urlIn(prompt);
        this.streamingId = contextCardId
            ? contextCardId
            : this.addCard(prompt, '...', {}, pageUrl, files);
        
        const cardEl = document.querySelector(`.flip-card[data-id="${this.streamingId}"]`);
        if(cardEl && !contextCardId) setTimeout(() => cardEl.classList.add('flipped'), 100);

        // Get preset for this request
        const preset = this.getCurrentPreset();
        const usePreset = Boolean(preset && preset.key);
        
        console.log("sendRequest - currentPresetKey:", this.currentPresetKey);
        console.log("sendRequest - preset:", preset);
        console.log("sendRequest - usePreset:", usePreset);

        // Build prompt - only include system prompt if not using OpenRouter preset
        let fullPrompt;
        const sysPrompt = this.getCurrentSystemPrompt();
        if (sysPrompt) {
            fullPrompt = sysPrompt + "\n\nUser: " + asked;
        } else {
            fullPrompt = asked;
        }
        
        if (contextCardId) {
            const oldCard = this.cards.find(c => c.id === contextCardId);
            if (oldCard) {
                const styleContext = (oldCard.styles && oldCard.styles.locked) ? `(Note: Original card has locked styles)` : '';
                fullPrompt = `Previous Request: "${oldCard.q}"\nPrevious Response: "${oldCard.r}" ${styleContext}\n\nUser Instruction: ${prompt}\n\nProvide a continuation or refinement.`;
            }
        }

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const url = this.getProxyUrl();
            
            const accumulated = await this.streamChat(
                {
                    messages: [{
                        role: 'user',
                        // Pictures travel as content parts, the one shape both
                        // providers accept; text alone stays a plain string.
                        content: imageUrls.length
                            ? [{ type: 'text', text: fullPrompt }, ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))]
                            : fullPrompt
                    }],
                    preset: usePreset ? preset.key : NO_PRESET_KEY,
                    presetLocked: this.presetChosen,
                    signal
                },
                (text, first) => this.updateStreamingContent(text, first)
            );

            this.finalizeResponse(accumulated);

        } catch (err) {
            if (err.name === 'AbortError') {
                const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
                if (el) el.innerHTML += '<div style="color:#ff6b6b; margin-top:10px;">[Stopped]</div>';
            } else {
                const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
                if (el) el.innerHTML = `<span style="color: #ff6b6b; font-weight: bold;">Error: ${err.message}</span>`;
            }
            this.streamingId = null;
        } finally {
            this.abortController = null;
        }
    }

    /**
     * The Worker emits one normalized stream: meta, deltas, error, [DONE].
     * The client never learns which provider answered, which is why switching
     * between Workers AI and OpenRouter needs no frontend change.
     */
    async streamChat({ messages, preset = null, presetLocked = false, signal = null }, onText) {
        const url = this.getProxyUrl();
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, preset, presetLocked, stream: true }),
            signal
        });

        if (!res.ok || !res.body) {
            let detail = `HTTP ${res.status} from ${url}`;
            try {
                const body = await res.json();
                detail = body?.error?.message || detail;
            } catch {}
            if (res.status === 405) {
                detail += ' — chat is POST /api/chat; clear the Proxy URL in Settings.';
            }
            throw new Error(detail);
        }

        const reader = res.body.getReader();
        let buffer = '';
        let accumulated = '';
        let first = true;
        let failure = null;
        let incomplete = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += this.decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() || '';

            for (const frame of frames) {
                const line = frame.replace(/^data: /, '').trim();
                if (!line || line === '[DONE]') continue;

                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }

                if (event.type === 'delta' && event.text) {
                    accumulated += event.text;
                    onText(accumulated, first);
                    first = false;
                } else if (event.type === 'error') {
                    failure = event.error?.message || event.error?.code || 'stream failed';
                } else if (event.type === 'incomplete') {
                    incomplete = event.message || 'The answer stopped before it finished.';
                } else if (event.type === 'meta') {
                    this.lastRoute = event;
                }
            }
        }

        if (failure && !accumulated) throw new Error(failure);
        // A half answer is shown, never passed off as the whole one: the note is
        // part of the text so it survives into the saved message.
        if (incomplete) {
            this.showToast(incomplete);
            accumulated += '\n\n---\n*This answer ended early: the stream closed mid-sentence, so the text above is all that arrived.*';
            onText(accumulated, false);
        }
        return accumulated;
    }

    stopStream() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.showToast("Streaming stopped");
        }
    }

    /**
     * Reveal a burst instead of painting it in one frame. Only a cached answer is
     * long enough to qualify, and it is already fully downloaded, so this adds the
     * reading rhythm without adding any waiting on the network.
     */
    runReveal() {
        clearInterval(this.revealTimer);
        this.revealTimer = setInterval(() => {
            const reveal = this.reveal;
            // A finished or abandoned stream must not keep a timer alive.
            if (!reveal || !this.streamingId) {
                clearInterval(this.revealTimer);
                this.reveal = null;
                return;
            }
            if (reveal.shown >= reveal.target.length) {
                clearInterval(this.revealTimer);
                reveal.done = true;
                // A finalise that arrived mid-reveal is applied now, so the exact
                // text lands on the frame after the last one, not on top of it.
                const pending = this.pendingFinalize;
                this.pendingFinalize = null;
                if (pending) {
                    this.applyFinalResponse(pending.fullText);
                } else {
                    this.reveal = null;
                }
                return;
            }

            // About half a second in total, whatever the length.
            const step = Math.max(3, Math.ceil(reveal.target.length / 25));
            reveal.shown = Math.min(reveal.target.length, reveal.shown + step);

            this.paintStreaming(reveal.target.slice(0, reveal.shown), false);
        }, 20);
    }

    updateStreamingContent(text, replace = false) {
        if (!this.streamingId) return;
        const visible = text.replace(/![^!]+!/g, '');

        // The first event of a cached answer carries the whole reply. Start a
        // reveal and let later events retarget it instead of jumping.
        if (replace && visible.length > 160) {
            this.pendingFinalize = null;
            this.reveal = { target: visible, shown: 0 };
            this.runReveal();
            return;
        }
        if (this.reveal) {
            this.reveal.target = visible;
            return;
        }
        
        this.paintStreaming(visible, replace);
    }

    /** The DOM half of a stream paint, shared by live tokens and the reveal. */
    paintStreaming(visible, replace) {
        const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
        if (el) {
            if (replace) {
                el.innerHTML = this.md(visible);
            } else {
                el.innerHTML = this.md(visible) + '<div class="streaming"><span class="cursor"></span></div>';
            }
            this.scrollToStreamingContent(el);
        }

        if (this.fullscreenId === this.streamingId) {
            const fsPane = document.getElementById('fsResponsePane');
            if (fsPane) {
                if (replace) {
                    document.getElementById('fsResponse').innerHTML = this.md(visible);
                } else {
                    document.getElementById('fsResponse').innerHTML = this.md(visible) + '<div class="streaming"><span class="cursor"></span></div>';
                }
                this.scrollToStreamingContent(fsPane);
            }
        }
    }

    finalizeResponse(fullText) {
        const id = this.streamingId;
        if (!id) return;

        // A cached answer is complete in one delta, so this lands in the same tick
        // the reveal starts. Defer it: finalising now would erase the animation
        // before a single frame of it is seen, which is exactly what happened.
        if (this.reveal && !this.reveal.done) {
            this.pendingFinalize = { fullText };
            return;
        }

        this.applyFinalResponse(fullText);
    }

    applyFinalResponse(fullText) {
        const id = this.streamingId;
        if (!id) return;

        // The paint below is authoritative: stop any reveal mid-flight.
        clearInterval(this.revealTimer);
        this.reveal = null;

        // Chat is text-only: directives are stripped from the text, never
        // applied. Theme, card styles and board actions live behind the menus,
        // so a stray !theme: or !action:clear! in a reply does nothing.
        const { cleanText } = this.parseCommands(fullText);
        const card = this.cards.find(c => c.id === id);
        
        if (card) {
            const previous = card.r;
            card.r = cleanText;
            // A reply made only of directives would otherwise blank the card.
            if (!cleanText && previous) card.r = previous;
        }

        const cleanHtml = this.renderAnswer(cleanText);
        const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
        if (el) el.innerHTML = cleanHtml;

        if (this.fullscreenId === id) {
            document.getElementById('fsResponse').innerHTML = cleanHtml;
            const fsPane = document.getElementById('fsResponsePane');
            if (fsPane) fsPane.scrollTop = fsPane.scrollHeight;
        }

        if (this.settings.autoTTS) this.readCard(id);

        this.streamingId = null;
        this.pushHistory("AI Response");
    }

    /**
     * Split the app's directive grammar out of a reply. Chat uses this only to
     * strip directives from the text — applying one is the menus' job (see
     * applyFinalResponse), so the two can never be confused.
     */
    parseCommands(text) {
        const cmdRegex = /!(theme|bg|text|border|pad|radius|font|bold|italic|css|action):?([^!]+)!/gi;
        let styles = {};
        let actions = [];
        let themeUpdate = null;
        let match;
        let safeText = text;

        while ((match = cmdRegex.exec(text)) !== null) {
            const type = match[1].toLowerCase();
            const val = match[2].trim();

            if (type === 'theme') {
                const [name, bg, cardBg, textC, border, primary] = val.split(',').map(s => s.trim());
                themeUpdate = { name, bg, cardBg, text: textC, border, primary };
            } else if (type === 'bg') styles.backgroundColor = val;
            else if (type === 'text') styles.color = val;
            else if (type === 'border') styles.borderColor = val;
            else if (type === 'pad') styles.padding = val.endsWith('px') ? val : val + 'px';
            else if (type === 'radius') styles.borderRadius = val.endsWith('px') ? val : val + 'px';
            else if (type === 'font') styles.fontSize = val.endsWith('px') ? val : val + 'px';
            else if (type === 'bold') styles.fontWeight = 'bold';
            else if (type === 'italic') styles.fontStyle = 'italic';
            else if (type === 'css') styles.customCSS = val;
            else if (type === 'action') actions.push(val);

            safeText = safeText.replace(match[0], '');
        }

        return { cleanText: safeText.trim(), styles, themeUpdate, actions };
    }

    applyCardStyleToEl(el, styles) {
        const face = el.querySelectorAll('.card-face');
        face.forEach(f => {
            if (styles.color) f.style.color = styles.color;
            if (styles.backgroundColor) f.style.backgroundColor = styles.backgroundColor;
            if (styles.fontSize) f.style.fontSize = styles.fontSize;
            if (styles.fontWeight) f.style.fontWeight = styles.fontWeight;
            if (styles.fontStyle) f.style.fontStyle = styles.fontStyle;
            if (styles.padding) f.style.padding = styles.padding;
        });
        
        if (styles.borderColor) el.style.borderColor = styles.borderColor;
        if (styles.borderRadius) el.style.borderRadius = styles.borderRadius;
        
        if (styles.customCSS) {
            const id = `style-${el.dataset.id}`;
            let styleTag = document.getElementById(id);
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = id;
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = `[data-id="${el.dataset.id}"] ${styles.customCSS}`;
        }
    }

    openCardMenu(id, e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        
        this.contextMenuTargetId = id;
        const menu = document.getElementById('cardMenu');
        
        let x, y;
        if (e && e.clientX) {
            x = e.clientX;
            y = e.clientY;
        } else if (e && e.touches && e.touches[0]) {
            x = e.touches[0].clientX;
            y = e.touches[0].clientY;
        } else {
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) {
                const rect = el.getBoundingClientRect();
                x = rect.left + rect.width / 2;
                y = rect.top + rect.height / 2;
            } else {
                x = window.innerWidth / 2;
                y = window.innerHeight / 2;
            }
        }

        if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
        if (y + 300 > window.innerHeight) y = window.innerHeight - 310;

        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('active');
    }

    closeCardMenu() {
        document.getElementById('cardMenu').classList.remove('active');
        this.contextMenuTargetId = null;
    }

    handleCardAction(action, id) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;

        switch (action) {
            case 'continue': this.promptAction('continue', id); break;
            case 'split': this.promptAction('split', id); break;
            case 'merge':
                if (!this.selectedIds.has(id)) {
                    this.selectedIds.add(id);
                    const el = document.querySelector(`.flip-card[data-id="${id}"]`);
                    if (el) el.classList.add('selected');
                }
                if (this.selectedIds.size < 2) {
                    this.showToast("Need at least 2 cards to merge");
                    this.updateSelectionUI();
                    return;
                }
                this.updateSelectionUI();
                this.promptAction('merge');
                break;
            case 'ai-edit': this.promptAction('ai-edit', id); break;
            case 'create-preset-card':
                // Open modal to select which preset to create a card for
                this.selectedIds.clear();
                this.selectedIds.add(id);
                this.openPresetSelectModal();
                break;
            case 'ai-theme': 
                this.editingId = id; 
                this.openModal('aiThemeModal'); 
                break;
            case 'copy': 
                navigator.clipboard.writeText(card.r || card.q || '');
                this.showToast('Copied to clipboard');
                break;
            case 'share-card':
                this.selectedIds.clear();
                this.selectedIds.add(id);
                this.shareSelectedCards();
                break;
            case 'export-pdf':
                this.selectedIds.clear();
                this.selectedIds.add(id);
                this.exportToPDF();
                this.clearSelection();
                break;
            case 'shot-page': this.attachScreenshot(id); break;
            case 'fullscreen': this.openFullscreen(id); break;
            case 'delete': 
                if(confirm("Delete this card?")) {
                    this.deleteCard(id);
                    this.showToast('Card deleted');
                }
                break;
            case 'style':
                this.stylingId = id;
                this.loadStyleValues(card.styles || {});
                this.openModal('styleModal');
                break;
            case 'manual-edit-response':
                this.editingId = id; this.editingField = 'r';
                this.openEditor(card.r);
                break;
            case 'manual-edit-question':
                this.editingId = id; this.editingField = 'q';
                this.openEditor(card.q);
                break;
        }
    }

    /**
     * Give a card a page to show. Free text rather than a picker: the URL is
     * usually already in the prompt, so the default is whatever that was.
     */
    attachScreenshot(id) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;

        const typed = window.prompt('Page URL to screenshot', card.url || this.urlIn(card.q) || 'https://');
        if (typed === null) return;

        const url = typed.trim();
        if (!/^https?:\/\//i.test(url)) {
            this.showToast('Only http and https pages');
            return;
        }

        card.url = url;
        card.shotFull = false;
        this.saveState();
        this.paintShot(card);
        this.showToast('Loading page shot…');
    }

    /**
     * Repaint just the thumbnail. renderAll() would drop every card you had
     * flipped, which is a heavy price for adding one image.
     */
    paintShot(card) {
        const el = document.querySelector(`.flip-card[data-id="${card.id}"]`);
        const face = el?.querySelector('.card-face:not(.card-back)');
        if (!face) return;

        face.querySelector('.card-shot')?.remove();
        if (!card.url) return;

        const request = face.querySelector('.content');
        if (request) request.insertAdjacentHTML('afterend', this.shotHtml(card));
    }

    /** Absolute URL of an uploaded file, on whichever origin chat uses. */
    fileUrl(attachment) {
        const base = this.getProxyUrl().replace(/\/api\/chat$/, '');
        return `${base}${attachment.url}`;
    }

    /**
     * Upload first, send later: the Worker stores the file and hands back the
     * text it could read out of it, so sending costs no extra round trip and a
     * reload cannot lose the document behind a prompt already sent.
     */
    async addFiles(fileList) {
        const room = Math.max(0, 6 - this.attachments.length);
        const files = Array.from(fileList || []).slice(0, room);
        if (!files.length) {
            this.showToast('Six attachments at a time');
            return;
        }

        for (const file of files) {
            if (file.size > 12 * 1024 * 1024) {
                this.showToast(`${file.name} is over 12 MB`);
                continue;
            }
            this.showToast(`Uploading ${file.name}…`);
            try {
                const res = await fetch('/api/upload', {
                    method: 'POST',
                    headers: { 'content-type': file.type || 'application/octet-stream' },
                    body: file
                });
                const body = await res.json().catch(() => null);
                if (!res.ok) {
                    this.showToast(body?.error?.message || `Upload failed (${res.status})`);
                    continue;
                }
                const image = /^image\//.test(body.contentType || '');
                this.attachments.push({
                    id: body.id,
                    url: body.url,
                    name: file.name,
                    contentType: body.contentType,
                    image,
                    text: body.text || '',
                    kind: body.kind || 'binary'
                });
                if (!image && !body.text) {
                    this.showToast(`${file.name}: ${body.note || 'no text found'}`);
                }
            } catch (err) {
                this.showToast(`Upload failed: ${err.message}`);
            }
        }
        this.renderAttachments();
    }

    renderAttachments() {
        const tray = document.getElementById('attachTray');
        if (!tray) return;

        tray.innerHTML = this.attachments.map((file, index) => `
            <div class="attach-chip">
                ${file.image
                    ? `<img src="${encodeURI(this.fileUrl(file))}" alt="">`
                    : `<i class="fas ${file.text ? 'fa-file-alt' : 'fa-file'}"></i>`}
                <span class="attach-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</span>
                <button class="attach-remove" data-remove="${index}" aria-label="Remove attachment"><i class="fas fa-times"></i></button>
            </div>`).join('');

        tray.classList.toggle('active', this.attachments.length > 0);
    }

    /** What a card was made from, kept as links rather than copies. */
    attachmentsHtml(card) {
        const files = Array.isArray(card?.attachments) ? card.attachments : [];
        if (!files.length) return '';

        const cells = files.map(file => {
            const href = encodeURI(this.fileUrl(file));
            const label = this.escapeHtml(file.name || 'file');
            return file.image
                ? `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${label}"><img loading="lazy" src="${href}" alt="${label}"></a>`
                : `<a href="${href}" target="_blank" rel="noopener noreferrer" title="${label}"><i class="fas fa-file-alt"></i>${label}</a>`;
        }).join('');

        return `<div class="card-attachments">${cells}</div>`;
    }

    /**
     * Record with MediaRecorder and let the Worker transcribe. This is the path
     * that works in every browser: the built-in recogniser is Chrome-only, which
     * is why the mic button does not depend on it.
     */
    /** Aim the one recorder at a field: the chat bar, or a menu's text box. */
    dictateInto(fieldId, btn) {
        this.dictationBtn = btn || document.getElementById('micBtn');
        return this.toggleRecording(fieldId || null);
    }

    async toggleRecording(fieldId = null) {
        const btn = this.dictationBtn || document.getElementById('micBtn');

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
            return;
        }

        this.dictationTarget = fieldId
            ? document.getElementById(fieldId)
            : (this.lastTextField || document.getElementById('userInput'));

        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            this.showToast('Recording is unavailable here');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
            this.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            this.recordChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size) this.recordChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(track => track.stop());
                if (btn) btn.classList.remove('recording');
                const blob = new Blob(this.recordChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
                this.recordChunks = [];
                await this.transcribeAudio(blob);
            };

            this.mediaRecorder.start();
            if (btn) btn.classList.add('recording');
            this.showToast('Recording — tap the mic to stop');
        } catch (err) {
            this.showToast(`Microphone unavailable: ${err.message}`);
        }
    }

    async transcribeAudio(blob) {
        if (!blob.size) {
            this.showToast('Nothing recorded');
            return;
        }
        this.showToast('Transcribing…');
        try {
            const res = await fetch('/api/stt', {
                method: 'POST',
                headers: { 'content-type': blob.type || 'audio/webm' },
                body: blob
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                this.showToast(body?.error?.message || `Transcription failed (${res.status})`);
                return;
            }
            const text = String(body.text || '').trim();
            if (!text) {
                this.showToast('Nothing heard');
                return;
            }
            this.insertDictated(text);
        } catch (err) {
            this.showToast(`Transcription failed: ${err.message}`);
        }
    }

    /** Type a transcript into the field the mic was aimed at. */
    insertDictated(text) {
        const target = this.dictationTarget && document.contains(this.dictationTarget)
            ? this.dictationTarget
            : document.getElementById('userInput');
        if (!target) return;

        // A panel that closed while we were transcribing must not collect text.
        const panel = target.closest('.modal-overlay');
        if (panel && !panel.classList.contains('active')) {
            this.showToast('Transcription discarded — that panel closed');
            return;
        }

        const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
        const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
        const before = target.value.slice(0, start);
        const after = target.value.slice(end);
        const glue = before && !/\s$/.test(before) ? ' ' : '';
        const inserted = before + glue + text;
        target.value = inserted + after;
        if (target.setSelectionRange) target.setSelectionRange(inserted.length, inserted.length);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus();
        this.showToast('Transcribed');
    }

    async loadSession() {
        try {
            const res = await fetch('/api/session', {
                headers: { accept: 'application/json' },
                credentials: 'same-origin'
            });
            const body = await res.json();
            this.user = body.user || null;
        } catch {
            this.user = null;
        }
        this.renderAuth();
    }

    renderAuth() {
        const status = document.getElementById('authStatus');
        if (status) status.textContent = this.user ? `Signed in as ${this.user}` : 'Not signed in.';
    }

    async login() {
        const user = document.getElementById('loginUser')?.value.trim() || '';
        const password = document.getElementById('loginPassword')?.value || '';
        if (!user || !password) {
            this.showToast('Name and password');
            return;
        }
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ user, password })
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                this.showToast(body?.error?.message || `Sign-in failed (${res.status})`);
                return;
            }
            this.user = body.user;
            const field = document.getElementById('loginPassword');
            if (field) field.value = '';
            this.renderAuth();
            this.showToast(`Signed in as ${this.user}`);
        } catch (err) {
            this.showToast(`Sign-in failed: ${err.message}`);
        }
    }

    async logout() {
        try {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        } catch {
            // A failed sign-out must still clear the local view of the session.
        }
        this.user = null;
        this.renderAuth();
        this.showToast('Signed out');
    }

    openModal(id) {
        // A fresh open must not show the previous attempt's complaint.
        if (id === 'aiThemeModal') this.closeThemeIssue();
        document.getElementById(id).classList.add('active');
    }

    closeModal(id) {
        document.getElementById(id).classList.remove('active');
        if (id === 'promptModal') this.promptContext = null;
        if (id === 'styleModal') this.stylingId = null;
        if (id === 'textEditorModal') { this.editingId = null; this.editingField = null; }
    }

    openEditor(text) {
        document.getElementById('textEditorArea').value = text;
        document.getElementById('editorTitle').textContent = `Edit ${this.editingField === 'q' ? 'Question' : 'Response'}`;
        this.openModal('textEditorModal');
    }

    saveManualEdit() {
        const val = document.getElementById('textEditorArea').value.trim();
        if (this.editingId && this.editingField) {
            this.pushHistory("Manual Edit");
            this.updateCardContent(this.editingId, this.editingField === 'q' ? val : null, this.editingField === 'r' ? val : null);
            this.closeModal('textEditorModal');
        }
    }

    loadStyleValues(styles) {
        const lockCheck = document.getElementById('styleLocked');
        lockCheck.checked = !!styles.locked;

        document.getElementById('styleColor').value = styles.color || '#f5f5f5';
        document.getElementById('styleBg').value = styles.backgroundColor || '#1e1e1e';
        document.getElementById('styleBorder').value = styles.borderColor || '#333333';
        document.getElementById('stylePadding').value = parseInt(styles.padding || '16');
        document.getElementById('styleRadius').value = parseInt(styles.borderRadius || '16');
        document.getElementById('styleWidth').value = parseInt(styles.borderWidth || '1');
        document.getElementById('styleCustom').value = styles.customCSS || '';

        document.getElementById('valPad').textContent = (parseInt(styles.padding || '16')) + 'px';
        document.getElementById('valRad').textContent = (parseInt(styles.borderRadius || '16')) + 'px';
        document.getElementById('valWid').textContent = (parseInt(styles.borderWidth || '1')) + 'px';

        document.querySelectorAll('.toggle-btn[data-style-prop]').forEach(btn => {
            const prop = btn.dataset.styleProp;
            const val = btn.dataset.styleVal;
            const current = styles[prop];
            if ((prop === 'textDecoration' && current === 'underline') || current === val) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    saveStyles() {
        if (!this.stylingId) return;
        
        if (this.theme.locked) {
            this.showToast("Global Theme Locked - Cannot change card styles");
            this.closeModal('styleModal');
            return;
        }

        const isLocked = document.getElementById('styleLocked').checked;
        
        const styles = {
            locked: isLocked,
            color: document.getElementById('styleColor').value,
            backgroundColor: document.getElementById('styleBg').value,
            borderColor: document.getElementById('styleBorder').value,
            padding: document.getElementById('stylePadding').value + 'px',
            borderRadius: document.getElementById('styleRadius').value + 'px',
            borderWidth: document.getElementById('styleWidth').value + 'px',
            customCSS: document.getElementById('styleCustom').value
        };

        document.querySelectorAll('.toggle-btn.active').forEach(btn => {
            const prop = btn.dataset.styleProp;
            const val = btn.dataset.styleVal;
            if (prop === 'textDecoration') {
                styles.textDecoration = val;
            } else {
                styles[prop] = val;
            }
        });

        const card = this.cards.find(c => c.id === this.stylingId);
        if (card) {
            card.styles = { ...(card.styles || {}), ...styles };
            this.saveState();
            
            const el = document.querySelector(`.flip-card[data-id="${this.stylingId}"]`);
            if (el) {
                this.applyCardStyleToEl(el, styles);
                if(isLocked) el.classList.add('locked');
                else el.classList.remove('locked');
            }
            
            this.pushHistory("Style Change");
            this.closeModal('styleModal');
        }
    }

    promptAction(action, id = null) {
        if (!id && this.selectedIds.size > 0) {
            id = Array.from(this.selectedIds)[0];
        }
        if (!id && action !== 'merge') return;

        this.promptContext = { action, id };
        const title = document.getElementById('promptTitle');
        const desc = document.getElementById('promptDesc');
        const btn = document.getElementById('promptConfirmBtn');

        if (action === 'continue') {
            title.textContent = "Continue Card";
            desc.textContent = "Instruct the AI on how to continue the response.";
            btn.textContent = "Continue";
        } else if (action === 'split') {
            title.textContent = "Split Card";
            desc.textContent = "How should the AI split this content?";
            btn.textContent = "Split";
        } else if (action === 'ai-edit') {
            title.textContent = "AI Edit";
            desc.textContent = "What changes do you want?";
            btn.textContent = "Edit";
        } else if (action === 'merge') {
            title.textContent = "Merge Cards";
            desc.textContent = "Combine selected cards. Instructions?";
            btn.textContent = `Merge (${this.selectedIds.size})`;
        }

        this.openModal('promptModal');
    }

    executePromptAction() {
        const instructions = document.getElementById('promptArea').value.trim();
        const { action, id } = this.promptContext;
        const card = this.cards.find(c => c.id === id);
        
        this.closeModal('promptModal');
        document.getElementById('promptArea').value = '';

        if (action === 'merge') {
            this.merge(instructions);
            return;
        }

        if (!card) return;
        let userPrompt = "";

        if (action === 'continue') {
            userPrompt = `CONTINUE: Original: "${card.q}". Current: "${card.r}". Instruct: ${instructions}`;
            this.sendRequest(userPrompt, id);
        } else if (action === 'split') {
            userPrompt = `SPLIT: ${instructions}. Text: ${card.r}`;
            this.sendRequest(userPrompt, null);
        } else if (action === 'ai-edit') {
            userPrompt = `EDIT: ${instructions}. Current: ${card.r}`;
            this.sendRequest(userPrompt, null);
        }
    }

    merge(instructions = "") {
        if (this.selectedIds.size < 2) {
            this.showToast("Select 2+ cards to merge");
            return;
        }

        const sel = Array.from(this.selectedIds).map(id => this.cards.find(c => c.id === id));
        const content = sel.map(c => `---\n${c.q}\n${c.r}`).join('\n');
        const prompt = instructions 
            ? `Merge these into one based on: ${instructions}\n\n${content}`
            : `Combine these into one coherent response:\n\n${content}`;

        const id = this.addCard(`Merged ${sel.length} cards`, '...', {});
        this.streamingId = id;
        this.clearSelection(); 
        this.requestMergeUpdate(id, prompt);
    }

    async requestMergeUpdate(id, prompt) {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const url = this.getProxyUrl();
            
            // Get preset for this request
            const preset = this.getCurrentPreset();
            const usePreset = Boolean(preset && preset.key);

            const sysPrompt = this.getCurrentSystemPrompt();
            const fullPrompt = sysPrompt ? sysPrompt + "\n\nUser: " + prompt : prompt;

            const accumulated = await this.streamChat(
                {
                    messages: [{ role: 'user', content: fullPrompt }],
                    preset: usePreset ? preset.key : NO_PRESET_KEY,
                    presetLocked: this.presetChosen,
                    signal
                },
                (text, first) => this.updateStreamingContent(text, first)
            );

            this.finalizeResponse(accumulated);
        } catch (err) {
            if (err.name === 'AbortError') {
                const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
                if (el) el.innerHTML += '<div style="color:#ff6b6b;">[Merge Stopped]</div>';
                return;
            }
            const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
            if (el) el.innerHTML = `<span style="color: #ff6b6b;">Merge Failed: ${err.message}</span>`;
        } finally {
            this.abortController = null;
        }
    }

    applyAITheme(retry = false) {
        const input = document.getElementById('aiThemePrompt');
        const desc = (input?.value || this.lastThemePrompt || '').trim();
        if (!desc) {
            this.showToast('Describe the vibe first');
            return;
        }
        
        if (this.editingId) {
            const card = this.cards.find(c => c.id === this.editingId);
            if (card && card.styles && card.styles.locked) {
                this.showToast("Card Locked - Rejected");
                this.closeModal('aiThemeModal');
                return;
            }
        }

        if (this.theme.locked) {
            this.showToast("Global Theme Locked");
            this.closeModal('aiThemeModal');
            return;
        }

        // Fixed on purpose: the menu owns styling, so it never has to be coaxed
        // out of a conversation.
        const prompt = `Generate ONLY a style definition in this exact format:
!theme:Name,BgHex,CardBgHex,TextHex,BorderHex,PrimaryHex!
Based on this vibe: ${desc}
${retry ? 'Your previous answer was unusable. Reply with that single line and nothing else, with all five colours as 6-digit hex.\n' : ''}Do not output any other text.`;

        this.lastThemePrompt = desc;
        this.closeModal('aiThemeModal');
        this.showToast(retry ? 'Retrying theme…' : 'Generating theme…');
        
        const preset = this.getCurrentPreset();
        const usePreset = Boolean(preset && preset.key);

        this.streamChat(
            { messages: [{ role: 'user', content: prompt }], preset: usePreset ? preset.key : NO_PRESET_KEY },
            () => {}
        )
        .then(fullText => {
            const result = this.parseThemeResult(fullText);
            if (!result.complete) {
                this.showThemeIssue(desc, result.missing);
                return;
            }

            // Opened from a card's menu, so the colours belong to that card.
            const card = this.editingId ? this.cards.find(c => c.id === this.editingId) : null;
            if (card) {
                card.styles = {
                    ...(card.styles || {}),
                    color: result.theme.text,
                    backgroundColor: result.theme.bg,
                    borderColor: result.theme.border
                };
                this.saveState();
                const el = document.querySelector(`.flip-card[data-id="${card.id}"]`);
                if (el) this.applyCardStyleToEl(el, card.styles);
                this.showToast(`Card style: ${result.theme.name}`);
            } else {
                this.theme = { ...this.theme, ...result.theme };
                this.applyTheme();
                this.saveState();
                this.showToast(`Theme: ${result.theme.name}`);
            }
            this.closeThemeIssue();
        })
        .catch(err => this.showThemeIssue(desc, [], err.message));
    }

    /** The page theme's menu entry: the Stylist with no card attached. */
    openPageStylist() {
        this.editingId = null;
        this.closeThemeIssue();
        this.closeModal('settingsModal');
        this.openModal('aiThemeModal');
    }

    /**
     * Read whatever the Stylist model returned and turn it into a theme. Models
     * drift: they wrap the line in prose, drop the "!", omit "#", answer in JSON
     * or label the colours. All of that is usable — only a missing or invalid
     * colour is a real failure, and that is what the retry is for.
     */
    parseThemeResult(text) {
        const slots = {
            bg: 'bg', background: 'bg', pagebackground: 'bg',
            cardbg: 'cardBg', cardbackground: 'cardBg', card: 'cardBg',
            text: 'text', textcolor: 'text', foreground: 'text', fg: 'text', color: 'text',
            border: 'border', bordercolor: 'border',
            primary: 'primary', accent: 'primary', primarycolor: 'primary'
        };
        const order = ['bg', 'cardBg', 'text', 'border', 'primary'];
        const found = {};
        let name = '';
        const raw = String(text || '');

        // JSON, because some models answer {"bg":"#111",...} whatever the prompt.
        const json = raw.match(/\{[\s\S]*\}/);
        if (json) {
            try {
                const parsed = JSON.parse(json[0]);
                for (const [key, value] of Object.entries(parsed)) {
                    const flat = String(key).toLowerCase().replace(/[^a-z]/g, '');
                    const slot = slots[flat];
                    const hex = slot && !found[slot] ? this.normalizeHex(value) : null;
                    if (hex) found[slot] = hex;
                    if (flat === 'name' && typeof value === 'string') name = value.trim();
                }
            } catch { /* not JSON — the other shapes still work */ }
        }

        // Labelled pairs: bg: #111, primary=#c41e3a
        for (const match of raw.matchAll(/([a-z]+)\s*[:=]\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi)) {
            const slot = slots[match[1].toLowerCase()];
            const hex = slot && !found[slot] ? this.normalizeHex(match[2]) : null;
            if (hex) found[slot] = hex;
        }
        const labelledName = raw.match(/\bname\s*[:=]\s*["']?([^"',\n!}]+)/i);
        if (!name && labelledName) name = labelledName[1].trim();

        // !theme:Name,bg,cardBg,text,border,primary! — with or without the bangs.
        const directive = raw.match(/!?\btheme\s*:\s*([^!\n]+)/i);
        let positional = [];
        if (directive) {
            // Split on the separators models actually use, but keep rgb(...) whole:
            // a comma split would cut "rgb(245,245,245)" into three tokens, and a
            // bare "245" would then be read as the 3-digit hex #224455.
            const pieces = (directive[1].match(/rgba?\([^)]*\)|[^,;|\n]+/gi) || [])
                .map(part => part.trim())
                .filter(Boolean);
            if (!name && pieces.length && !this.normalizeHex(pieces[0])) {
                name = pieces[0].replace(/^["']|["']$/g, '').trim();
            }
            positional = pieces.map(part => this.normalizeHex(part)).filter(Boolean);
        } else {
            positional = (raw.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [])
                .map(hex => this.normalizeHex(hex))
                .filter(Boolean);
        }

        const missing = order.filter(slot => !found[slot]);
        if (missing.length) {
            // A full set is a whole theme; otherwise the colours fill the gaps.
            const fills = positional.length === order.length
                ? order.map((slot, index) => [slot, positional[index]])
                : missing.map((slot, index) => [slot, positional[index]]);
            for (const [slot, hex] of fills) {
                if (hex && !found[slot]) found[slot] = hex;
            }
        }

        const stillMissing = order.filter(slot => !found[slot]);
        return {
            theme: { name: name || 'AI Stylist', ...found },
            missing: stillMissing,
            complete: stillMissing.length === 0
        };
    }

    /** "#abc" | "abc" | "#AABBCC" | "rgb(1, 2, 3)" → "#aabbcc", or null. */
    normalizeHex(raw) {
        const value = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
        const hex = value.replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + hex.split('').map(c => c + c).join('').toLowerCase();
        if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
        if (/^[0-9a-f]{8}$/i.test(hex)) return '#' + hex.slice(0, 6).toLowerCase();
        const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
        if (rgb) {
            const parts = rgb.slice(1, 4).map(n => Math.min(255, Number(n)));
            return '#' + parts.map(n => n.toString(16).padStart(2, '0')).join('');
        }
        return null;
    }

    /** Reopen the Stylist with what was typed, saying what the answer lacked. */
    showThemeIssue(desc, missing = [], reason = '') {
        if (desc) this.lastThemePrompt = desc;
        const detail = missing.length
            ? `The answer left out ${missing.join(', ')}.`
            : `The answer had no usable colours${reason ? ` (${reason})` : ''}.`;

        const input = document.getElementById('aiThemePrompt');
        if (input && desc) input.value = desc;
        this.openModal('aiThemeModal');

        const status = document.getElementById('aiThemeStatus');
        if (status) {
            status.textContent = `${detail} Retry, or describe the look differently.`;
            status.hidden = false;
        }
        const retry = document.getElementById('aiThemeRetry');
        if (retry) retry.hidden = false;
        this.showToast('Theme needs another try');
    }

    closeThemeIssue() {
        const status = document.getElementById('aiThemeStatus');
        if (status) {
            status.textContent = '';
            status.hidden = true;
        }
        const retry = document.getElementById('aiThemeRetry');
        if (retry) retry.hidden = true;
    }

    toggleSelect(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
            el.classList.remove('selected');
        } else {
            this.selectedIds.add(id);
            el.classList.add('selected');
        }
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        const bar = document.getElementById('selectionBar');
        const count = document.getElementById('selectCount');
        const mergeBtn = document.getElementById('mergeSelected');
        const splitBtn = document.getElementById('splitSelected');

        if (this.selectedIds.size > 0) {
            bar.classList.add('active');
            count.textContent = `${this.selectedIds.size}`;
            mergeBtn.style.display = this.selectedIds.size > 1 ? 'inline-flex' : 'none';
            splitBtn.style.display = this.selectedIds.size === 1 ? 'inline-flex' : 'none';
        } else {
            bar.classList.remove('active');
        }
    }

    clearSelection() {
        this.selectedIds.forEach(id => {
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) el.classList.remove('selected');
        });
        this.selectedIds.clear();
        this.updateSelectionUI();
    }

    bulkDelete() {
        if (!confirm(`Delete ${this.selectedIds.size} cards?`)) return;
        this.pushHistory("Bulk Delete");
        this.selectedIds.forEach(id => {
            this.cards = this.cards.filter(c => c.id !== id);
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) el.remove();
        });
        this.clearSelection();
        this.saveState();
        if (this.cards.length === 0) {
            this.renderAll();
        }
    }

    openFullscreen(id) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;

        this.fullscreenId = id;
        this.fsFlipped = false;

        const headerTitle = document.querySelector('.fs-header h3');
        if (headerTitle) headerTitle.textContent = `Response: ${card.q.substring(0, 50)}...`;

        const requestPane = document.getElementById('fsRequestPane');
        const requestContent = document.getElementById('fsRequest');
        requestContent.innerHTML = this.md(card.q) + this.shotHtml(card);
        requestPane.style.display = 'none';

        const responseContent = document.getElementById('fsResponse');
        if (card.r === '...' && this.streamingId === id) {
            responseContent.innerHTML = '<div class="streaming"><span class="thinking-indicator">Thinking...</span><button class="stop-stream-btn" onclick="app.stopStream()">Stop</button></div>';
        } else {
            responseContent.innerHTML = this.renderAnswer(card.r, { full: true });
        }

        // A size the reader chose earlier, kept across cards and reloads.
        this.applyFsSize(this.settings.fsSize || null);

        const ov = document.getElementById('fullscreenOverlay');
        ov.classList.add('active');
        
        setTimeout(() => {
            // The overlay opens at the top of the answer: reading starts at the
            // first line, not at whatever the last stream left scrolled into view.
            const content = document.getElementById('fsContent');
            if (content) content.scrollTop = 0;
        }, 50);
    }

    closeFullscreen() {
        document.getElementById('fullscreenOverlay').classList.remove('active');
        this.fullscreenId = null;
    }

    /**
     * The fullscreen answer is not fixed to the glass: drag the corner and it
     * covers less of the screen, which is what portrait and landscape each need
     * at different times. Percentages, so a rotation keeps the proportion.
     */
    beginFsResize(event) {
        const pane = document.getElementById('fsResponsePane');
        const content = document.getElementById('fsContent');
        if (!pane || !content) return;
        event.preventDefault();
        event.stopPropagation();

        const contentRect = content.getBoundingClientRect();
        const paneRect = pane.getBoundingClientRect();
        const start = {
            x: event.clientX,
            y: event.clientY,
            w: (paneRect.width / contentRect.width) * 100,
            h: (paneRect.height / contentRect.height) * 100
        };

        const move = (e) => {
            const w = Math.min(100, Math.max(35, start.w + ((e.clientX - start.x) / contentRect.width) * 100));
            const h = Math.min(100, Math.max(25, start.h + ((e.clientY - start.y) / contentRect.height) * 100));
            this.applyFsSize({ w: Math.round(w), h: Math.round(h) });
        };
        const end = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            const box = pane.getBoundingClientRect();
            const now = content.getBoundingClientRect();
            this.settings.fsSize = {
                w: Math.round((box.width / now.width) * 100),
                h: Math.round((box.height / now.height) * 100)
            };
            this.saveState();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    applyFsSize(size) {
        const pane = document.getElementById('fsResponsePane');
        if (!pane) return;
        if (!size) {
            pane.style.flex = '';
            pane.style.width = '';
            pane.style.height = '';
            return;
        }
        pane.style.flex = '0 0 auto';
        pane.style.width = size.w + '%';
        pane.style.height = size.h + '%';
    }

    toggleFullscreenFlip() {
        if (!this.fullscreenId) return;
        this.fsFlipped = !this.fsFlipped;
        const requestPane = document.getElementById('fsRequestPane');
        const responsePane = document.getElementById('fsResponsePane');
        
        if (this.fsFlipped) {
            requestPane.style.display = 'block';
            responsePane.style.display = 'none';
        } else {
            requestPane.style.display = 'none';
            responsePane.style.display = 'block';
        }
    }

    toggleNativeFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch((e) => {
                this.showToast("Fullscreen blocked by browser");
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }
    
    readCurrentFullscreen() {
        if (this.fullscreenId) this.readCard(this.fullscreenId);
    }

    setCardView(view) {
        this.settings.view = view;
        // Rebuild the view classes only: the hidden bar is a body class too, and
        // clearing them all would bring the bar back on every view change.
        document.body.classList.remove('view-list', 'view-grid', 'view-full');
        if (view === 'grid') document.body.classList.add('view-grid');
        if (view === 'list') document.body.classList.add('view-list');
        if (view === 'full') document.body.classList.add('view-full');
        this.saveState();
    }

    cycleView() {
        const views = ['list', 'grid', 'full'];
        const next = views[(views.indexOf(this.settings.view) + 1) % views.length];
        this.setCardView(next);
        this.showToast(`View: ${next.toUpperCase()}`);
    }

    applyView() {
        this.setCardView(this.settings.view);
    }

    toggleThemeMode() {
        const current = document.body.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';
        document.body.setAttribute('data-theme', next);
        if (next === 'light') {
            this.theme.bg = '#f8f9fa'; this.theme.cardBg = '#ffffff'; this.theme.text = '#222'; this.theme.border = '#ddd';
        } else {
            this.theme.bg = '#121212'; this.theme.cardBg = '#1e1e1e'; this.theme.text = '#f5f5f5'; this.theme.border = '#333';
        }
        this.applyTheme();
        this.saveState();
    }

    toggleThemeLock() {
        this.theme.locked = !this.theme.locked;
        document.getElementById('lockLabel').textContent = this.theme.locked ? "Theme Locked" : "Lock Theme";
        this.showToast(this.theme.locked ? "Global Theme Locked" : "Global Theme Unlocked");
        this.saveState();
    }

    applyTheme() {
        const r = document.documentElement.style;
        r.setProperty('--primary', this.theme.primary);
        r.setProperty('--bg', this.theme.bg);
        r.setProperty('--card-bg', this.theme.cardBg);
        r.setProperty('--text', this.theme.text);
        r.setProperty('--border', this.theme.border);
        const brand = document.getElementById('brandPlaceholder');
        if (brand) brand.textContent = this.theme.name || 'ai-Ncards';
    }

    initASR() {
        if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.lang = 'en-US';
            this.recognition.interimResults = false;

            this.recognition.onstart = () => {
                this.isListening = true;
                const btn = document.getElementById('sendBtn');
                btn.innerHTML = '<i class="fas fa-stop"></i>';
                btn.classList.add('listening');
                btn.title = "Stop Listening";
            };

            this.recognition.onend = () => {
                this.isListening = false;
                const btn = document.getElementById('sendBtn');
                btn.innerHTML = '⏎';
                btn.classList.remove('listening');
                btn.title = "Send";
            };

            this.recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                document.getElementById('userInput').value = transcript;
            };
        }
    }

    /** The switch is server state, so the label has to be read, not remembered. */
    async loadEngine() {
        try {
            this.engineKey = localStorage.getItem('mind-engine-key') || '';
        } catch {
            this.engineKey = '';
        }
        const keyInput = document.getElementById('engineKeyInput');
        if (keyInput) keyInput.value = this.engineKey;

        try {
            const res = await fetch('/api/engine', { headers: { accept: 'application/json' } });
            const body = await res.json();
            this.engineCloudflare = Boolean(body.cloudflare);
        } catch {
            // Offline, or a Worker without the route: "On" is what it will be doing.
            this.engineCloudflare = true;
        }
        this.renderEngineToggle();
    }

    /** The key is only ever sent with a write, and never leaves this device. */
    saveEngineKey(value) {
        this.engineKey = String(value || '').trim();
        try {
            if (this.engineKey) localStorage.setItem('mind-engine-key', this.engineKey);
            else localStorage.removeItem('mind-engine-key');
        } catch {
            // Private mode: it still works for this page's lifetime.
        }
    }

    async toggleEngine() {
        const next = !this.engineCloudflare;
        if (!this.engineKey) {
            this.showToast('Add the KEY first — the switch is keyed');
            return;
        }
        try {
            const res = await fetch('/api/engine', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-engine-key': this.engineKey },
                body: JSON.stringify({ cloudflare: next }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                this.showToast(body?.error?.message || `Could not switch engines (${res.status})`);
                return;
            }
            this.engineCloudflare = Boolean(body.cloudflare);
            this.renderEngineToggle();
            this.showToast(
                this.engineCloudflare
                    ? 'Cloudflare on — Workers AI answers first'
                    : 'Cloudflare off — OpenRouter only, no neurons',
            );
        } catch (err) {
            this.showToast(`Could not switch engines: ${err.message}`);
        }
    }

    renderEngineToggle() {
        const btn = document.getElementById('engineToggle');
        const label = document.getElementById('engineLabel');
        if (label) label.textContent = this.engineCloudflare ? 'Cloudflare: On' : 'Cloudflare: Off';
        if (btn) {
            btn.setAttribute('aria-pressed', String(this.engineCloudflare));
            btn.classList.toggle('active', this.engineCloudflare);
        }
    }

    toggleASR() {
        this.settings.asrEnabled = !this.settings.asrEnabled;
        this.updateToggles();
        this.saveState();
    }

    toggleTTS() {
        this.settings.autoTTS = !this.settings.autoTTS;
        this.updateToggles();
        this.saveState();
    }

    updateToggles() {
        const asrBtn = document.getElementById('asrToggle');
        const ttsBtn = document.getElementById('ttsToggle');
        if (asrBtn) asrBtn.classList.toggle('active', this.settings.asrEnabled);
        if (ttsBtn) ttsBtn.classList.toggle('active', this.settings.autoTTS);
    }

    readCard(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const card = this.cards.find(c => c.id === id);
        if (!card || !card.r) return;
        
        this.speak(card.r);
    }

    /** Strip the app's own directives so the voice never reads markup aloud. */
    cleanForSpeech(text) {
        return String(text || '')
            .replace(/!theme:[^!]*!/gi, ' ')
            .replace(/!action:[^!]*!/gi, ' ')
            .replace(/![a-z]+:[^!]*!/gi, ' ')
            .replace(/!(bold|italic)!?/gi, ' ')
            .replace(/\[(FRONT|BACK)\]/gi, ' ')
            .replace(/[#*_`>~]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    stopSpeech() {
        if (this.speechAudio) {
            this.speechAudio.pause();
            this.speechAudio = null;
        }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }

    /**
     * Cloudflare melotts behind a cacheable GET, so the audio element streams it
     * and re-reading the same card costs no neurons. Browser speech is the
     * offline rung when the Worker cannot answer.
     */
    speak(text) {
        const clean = this.cleanForSpeech(text);
        if (!clean) return;

        if (this.speechAudio) {
            this.stopSpeech();
            return;
        }

        const chunks = [];
        let rest = clean;
        while (rest.length > 1800) {
            const cut = rest.lastIndexOf('. ', 1800);
            const at = cut > 400 ? cut + 1 : 1800;
            chunks.push(rest.slice(0, at).trim());
            rest = rest.slice(at).trim();
        }
        if (rest) chunks.push(rest);

        const base = this.getProxyUrl().replace(/\/api\/chat$/, '');
        const queue = chunks.map(chunk => `${base}/api/tts?${new URLSearchParams({ t: chunk, m: 'melotts' })}`);

        const playNext = () => {
            const src = queue.shift();
            if (!src) {
                this.speechAudio = null;
                return;
            }
            const audio = new Audio(src);
            this.speechAudio = audio;
            audio.onended = playNext;
            audio.onerror = () => {
                this.speechAudio = null;
                this.speakLocally(clean);
            };
            audio.play().catch(() => {
                this.speechAudio = null;
                this.speakLocally(clean);
            });
        };

        playNext();
    }

    speakLocally(text) {
        if (!window.speechSynthesis) {
            this.showToast('Speech unavailable');
            return;
        }
        window.speechSynthesis.cancel();
        // Chrome truncates long utterances, so sentence-sized chunks.
        for (const sentence of text.match(/[^.!?]+[.!?]*/g) || [text]) {
            const utterance = new SpeechSynthesisUtterance(sentence.trim());
            utterance.rate = 1.05;
            window.speechSynthesis.speak(utterance);
        }
    }

    /**
     * A saved Proxy URL is honoured only if it serves this app's presets.
     *
     * Which preset ran, its prompt, its budget and the truth cache are all
     * decided by the Worker behind /api/chat. A plain chat relay accepts the
     * same POST, ignores `preset`, and can end a long answer with an empty
     * stream — which reads as truncation rather than as the wrong URL. So ask
     * the configured server for its preset list once at boot: a server that
     * cannot name its presets cannot honour one, and chat returns to this site.
     */
    async verifyProxyUrl() {
        const own = new URL(DEFAULT_PROXY_URL, window.location.href).href;
        const configured = this.getProxyUrl();
        if (configured === own) return true;

        const base = configured.replace(/\/api\/chat$/, '');
        let servesPresets = false;
        let timer = null;
        try {
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(`${base}/api/presets`, { signal: controller.signal });
            const body = res.ok ? await res.json().catch(() => null) : null;
            servesPresets = Array.isArray(body?.presets) && body.presets.length > 0;
        } catch {
            servesPresets = false;
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (servesPresets) return true;

        const before = configured;
        this.settings.proxyUrl = own;
        this.saveState();
        const input = document.getElementById('proxyUrlInput');
        if (input) input.value = own;
        this.showToast(`Proxy URL ${before} cannot serve presets — chat is back on this site`);
        return false;
    }

    showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    /**
     * A reply that is a page, not prose.
     *
     * A stored document carries its own <style>, and sanitizing a markdown parse
     * drops that block: the layout, the type and every colour go with it, and the
     * card shows a wall of unstyled text. Anything shaped like a document is
     * framed instead, so the CSS it shipped with survives untouched.
     *
     * Fenced code is stripped first: explaining HTML should not turn the answer
     * into a frame.
     */
    looksLikeDocument(text) {
        const prose = String(text || '').replace(/```[\s\S]*?```/g, '');
        return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]/i.test(prose);
    }

    /**
     * The frame's document, with a light base underneath the page's own CSS.
     *
     * A document that names no colour inherits the browser's default, which is
     * black text — invisible once that frame is painted on a dark card. The base
     * only fills in what the page left unsaid, and it is injected into <head> so
     * the page's own <style> still wins the cascade.
     */
    documentSrcdoc(html) {
        const text = String(html || '');
        const css = (text.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
        const hasBackground = /background(-color)?\s*:/i.test(css);
        const hasColor = /(?:^|[;{\s])color\s*:/i.test(css);
        const base =
            `<style>${hasBackground ? '' : 'html{background:#fff}'}` +
            `${hasColor ? '' : 'html,body{color:#111}'}body{margin:0}</style>`;
        const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';

        if (/<head[^>]*>/i.test(text)) {
            return text.replace(/<head[^>]*>/i, (tag) => `${tag}${viewport}${base}`);
        }
        if (/<html[^>]*>/i.test(text)) {
            return text.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${viewport}${base}</head>`);
        }
        return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${viewport}${base}</head><body>${text}</body></html>`;
    }

    /**
     * Render a reply: prose as markdown, a document as a sandboxed frame.
     *
     * The frame runs scripts so a page's own buttons work, but without
     * allow-same-origin it cannot reach this document, its state or its storage.
     */
    renderAnswer(text, { full = false } = {}) {
        const raw = String(text || '');
        if (!raw.trim() || !this.looksLikeDocument(raw)) return this.md(raw);
        const doc = this.escapeAttr(this.documentSrcdoc(raw));
        return (
            '<div class="doc-shell">' +
            `<iframe class="doc-frame${full ? ' doc-frame-full' : ''}" title="Generated document" ` +
            `sandbox="allow-scripts allow-modals allow-popups allow-forms" srcdoc="${doc}"></iframe>` +
            '</div>'
        );
    }

    escapeAttr(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    md(text) {
        if (!text) return '';
        try {
            return DOMPurify.sanitize(marked.parse(text));
        } catch (e) {
            console.error("Markdown parsing error", e);
            return text;
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    window.app.init();
    window.app.verifyProxyUrl();
});
