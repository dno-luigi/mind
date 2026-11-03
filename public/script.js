// Same-origin: the Worker serves this page and /api/chat, so there is no CORS.
const DEFAULT_PROXY_URL = "/api/chat";
const STORAGE_KEY = "ai_ndraft_data_v2";
const PRESETS_KEY = "ai_ncards_presets_v1";

const SYSTEM_PROMPT_BASE = `You are a helpful, casual AI assistant. You can control styling and app behavior.

1. VISUAL STYLING (Start of response):
   - Page Theme: !theme:Name,BgHex,CardBgHex,TextHex,BorderHex,PrimaryHex!
   - Card Style: !bg:#hex! !text:#hex! !border:#hex! !pad:px! !radius:px! !bold! !italic!

2. APP ACTIONS (Hidden commands, put at end):
   - !action:merge! (Merges current selection)
   - !action:clear! (Clears the entire board)
   - !action:view:grid! or !action:view:list! or !action:view:full! (Changes view)

User requests are natural language. Be efficient.`;

// Default presets - these reference OpenRouter presets by their slug
// Configure your presets at: https://openrouter.ai/presets
const DEFAULT_PRESETS = {
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
            proxyUrl: ''
        };

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

        this.recognizer = null;
        this.isListening = false;

        this.decoder = new TextDecoder();
        this.abortController = null;
    }

    loadPresets() {
        try {
            const saved = localStorage.getItem(PRESETS_KEY);
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    // Migrate old presets to new format
                    const migrated = { ...DEFAULT_PRESETS };
                    for (const [key, preset] of Object.entries(parsed)) {
                        if (preset.key) {
                            // Already new format
                            migrated[key] = preset;
                        } else if (preset.prompt) {
                            // Old format - convert prompt to key
                            migrated[key] = {
                                name: preset.name || key,
                                key: key
                            };
                        }
                    }
                    return migrated;
                } catch (e) {
                    return { ...DEFAULT_PRESETS };
                }
            }
        } catch (e) {
            console.warn("localStorage not available:", e);
        }
        return { ...DEFAULT_PRESETS };
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
        this.applyTheme();
        this.applyView();
        this.bindEvents();
        this.initASR();
        this.renderAll();
        this.updateToggles();
        this.updatePresetButtonLabel();
        
        const proxyInput = document.getElementById('proxyUrlInput');
        if (proxyInput && this.settings.proxyUrl) proxyInput.value = this.settings.proxyUrl;

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
            html += `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--bg); border-radius: 8px; margin-bottom: 8px;">
                    <div>
                        <strong>${this.escapeHtml(preset.name)}</strong>
                        ${isDefault ? '<span style="font-size: 11px; opacity: 0.6; margin-left: 6px;">(default)</span>' : ''}
                    </div>
                    ${!isDefault ? `<button class="btn btn-danger" onclick="app.deletePreset('${key}')" style="padding: 4px 8px; font-size: 12px;">Delete</button>` : ''}
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
        
        const wasDefault = this.currentPresetKey === FALLBACK_PRESET_KEY;
        this.currentPresetKey = presetKey;
        
        // Update button label
        const label = document.getElementById('currentPresetLabel');
        if (label) {
            label.textContent = this.presets[presetKey].name;
        }
        
        const btn = document.getElementById('presetSelectorBtn');
        if (btn) {
            btn.classList.add('active');
        }
        
        const preset = this.presets[presetKey];
        if (wasDefault) {
            this.showToast(`Preset set: ${preset.name}`);
        }
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
            r: `OpenRouter Preset: ${preset.key}\n\nThis card uses the OpenRouter preset configuration.`,
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
        if (inputVal) {
            this.settings.proxyUrl = inputVal;
            this.saveState();
            return inputVal;
        }
        return this.settings.proxyUrl || DEFAULT_PROXY_URL;
    }

    bindEvents() {
        const sendBtn = document.getElementById('sendBtn');
        sendBtn.addEventListener('click', () => this.handleSendClick());
        
        const input = document.getElementById('userInput');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendClick();
            }
        });

        // Preset selector button for next query
        document.getElementById('presetSelectorBtn').addEventListener('click', () => this.openInputPresetSelector());

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

    addCard(q, r, styles = {}) {
        const id = crypto.randomUUID();
        const card = { 
            id, 
            q, 
            r, 
            styles,
            preset: this.currentPresetKey 
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
            grid.appendChild(empty);
            empty.style.display = 'flex';
        } else {
            empty.style.display = 'none';
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
            rHtml = this.md(card.r);
        }

        div.innerHTML = `
            <div class="flip-card-inner">
                <div class="card-face">
                    <div class="card-header">
                        <span style="font-size:11px; opacity:0.5;">REQ${presetBadge}</span>
                        <div class="card-actions">
                            <button onclick="app.openCardMenu('${card.id}', event)"><i class="fas fa-ellipsis-v"></i></button>
                            <button onclick="app.toggleSelect('${card.id}', event)"><i class="fas fa-check-circle"></i></button>
                        </div>
                    </div>
                    <div class="content">${this.md(card.q)}</div>
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
        `;

        if (card.styles) this.applyCardStyleToEl(div, card.styles);

        this.attachCardEvents(div, card.id);
        grid.appendChild(div);
    }

    attachCardEvents(div, id) {
        div.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.card-actions')) return;
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
                if (e.target.closest('button') || e.target.closest('.card-actions')) return;
                this.openFullscreen(id);
                e.preventDefault();
            }
            lastTap = currentTime;
        });
        div.addEventListener('dblclick', (e) => {
            if (!e.target.closest('button')) this.openFullscreen(id);
        });

        let pressTimer;
        div.addEventListener('touchstart', (e) => {
            if (this.selectedIds.size > 0) return;
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

        this.streamingId = contextCardId ? contextCardId : this.addCard(prompt, '...', {});
        
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
            fullPrompt = sysPrompt + "\n\nUser: " + prompt;
        } else {
            fullPrompt = prompt;
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
                    messages: [{ role: 'user', content: fullPrompt }],
                    preset: usePreset ? preset.key : null,
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
    async streamChat({ messages, preset = null, signal = null }, onText) {
        const res = await fetch(this.getProxyUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, preset, stream: true }),
            signal
        });

        if (!res.ok || !res.body) {
            let detail = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                detail = body?.error?.message || detail;
            } catch {}
            throw new Error(detail);
        }

        const reader = res.body.getReader();
        let buffer = '';
        let accumulated = '';
        let first = true;
        let failure = null;

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
                } else if (event.type === 'meta') {
                    this.lastRoute = event;
                }
            }
        }

        if (failure && !accumulated) throw new Error(failure);
        return accumulated;
    }

    stopStream() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.showToast("Streaming stopped");
        }
    }

    updateStreamingContent(text, replace = false) {
        if (!this.streamingId) return;
        const visible = text.replace(/![^!]+!/g, '');
        
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

        const { cleanText, styles, themeUpdate, actions } = this.parseCommands(fullText);
        const card = this.cards.find(c => c.id === id);
        
        if (card) {
            if (card.styles && card.styles.locked) {
                this.showToast("Card Locked - Style changes ignored");
            } else {
                if (Object.keys(styles).length > 0) {
                    card.styles = { ...card.styles, ...styles };
                }
            }
            card.r = cleanText;
        }

        const cleanHtml = this.md(cleanText);
        const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
        if (el) el.innerHTML = cleanHtml;

        if (this.fullscreenId === id) {
            document.getElementById('fsResponse').innerHTML = cleanHtml;
            const fsPane = document.getElementById('fsResponsePane');
            if (fsPane) fsPane.scrollTop = fsPane.scrollHeight;
        }

        if (card && (!card.styles || !card.styles.locked)) {
            if (Object.keys(styles).length > 0 && !this.theme.locked) {
                const cardEl = document.querySelector(`.flip-card[data-id="${id}"]`);
                if (cardEl) this.applyCardStyleToEl(cardEl, styles);
            }
        }

        if (themeUpdate) {
            if (this.theme.locked) {
                this.showToast("Global Theme Locked");
            } else {
                this.theme = { ...this.theme, ...themeUpdate };
                this.applyTheme();
                this.saveState();
                this.showToast(`Theme: ${themeUpdate.name || 'Updated'}`);
            }
        }

        if (actions.length > 0) {
            actions.forEach(action => {
                if (action === 'clear') this.clearAll();
                if (action === 'merge') {
                     if (this.selectedIds.size > 1) {
                         this.merge();
                     } else {
                         this.showToast("AI requested merge, but no cards selected.");
                     }
                }
                if (action.startsWith('view:')) {
                    const view = action.split(':')[1];
                    if (['list', 'grid', 'full'].includes(view)) {
                        this.setCardView(view);
                        this.showToast(`AI switched to ${view}`);
                    }
                }
            });
        }

        if (this.settings.autoTTS) this.readCard(id);

        this.streamingId = null;
        this.pushHistory("AI Response");
    }

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

    openModal(id) {
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
                    preset: usePreset ? preset.key : null,
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

    applyAITheme() {
        const desc = document.getElementById('aiThemePrompt').value.trim();
        if (!desc) return;
        
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

        const prompt = `Generate ONLY a style definition in this exact format:
!theme:Name,BgHex,CardBgHex,TextHex,BorderHex,PrimaryHex!
Based on this vibe: ${desc}
Do not output any other text.`;

        this.closeModal('aiThemeModal');
        this.showToast("Generating Theme...");
        
        const preset = this.getCurrentPreset();
        const usePreset = Boolean(preset && preset.key);

        this.streamChat(
            { messages: [{ role: 'user', content: prompt }], preset: usePreset ? preset.key : null },
            () => {}
        )
        .then(fullText => {
            const { themeUpdate } = this.parseCommands(fullText);
            if (themeUpdate) {
                this.theme = { ...this.theme, ...themeUpdate };
                this.applyTheme();
                this.saveState();
                this.showToast(`Theme: ${themeUpdate.name}`);
            } else {
                this.showToast("Theme generation failed (parse error)");
            }
        })
        .catch(() => {
            this.showToast("Theme generation failed");
        });
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
        requestContent.innerHTML = this.md(card.q);
        requestPane.style.display = 'none';

        const responseContent = document.getElementById('fsResponse');
        if (card.r === '...' && this.streamingId === id) {
            responseContent.innerHTML = '<div class="streaming"><span class="thinking-indicator">Thinking...</span><button class="stop-stream-btn" onclick="app.stopStream()">Stop</button></div>';
        } else {
            responseContent.innerHTML = this.md(card.r);
        }

        const ov = document.getElementById('fullscreenOverlay');
        ov.classList.add('active');
        
        setTimeout(() => {
            const responsePane = document.getElementById('fsResponsePane');
            if (responsePane) responsePane.scrollTop = responsePane.scrollHeight;
        }, 50);
    }

    closeFullscreen() {
        document.getElementById('fullscreenOverlay').classList.remove('active');
        this.fullscreenId = null;
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
        document.body.className = '';
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

    showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
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
});
