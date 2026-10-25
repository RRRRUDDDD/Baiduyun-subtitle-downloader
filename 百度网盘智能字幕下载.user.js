// ==UserScript==
// @name         百度网盘智能字幕下载
// @namespace    http://github.com/lihaoze123/Baiduyun-subtitle-downloader
// @version      0.7.0
// @description  下载百度网盘视频的智能字幕（SRT），支持单个视频与文件夹批量提取，保存目录可自选
// @match        *://pan.baidu.com/*
// @grant        GM_download
// @connect      baidupcs.com
// @license      GPL3
// @downloadURL https://update.greasyfork.org/scripts/501784/%E7%99%BE%E5%BA%A6%E7%BD%91%E7%9B%98%E6%99%BA%E8%83%BD%E5%AD%97%E5%B9%95%E4%B8%8B%E8%BD%BD.user.js
// @updateURL https://update.greasyfork.org/scripts/501784/%E7%99%BE%E5%BA%A6%E7%BD%91%E7%9B%98%E6%99%BA%E8%83%BD%E5%AD%97%E5%B9%95%E4%B8%8B%E8%BD%BD.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://pan.baidu.com';
    const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|webm|m4v|rmvb|rm|ts|m2ts|mpg|mpeg|3gp|ogv)$/i;
    const CONCURRENCY = 3;
    const RESULT_DELAY = 400;
    const HOST_ID = 'bdy-subtitle-helper';
    const ENTRY_ID = 'bdy-subtitle-entry';
    const ENTRY_WRAP_ID = 'bdy-subtitle-entry-wrap';
    const FALLBACK_ID = 'bdy-subtitle-fallback';
    // 未选择自定义文件夹时，保存到浏览器下载目录下的这个子目录。
    const SAVE_FOLDER = '百度网盘字幕';
    const DB_NAME = 'bdy-subtitle-helper';
    const DB_STORE = 'settings';
    const DIR_KEY = 'custom-dir';
    let customDir = null;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    let bdstokenPromise = null;

    function getBdstoken(force = false) {
        if (!bdstokenPromise || force) {
            bdstokenPromise = fetch(`${API_BASE}/api/loginStatus?clienttype=0&app_id=250528&web=1`, {
                credentials: 'include',
            })
                .then(res => res.json())
                .then(json => {
                    const token = json && json.login_info && json.login_info.bdstoken;
                    if (!token) throw new Error('未获取到登录状态，请先登录百度网盘');
                    return token;
                })
                .catch(err => {
                    bdstokenPromise = null;
                    throw err;
                });
        }
        return bdstokenPromise;
    }

    async function apiGet(path, params, retry = true) {
        const token = await getBdstoken();
        const query = new URLSearchParams({
            ...params,
            clienttype: '0',
            app_id: '250528',
            web: '1',
            channel: 'chunlei',
            bdstoken: token,
        });
        const res = await fetch(`${API_BASE}${path}?${query}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`接口请求失败 (HTTP ${res.status})`);
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return text;
        }
        if (data && data.errno === -6 && retry) {
            await getBdstoken(true);
            return apiGet(path, params, false);
        }
        return data;
    }

    async function streamingRequest(path, retry = true) {
        const token = await getBdstoken();
        const query = new URLSearchParams({
            app_id: '250528',
            clienttype: '0',
            channel: 'chunlei',
            web: '1',
            isplayer: '1',
            check_blue: '1',
            bdstoken: token,
            path,
            vip: '2',
            jsToken: window.jsToken || '',
            type: 'M3U8_SUBTITLE_SRT',
            trans: '',
        });
        const res = await fetch(`${API_BASE}/api/streaming?${query}`, { credentials: 'include' });
        const text = await res.text();
        if (text.trim().startsWith('{')) {
            let json = {};
            try {
                json = JSON.parse(text);
            } catch (e) {
                // 保持空对象，交给下面统一报错
            }
            if (json.errno === -6 && retry) {
                await getBdstoken(true);
                return streamingRequest(path, false);
            }
            throw new Error(json.show_msg || `字幕接口返回错误 (${json.errno})`);
        }
        if (!res.ok) throw new Error(`字幕接口请求失败 (HTTP ${res.status})`);
        return text;
    }

    function subtitleFileName(fn, videoPath) {
        let base = fn || decodeURIComponent(videoPath.split('/').pop() || '');
        base = base.replace(/\.[^./\\]+$/, '');
        base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[.\s]+$/, '');
        if (!base) base = 'subtitle';
        return `${base}.srt`;
    }

    function sanitizeSegment(text) {
        return String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[.\s]+$/, '');
    }

    function folderOfPath(path) {
        return path.split('/').slice(-2, -1)[0] || '';
    }

    function downloadName(subtitle, videoPath) {
        const dir = [SAVE_FOLDER, sanitizeSegment(folderOfPath(videoPath))].filter(Boolean).join('/');
        return [dir, subtitle.fileName].filter(Boolean).join('/');
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function idbRequest(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function loadDirHandle() {
        const db = await openDb();
        try {
            return await idbRequest(db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DIR_KEY));
        } finally {
            db.close();
        }
    }

    async function storeDirHandle(handle) {
        const db = await openDb();
        try {
            await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(handle, DIR_KEY));
        } finally {
            db.close();
        }
    }

    async function clearDirHandle() {
        const db = await openDb();
        try {
            await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(DIR_KEY));
        } finally {
            db.close();
        }
    }

    async function writableCustomDir() {
        if (!customDir) return null;
        const opts = { mode: 'readwrite' };
        let permission = await customDir.queryPermission(opts);
        // 页面刷新后权限会退回 prompt，需要在用户点击动作里重新申请
        if (permission !== 'granted' && typeof customDir.requestPermission === 'function') {
            permission = await customDir.requestPermission(opts);
        }
        if (permission === 'granted') return customDir;
        throw new Error('自定义文件夹没有写入权限，请重新选择文件夹');
    }

    async function saveToCustomDir(subtitle) {
        const dir = await writableCustomDir();
        const res = await fetch(subtitle.url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`字幕文件下载失败 (HTTP ${res.status})`);
        const data = await res.arrayBuffer();
        if (!data.byteLength) throw new Error('字幕内容为空');
        const target = await dir.getFileHandle(subtitle.fileName, { create: true });
        const writable = await target.createWritable();
        await writable.write(data);
        await writable.close();
    }

    function extractSubtitle(m3u8, videoPath) {
        const lines = m3u8.split(/\r?\n/).map(line => line.trim());
        const urls = lines.filter(line => /^https?:\/\//i.test(line));
        const url = urls.filter(line => /\/netdisk-subtitle\//i.test(line)).pop() || urls.pop();
        if (!url) throw new Error('该视频暂无智能字幕');
        let fn = '';
        try {
            fn = new URL(url).searchParams.get('fn') || '';
        } catch (e) {
            // 解析失败时退回视频文件名
        }
        return { url, fileName: subtitleFileName(fn, videoPath) };
    }

    async function getSubtitleForPath(path) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const m3u8 = await streamingRequest(path);
                return extractSubtitle(m3u8, path);
            } catch (err) {
                lastError = err;
                if (/暂无智能字幕/.test(err.message)) throw err;
                await sleep(600 * (attempt + 1));
            }
        }
        throw lastError;
    }

    async function listVideos(dir) {
        const videos = [];
        const pageSize = 1000;
        for (let page = 1; page <= 50; page++) {
            const data = await apiGet('/api/list', {
                dir,
                order: 'name',
                desc: '0',
                num: String(pageSize),
                page: String(page),
            });
            if (!data || data.errno !== 0) {
                const reason = data && (data.show_msg || data.errno);
                throw new Error(`读取目录失败${reason ? `：${reason}` : ''}`);
            }
            const list = data.list || [];
            for (const item of list) {
                if (item.isdir) continue;
                const name = item.server_filename || '';
                if (item.category !== 1 && !VIDEO_EXT_RE.test(name)) continue;
                videos.push({
                    name,
                    fs_id: item.fs_id,
                    path: `${dir.replace(/\/+$/, '')}/${name}`,
                });
            }
            if (list.length < pageSize) break;
        }
        return videos;
    }

    function anchorDownloadBlob(blob, fileName) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    }

    function anchorDownload(text, fileName) {
        anchorDownloadBlob(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }), fileName);
    }

    let crcTable = null;

    function crc32(bytes) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                crcTable[i] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
            crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function buildZip(files) {
        const encoder = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;
        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const data = file.data;
            const crc = crc32(data);

            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true);
            lv.setUint16(8, 0, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nameBytes.length, true);
            local.set(nameBytes, 30);
            parts.push(local, data);

            const cd = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(cd.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint32(42, offset, true);
            cd.set(nameBytes, 46);
            central.push(cd);

            offset += local.length + data.length;
        }
        const centralSize = central.reduce((sum, item) => sum + item.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }

    function zipFileName(dir) {
        const base = dir.split('/').filter(Boolean).pop() || '字幕';
        return `${base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}_字幕.zip`;
    }

    function gmDownload(url, fileName) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (err) => {
                if (done) return;
                done = true;
                if (err) reject(err);
                else resolve();
            };
            try {
                GM_download({
                    url,
                    name: fileName,
                    saveAs: false,
                    onload: () => finish(),
                    onerror: err => finish(new Error((err && err.error) || '下载失败')),
                    ontimeout: () => finish(new Error('下载超时')),
                });
                // 部分管理器成功时不会触发 onload，避免批次被单个任务卡住
                setTimeout(() => finish(), 20000);
            } catch (err) {
                finish(err);
            }
        });
    }

    async function saveSubtitle(subtitle, videoPath) {
        if (customDir) {
            await saveToCustomDir(subtitle);
            return;
        }
        if (typeof GM_download === 'function') {
            try {
                await gmDownload(subtitle.url, downloadName(subtitle, videoPath));
                return;
            } catch (err) {
                // 某些管理器不允许 name 带子目录，退回下载目录根部，仍保持静默
                console.warn('[百度网盘字幕] 指定子目录失败，改为下载目录根部', err);
            }
            await gmDownload(subtitle.url, subtitle.fileName);
            return;
        }
        const res = await fetch(subtitle.url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`字幕文件下载失败 (HTTP ${res.status})`);
        const text = await res.text();
        if (!text.trim()) throw new Error('字幕内容为空');
        anchorDownload(text, subtitle.fileName);
    }

    async function runBatch(videos, hooks, save) {
        const queue = videos.slice();
        const results = [];
        const workerCount = Math.min(CONCURRENCY, queue.length);
        const worker = async () => {
            while (queue.length) {
                if (hooks.isCancelled()) break;
                const video = queue.shift();
                let outcome;
                try {
                    const subtitle = await getSubtitleForPath(video.path);
                    await save(subtitle, video);
                    outcome = { ok: true, file: subtitle.fileName, video };
                } catch (err) {
                    outcome = { ok: false, reason: err.message || String(err), video };
                }
                results.push(outcome);
                hooks.onResult(results.length, videos.length, outcome);
                await sleep(RESULT_DELAY);
            }
        };
        await Promise.all(Array.from({ length: workerCount }, worker));
        return { cancelled: hooks.isCancelled(), results };
    }

    function getPathFromUrl() {
        const fromSearch = new URLSearchParams(location.search).get('path');
        if (fromSearch) return fromSearch;
        const hash = location.hash || '';
        const queryIndex = hash.indexOf('?');
        if (queryIndex >= 0) {
            const fromHash = new URLSearchParams(hash.slice(queryIndex + 1)).get('path');
            if (fromHash) return fromHash;
        }
        return null;
    }

    function getPageContext() {
        const path = getPathFromUrl();
        if (!path || path === '/') return null;
        const isVideoPage = /^\/pfile\/video/.test(location.pathname) || /^\/play\/video/.test(location.pathname);
        if (isVideoPage) {
            return { mode: 'video', path, name: path.split('/').pop() || path };
        }
        const isDiskPage = /^\/disk\/(main|home)/.test(location.pathname) || location.hash.includes('/index');
        if (isDiskPage) {
            return { mode: 'folder', path, name: path.split('/').pop() || path };
        }
        return null;
    }

    const ui = {
        host: null,
        root: null,
        panel: null,
        fallbackBtn: null,
        entryBtn: null,
        anchorEl: null,
        ctxNameEl: null,
        ctxMetaEl: null,
        saveRow: null,
        savePathEl: null,
        pickDirBtn: null,
        resetDirBtn: null,
        actionBtn: null,
        actionLabel: null,
        cancelBtn: null,
        copyBtn: null,
        toolbarEl: null,
        statsEl: null,
        statOk: null,
        statNo: null,
        statErr: null,
        statusEl: null,
        progressEl: null,
        progressBar: null,
        progressText: null,
        logEl: null,
        context: null,
        running: false,
        cancelRequested: false,
        countRequestId: 0,
        problems: [],
    };

    let countCache = { dir: '', count: 0, time: 0 };
    let entryTimer = 0;
    let dirTouched = false;

    function saveHint(folderName) {
        if (customDir) return `自定义文件夹：${customDir.name}/`;
        if (typeof GM_download !== 'function') return '未检测到 Tampermonkey，批量时将打包为 ZIP';
        const dir = [SAVE_FOLDER, sanitizeSegment(folderName)].filter(Boolean).join('/');
        return `下载目录/${dir}/`;
    }

    function currentFolderName() {
        if (!ui.context) return '';
        return ui.context.mode === 'video' ? folderOfPath(ui.context.path) : ui.context.name;
    }

    function updateSaveHint() {
        if (!ui.savePathEl || !ui.context) return;
        ui.savePathEl.textContent = saveHint(currentFolderName());
        ui.saveRow.classList.toggle('warn', !customDir && typeof GM_download !== 'function');
        ui.saveRow.title = customDir ? '出于隐私限制，网页只能获取文件夹名称' : '';
        ui.pickDirBtn.textContent = customDir ? '更换文件夹' : '选择文件夹';
        ui.resetDirBtn.classList.toggle('hidden', !customDir);
        const supported = typeof window.showDirectoryPicker === 'function';
        ui.pickDirBtn.disabled = ui.running || !supported;
        ui.pickDirBtn.title = supported ? '' : '当前浏览器不支持选择文件夹';
        ui.resetDirBtn.disabled = ui.running;
    }

    async function chooseCustomDir() {
        if (ui.running) return;
        if (typeof window.showDirectoryPicker !== 'function') {
            setStatus('当前浏览器不支持选择文件夹，请使用 Chrome 或 Edge', 'err');
            return;
        }
        let handle = null;
        try {
            handle = await window.showDirectoryPicker({ id: 'bdy-subtitle', mode: 'readwrite', startIn: 'downloads' });
        } catch (err) {
            if (!err || err.name !== 'AbortError') setStatus(`选择文件夹失败：${(err && err.message) || err}`, 'err');
            return;
        }
        try {
            if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted'
                && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
                setStatus('未获得文件夹写入权限', 'err');
                return;
            }
        } catch (e) {
            setStatus('未获得文件夹写入权限', 'err');
            return;
        }
        dirTouched = true;
        customDir = handle;
        try {
            await storeDirHandle(handle);
        } catch (e) {
            // 无法持久化时只对当前页面生效
        }
        updateSaveHint();
        setStatus(`已选择文件夹：${handle.name}`, 'ok');
    }

    async function resetCustomDir() {
        if (ui.running) return;
        dirTouched = true;
        customDir = null;
        try {
            await clearDirHandle();
        } catch (e) {
            // 忽略存储错误
        }
        updateSaveHint();
        setStatus('已恢复默认保存位置', 'ok');
    }

    async function restoreCustomDir() {
        if (typeof window.showDirectoryPicker !== 'function') return;
        try {
            const handle = await loadDirHandle();
            if (dirTouched) return;
            if (!handle || typeof handle.queryPermission !== 'function') return;
            customDir = handle;
            updateSaveHint();
        } catch (e) {
            // IndexedDB 不可用时保持默认
        }
    }

    function setStatus(text, kind) {
        if (!ui.statusEl) return;
        ui.statusEl.textContent = text || '';
        ui.statusEl.dataset.kind = kind || '';
    }

    function setProgress(done, total, text) {
        if (!ui.progressEl) return;
        ui.progressEl.classList.toggle('hidden', !total);
        const percent = total ? Math.round((done / total) * 100) : 0;
        ui.progressBar.style.width = `${percent}%`;
        ui.progressText.textContent = text || `已完成 ${done} / ${total}（${percent}%）`;
    }

    function setStats(stats, visible) {
        if (!ui.statsEl) return;
        ui.statsEl.classList.toggle('hidden', !visible);
        if (!visible) return;
        ui.statOk.textContent = String(stats.ok);
        ui.statNo.textContent = String(stats.noSubtitle);
        ui.statErr.textContent = String(stats.failed);
    }

    function updateToolbar() {
        if (!ui.toolbarEl) return;
        const showCancel = ui.running && ui.context && ui.context.mode === 'folder';
        const showCopy = !ui.running && ui.problems.length > 0;
        ui.cancelBtn.classList.toggle('hidden', !showCancel);
        ui.copyBtn.classList.toggle('hidden', !showCopy);
        ui.toolbarEl.classList.toggle('hidden', !showCancel && !showCopy);
    }

    async function copyProblems() {
        if (!ui.problems.length) return;
        const text = ui.problems.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            setStatus('问题列表已复制', 'ok');
        } catch (err) {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(area);
            area.select();
            try {
                document.execCommand('copy');
                setStatus('问题列表已复制', 'ok');
            } catch (e) {
                setStatus('复制失败，请手动选择日志', 'err');
            }
            area.remove();
        }
    }

    function addLog(text, kind) {
        if (!ui.logEl) return;
        const row = document.createElement('div');
        row.className = `log-item ${kind || ''}`;
        row.textContent = text;
        row.title = text;
        ui.logEl.prepend(row);
        while (ui.logEl.children.length > 50) ui.logEl.lastElementChild.remove();
    }

    function clearLog() {
        if (ui.logEl) ui.logEl.textContent = '';
    }

    function restoreActionLabel() {
        if (!ui.actionLabel || !ui.context) return;
        ui.actionLabel.textContent = ui.context.mode === 'video' ? '下载本视频字幕' : '批量下载字幕';
    }

    function setRunning(running) {
        ui.running = running;
        if (ui.actionBtn) {
            ui.actionBtn.disabled = running;
            ui.actionBtn.classList.toggle('loading', running);
        }
        if (running) {
            ui.cancelRequested = false;
            ui.problems = [];
            if (ui.actionLabel) ui.actionLabel.textContent = '正在获取字幕…';
            if (ui.cancelBtn) {
                ui.cancelBtn.disabled = false;
                ui.cancelBtn.textContent = '取消';
            }
        } else {
            restoreActionLabel();
        }
        updateToolbar();
        updateSaveHint();
    }

    async function refreshFolderCount(force = false) {
        if (!ui.context || ui.context.mode !== 'folder') return;
        const dir = ui.context.path;
        if (!force && countCache.dir === dir && Date.now() - countCache.time < 60000) {
            if (ui.ctxMetaEl) ui.ctxMetaEl.textContent = `共 ${countCache.count} 个视频`;
            return;
        }
        const requestId = ++ui.countRequestId;
        if (ui.ctxMetaEl) ui.ctxMetaEl.textContent = '正在统计视频数量…';
        try {
            const videos = await listVideos(dir);
            if (requestId !== ui.countRequestId) return;
            countCache = { dir, count: videos.length, time: Date.now() };
            if (ui.ctxMetaEl) ui.ctxMetaEl.textContent = `共 ${videos.length} 个视频`;
        } catch (err) {
            if (requestId !== ui.countRequestId) return;
            if (ui.ctxMetaEl) ui.ctxMetaEl.textContent = err.message;
        }
    }

    function refreshContext() {
        if (!ui.host) return;
        const previous = ui.context;
        const context = getPageContext();
        const changed = !previous || !context || previous.mode !== context.mode || previous.path !== context.path;
        ui.context = context;
        if (changed) closePanel();
        ensureEntryButton();
        if (!context) {
            closePanel();
            return;
        }
        if (ui.running) return;
        ui.progressEl.classList.add('hidden');
        setStats({ ok: 0, noSubtitle: 0, failed: 0 }, false);
        ui.problems = [];
        clearLog();
        setStatus('');
        if (context.mode === 'video') {
            ui.ctxNameEl.textContent = context.name;
            ui.ctxMetaEl.textContent = '视频播放页';
            ui.actionLabel.textContent = '下载本视频字幕';
        } else {
            ui.ctxNameEl.textContent = context.name;
            ui.ctxMetaEl.textContent = '正在统计视频数量…';
            ui.actionLabel.textContent = '批量下载字幕';
            if (!ui.panel.classList.contains('hidden')) refreshFolderCount();
        }
        updateSaveHint();
        updateToolbar();
    }

    function closePanel() {
        if (!ui.panel) return;
        ui.panel.classList.add('hidden');
        ui.anchorEl = null;
    }

    function positionPanel() {
        if (!ui.anchorEl || !ui.panel || ui.panel.classList.contains('hidden')) return;
        if (!ui.anchorEl.isConnected) {
            closePanel();
            return;
        }
        const rect = ui.anchorEl.getBoundingClientRect();
        const width = ui.panel.offsetWidth;
        const height = ui.panel.offsetHeight;
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const left = Math.min(Math.max(margin, rect.right - width), maxLeft);
        let top = rect.bottom + 8;
        if (top + height > window.innerHeight - margin) top = rect.top - height - 8;
        top = Math.max(margin, top);
        ui.host.style.left = `${Math.round(left)}px`;
        ui.host.style.top = `${Math.round(top)}px`;
    }

    function togglePanel(anchor) {
        if (!ui.panel.classList.contains('hidden')) {
            closePanel();
            return;
        }
        ui.anchorEl = anchor || ui.entryBtn;
        ui.panel.classList.remove('hidden');
        positionPanel();
        requestAnimationFrame(positionPanel);
        if (ui.context && ui.context.mode === 'folder' && !ui.running) refreshFolderCount();
    }

    function entryIconHtml() {
        return '<i class="bdy-sub-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h4M7 15h7M14 11h3"/></svg></i><span>字幕</span>';
    }

    function ensurePageStyles() {
        if (document.getElementById('bdy-subtitle-style')) return;
        const style = document.createElement('style');
        style.id = 'bdy-subtitle-style';
        style.textContent = `
            #bdy-subtitle-entry { white-space: nowrap; }
            #bdy-subtitle-entry .bdy-sub-icon {
                display: inline-block;
                width: 16px;
                height: 16px;
                margin-right: 6px;
                vertical-align: -3px;
                font-style: normal;
            }
            #bdy-subtitle-entry .bdy-sub-icon svg { display: block; width: 100%; height: 100%; }
            #bdy-subtitle-entry.vp-toolsbar__tools-btn .bdy-sub-icon { width: 15px; height: 15px; vertical-align: -2px; }
            #bdy-subtitle-fallback {
                position: fixed;
                right: 24px;
                bottom: 24px;
                z-index: 2147483646;
                height: 34px;
                padding: 0 18px;
                border: none;
                border-radius: 17px;
                background: #06a7ff;
                color: #fff;
                font: 700 13px/1 SFUIText, "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
                display: inline-flex;
                align-items: center;
                cursor: pointer;
                box-shadow: 0 4px 16px rgba(6, 167, 255, .35);
            }
            #bdy-subtitle-fallback:hover { background: #0597e6; }
            #bdy-subtitle-fallback.hidden { display: none; }
            #bdy-subtitle-fallback .bdy-sub-icon {
                display: inline-flex;
                width: 16px;
                height: 16px;
                margin-right: 6px;
                font-style: normal;
            }
            #bdy-subtitle-fallback .bdy-sub-icon svg { width: 100%; height: 100%; }
        `;
        document.head.appendChild(style);
    }

    function visibleElements(selector) {
        return [...document.querySelectorAll(selector)].filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    function findNoteButton() {
        return visibleElements('button[title="新建笔记"]')[0] || null;
    }

    function findVideoDownloadButton() {
        return visibleElements('button.vp-toolsbar__tools-btn[title="下载"]')[0] || null;
    }

    function createEntryButton(mode, anchor) {
        ensurePageStyles();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = ENTRY_ID;
        btn.className = anchor.className;
        btn.title = '字幕';
        const style = anchor.getAttribute('style');
        if (style) btn.setAttribute('style', style);
        btn.dataset.mode = mode;
        btn.innerHTML = entryIconHtml();
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            togglePanel(btn);
        });
        if (mode === 'folder') {
            const action = anchor.closest('.wp-s-agile-tool-bar__h-action');
            const wrap = document.createElement('div');
            wrap.id = ENTRY_WRAP_ID;
            wrap.className = action ? action.className : '';
            wrap.appendChild(btn);
            if (action && action.parentElement) action.after(wrap);
            else anchor.after(wrap);
        } else {
            anchor.after(btn);
        }
        return btn;
    }

    function removeEntryButton() {
        const wrap = document.getElementById(ENTRY_WRAP_ID);
        if (wrap) wrap.remove();
        const btn = document.getElementById(ENTRY_ID);
        if (btn) btn.remove();
        ui.entryBtn = null;
    }

    function showFallback() {
        ensurePageStyles();
        if (!ui.fallbackBtn) {
            const btn = document.createElement('button');
            btn.id = FALLBACK_ID;
            btn.type = 'button';
            btn.title = '下载字幕';
            btn.innerHTML = entryIconHtml();
            btn.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                togglePanel(btn);
            });
            document.body.appendChild(btn);
            ui.fallbackBtn = btn;
        }
        ui.fallbackBtn.classList.remove('hidden');
        ui.entryBtn = ui.fallbackBtn;
    }

    function hideFallback() {
        if (ui.fallbackBtn) ui.fallbackBtn.classList.add('hidden');
    }

    function ensureEntryButton() {
        if (!ui.host) return;
        const mode = ui.context && ui.context.mode;
        if (!mode) {
            removeEntryButton();
            hideFallback();
            return;
        }
        const anchor = mode === 'folder' ? findNoteButton() : findVideoDownloadButton();
        if (!anchor) {
            removeEntryButton();
            showFallback();
            return;
        }
        hideFallback();
        const existing = document.getElementById(ENTRY_ID);
        if (existing && existing.isConnected && existing.dataset.mode === mode) {
            ui.entryBtn = existing;
            return;
        }
        removeEntryButton();
        ui.entryBtn = createEntryButton(mode, anchor);
    }

    async function downloadCurrentVideo() {
        if (ui.running || !ui.context || ui.context.mode !== 'video') return;
        const context = ui.context;
        if (customDir) {
            try {
                await writableCustomDir();
            } catch (err) {
                setStatus(err.message, 'err');
                return;
            }
        }
        setRunning(true);
        setStatus('正在获取字幕地址…');
        try {
            const subtitle = await getSubtitleForPath(context.path);
            setStatus(`正在保存：${subtitle.fileName}`);
            await saveSubtitle(subtitle, context.path);
            setStatus(`已保存：${subtitle.fileName}`, 'ok');
        } catch (err) {
            setStatus(err.message, 'err');
            addLog(err.message, 'err');
        } finally {
            setRunning(false);
        }
    }

    async function startBatch() {
        if (ui.running || !ui.context || ui.context.mode !== 'folder') return;
        if (customDir) {
            try {
                await writableCustomDir();
            } catch (err) {
                setStatus(err.message, 'err');
                return;
            }
        }
        const dir = ui.context.path;
        const useZip = !customDir && typeof GM_download !== 'function';
        const zipEntries = [];
        const save = async (subtitle, video) => {
            if (customDir) {
                await saveToCustomDir(subtitle);
                return;
            }
            if (!useZip) {
                await saveSubtitle(subtitle, video.path);
                return;
            }
            const res = await fetch(subtitle.url, { credentials: 'omit' });
            if (!res.ok) throw new Error(`字幕文件下载失败 (HTTP ${res.status})`);
            const data = new Uint8Array(await res.arrayBuffer());
            if (!data.length) throw new Error('字幕内容为空');
            zipEntries.push({ name: subtitle.fileName, data });
        };
        setRunning(true);
        clearLog();
        ui.problems = [];
        setStats({ ok: 0, noSubtitle: 0, failed: 0 }, true);
        setStatus('正在读取目录…');
        setProgress(0, 0, '');
        ui.ctxMetaEl.textContent = '正在读取目录…';
        let ok = 0;
        let failed = 0;
        let noSubtitle = 0;
        try {
            const videos = await listVideos(dir);
            countCache = { dir, count: videos.length, time: Date.now() };
            ui.ctxMetaEl.textContent = `共 ${videos.length} 个视频`;
            if (!videos.length) {
                setStatus('当前文件夹没有视频', 'err');
                return;
            }
            setStatus(`开始获取 ${videos.length} 个字幕…`);
            setProgress(0, videos.length);
            const result = await runBatch(
                videos,
                {
                    isCancelled: () => ui.cancelRequested,
                    onResult: (done, total, outcome) => {
                        if (outcome.ok) {
                            ok++;
                            addLog(`${useZip ? '已获取' : '已保存'}：${outcome.file}`, 'ok');
                        } else if (/暂无智能字幕/.test(outcome.reason)) {
                            noSubtitle++;
                            ui.problems.push(`无字幕：${outcome.video.name}`);
                            addLog(`无字幕：${outcome.video.name}`, 'warn');
                        } else {
                            failed++;
                            ui.problems.push(`失败：${outcome.video.name}（${outcome.reason}）`);
                            addLog(`失败：${outcome.video.name}（${outcome.reason}）`, 'err');
                        }
                        setStats({ ok, noSubtitle, failed }, true);
                        setProgress(done, total);
                        updateToolbar();
                    },
                },
                save
            );
            let summary = `成功 ${ok}，无字幕 ${noSubtitle}，失败 ${failed}`;
            if (useZip && zipEntries.length) {
                setStatus(`正在打包 ${zipEntries.length} 个字幕…`);
                const fileName = zipFileName(dir);
                anchorDownloadBlob(buildZip(zipEntries), fileName);
                summary += `，已打包为 ${fileName}`;
            }
            if (result.cancelled) {
                setStatus(`已取消（${summary}）`, 'warn');
            } else {
                setStatus(`完成：${summary}`, failed ? 'warn' : 'ok');
            }
        } catch (err) {
            setStatus(err.message, 'err');
            addLog(err.message, 'err');
        } finally {
            setRunning(false);
        }
    }

    function mountUI() {
        if (document.getElementById(HOST_ID)) return;
        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;';
        document.documentElement.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { all: initial; }
                * { box-sizing: border-box; }
                .panel {
                    width: 344px;
                    max-width: calc(100vw - 24px);
                    max-height: calc(100vh - 24px);
                    display: flex;
                    flex-direction: column;
                    background: #fff;
                    border: 1px solid rgba(0, 0, 0, .05);
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, .14);
                    font-family: SFUIText, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
                    font-size: 13px;
                    line-height: 1.5;
                    color: #333;
                    overflow: hidden;
                    animation: bdy-pop .16s ease-out;
                }
                .panel.hidden { display: none; }
                @keyframes bdy-pop {
                    from { opacity: 0; transform: translateY(-4px); }
                    to { opacity: 1; transform: none; }
                }
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 13px 16px 10px;
                }
                .title { font-size: 15px; font-weight: 600; color: #1a1a1a; }
                .close {
                    width: 24px;
                    height: 24px;
                    padding: 0;
                    border: none;
                    border-radius: 4px;
                    background: transparent;
                    color: #999;
                    cursor: pointer;
                    display: grid;
                    place-items: center;
                }
                .close:hover { background: #f2f3f5; color: #666; }
                .close svg { width: 14px; height: 14px; }
                .body { padding: 0 16px 16px; overflow-y: auto; }
                .body::-webkit-scrollbar { width: 6px; }
                .body::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 3px; }
                .context { background: #f7f8fa; border-radius: 8px; padding: 10px 12px; }
                .ctx-name {
                    font-size: 13px;
                    font-weight: 600;
                    line-height: 1.45;
                    color: #1a1a1a;
                    word-break: break-all;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .ctx-meta { margin-top: 2px; color: #999; font-size: 12px; }
                .save-row {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 10px;
                    color: #8c8c8c;
                    font-size: 12px;
                    line-height: 1.5;
                }
                .save-row .folder-icon {
                    width: 13px;
                    height: 13px;
                    flex: 0 0 auto;
                    opacity: .7;
                }
                .save-path { flex: 1; word-break: break-all; }
                .save-row.warn { color: #d97706; }
                .save-actions { flex: 0 0 auto; display: flex; gap: 8px; margin-left: 2px; }
                .save-actions button {
                    padding: 0;
                    border: none;
                    background: none;
                    color: #06a7ff;
                    font: inherit;
                    font-size: 12px;
                    line-height: 1.5;
                    cursor: pointer;
                }
                .save-actions button:hover:not(:disabled) { color: #0597e6; }
                .save-actions button.hidden { display: none; }
                .save-actions button:disabled { color: #c0c4cc; cursor: default; }
                .save-actions .reset-dir { color: #8c8c8c; }
                .save-actions .reset-dir:hover:not(:disabled) { color: #666; }
                .action {
                    margin-top: 14px;
                    width: 100%;
                    height: 34px;
                    padding: 0;
                    border: none;
                    border-radius: 17px;
                    background: #06a7ff;
                    color: #fff;
                    font: inherit;
                    font-size: 13px;
                    font-weight: 700;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    transition: background .15s;
                }
                .action:hover:not(:disabled) { background: #0597e6; }
                .action:disabled { opacity: .65; cursor: default; }
                .spinner {
                    display: none;
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                    border: 2px solid rgba(255, 255, 255, .45);
                    border-top-color: #fff;
                    animation: bdy-spin .7s linear infinite;
                }
                .action.loading .spinner { display: inline-block; }
                @keyframes bdy-spin { to { transform: rotate(360deg); } }
                .stats { display: flex; gap: 8px; margin-top: 12px; }
                .stats.hidden { display: none; }
                .stat {
                    flex: 1;
                    padding: 7px 6px;
                    border-radius: 8px;
                    background: #f7f8fa;
                    text-align: center;
                }
                .stat b { display: block; font-size: 15px; line-height: 1.3; }
                .stat em { font-style: normal; font-size: 11px; color: #999; }
                .stat.ok b { color: #21a675; }
                .stat.warn b { color: #ff8800; }
                .stat.err b { color: #f5222d; }
                .progress { margin-top: 12px; }
                .progress.hidden { display: none; }
                .bar { height: 4px; border-radius: 2px; background: #eef0f4; overflow: hidden; }
                .bar > i {
                    display: block;
                    height: 100%;
                    width: 0;
                    background: #06a7ff;
                    transition: width .2s ease;
                }
                .progress-text { margin-top: 6px; color: #999; font-size: 11px; }
                .status {
                    margin-top: 10px;
                    min-height: 18px;
                    color: #8c8c8c;
                    font-size: 12px;
                    word-break: break-all;
                }
                .status[data-kind="ok"] { color: #21a675; }
                .status[data-kind="warn"] { color: #d97706; }
                .status[data-kind="err"] { color: #f5222d; }
                .toolbar { display: flex; gap: 14px; margin-top: 8px; }
                .toolbar.hidden { display: none; }
                .toolbar button {
                    padding: 0;
                    border: none;
                    background: none;
                    color: #06a7ff;
                    font: inherit;
                    font-size: 12px;
                    cursor: pointer;
                }
                .toolbar button:hover:not(:disabled) { color: #0597e6; }
                .toolbar button.hidden { display: none; }
                .toolbar button:disabled { color: #c0c4cc; cursor: default; }
                .log {
                    margin-top: 12px;
                    max-height: 128px;
                    overflow-y: auto;
                    padding: 6px 10px;
                    border-radius: 8px;
                    background: #f7f8fa;
                }
                .log:empty { display: none; }
                .log::-webkit-scrollbar { width: 6px; }
                .log::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 3px; }
                .log-item {
                    position: relative;
                    padding: 2px 0 2px 10px;
                    font-size: 12px;
                    line-height: 1.5;
                    color: #8c8c8c;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .log-item::before {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 9px;
                    width: 4px;
                    height: 4px;
                    border-radius: 50%;
                    background: currentColor;
                    opacity: .5;
                }
                .log-item.ok { color: #21a675; }
                .log-item.warn { color: #d97706; }
                .log-item.err { color: #f5222d; }
            </style>
            <div class="panel hidden" role="dialog" aria-label="字幕下载">
                <div class="header">
                    <span class="title">字幕下载</span>
                    <button class="close" type="button" title="关闭">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                    </button>
                </div>
                <div class="body">
                    <div class="context">
                        <div class="ctx-name"></div>
                        <div class="ctx-meta"></div>
                    </div>
                    <div class="save-row">
                        <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
                        <span class="save-path"></span>
                        <span class="save-actions">
                            <button class="pick-dir" type="button">选择文件夹</button>
                            <button class="reset-dir hidden" type="button">恢复默认</button>
                        </span>
                    </div>
                    <button class="action" type="button">
                        <span class="spinner"></span>
                        <span class="action-label">下载本视频字幕</span>
                    </button>
                    <div class="stats hidden">
                        <span class="stat ok"><b>0</b><em>成功</em></span>
                        <span class="stat warn"><b>0</b><em>无字幕</em></span>
                        <span class="stat err"><b>0</b><em>失败</em></span>
                    </div>
                    <div class="progress hidden">
                        <div class="bar"><i></i></div>
                        <div class="progress-text"></div>
                    </div>
                    <div class="status"></div>
                    <div class="toolbar hidden">
                        <button class="cancel hidden" type="button">取消</button>
                        <button class="copy hidden" type="button">复制问题项</button>
                    </div>
                    <div class="log"></div>
                </div>
            </div>
        `;
        ui.host = host;
        ui.root = root;
        ui.panel = root.querySelector('.panel');
        ui.ctxNameEl = root.querySelector('.ctx-name');
        ui.ctxMetaEl = root.querySelector('.ctx-meta');
        ui.saveRow = root.querySelector('.save-row');
        ui.savePathEl = root.querySelector('.save-path');
        ui.pickDirBtn = root.querySelector('.pick-dir');
        ui.resetDirBtn = root.querySelector('.reset-dir');
        ui.actionBtn = root.querySelector('.action');
        ui.actionLabel = root.querySelector('.action-label');
        ui.cancelBtn = root.querySelector('.cancel');
        ui.copyBtn = root.querySelector('.copy');
        ui.toolbarEl = root.querySelector('.toolbar');
        ui.statsEl = root.querySelector('.stats');
        ui.statOk = root.querySelector('.stat.ok b');
        ui.statNo = root.querySelector('.stat.warn b');
        ui.statErr = root.querySelector('.stat.err b');
        ui.statusEl = root.querySelector('.status');
        ui.progressEl = root.querySelector('.progress');
        ui.progressBar = root.querySelector('.bar > i');
        ui.progressText = root.querySelector('.progress-text');
        ui.logEl = root.querySelector('.log');

        root.querySelector('.close').addEventListener('click', closePanel);
        ui.actionBtn.addEventListener('click', () => {
            if (!ui.context || ui.running) return;
            if (ui.context.mode === 'video') downloadCurrentVideo();
            else startBatch();
        });
        ui.cancelBtn.addEventListener('click', () => {
            ui.cancelRequested = true;
            ui.cancelBtn.disabled = true;
            ui.cancelBtn.textContent = '正在取消…';
            setStatus('正在取消，等待当前任务结束…', 'warn');
        });
        ui.copyBtn.addEventListener('click', copyProblems);
        ui.pickDirBtn.addEventListener('click', chooseCustomDir);
        ui.resetDirBtn.addEventListener('click', resetCustomDir);

        const resizeObserver = new ResizeObserver(() => {
            if (!ui.panel.classList.contains('hidden')) positionPanel();
        });
        resizeObserver.observe(ui.panel);
    }

    mountUI();
    refreshContext();
    restoreCustomDir();

    window.addEventListener('hashchange', refreshContext);
    window.addEventListener('popstate', refreshContext);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);

    document.addEventListener('click', event => {
        if (ui.panel.classList.contains('hidden')) return;
        const path = event.composedPath ? event.composedPath() : [];
        if (path.includes(ui.host) || path.includes(ui.entryBtn) || path.includes(ui.fallbackBtn)) return;
        closePanel();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closePanel();
    });

    new MutationObserver(() => {
        clearTimeout(entryTimer);
        entryTimer = setTimeout(ensureEntryButton, 200);
    }).observe(document.body, { childList: true, subtree: true });

    // 文件列表是 SPA，切换目录后入口、文案与统计需要跟随更新
    setInterval(() => {
        if (!ui.host) return;
        const next = getPageContext();
        const changed = (!next && ui.context) || (next && (!ui.context || next.mode !== ui.context.mode || next.path !== ui.context.path));
        if (changed) refreshContext();
        else if (!ui.running) ensureEntryButton();
    }, 1500);
})();
