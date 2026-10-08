// ==UserScript==
// @name         LinkedIn Job Extractor
// @author       Raffaele Marco Cecere
// @namespace    https://github.com/raffaelececere/linkedin-job-extractor
// @version      1.0.3
// @description  Extract complete LinkedIn job listings and export structured TXT and JSON files.
// @match        https://www.linkedin.com/jobs/*
// @homepageURL  https://github.com/raffaelececere/linkedin-job-extractor
// @supportURL   https://github.com/raffaelececere/linkedin-job-extractor/issues
// @updateURL    https://raw.githubusercontent.com/raffaelececere/linkedin-job-extractor/main/linkedin-job-extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/raffaelececere/linkedin-job-extractor/main/linkedin-job-extractor.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
    'use strict';

    try {
        if (window.top !== window.self) return;
    } catch {
        return;
    }

    const VERSION = '1.0.3';
    const STATE_KEY = 'LINKEDIN_JOB_EXTRACTOR_V1_STATE';
    const POS_KEY = 'LINKEDIN_JOB_EXTRACTOR_V1_POSITION';
    const LOG_KEY = 'LINKEDIN_JOB_EXTRACTOR_V1_DEBUG_LOG';

    const CONFIG = Object.freeze({
        pageSize: 25,
        maxPages: 20,
        maxJobs: 500,
        initialWait: 350,
        scrollWait: 180,
        maxScrollRounds: 65,
        stableRounds: 3,
        paneTimeout: 5000,
        panePoll: 80,
        relocalizeScrollWait: 100,
        maxConsecutivePaneFailures: 3,
        descriptionExpandTimeout: 1400,
        descriptionExpandPoll: 40,
        maxLogEntries: 2500
    });

    let STOP = false;
    let RUNNING = false;

    const SESSION_ID = `${new Date().toISOString()}_${Math.random().toString(36).slice(2, 8)}`;

    const APP = Object.freeze({
        name: 'LinkedIn Job Extractor',
        panelId: 'linkedin-job-extractor-panel',
        reopenId: 'linkedin-job-extractor-reopen',
        pagesInputId: 'linkedin-job-extractor-pages',
        logPrefix: '[LinkedIn Job Extractor]'
    });

    const SELECTORS = Object.freeze({
        cardRoots: [
            'li.jobs-search-results__list-item',
            'li.scaffold-layout__list-item',
            'li.discovery-templates-entity-item',
            '[data-occludable-job-id]',
            '[data-job-id]',
            '[componentkey*="job-card-component-ref-"]'
        ],
        cardCandidates: [
            '[data-job-id]',
            '[data-occludable-job-id]',
            '[componentkey*="job-card-component-ref-"]',
            'a[href*="/jobs/view/"]',
            'a[href*="currentJobId="]'
        ],
        paneTitle: [
            '.job-details-jobs-unified-top-card__job-title',
            '.jobs-unified-top-card__job-title',
            '.top-card-layout__title',
            '.topcard__title',
            '.job-details-jobs-unified-top-card__job-title h1'
        ],
        paneCompany: [
            '.job-details-jobs-unified-top-card__company-name',
            '.jobs-unified-top-card__company-name',
            '.topcard__org-name-link',
            '.topcard__flavor-row a'
        ],
        paneInfo: [
            '.job-details-jobs-unified-top-card__primary-description-container',
            '.jobs-unified-top-card__primary-description',
            '.topcard__flavor-row'
        ]
    });

    const EXPAND_TEXT_RE = /mostra\s+altro|vedi\s+altro|show\s+more|see\s+more|ver\s+m[aá]s|voir\s+plus|mehr\s+anzeigen|ver\s+mais|meer\s+weergeven/i;
    const COLLAPSE_TEXT_RE = /mostra\s+meno|vedi\s+meno|show\s+less|see\s+less|ver\s+menos|voir\s+moins|weniger\s+anzeigen|ver\s+menos|minder\s+weergeven/i;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function sanitizeDiagnosticText(value) {
        return String(value || '')
            .replace(/chrome-extension:\/\/[^/]+/gi, 'chrome-extension://<redacted>')
            .replace(/moz-extension:\/\/[^/]+/gi, 'moz-extension://<redacted>');
    }

    function diagnosticUrl(raw = location.href) {
        try {
            const input = new URL(raw, location.origin);
            const output = new URL(input.origin + input.pathname);
            for (const key of ['currentJobId', 'start']) {
                const value = input.searchParams.get(key);
                if (value) output.searchParams.set(key, value);
            }
            return output.toString();
        } catch {
            return `${location.origin}${location.pathname}`;
        }
    }

    function sanitizeLogString(value) {
        const text = sanitizeDiagnosticText(value);
        return /^https?:\/\//i.test(text) ? diagnosticUrl(text) : text;
    }

    function isPlainObject(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function clean(text) {
        return (text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function inline(text) {
        return clean(text).replace(/\n+/g, ' ').trim();
    }

    function normalize(text) {
        return inline(text)
            .toLowerCase()
            .replace(/[–—]/g, '-')
            .replace(/[^a-z0-9à-ÿ+#. -]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function visible(el, win = window) {
        if (!el) return false;
        try {
            const r = el.getBoundingClientRect();
            const s = win.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        } catch {
            return false;
        }
    }

    function serializeForLog(value) {
        if (value == null) return value;
        if (value instanceof Error) {
            return { name: value.name, message: sanitizeDiagnosticText(value.message), stack: sanitizeDiagnosticText(value.stack || '') };
        }
        if (typeof value === 'string') return sanitizeLogString(value);
        if (['number', 'boolean'].includes(typeof value)) return value;
        try {
            return JSON.parse(JSON.stringify(value, (_key, item) => {
                if (item instanceof Error) {
                    return { name: item.name, message: sanitizeDiagnosticText(item.message), stack: sanitizeDiagnosticText(item.stack || '') };
                }
                if (item instanceof Element) {
                    return {
                        tag: item.tagName,
                        id: item.id || '',
                        className: typeof item.className === 'string' ? item.className : ''
                    };
                }
                if (typeof item === 'string') return sanitizeLogString(item);
                return item;
            }));
        } catch {
            try { return String(value); } catch { return '[unserializable]'; }
        }
    }

    function loadJsonValue(key, fallback) {
        let raw = null;
        try {
            raw = GM_getValue(key, null);
        } catch (error) {
            console.warn(`${APP.logPrefix} GM_getValue failed; trying localStorage`, error);
            try { raw = localStorage.getItem(key); } catch {}
        }

        if (raw == null) return fallback;
        if (typeof raw !== 'string') return raw;

        try {
            return JSON.parse(raw);
        } catch (error) {
            console.warn(`${APP.logPrefix} ignored corrupt persisted JSON for ${key}`, error);
            return fallback;
        }
    }

    function saveJsonValue(key, value) {
        const serialized = JSON.stringify(value);
        try {
            GM_setValue(key, serialized);
            return true;
        } catch (error) {
            console.warn(`${APP.logPrefix} GM_setValue failed; trying localStorage`, error);
            try {
                localStorage.setItem(key, serialized);
                return true;
            } catch (fallbackError) {
                console.error(`${APP.logPrefix} persistence failed for ${key}`, fallbackError);
                return false;
            }
        }
    }

    function deleteStoredValue(key) {
        let deleted = false;
        try {
            GM_deleteValue(key);
            deleted = true;
        } catch {}
        try {
            localStorage.removeItem(key);
            deleted = true;
        } catch {}
        return deleted;
    }

    function loadState() {
        const state = loadJsonValue(STATE_KEY, null);
        if (!isPlainObject(state)) return null;
        if (!Array.isArray(state.results) || !Array.isArray(state.seenIds) || !Array.isArray(state.errors)) return null;
        if (!Number.isInteger(state.page) || !Number.isInteger(state.targetPages)) return null;
        return state;
    }

    function saveState(state) {
        if (!saveJsonValue(STATE_KEY, state)) {
            throw new Error('Unable to persist extractor state.');
        }
    }

    function clearState() {
        deleteStoredValue(STATE_KEY);
    }

    let debugLogCache = null;

    function loadDebugLog() {
        if (Array.isArray(debugLogCache)) return debugLogCache;
        const value = loadJsonValue(LOG_KEY, []);
        debugLogCache = Array.isArray(value) ? value : [];
        return debugLogCache;
    }

    function debugLog(level, event, data) {
        try {
            const entries = loadDebugLog();
            entries.push({
                ts: new Date().toISOString(),
                level,
                event,
                sessionId: SESSION_ID,
                url: diagnosticUrl(),
                data: serializeForLog(data)
            });
            if (entries.length > CONFIG.maxLogEntries) {
                entries.splice(0, entries.length - CONFIG.maxLogEntries);
            }
            saveJsonValue(LOG_KEY, entries);
        } catch (e) {
            console.error(`${APP.logPrefix} debug log failure`, e);
        }
    }

    function resetDebugLogForNewRun() {
        debugLogCache = [];
        deleteStoredValue(LOG_KEY);
    }

    function buildDebugTxt() {
        const state = loadState();
        const entries = loadDebugLog();
        let out = `LINKEDIN JOB EXTRACTOR V${VERSION} - DEBUG LOG\n\n`;
        out += `Generated: ${new Date().toLocaleString()}\n`;
        out += `Current session: ${state?.sessionId || SESSION_ID}\n`;
        out += `Current URL: ${diagnosticUrl()}\n`;
        out += `Browser: ${navigator.userAgentData?.brands?.map(x => x.brand + ' ' + x.version).join(', ') || navigator.userAgent}\n`;
        out += `State present: ${state ? 'YES' : 'NO'}\n`;
        out += `Running: ${Boolean(state?.running)}\n`;
        out += `Page: ${(state?.page ?? 0) + 1}\n`;
        out += `Target pages: ${state?.targetPages || '-'}\n`;
        out += `Results: ${state?.results?.length || 0}\n`;
        out += `Job errors: ${state?.errors?.length || 0}\n`;
        out += `Stored log events: ${entries.length}\n\n`;
        out += '============================================================\n';

        for (const entry of entries) {
            out += `\n[${entry.ts}] [${entry.level}] [${entry.sessionId || '-'}] ${entry.event}\n`;
            out += `URL: ${entry.url || '-'}\n`;
            if (entry.data !== undefined) {
                out += `DATA: ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}\n`;
            }
        }
        return out;
    }

    function download(filename, contents, type) {
        const blob = new Blob([contents], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    function downloadDebugLog(reason = 'manual') {
        debugLog('INFO', 'debug.download', { reason });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        download(`linkedin_job_extractor_DEBUG_${stamp}.txt`, buildDebugTxt(), 'text/plain;charset=utf-8');
    }

    function loadPos() {
        return loadJsonValue(POS_KEY, null);
    }

    function savePos(pos) {
        saveJsonValue(POS_KEY, pos);
    }

    let statusEl = null;
    let pagesInput = null;
    let progressBarEl = null;
    let progressLabelEl = null;
    let miniProgressEl = null;
    let elapsedEl = null;
    let etaEl = null;
    let progressTimerId = null;
    let startButtonEl = null;
    let stopButtonEl = null;
    let resetButtonEl = null;
    let saveButtonEl = null;
    let saveFormatEl = null;
    let debugButtonEl = null;

    const progressState = {
        startedAtMs: 0,
        finishedAtMs: 0,
        completed: 0,
        total: 0,
        running: false
    };

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    function formatDuration(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '--:--';
        const totalSeconds = Math.max(0, Math.round(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function refreshProgressClock() {
        const now = progressState.running
            ? Date.now()
            : (progressState.finishedAtMs || Date.now());
        const startedAtMs = progressState.startedAtMs || now;
        const elapsedMs = Math.max(0, now - startedAtMs);

        if (elapsedEl) elapsedEl.textContent = `Elapsed ${formatDuration(elapsedMs)}`;

        if (etaEl) {
            if (!progressState.running) {
                etaEl.textContent = progressState.total > 0 && progressState.completed >= progressState.total
                    ? 'Remaining 00:00'
                    : 'Remaining --:--';
            } else if (
                progressState.completed >= 2 &&
                progressState.total > progressState.completed
            ) {
                const averageMs = elapsedMs / progressState.completed;
                const remainingMs = averageMs * (progressState.total - progressState.completed);
                etaEl.textContent = `Remaining ~${formatDuration(remainingMs)}`;
            } else if (progressState.total > 0 && progressState.completed >= progressState.total) {
                etaEl.textContent = 'Remaining 00:00';
            } else {
                etaEl.textContent = 'Remaining --:--';
            }
        }
    }

    function updateProgress({ completed, total, startedAtMs, finishedAtMs = 0, running = true }) {
        progressState.completed = Math.max(0, Number(completed) || 0);
        progressState.total = Math.max(0, Number(total) || 0);
        progressState.startedAtMs = Number(startedAtMs) || progressState.startedAtMs || Date.now();
        progressState.finishedAtMs = Number(finishedAtMs) || (running ? 0 : progressState.finishedAtMs);
        progressState.running = Boolean(running);

        const percentage = progressState.total > 0
            ? Math.min(100, Math.max(0, (progressState.completed / progressState.total) * 100))
            : 0;

        if (progressBarEl) {
            progressBarEl.style.width = `${percentage}%`;
            progressBarEl.setAttribute('aria-valuenow', String(Math.round(percentage)));
        }

        if (progressLabelEl) {
            const count = progressState.total > 0
                ? `${progressState.completed} / ${progressState.total}`
                : `${progressState.completed}`;
            progressLabelEl.textContent = `${count} · ${Math.round(percentage)}%`;
        }

        if (miniProgressEl) {
            miniProgressEl.textContent = progressState.total > 0
                ? `${Math.round(percentage)}%`
                : '';
        }

        refreshProgressClock();
    }

    function startProgressClock(startedAtMs) {
        progressState.startedAtMs = Number(startedAtMs) || Date.now();
        progressState.finishedAtMs = 0;
        progressState.running = true;
        if (progressTimerId !== null) clearInterval(progressTimerId);
        progressTimerId = window.setInterval(refreshProgressClock, 500);
        refreshProgressClock();
    }

    function stopProgressClock() {
        progressState.running = false;
        if (progressTimerId !== null) {
            clearInterval(progressTimerId);
            progressTimerId = null;
        }
        refreshProgressClock();
    }

    function resetProgressUi() {
        stopProgressClock();
        progressState.startedAtMs = 0;
        progressState.finishedAtMs = 0;
        progressState.completed = 0;
        progressState.total = 0;
        if (progressBarEl) {
            progressBarEl.style.width = '0%';
            progressBarEl.setAttribute('aria-valuenow', '0');
        }
        if (progressLabelEl) progressLabelEl.textContent = '0 / 0 · 0%';
        if (miniProgressEl) miniProgressEl.textContent = '';
        if (elapsedEl) elapsedEl.textContent = 'Elapsed 00:00';
        if (etaEl) etaEl.textContent = 'Remaining --:--';
    }

    function setPages(value) {
        if (!pagesInput) return;
        const n = Math.max(1, Math.min(CONFIG.maxPages, parseInt(value || '1', 10) || 1));
        pagesInput.value = String(n);
    }

    function getPages() {
        return Math.max(1, Math.min(CONFIG.maxPages, parseInt(pagesInput?.value || '1', 10) || 1));
    }

    function runDetached(label, task) {
        Promise.resolve()
            .then(task)
            .catch(error => {
                debugLog('ERROR', 'async.detached.failed', {
                    label,
                    error: serializeForLog(error)
                });
                setStatus(`ERROR\n\n${error?.message || String(error)}`);
            });
    }

    function setButtonEnabled(button, enabled) {
        if (!button) return;
        const active = Boolean(enabled);
        button.disabled = !active;
        button.setAttribute('aria-disabled', String(!active));
        button.style.opacity = active ? '1' : '0.42';
        button.style.cursor = active ? 'pointer' : 'not-allowed';
    }

    function refreshControls(state = loadState()) {
        const running = Boolean(state?.running);
        const hasResults = Boolean(state?.results?.length);

        setButtonEnabled(startButtonEl, !running);
        setButtonEnabled(stopButtonEl, running);
        setButtonEnabled(saveButtonEl, !running && hasResults);
        setButtonEnabled(debugButtonEl, loadDebugLog().length > 0);

        if (pagesInput) pagesInput.disabled = running;
        if (saveFormatEl) saveFormatEl.disabled = running || !hasResults;
    }

    function createButton(text, background) {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, {
            width: '100%',
            marginTop: '7px',
            padding: '8px 9px',
            border: '0',
            borderRadius: '6px',
            background,
            color: '#fff',
            fontWeight: '700',
            cursor: 'pointer'
        });
        return b;
    }

    function createPanel() {
        if (document.getElementById(APP.panelId)) return;

        const panel = document.createElement('div');
        panel.id = APP.panelId;
        Object.assign(panel.style, {
            position: 'fixed',
            top: '90px',
            right: '20px',
            width: '280px',
            zIndex: '2147483647',
            padding: '12px',
            background: '#fff',
            border: '1px solid #bbb',
            borderRadius: '9px',
            boxShadow: '0 5px 22px rgba(0,0,0,.22)',
            color: '#111',
            font: '13px Arial,sans-serif'
        });

        const savedPos = loadPos();
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            panel.style.left = `${savedPos.left}px`;
            panel.style.top = `${savedPos.top}px`;
            panel.style.right = 'auto';
        }

        const title = document.createElement('div');
        title.textContent = `${APP.name} ${VERSION}`;
        Object.assign(title.style, {
            fontWeight: '800',
            fontSize: '14px',
            marginRight: '64px',
            cursor: 'move',
            userSelect: 'none'
        });

        const minimize = document.createElement('button');
        minimize.textContent = '−';
        minimize.title = 'Minimize panel';
        minimize.setAttribute('aria-label', 'Minimize panel');
        Object.assign(minimize.style, {
            position: 'absolute', top: '5px', right: '36px', width: '28px', height: '28px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0',
            border: '0', background: 'transparent', color: '#444', fontSize: '20px',
            lineHeight: '1', cursor: 'pointer', borderRadius: '5px'
        });

        miniProgressEl = document.createElement('span');
        Object.assign(miniProgressEl.style, {
            display: 'none',
            marginLeft: '8px',
            color: '#555',
            fontSize: '11px',
            fontWeight: '700',
            fontVariantNumeric: 'tabular-nums'
        });

        const close = document.createElement('button');
        close.textContent = '×';
        close.title = 'Close panel';
        close.setAttribute('aria-label', 'Close panel');
        Object.assign(close.style, {
            position: 'absolute', top: '5px', right: '7px', width: '28px', height: '28px',
            border: '0', background: 'transparent', color: '#444', fontSize: '22px',
            lineHeight: '24px', cursor: 'pointer', borderRadius: '5px'
        });

        const subtitle = document.createElement('div');
        subtitle.textContent = 'Export complete job listings to TXT and JSON';
        Object.assign(subtitle.style, { marginTop: '4px', color: '#555', fontSize: '11px' });

        const row = document.createElement('div');
        Object.assign(row.style, { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '7px' });
        const label = document.createElement('span');
        label.textContent = 'Pages';
        pagesInput = document.createElement('input');
        pagesInput.id = APP.pagesInputId;
        pagesInput.type = 'number';
        pagesInput.min = '1';
        pagesInput.max = String(CONFIG.maxPages);
        pagesInput.value = '1';
        Object.assign(pagesInput.style, { width: '62px', padding: '5px', border: '1px solid #aaa', borderRadius: '5px' });
        row.append(label, pagesInput);

        const progressBox = document.createElement('div');
        Object.assign(progressBox.style, {
            marginTop: '11px',
            padding: '9px',
            background: '#f7f7f7',
            border: '1px solid #e2e2e2',
            borderRadius: '7px'
        });

        const progressTop = document.createElement('div');
        Object.assign(progressTop.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '6px',
            fontSize: '11px'
        });

        const progressCaption = document.createElement('span');
        progressCaption.textContent = 'Progress';
        progressCaption.style.fontWeight = '700';

        progressLabelEl = document.createElement('span');
        progressLabelEl.textContent = '0 / 0 · 0%';
        progressLabelEl.style.fontVariantNumeric = 'tabular-nums';

        progressTop.append(progressCaption, progressLabelEl);

        const progressTrack = document.createElement('div');
        Object.assign(progressTrack.style, {
            width: '100%',
            height: '8px',
            overflow: 'hidden',
            background: '#dedede',
            borderRadius: '999px'
        });

        progressBarEl = document.createElement('div');
        progressBarEl.setAttribute('role', 'progressbar');
        progressBarEl.setAttribute('aria-label', 'Job extraction progress');
        progressBarEl.setAttribute('aria-valuemin', '0');
        progressBarEl.setAttribute('aria-valuemax', '100');
        progressBarEl.setAttribute('aria-valuenow', '0');
        Object.assign(progressBarEl.style, {
            width: '0%',
            height: '100%',
            background: '#0a66c2',
            borderRadius: '999px',
            transition: 'width 180ms ease-out'
        });
        progressTrack.append(progressBarEl);

        const timeRow = document.createElement('div');
        Object.assign(timeRow.style, {
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
            marginTop: '7px',
            color: '#555',
            fontSize: '10px',
            fontVariantNumeric: 'tabular-nums'
        });

        elapsedEl = document.createElement('span');
        elapsedEl.textContent = 'Elapsed 00:00';
        etaEl = document.createElement('span');
        etaEl.textContent = 'Remaining --:--';
        timeRow.append(elapsedEl, etaEl);

        progressBox.append(progressTop, progressTrack, timeRow);

        startButtonEl = createButton('START EXTRACTION', '#0a66c2');
        stopButtonEl = createButton('STOP', '#a82828');
        resetButtonEl = createButton('RESET', '#555');
        debugButtonEl = createButton('DOWNLOAD DEBUG', '#6b4ca5');

        const saveRow = document.createElement('div');
        Object.assign(saveRow.style, {
            display: 'flex',
            gap: '7px',
            alignItems: 'stretch',
            marginTop: '7px'
        });

        saveFormatEl = document.createElement('select');
        saveFormatEl.setAttribute('aria-label', 'Export format');
        Object.assign(saveFormatEl.style, {
            width: '96px',
            minWidth: '96px',
            padding: '7px 6px',
            border: '1px solid #aaa',
            borderRadius: '6px',
            background: '#fff',
            color: '#111',
            fontWeight: '700',
            cursor: 'pointer'
        });
        for (const [value, labelText] of [
            ['txt', 'TXT'],
            ['json', 'JSON'],
            ['both', 'TXT + JSON']
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = labelText;
            saveFormatEl.append(option);
        }

        saveButtonEl = createButton('SAVE RESULTS', '#237a47');
        saveButtonEl.style.marginTop = '0';
        saveButtonEl.style.flex = '1';

        saveRow.append(saveFormatEl, saveButtonEl);

        statusEl = document.createElement('pre');
        Object.assign(statusEl.style, {
            margin: '10px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: '210px', overflow: 'auto', background: '#f4f4f4',
            borderRadius: '6px', padding: '8px', font: '11px/1.35 Consolas,monospace'
        });
        statusEl.textContent = 'Ready.';

        const content = document.createElement('div');
        content.append(
            subtitle,
            row,
            progressBox,
            startButtonEl,
            stopButtonEl,
            saveRow,
            resetButtonEl,
            debugButtonEl,
            statusEl
        );

        const reopen = document.createElement('button');
        reopen.id = APP.reopenId;
        reopen.textContent = 'Job Extractor';
        Object.assign(reopen.style, {
            position: 'fixed', top: '90px', right: '10px', zIndex: '2147483647',
            display: 'none', border: '0', borderRadius: '16px', padding: '7px 10px',
            background: '#0a66c2', color: '#fff', fontWeight: '700', cursor: 'pointer'
        });

        let minimized = false;

        function persistPanelState() {
            const rect = panel.getBoundingClientRect();
            savePos({
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                minimized
            });
        }

        function setMinimized(nextMinimized, { persist = true } = {}) {
            minimized = Boolean(nextMinimized);

            content.style.display = minimized ? 'none' : 'block';
            miniProgressEl.style.display = minimized ? 'inline' : 'none';

            panel.style.width = minimized ? '205px' : '280px';
            panel.style.padding = minimized ? '8px 10px' : '12px';
            panel.style.borderRadius = minimized ? '8px' : '9px';

            title.textContent = minimized ? 'Job Extractor' : `${APP.name} ${VERSION}`;
            title.style.fontSize = minimized ? '12px' : '14px';
            title.style.marginRight = minimized ? '60px' : '64px';

            minimize.textContent = minimized ? '□' : '−';
            minimize.title = minimized ? 'Restore panel' : 'Minimize panel';
            minimize.setAttribute(
                'aria-label',
                minimized ? 'Restore panel' : 'Minimize panel'
            );

            if (persist) persistPanelState();
            debugLog('INFO', minimized ? 'panel.minimized' : 'panel.restored', {
                running: RUNNING
            });
        }

        minimize.addEventListener('click', event => {
            event.stopPropagation();
            setMinimized(!minimized);
        });

        close.addEventListener('click', () => {
            panel.style.display = 'none';
            reopen.style.display = 'block';
            debugLog('INFO', 'panel.hidden', { running: RUNNING });
        });
        reopen.addEventListener('click', () => {
            reopen.style.display = 'none';
            panel.style.display = 'block';
        });

        startButtonEl.addEventListener('click', () => runDetached('ui.start', startNew));
        stopButtonEl.addEventListener('click', stopRun);
        resetButtonEl.addEventListener('click', resetRun);
        debugButtonEl.addEventListener('click', () => runDetached('ui.download-log', () => downloadDebugLog('button')));
        saveButtonEl.addEventListener('click', () => runDetached('ui.save-results', async () => {
            const state = loadState();
            if (!state?.results?.length || state.running) return;
            await exportResults(state, saveFormatEl?.value || 'txt');
            setStatus(
                `Save complete\n` +
                `${state.results.length} jobs · ${(saveFormatEl?.value || 'txt').toUpperCase()}`
            );
            refreshControls(state);
        }));

        title.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const startRect = panel.getBoundingClientRect();
            const dx = event.clientX - startRect.left;
            const dy = event.clientY - startRect.top;
            panel.style.right = 'auto';
            event.preventDefault();

            const onMove = moveEvent => {
                const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, moveEvent.clientX - dx));
                const top = Math.max(0, Math.min(window.innerHeight - 40, moveEvent.clientY - dy));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
            };

            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                persistPanelState();
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        });

        title.append(miniProgressEl);
        panel.append(title, minimize, close, content);
        document.body.append(panel, reopen);

        if (savedPos?.minimized) {
            setMinimized(true, { persist: false });
        }

        refreshControls(loadState());
    }

    function idFromString(value) {
        const text = String(value || '');
        const patterns = [
            /\/jobs\/view\/(\d+)/,
            /[?&]currentJobId=(\d+)/,
            /job-card-component-ref-(\d+)/
        ];
        for (const re of patterns) {
            const m = text.match(re);
            if (m) return m[1];
        }
        return '';
    }

    function idFromElement(el) {
        if (!el) return '';
        for (const attr of ['data-job-id', 'data-occludable-job-id', 'componentkey', 'href']) {
            const value = el.getAttribute?.(attr);
            if (!value) continue;
            if ((attr === 'data-job-id' || attr === 'data-occludable-job-id') && /^\d+$/.test(value)) return value;
            const id = idFromString(value);
            if (id) return id;
        }
        return '';
    }

    function canonicalCard(el) {
        return el.closest(SELECTORS.cardRoots.join(',')) || el;
    }

    function hasJobIdentity(card, id) {
        if (!card || !id) return false;

        const strongSelectors = [
            `[data-job-id="${id}"]`,
            `[data-occludable-job-id="${id}"]`,
            `[componentkey*="job-card-component-ref-${id}"]`,
            `a[href*="/jobs/view/${id}"]`
        ];

        for (const selector of strongSelectors) {
            try {
                if (card.matches?.(selector) || card.querySelector?.(selector)) return true;
            } catch {}
        }

        let currentJobLink = null;
        try {
            currentJobLink = [...card.querySelectorAll('a[href*="currentJobId="]')].find(anchor => {
                try {
                    return new URL(anchor.getAttribute('href') || '', location.href).searchParams.get('currentJobId') === String(id);
                } catch {
                    return false;
                }
            }) || null;
        } catch {}

        if (!currentJobLink) return false;

        return Boolean(
            card.querySelector?.(
                '.job-card-list__title--link,.job-card-container__link,.job-card-container,' +
                '.artdeco-entity-lockup__subtitle,.artdeco-entity-lockup__caption'
            )
        );
    }

    function cardTitle(card) {
        const selectors = [
            '.job-card-list__title--link',
            '.job-card-container__link',
            'a[href*="/jobs/view/"]',
            'a[href*="currentJobId="]',
            'div[data-display-contents] > p[style] > span[aria-hidden="true"]',
            'p[style] > span[aria-hidden="true"]'
        ];
        for (const selector of selectors) {
            for (const el of card.querySelectorAll(selector)) {
                if (!visible(el) || el.closest('button')) continue;
                const t = inline(el.innerText || el.textContent);
                if (t) return t;
            }
        }
        return clean(card.innerText).split('\n').map(inline).filter(Boolean)[0] || '';
    }

    function parseCard(card, id) {
        const raw = clean(card.innerText);
        const title = cardTitle(card);
        const lines = raw.split('\n').map(inline).filter(Boolean);
        const titleNorm = normalize(title);
        const titleLikeIndexes = [];

        if (titleNorm) {
            for (let i = 0; i < Math.min(lines.length, 5); i++) {
                const nx = normalize(lines[i]);
                if (nx === titleNorm || nx.includes(titleNorm)) titleLikeIndexes.push(i);
            }
        }

        const titleClusterEnd = titleLikeIndexes.length ? Math.max(...titleLikeIndexes) : -1;
        const afterTitle = titleClusterEnd >= 0 ? lines.slice(titleClusterEnd + 1) : lines.filter(x => normalize(x) !== titleNorm);

        const companyNode = card.querySelector(
            '.artdeco-entity-lockup__subtitle span[aria-hidden="true"],.artdeco-entity-lockup__subtitle,' +
            '.job-card-container__primary-description,.job-card-container__company-name'
        );
        const locationNode = card.querySelector(
            '.artdeco-entity-lockup__caption span[aria-hidden="true"],.artdeco-entity-lockup__caption'
        );

        const companyFromDom = inline(companyNode?.innerText || companyNode?.textContent || '');
        const locationFromDom = inline(locationNode?.innerText || locationNode?.textContent || '');
        const salary = lines.find(x => /(?:€|eur|\$|£).*?(?:yr|year|anno|annual|ral)|(?:\d+[\.,]?\d*)\s*[kK]\s*(?:€|eur|\$|£)/i.test(x)) || '';

        const fallbackCompany = afterTitle[0] || '';
        let fallbackLocation = afterTitle[1] || '';
        if (salary && normalize(fallbackLocation) === normalize(salary)) fallbackLocation = '';

        return {
            id,
            title,
            company: companyFromDom || fallbackCompany,
            location: locationFromDom || fallbackLocation,
            salary,
            raw
        };
    }

    function findScroller() {
        const probes = [...document.querySelectorAll('[data-job-id],[data-occludable-job-id],[componentkey*="job-card-component-ref-"]')];
        for (const el of probes) {
            let node = el.parentElement;
            while (node && node !== document.body) {
                const r = node.getBoundingClientRect();
                if (
                    node.scrollHeight > node.clientHeight + 200 &&
                    r.left < window.innerWidth * 0.55 &&
                    r.width >= 260 && r.width <= 750 && r.height > 300
                ) return node;
                node = node.parentElement;
            }
        }
        return [...document.querySelectorAll('div,ul')]
            .filter(el => {
                const r = el.getBoundingClientRect();
                return el.scrollHeight > el.clientHeight + 300 && r.left < window.innerWidth * 0.55 &&
                    r.width >= 260 && r.width <= 750 && r.height > 350;
            })
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || null;
    }

    function cardQuality(meta, card) {
        let score = 0;
        const title = normalize(meta?.title || '');
        const rawLines = clean(meta?.raw || '').split('\n').map(inline).filter(Boolean);

        if (title) score += 2;
        if (meta?.company) score += 4;
        if (meta?.location) score += 3;
        if (rawLines.length >= 3) score += 2;
        if (card?.matches?.('[data-job-id],[data-occludable-job-id]')) score += 4;
        if (card?.querySelector?.('[data-job-id],[data-occludable-job-id]')) score += 2;

        if (
            /offerte?\s+di\s+lavoro|job\s+matches?|top\s+candidates?|migliori\s+candidati/i.test(title)
        ) {
            score -= 8;
        }

        return score;
    }

    function scanCards(root, map) {
        for (const el of root.querySelectorAll(SELECTORS.cardCandidates.join(','))) {
            const id = idFromElement(el);
            if (!id) continue;

            const card = canonicalCard(el);
            if (!card || !hasJobIdentity(card, id)) continue;

            const r = card.getBoundingClientRect();
            if (r.left > window.innerWidth * 0.60 || r.width < 180 || r.height < 35) continue;

            const candidate = parseCard(card, id);
            candidate.quality = cardQuality(candidate, card);

            const current = map.get(id);
            if (!current || candidate.quality > (current.quality ?? -Infinity)) {
                map.set(id, candidate);
            }
        }
    }

    async function collectCurrentPageMeta() {
        const map = new Map();
        const scroller = findScroller();
        debugLog(scroller ? 'INFO' : 'WARN', 'page.scroller.detected', {
            found: Boolean(scroller), tag: scroller?.tagName || '',
            scrollHeight: scroller?.scrollHeight || 0, clientHeight: scroller?.clientHeight || 0
        });
        scanCards(scroller || document, map);
        if (!scroller) return map;

        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(350);

        let stable = 0;
        let lastCount = -1;
        for (let round = 0; round < CONFIG.maxScrollRounds; round++) {
            if (STOP) break;
            scanCards(scroller, map);
            const state = loadState();
            setStatus(`Page ${state?.page + 1 || 1}/${state?.targetPages || 1}\nCollecting job cards... ${map.size}`);

            stable = map.size === lastCount ? stable + 1 : 0;
            lastCount = map.size;
            if (map.size >= CONFIG.pageSize || stable >= CONFIG.stableRounds) break;

            const step = Math.max(450, Math.floor(scroller.clientHeight * 0.78));
            scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(CONFIG.scrollWait);
        }
        scanCards(scroller, map);
        debugLog('INFO', 'page.cards.collected', { count: map.size, stableRounds: stable });
        return map;
    }

    function firstText(doc, selectors) {
        for (const selector of selectors) {
            const el = doc.querySelector(selector);
            const text = inline(el?.innerText || el?.textContent || '');
            if (text) return text;
        }
        return '';
    }

    function descriptionTextFromElement(el) {
        if (!el) return '';

        try {
            const rendered = clean(el.innerText || '');
            if (rendered) return rendered;
        } catch {}

        try {
            const clone = el.cloneNode(true);
            for (const control of clone.querySelectorAll(
                'button,[role="button"],script,style,.jobs-description__footer-button,.show-more-less-html__button'
            )) {
                control.remove();
            }

            for (const br of clone.querySelectorAll('br')) {
                br.replaceWith(document.createTextNode('\n'));
            }

            const blocks = clone.querySelectorAll(
                'p,div,section,article,h1,h2,h3,h4,h5,h6,li,ul,ol,blockquote,pre,tr'
            );
            for (const block of blocks) {
                block.insertBefore(document.createTextNode('\n'), block.firstChild);
                block.appendChild(document.createTextNode('\n'));
            }

            return clean(clone.textContent || '');
        } catch {
            return clean(el.textContent || '');
        }
    }

    function stripDescriptionControlTail(text) {
        return clean(text).replace(
            /(?:\n|\s)*(?:(?:…|\.\.\.)\s*)?(?:mostra\s+altro|vedi\s+altro|show\s+more|see\s+more|ver\s+m[aá]s|voir\s+plus|mehr\s+anzeigen|ver\s+mais|meer\s+weergeven|altro|more|mostra\s+meno|vedi\s+meno|show\s+less|see\s+less|ver\s+menos|voir\s+moins|weniger\s+anzeigen|minder\s+weergeven|meno|less)\s*$/i,
            ''
        ).trim();
    }

    function descriptionElement(doc) {
        const selectors = [
            '[componentkey^="JobDetails_AboutTheJob_"] .jobs-box__html-content',
            '[componentkey^="JobDetails_AboutTheJob_"] .jobs-description-content__text',
            '[componentkey^="JobDetails_AboutTheJob_"] .show-more-less-html__markup',
            '#job-details .jobs-box__html-content',
            '#job-details .jobs-description-content__text',
            '#job-details .show-more-less-html__markup',
            '.jobs-box__html-content',
            '.jobs-description-content__text',
            '.show-more-less-html__markup',
            '.description__text',
            '#job-details',
            '.jobs-description__content',
            '[componentkey^="JobDetails_AboutTheJob_"]'
        ];

        let best = null;
        let bestLength = 0;

        for (const selector of selectors) {
            let nodes = [];
            try { nodes = [...doc.querySelectorAll(selector)]; } catch {}
            for (const el of nodes) {
                const length = stripDescriptionControlTail(descriptionTextFromElement(el)).length;
                if (length > bestLength) {
                    best = el;
                    bestLength = length;
                }
                if (length > 80 && !selector.startsWith('[componentkey') && selector !== '#job-details') {
                    return el;
                }
            }
        }

        return bestLength > 80 ? best : null;
    }

    function htmlToPlainText(_doc, html) {
        if (!html) return '';
        try {
            const parsed = new DOMParser().parseFromString(String(html), 'text/html');
            parsed.querySelectorAll('script,style,noscript,template,iframe,object,embed').forEach(node => node.remove());
            return clean(parsed.body?.innerText || parsed.body?.textContent || '');
        } catch {
            return clean(String(html).replace(/<[^>]+>/g, ' '));
        }
    }

    function descriptionFromStructuredData(doc) {
        const queue = [];
        try {
            for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
                const raw = String(script.textContent || '').trim();
                if (!raw || raw.length > 1500000) continue;
                try { queue.push(JSON.parse(raw)); } catch {}
            }
        } catch { return ''; }

        const seen = new Set();
        let inspected = 0;
        while (queue.length && inspected < 5000) {
            const value = queue.shift();
            inspected++;
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            if (Array.isArray(value)) { queue.push(...value); continue; }
            const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
            if (types.some(t => String(t || '').toLowerCase() === 'jobposting') && typeof value.description === 'string') {
                const text = htmlToPlainText(doc, value.description);
                if (text.length >= 80) return text;
            }
            for (const nested of Object.values(value)) {
                if (nested && typeof nested === 'object') queue.push(nested);
            }
        }
        return '';
    }

    function salaryFromText(text) {
        const cleanText = clean(text);
        if (!cleanText) return '';

        const lines = cleanText
            .split('\n')
            .map(inline)
            .filter(Boolean);

        const contextRe = /\b(?:salary|pay|compensation|retribuzione|retributiv[oa]|ral|stipendio|compenso|tariffa)\b/i;
        const moneyRe = /(?:€|EUR|\$|£)\s*\d|\d[\d.,'’]*\s*[kK]\b|\d[\d.,'’]*\s*(?:€|EUR|\$|£)/i;
        const contextual = [];

        for (const line of lines) {
            const sentences = line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ü€$£])/);
            let foundSentence = false;

            for (const sentence of sentences) {
                if (contextRe.test(sentence) && moneyRe.test(sentence)) {
                    contextual.push(inline(sentence));
                    foundSentence = true;
                }
            }

            if (!foundSentence && contextRe.test(line) && moneyRe.test(line)) {
                contextual.push(line);
            }
        }

        const uniqueContextual = [...new Set(contextual)];
        if (uniqueContextual.length) {
            return uniqueContextual.slice(0, 2).join(' | ');
        }

        const amount = String.raw`(?:(?:€|EUR|\$|£)\s*)?\d[\d.,'’]*\s*[kK]?\s*(?:€|EUR|\$|£)?`;
        const connector = String.raw`(?:-|–|—|a|al|e|ed|to|and)`;
        const rangeRe = new RegExp(`${amount}\\s*${connector}\\s*${amount}`, 'i');

        for (const line of lines) {
            const m = line.match(rangeRe);
            if (m && /€|EUR|\$|£|[kK]/i.test(m[0])) {
                return inline(m[0]);
            }
        }

        const singleRe = /(?:€|EUR|\$|£)\s*\d[\d.,'’]*\s*[kK]?|\d[\d.,'’]*\s*[kK]?\s*(?:€|EUR|\$|£)/i;
        for (const line of lines) {
            const m = line.match(singleRe);
            if (m) return inline(m[0]);
        }

        return '';
    }

    function currentJobIdFromPage() {
        try {
            return new URL(location.href).searchParams.get('currentJobId') || '';
        } catch {
            return '';
        }
    }

    function findCardById(id) {
        const selectors = [
            `[data-job-id="${id}"]`,
            `[data-occludable-job-id="${id}"]`,
            `[componentkey*="job-card-component-ref-${id}"]`,
            `a[href*="/jobs/view/${id}"]`,
            `a[href*="currentJobId=${id}"]`
        ];

        for (const selector of selectors) {
            let nodes = [];
            try { nodes = [...document.querySelectorAll(selector)]; } catch {}
            for (const el of nodes) {
                const card = canonicalCard(el);
                if (card) return card;
            }
        }

        for (const el of document.querySelectorAll('a[href*="/jobs/view/"],a[href*="currentJobId="],[data-job-id],[data-occludable-job-id]')) {
            if (idFromElement(el) !== String(id)) continue;
            const card = canonicalCard(el);
            if (card) return card;
        }

        return null;
    }

    async function locateCardById(id, scroller) {
        let card = findCardById(id);
        if (card || !scroller) return card;

        const original = scroller.scrollTop;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const steps = 12;

        for (let i = 0; i <= steps && !STOP; i++) {
            scroller.scrollTop = Math.round(maxTop * (i / steps));
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            await sleep(CONFIG.relocalizeScrollWait);
            card = findCardById(id);
            if (card) return card;
        }

        scroller.scrollTop = original;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        return null;
    }

    function clickableForCard(card, id) {
        if (!card || !hasJobIdentity(card, id)) return null;

        const links = [...card.querySelectorAll('a[href]')];
        const exactLink = links.find(anchor => {
            const href = anchor.getAttribute('href') || '';
            if (new RegExp(`/jobs/view/${id}(?:[/?#]|$)`, 'i').test(href)) return true;
            try {
                return new URL(href, location.href).searchParams.get('currentJobId') === String(id);
            } catch {
                return false;
            }
        });
        if (exactLink) return exactLink;

        const exactNode = card.querySelector(
            `[data-job-id="${id}"],[data-occludable-job-id="${id}"],[componentkey*="job-card-component-ref-${id}"]`
        );
        if (exactNode) return exactNode;

        return idFromElement(card) === String(id) ? card : null;
    }

    async function activateCard(id, scroller) {
        const card = await locateCardById(id, scroller);
        if (!card) throw new Error(`Job card not found in the DOM for Job ID ${id}`);

        try { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
        await sleep(20);

        const clickable = clickableForCard(card, id);
        if (!clickable) throw new Error(`No safe clickable element found for Job ID ${id}`);

        debugLog('DEBUG', 'job.card.click', {
            jobId: String(id),
            tag: clickable.tagName || '',
            href: clickable.getAttribute?.('href') || ''
        });

        try {
            clickable.click();
        } catch (error) {
            try {
                clickable.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true,
                    cancelable: true,
                    pointerType: 'mouse'
                }));
            } catch {
                throw new Error(`Unable to activate the job card for Job ID ${id}: ${error?.message || error}`);
            }
        }
        return card;
    }

    function paneTitle() {
        return firstText(document, SELECTORS.paneTitle);
    }

    function paneCompany() {
        return firstText(document, SELECTORS.paneCompany);
    }

    function paneInfo() {
        return firstText(document, SELECTORS.paneInfo);
    }

    function locationFromPaneInfo(info) {
        const text = inline(info);
        if (!text) return '';
        return inline(text.split('·')[0] || '');
    }

    function descriptionExpansionButton() {
        const box = descriptionElement(document);
        if (!box) return null;

        const roots = [];
        const pushRoot = root => {
            if (root && !roots.includes(root)) roots.push(root);
        };

        pushRoot(box.closest('[componentkey^="JobDetails_AboutTheJob_"]'));
        pushRoot(box.closest('.jobs-description'));
        pushRoot(box.closest('section'));
        pushRoot(box.parentElement);
        pushRoot(box.parentElement?.parentElement);

        const candidates = [];
        for (const root of roots) {
            let controls = [];
            try { controls = [...root.querySelectorAll('button,[role="button"]')]; } catch {}
            for (const control of controls) {
                if (!candidates.includes(control)) candidates.push(control);
            }
        }

        function score(control) {
            const text = inline(control.innerText || control.textContent || '');
            const aria = inline(control.getAttribute?.('aria-label') || '');
            const cls = String(control.className || '');
            const expanded = control.getAttribute?.('aria-expanded');
            const haystack = `${text} ${aria}`.toLowerCase();

            const classMatch = /jobs-description__footer-button|show-more-less-html__button|show-more/i.test(cls);
            const textMatch = EXPAND_TEXT_RE.test(haystack) || /^(?:…|\.\.\.)?\s*(?:altro|more)\s*$/i.test(text);
            const ariaMatch = /descrizione|description/i.test(aria);

            if (!classMatch && !textMatch && !ariaMatch) return 0;

            let points = 0;
            if (classMatch) points += 10;
            if (textMatch) points += 12;
            if (ariaMatch) points += 4;
            if (expanded === 'false') points += 3;
            if (COLLAPSE_TEXT_RE.test(haystack)) points -= 20;
            return points;
        }

        return candidates
            .map(control => ({ control, score: score(control) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.control || null;
    }

    async function expandDescriptionIfNeeded(id) {
        const box = descriptionElement(document);
        if (!box) return { attempted: false, expanded: false, reason: 'description-not-found' };

        const before = stripDescriptionControlTail(descriptionTextFromElement(box));
        const button = descriptionExpansionButton();

        if (!button) {
            const raw = clean(box.innerText || box.textContent || '');
            const hasTail = /(?:…|\.\.\.)\s*(?:altro|more|m[aá]s|plus|mais)\s*$/i.test(raw) || /mehr\s+anzeigen|meer\s+weergeven/i.test(raw);
            if (hasTail) {
                debugLog('WARN', 'description.expand.button_not_found', {
                    jobId: String(id),
                    beforeLength: before.length
                });
            }
            return { attempted: false, expanded: false, reason: 'button-not-found', beforeLength: before.length };
        }

        const buttonText = inline(button.innerText || button.textContent || button.getAttribute?.('aria-label') || '');
        const ariaBefore = button.getAttribute?.('aria-expanded');

        debugLog('DEBUG', 'description.expand.click', {
            jobId: String(id),
            buttonText,
            ariaExpanded: ariaBefore,
            beforeLength: before.length
        });

        try {
            button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        } catch {}

        try {
            button.click();
        } catch (error) {
            debugLog('WARN', 'description.expand.click_failed', {
                jobId: String(id),
                message: error?.message || String(error)
            });
        }

        const started = performance.now();
        let after = before;
        let expanded = false;
        let reason = 'timeout';

        while (!STOP && performance.now() - started < CONFIG.descriptionExpandTimeout) {
            const currentBox = descriptionElement(document) || box;
            after = stripDescriptionControlTail(descriptionTextFromElement(currentBox));
            const stillConnected = button.isConnected;
            const ariaNow = stillConnected ? button.getAttribute?.('aria-expanded') : null;
            const currentText = stillConnected
                ? inline(button.innerText || button.textContent || button.getAttribute?.('aria-label') || '')
                : '';

            if (ariaNow === 'true') { expanded = true; reason = 'aria-expanded'; break; }
            if (!stillConnected) { expanded = true; reason = 'button-removed'; break; }
            if (COLLAPSE_TEXT_RE.test(currentText) || /^(?:…|\.\.\.)?\s*(?:meno|less)\s*$/i.test(currentText)) {
                expanded = true; reason = 'button-became-less'; break;
            }
            if (after.length > before.length + 20) { expanded = true; reason = 'text-grew'; break; }

            await sleep(CONFIG.descriptionExpandPoll);
        }

        if (expanded) {
            await sleep(20);
            const currentBox = descriptionElement(document) || box;
            after = stripDescriptionControlTail(descriptionTextFromElement(currentBox));
        }

        debugLog(expanded ? 'INFO' : 'WARN', 'description.expand.result', {
            jobId: String(id),
            expanded,
            reason,
            beforeLength: before.length,
            afterLength: after.length
        });

        return { attempted: true, expanded, reason, beforeLength: before.length, afterLength: after.length };
    }

    function titleMatches(expected, actual) {
        const a = normalize(expected);
        const b = normalize(actual);
        if (!a || !b) return false;
        return a === b || a.includes(b) || b.includes(a);
    }

    function readCurrentPaneJob(meta, id) {
        const descEl = descriptionElement(document);
        let description = stripDescriptionControlTail(descriptionTextFromElement(descEl));
        let descriptionSource = description.length >= 80 ? 'in-page-dom-expanded-formatted' : '';

        if (description.length < 80) {
            const structured = descriptionFromStructuredData(document);
            if (structured.length > description.length) {
                description = structured;
                descriptionSource = 'in-page-ld+json';
            }
        }

        description = stripDescriptionControlTail(
            description.replace(
                /^(Informazioni sull['’]offerta di lavoro|About the job)\s*/i,
                ''
            )
        );

        const actualTitle = paneTitle();
        const actualCompany = paneCompany();
        const info = paneInfo();
        const actualLocation = locationFromPaneInfo(info);
        const salary = salaryFromText(description) || meta.salary;

        return {
            title: actualTitle || meta.title || '',
            company: actualCompany || meta.company || '',
            location: actualLocation || meta.location || '',
            salary: salary || '',
            linkedinInfo: info || '',
            jobId: String(id),
            url: `https://www.linkedin.com/jobs/view/${id}/`,
            description,
            descriptionSource: descriptionSource || 'unknown',
            cardText: meta.raw || ''
        };
    }

    async function waitForPane(id, meta, timeoutMs = CONFIG.paneTimeout, previousJob = null) {
        const started = performance.now();
        let expansionHandled = false;
        let expansionResult = null;
        let last = null;
        let staleContentLogged = false;

        while (!STOP && performance.now() - started < timeoutMs) {
            const selectedId = currentJobIdFromPage();
            const actualTitle = paneTitle();
            const actualCompany = paneCompany();
            const idOk = selectedId === String(id);
            const titleOk = titleMatches(meta.title, actualTitle);
            const companyOk = !meta.company || !actualCompany || titleMatches(meta.company, actualCompany);
            const fallbackIdentityOk = titleOk && companyOk;
            const identityContradiction =
                Boolean(actualTitle && !titleOk) ||
                Boolean(meta.company && actualCompany && !companyOk);

            if ((idOk || fallbackIdentityOk) && !identityContradiction) {
                if (!expansionHandled && descriptionElement(document)) {
                    expansionResult = await expandDescriptionIfNeeded(id);
                    expansionHandled = true;
                }

                const job = readCurrentPaneJob(meta, id);
                const samePreviousDescription = Boolean(
                    previousJob?.description &&
                    clean(previousJob.description) === clean(job.description)
                );
                const samePreviousListing = Boolean(
                    previousJob &&
                    titleMatches(meta.title, previousJob.title) &&
                    (!meta.company || !previousJob.company || titleMatches(meta.company, previousJob.company))
                );
                const staleContent =
                    samePreviousDescription &&
                    !samePreviousListing &&
                    !fallbackIdentityOk;

                last = {
                    selectedId,
                    actualTitle,
                    actualCompany,
                    company: job.company,
                    location: job.location,
                    descriptionLength: job.description.length,
                    staleContent,
                    expansion: expansionResult
                };

                if (staleContent && !staleContentLogged) {
                    debugLog('WARN', 'job.pane.stale_content', {
                        jobId: String(id),
                        previousJobId: previousJob?.jobId || '',
                        expectedTitle: meta.title || '',
                        previousTitle: previousJob?.title || '',
                        descriptionLength: job.description.length
                    });
                    staleContentLogged = true;
                }

                if (job.description.length >= 80 && !staleContent) {
                    return {
                        job,
                        elapsedMs: Math.round(performance.now() - started),
                        selectedBy: fallbackIdentityOk ? 'title+company' : 'currentJobId'
                    };
                }
            }

            await sleep(CONFIG.panePoll);
        }

        const error = new Error(`Job details pane/description did not load within ${timeoutMs} ms for Job ID ${id}`);
        error.diagnostic = last || {
            selectedId: currentJobIdFromPage(),
            actualTitle: paneTitle(),
            descriptionLength: stripDescriptionControlTail(descriptionTextFromElement(descriptionElement(document))).length
        };
        throw error;
    }

    async function extractJobInPage(id, meta, scroller, previousJob = null) {
        const started = performance.now();
        await activateCard(id, scroller);

        try {
            const result = await waitForPane(id, meta, CONFIG.paneTimeout, previousJob);
            debugLog('INFO', 'job.inpage.success', {
                jobId: String(id),
                title: result.job.title,
                company: result.job.company,
                location: result.job.location,
                descriptionLength: result.job.description.length,
                descriptionLines: result.job.description.split('\n').filter(Boolean).length,
                selectedBy: result.selectedBy,
                elapsedMs: Math.round(performance.now() - started)
            });
            return result.job;
        } catch (firstError) {
            if (STOP) throw firstError;

            debugLog('WARN', 'job.inpage.retry_click', {
                jobId: String(id),
                firstError: firstError.message,
                diagnostic: firstError.diagnostic || null
            });

            await activateCard(id, scroller);
            const result = await waitForPane(id, meta, 2500, previousJob);
            debugLog('INFO', 'job.inpage.success_after_retry', {
                jobId: String(id),
                descriptionLength: result.job.description.length,
                descriptionLines: result.job.description.split('\n').filter(Boolean).length,
                elapsedMs: Math.round(performance.now() - started)
            });
            return result.job;
        }
    }

    async function processCurrentPage(state) {
        await sleep(CONFIG.initialWait);
        const metaMap = await collectCurrentPageMeta();
        for (const meta of metaMap.values()) delete meta.quality;
        const entries = [...metaMap.entries()].filter(([id]) => !state.seenIds.includes(id));
        const scroller = findScroller();

        debugLog('INFO', 'page.meta.summary', {
            page: state.page + 1,
            found: metaMap.size,
            newJobs: entries.length,
            alreadySeen: metaMap.size - entries.length
        });

        if (!metaMap.size) throw new Error('No job listings found on the current page');

        let added = 0;
        let consecutiveFailures = 0;
        const started = performance.now();
        const runStartedAtMs = Date.parse(state.createdAt) || Date.now();
        const processedBeforePage = state.results.length + state.errors.length;
        const estimatedTotal = Math.min(
            CONFIG.maxJobs,
            processedBeforePage +
                entries.length +
                Math.max(0, state.targetPages - state.page - 1) * CONFIG.pageSize
        );

        startProgressClock(runStartedAtMs);
        updateProgress({
            completed: processedBeforePage,
            total: estimatedTotal,
            startedAtMs: runStartedAtMs,
            running: true
        });

        setStatus(
            `Page ${state.page + 1}/${state.targetPages}\n` +
            `${entries.length} jobs found`
        );

        for (let index = 0; index < entries.length; index++) {
            if (STOP) break;
            if (state.results.length >= CONFIG.maxJobs) break;

            const [id, meta] = entries[index];
            setStatus(
                `Page ${state.page + 1}/${state.targetPages}\n` +
                `Job ${index + 1}/${entries.length}\n` +
                `${meta.title || id}`
            );

            debugLog('INFO', 'job.inpage.start', {
                page: state.page + 1,
                index: index + 1,
                jobId: id,
                title: meta.title
            });

            try {
                const previousJob = state.results[state.results.length - 1] || null;
                const job = await extractJobInPage(id, meta, scroller, previousJob);
                if (!state.seenIds.includes(id)) {
                    state.results.push(job);
                    state.seenIds.push(id);
                    added++;
                }
                consecutiveFailures = 0;
            } catch (e) {
                if (STOP) break;

                consecutiveFailures++;
                if (!state.seenIds.includes(id)) state.seenIds.push(id);
                state.errors.push({
                    page: state.page + 1,
                    jobId: id,
                    title: meta.title || '',
                    reason: e?.message || String(e),
                    diagnostic: e?.diagnostic || null
                });

                debugLog('ERROR', 'job.inpage.failed', {
                    page: state.page + 1,
                    jobId: id,
                    title: meta.title,
                    consecutiveFailures,
                    error: serializeForLog(e),
                    diagnostic: e?.diagnostic || null
                });

                if (consecutiveFailures >= CONFIG.maxConsecutivePaneFailures) {
                    saveState(state);
                    throw new Error(
                        `${consecutiveFailures} consecutive LinkedIn job panes failed to load. ` +
                        `Stopping to avoid a retry cascade.`
                    );
                }
            }

            saveState(state);
            updateProgress({
                completed: state.results.length + state.errors.length,
                total: estimatedTotal,
                startedAtMs: runStartedAtMs,
                running: true
            });
        }

        debugLog('INFO', 'page.process.end', {
            page: state.page + 1,
            added,
            totalResults: state.results.length,
            totalErrors: state.errors.length,
            elapsedMs: Math.round(performance.now() - started),
            architecture: 'in-page-card-click'
        });

        return added;
    }

    function currentStartOffset() {
        try { return parseInt(new URL(location.href).searchParams.get('start') || '0', 10) || 0; }
        catch { return 0; }
    }

    function makeBaseUrl() {
        const u = new URL(location.href);
        for (const key of ['currentJobId', 'start', 'eBP', 'refId', 'trackingId']) u.searchParams.delete(key);
        return u.toString();
    }

    function makePageUrl(state, page) {
        const u = new URL(state.baseUrl);
        const offset = state.startOffset + page * CONFIG.pageSize;
        if (offset > 0) u.searchParams.set('start', String(offset));
        else u.searchParams.delete('start');
        return u.toString();
    }

    function goPage(state, page) {
        const targetUrl = makePageUrl(state, page);
        debugLog('INFO', 'page.navigate', { fromPage: state.page + 1, toPage: page + 1, targetUrl });
        state.page = page;
        saveState(state);
        location.assign(targetUrl);
    }

    function buildTxt(state) {
        let out = `LINKEDIN JOB EXTRACTOR V${VERSION}\n\nDate: ${new Date().toLocaleString()}\nSuccessful jobs: ${state.results.length}\nSkipped jobs: ${state.errors.length}\n\n============================================================\n`;
        state.results.forEach((job, index) => {
            out += `\n\nJOB ${index + 1}\n\nTITLE\n${job.title || '-'}\n\nCOMPANY\n${job.company || '-'}\n\nLOCATION / WORK MODE\n${job.location || '-'}\n\nSALARY / COMPENSATION\n${job.salary || '-'}\n\nLINKEDIN INFO\n${job.linkedinInfo || '-'}\n\nJOB ID\n${job.jobId || '-'}\n\nURL\n${job.url || '-'}\n\nDESCRIPTION SOURCE\n${job.descriptionSource || '-'}\n\nFULL DESCRIPTION\n\n${job.description || '-'}\n\nCARD TEXT\n\n${job.cardText || '-'}\n\n============================================================\n`;
        });
        if (state.errors.length) {
            out += `\n\n============================================================\nSKIPPED JOBS\n============================================================\n`;
            state.errors.forEach((e, i) => {
                out += `\n\n${i + 1}. ${e.title || 'Job'} · ID ${e.jobId || '-'}\n\nPage: ${e.page || '-'}\nReason: ${e.reason || '-'}\n`;
            });
        }
        return out;
    }

    function buildJson(state) {
        return JSON.stringify({
            schemaVersion: 1,
            generator: APP.name,
            version: VERSION,
            exportedAt: new Date().toISOString(),
            jobs: state.results,
            skipped: state.errors
        }, null, 2);
    }

    function exportBaseName() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `linkedin_jobs_${stamp}`;
    }

    async function exportResults(state, format) {
        if (!state?.results?.length) {
            throw new Error('No results are available to save.');
        }

        const base = exportBaseName();
        const selected = ['txt', 'json', 'both'].includes(format) ? format : 'txt';

        if (selected === 'txt' || selected === 'both') {
            download(`${base}.txt`, buildTxt(state), 'text/plain;charset=utf-8');
        }

        if (selected === 'both') await sleep(250);

        if (selected === 'json' || selected === 'both') {
            download(`${base}.json`, buildJson(state), 'application/json;charset=utf-8');
        }

        debugLog('INFO', 'results.download', {
            format: selected,
            results: state.results.length,
            errors: state.errors.length
        });
    }

    async function finish(state) {
        const endedAt = new Date().toISOString();
        state.running = false;
        state.completedAt = endedAt;
        state.endedAt = endedAt;
        saveState(state);

        debugLog('INFO', 'run.finish', {
            results: state.results.length,
            errors: state.errors.length
        });

        const completed = state.results.length + state.errors.length;
        updateProgress({
            completed,
            total: completed,
            startedAtMs: Date.parse(state.createdAt) || Date.now(),
            finishedAtMs: Date.parse(endedAt) || Date.now(),
            running: false
        });
        stopProgressClock();
        setStatus(
            `Completed\n` +
            `${state.results.length} jobs ready · ${state.errors.length} skipped\n` +
            `Choose a format and click SAVE RESULTS`
        );
        refreshControls(state);
    }

    async function runPage() {
        if (RUNNING) return;
        RUNNING = true;
        STOP = false;
        let state = loadState();
        if (!state || !state.running) {
            RUNNING = false;
            refreshControls(state);
            return;
        }
        setPages(state.targetPages);
        refreshControls(state);

        try {
            const added = await processCurrentPage(state);
            state = loadState() || state;
            if (STOP || !state.running) { RUNNING = false; return; }

            if (state.page + 1 >= state.targetPages) {
                await finish(state);
                RUNNING = false;
                return;
            }

            const next = state.page + 1;
            setStatus(
                `Page ${state.page + 1}/${state.targetPages} completed\n` +
                `${added} new jobs\n` +
                `Opening page ${next + 1}/${state.targetPages}...`
            );
            await sleep(350);
            goPage(state, next);
        } catch (e) {
            const current = loadState() || state;
            current.running = false;
            current.endedAt = new Date().toISOString();
            saveState(current);
            debugLog('ERROR', e?.fatal ? 'run.safety_stop' : 'runPage.fatal', {
                page: current?.page + 1 || null,
                error: serializeForLog(e)
            });
            stopProgressClock();
            setStatus(
                `${e?.fatal ? 'SAFETY STOP' : 'ERROR'}\n\n${e?.message || String(e)}\n\n` +
                `Results preserved: ${current?.results?.length || 0}\n` +
                'Download the DEBUG LOG for diagnostics.'
            );
            RUNNING = false;
            refreshControls(current);
        }
    }

    async function startNew() {
        if (RUNNING) return;
        resetDebugLogForNewRun();
        clearState();
        STOP = false;
        const state = {
            schemaVersion: 1,
            sessionId: SESSION_ID,
            createdAt: new Date().toISOString(),
            running: true,
            baseUrl: makeBaseUrl(),
            startOffset: currentStartOffset(),
            page: 0,
            targetPages: getPages(),
            results: [],
            seenIds: [],
            errors: []
        };
        saveState(state);
        refreshControls(state);
        resetProgressUi();
        startProgressClock(Date.parse(state.createdAt) || Date.now());
        updateProgress({
            completed: 0,
            total: 0,
            startedAtMs: Date.parse(state.createdAt) || Date.now(),
            running: true
        });
        debugLog('INFO', 'run.start.requested', {
            requestedPages: state.targetPages,
            startUrl: diagnosticUrl(),
            architecture: 'in-page-card-click',
            paneTimeout: CONFIG.paneTimeout
        });
        refreshControls(state);
        await runPage();
    }

    function stopRun() {
        STOP = true;
        const state = loadState();
        if (state) {
            state.running = false;
            state.endedAt = new Date().toISOString();
            try {
                saveState(state);
            } catch (error) {
                console.error(`${APP.logPrefix} could not persist STOP state`, error);
            }
        }
        debugLog('WARN', 'run.stop.requested', { results: state?.results?.length || 0, errors: state?.errors?.length || 0 });
        stopProgressClock();
        setStatus('Stopped.\nCollected results remain available.');
        RUNNING = false;
        refreshControls(state);
    }

    function resetRun() {
        STOP = true;
        clearState();
        RUNNING = false;
        setPages(1);
        resetProgressUi();
        debugLog('INFO', 'run.reset');
        setStatus('Ready.');
        refreshControls(null);
    }

    function restoreActiveRun() {
        const state = loadState();
        if (!state?.running) return;
        debugLog('INFO', 'run.resume.after_navigation', { page: state.page + 1, targetPages: state.targetPages });
        setPages(state.targetPages);
        refreshControls(state);
        startProgressClock(Date.parse(state.createdAt) || Date.now());
        updateProgress({
            completed: state.results.length + state.errors.length,
            total: Math.min(CONFIG.maxJobs, state.targetPages * CONFIG.pageSize),
            startedAtMs: Date.parse(state.createdAt) || Date.now(),
            running: true
        });
        setTimeout(() => runDetached('resume-after-navigation', runPage), 250);
    }

    function restoreIdleRun() {
        const state = loadState();
        if (!state || state.running) {
            refreshControls(state);
            return;
        }

        const completed = (state.results?.length || 0) + (state.errors?.length || 0);
        if (!completed) {
            refreshControls(state);
            return;
        }

        const endedAtMs = Date.parse(state.endedAt || state.completedAt || '') || Date.now();
        updateProgress({
            completed,
            total: completed,
            startedAtMs: Date.parse(state.createdAt) || endedAtMs,
            finishedAtMs: endedAtMs,
            running: false
        });
        stopProgressClock();

        if (state.completedAt) {
            setStatus(
                `Completed\n` +
                `${state.results.length} jobs ready · ${state.errors.length} skipped\n` +
                `Choose a format and click SAVE RESULTS`
            );
        } else {
            setStatus(
                `Previous extraction stopped\n` +
                `${state.results.length} results available`
            );
        }

        refreshControls(state);
    }

    window.addEventListener('error', event => {
        const msg = String(event?.message || '');
        if (/Minified React error #418/i.test(msg)) return;
        debugLog('ERROR', 'window.error', { message: msg, filename: event?.filename || '', lineno: event?.lineno || 0 });
    });

    window.addEventListener('unhandledrejection', event => {
        const reason = event?.reason;
        const msg = String(reason?.message || reason || '');
        if (/Minified React error #418/i.test(msg)) return;
        debugLog('ERROR', 'window.unhandledrejection', serializeForLog(reason));
    });

    function boot() {
        createPanel();
        debugLog('INFO', 'boot', { version: VERSION, href: diagnosticUrl(), architecture: 'in-page-card-click' });
        restoreIdleRun();
        restoreActiveRun();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();