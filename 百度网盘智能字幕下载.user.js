// ==UserScript==
// @name         百度网盘智能字幕下载
// @namespace    http://github.com/lihaoze123/Baiduyun-subtitle-downloader
// @version      0.5.0
// @description  下载百度网盘视频的智能字幕（SRT），支持单个视频下载与整个文件夹批量提取
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
    // 保存目录：相对于浏览器默认下载目录。留空则直接保存到下载目录根部。
    const SAVE_FOLDER = '百度网盘字幕';

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

    function downloadName(subtitle, videoPath) {
        const folder = sanitizeSegment(videoPath.split('/').slice(-2, -1)[0] || '');
        const parts = [];
        if (SAVE_FOLDER) parts.push(sanitizeSegment(SAVE_FOLDER));
        if (folder) parts.push(folder);
        parts.push(subtitle.fileName);
        return parts.filter(Boolean).join('/');
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
        pill: null,
        ctxNameEl: null,
        ctxMetaEl: null,
        saveRow: null,
        savePathEl: null,
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

    function saveHint(folderName) {
        if (typeof GM_download !== 'function') return '未检测到 Tampermonkey，批量时将打包为 ZIP';
        const folder = sanitizeSegment(folderName || '');
        return `下载目录/${[SAVE_FOLDER, folder].filter(Boolean).join('/')}/`;
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

    function setRunning(running, mode) {
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
        const context = getPageContext();
        ui.context = context;
        if (!context) {
            ui.host.style.display = 'none';
            return;
        }
        if (ui.running) return;
        ui.host.style.display = 'block';
        ui.progressEl.classList.add('hidden');
        ui.saveRow.classList.remove('warn');
        setStats({ ok: 0, noSubtitle: 0, failed: 0 }, false);
        ui.problems = [];
        clearLog();
        setStatus('');
        if (context.mode === 'video') {
            ui.ctxNameEl.textContent = context.name;
            ui.ctxMetaEl.textContent = '视频播放页';
            ui.savePathEl.textContent = saveHint(context.path.split('/').slice(-2, -1)[0]);
            ui.saveRow.classList.toggle('warn', typeof GM_download !== 'function');
            ui.actionLabel.textContent = '下载本视频字幕';
        } else {
            ui.ctxNameEl.textContent = context.name;
            ui.ctxMetaEl.textContent = '正在统计视频数量…';
            ui.savePathEl.textContent = saveHint(context.name);
            ui.saveRow.classList.toggle('warn', typeof GM_download !== 'function');
            ui.actionLabel.textContent = '批量下载字幕';
            if (!ui.panel.classList.contains('hidden')) refreshFolderCount();
        }
        updateToolbar();
    }

    async function downloadCurrentVideo() {
        if (ui.running || !ui.context || ui.context.mode !== 'video') return;
        const context = ui.context;
        setRunning(true, 'video');
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
            setRunning(false, 'video');
        }
    }

    async function startBatch() {
        if (ui.running || !ui.context || ui.context.mode !== 'folder') return;
        const dir = ui.context.path;
        const useZip = typeof GM_download !== 'function';
        const zipEntries = [];
        const save = async (subtitle, video) => {
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
        setRunning(true, 'batch');
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
            setRunning(false, 'batch');
            updateToolbar();
        }
    }

    function mountUI() {
        if (document.getElementById(HOST_ID)) return;
        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'position:fixed;right:16px;bottom:88px;z-index:2147483647;';
        document.documentElement.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { all: initial; }
                * { box-sizing: border-box; }
                .wrap {
                    --bg: #ffffff;
                    --text: #1f2329;
                    --muted: #7c8698;
                    --line: rgba(31, 35, 41, .09);
                    --card: #f6f8fc;
                    --accent: #2b7cff;
                    --accent-2: #06a7ff;
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    gap: 10px;
                    font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", "PingFang SC", sans-serif;
                    font-size: 13px;
                    color: var(--text);
                    line-height: 1.5;
                }
                .panel {
                    width: 360px;
                    max-width: calc(100vw - 32px);
                    background: var(--bg);
                    border: 1px solid var(--line);
                    border-radius: 14px;
                    box-shadow: 0 16px 48px rgba(20, 30, 50, .18), 0 2px 8px rgba(20, 30, 50, .08);
                    overflow: hidden;
                    transform-origin: bottom right;
                    animation: pop .18s cubic-bezier(.2, .9, .3, 1.2);
                }
                @keyframes pop {
                    from { opacity: 0; transform: translateY(6px) scale(.98); }
                    to { opacity: 1; transform: none; }
                }
                .panel.hidden { display: none; }
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 12px 14px;
                    border-bottom: 1px solid var(--line);
                }
                .title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 700;
                    font-size: 13.5px;
                    letter-spacing: .2px;
                }
                .logo {
                    width: 24px;
                    height: 24px;
                    border-radius: 7px;
                    background: linear-gradient(135deg, var(--accent), var(--accent-2));
                    color: #fff;
                    display: grid;
                    place-items: center;
                }
                .logo svg { width: 14px; height: 14px; }
                .close {
                    border: none;
                    background: transparent;
                    font-size: 19px;
                    line-height: 1;
                    color: var(--muted);
                    cursor: pointer;
                    padding: 2px 4px;
                    border-radius: 5px;
                }
                .close:hover { color: var(--text); background: var(--card); }
                .body { padding: 12px 14px 14px; }
                .context {
                    background: var(--card);
                    border-radius: 9px;
                    padding: 9px 11px;
                }
                .ctx-name {
                    font-weight: 600;
                    font-size: 13px;
                    line-height: 1.45;
                    word-break: break-all;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .ctx-meta {
                    margin-top: 2px;
                    color: var(--muted);
                    font-size: 11.5px;
                }
                .save-row {
                    display: flex;
                    gap: 6px;
                    align-items: flex-start;
                    margin-top: 8px;
                    color: var(--muted);
                    font-size: 11.5px;
                    line-height: 1.4;
                }
                .save-row svg {
                    width: 12px;
                    height: 12px;
                    flex: 0 0 auto;
                    margin-top: 2px;
                    opacity: .75;
                }
                .save-path { word-break: break-all; }
                .save-row.warn { color: #b26a00; }
                .action {
                    margin-top: 12px;
                    width: 100%;
                    height: 38px;
                    border: none;
                    border-radius: 9px;
                    background: linear-gradient(135deg, var(--accent), var(--accent-2));
                    color: #fff;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    box-shadow: 0 6px 16px rgba(43, 124, 255, .28);
                    transition: filter .15s, transform .15s;
                }
                .action:hover:not(:disabled) { filter: brightness(1.05); }
                .action:active:not(:disabled) { transform: translateY(1px); }
                .action:disabled { cursor: default; filter: saturate(.75); opacity: .82; }
                .spinner {
                    display: none;
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                    border: 2px solid rgba(255, 255, 255, .4);
                    border-top-color: #fff;
                    animation: spin .7s linear infinite;
                }
                .action.loading .spinner { display: inline-block; }
                @keyframes spin { to { transform: rotate(360deg); } }
                .stats { display: flex; gap: 8px; margin-top: 10px; }
                .stats.hidden { display: none; }
                .stat {
                    flex: 1;
                    background: var(--card);
                    border-radius: 8px;
                    padding: 6px 8px;
                    text-align: center;
                }
                .stat b { display: block; font-size: 15px; font-weight: 700; line-height: 1.25; }
                .stat em { font-style: normal; font-size: 10.5px; color: var(--muted); }
                .stat.ok b { color: #1a9b52; }
                .stat.warn b { color: #c47f00; }
                .stat.err b { color: #d93026; }
                .progress { margin-top: 10px; }
                .progress.hidden { display: none; }
                .bar {
                    height: 5px;
                    border-radius: 999px;
                    background: var(--line);
                    overflow: hidden;
                }
                .bar > i {
                    display: block;
                    height: 100%;
                    width: 0;
                    border-radius: 999px;
                    background: linear-gradient(90deg, var(--accent), var(--accent-2));
                    transition: width .2s ease;
                }
                .progress-text { margin-top: 5px; color: var(--muted); font-size: 11.5px; }
                .status {
                    margin-top: 9px;
                    min-height: 17px;
                    color: var(--muted);
                    font-size: 12px;
                    word-break: break-all;
                }
                .status[data-kind="ok"] { color: #1a9b52; }
                .status[data-kind="warn"] { color: #b26a00; }
                .status[data-kind="err"] { color: #d93026; }
                .toolbar { display: flex; gap: 8px; margin-top: 9px; }
                .toolbar.hidden { display: none; }
                .toolbar button {
                    border: 1px solid var(--line);
                    background: var(--bg);
                    color: var(--muted);
                    border-radius: 7px;
                    padding: 5px 10px;
                    font-size: 11.5px;
                    cursor: pointer;
                }
                .toolbar button:hover:not(:disabled) { color: var(--text); border-color: rgba(31, 35, 41, .2); }
                .toolbar button.hidden { display: none; }
                .log {
                    margin-top: 10px;
                    max-height: 132px;
                    overflow-y: auto;
                    background: var(--card);
                    border-radius: 8px;
                    padding: 6px 8px;
                }
                .log:empty { display: none; }
                .log::-webkit-scrollbar { width: 6px; }
                .log::-webkit-scrollbar-thumb { background: rgba(127, 140, 160, .35); border-radius: 3px; }
                .log-item {
                    position: relative;
                    padding: 2px 0 2px 12px;
                    font-size: 11.5px;
                    color: var(--muted);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .log-item::before {
                    content: "";
                    position: absolute;
                    left: 2px;
                    top: 8px;
                    width: 4px;
                    height: 4px;
                    border-radius: 50%;
                    background: currentColor;
                    opacity: .6;
                }
                .log-item.ok { color: #1a9b52; }
                .log-item.warn { color: #c47f00; }
                .log-item.err { color: #d93026; }
                .pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    height: 40px;
                    padding: 0 16px 0 13px;
                    border: none;
                    border-radius: 999px;
                    background: linear-gradient(135deg, var(--accent), var(--accent-2));
                    color: #fff;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    box-shadow: 0 8px 22px rgba(43, 124, 255, .34);
                    transition: transform .15s, box-shadow .15s;
                }
                .pill svg { width: 16px; height: 16px; }
                .pill:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(43, 124, 255, .42); }
                .pill:active { transform: translateY(0); }
                @media (prefers-color-scheme: dark) {
                    .wrap {
                        --bg: #1e2127;
                        --text: #e8eaed;
                        --muted: #9aa1ad;
                        --line: rgba(255, 255, 255, .1);
                        --card: #272b33;
                    }
                    .panel { box-shadow: 0 16px 48px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .04); }
                    .toolbar button:hover:not(:disabled) { border-color: rgba(255, 255, 255, .25); }
                }
            </style>
            <div class="wrap">
                <div class="panel hidden">
                    <div class="header">
                        <div class="title">
                            <span class="logo">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h4M7 15h7M14 11h3"/></svg>
                            </span>
                            <span>智能字幕</span>
                        </div>
                        <button class="close" type="button" title="收起">×</button>
                    </div>
                    <div class="body">
                        <div class="context">
                            <div class="ctx-name"></div>
                            <div class="ctx-meta"></div>
                        </div>
                        <div class="save-row">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
                            <span class="save-path"></span>
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
                <button class="pill" type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h4M7 15h7M14 11h3"/></svg>
                    <span>字幕</span>
                </button>
            </div>
        `;
        ui.host = host;
        ui.root = root;
        ui.panel = root.querySelector('.panel');
        ui.pill = root.querySelector('.pill');
        ui.ctxNameEl = root.querySelector('.ctx-name');
        ui.ctxMetaEl = root.querySelector('.ctx-meta');
        ui.saveRow = root.querySelector('.save-row');
        ui.savePathEl = root.querySelector('.save-path');
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

        ui.pill.addEventListener('click', () => {
            const opening = ui.panel.classList.contains('hidden');
            ui.panel.classList.toggle('hidden');
            if (opening && ui.context && ui.context.mode === 'folder' && !ui.running) {
                refreshFolderCount();
            }
        });
        root.querySelector('.close').addEventListener('click', () => {
            ui.panel.classList.add('hidden');
        });
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
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') ui.panel.classList.add('hidden');
        });
    }

    mountUI();
    refreshContext();
    window.addEventListener('hashchange', refreshContext);
    window.addEventListener('popstate', refreshContext);

    // 文件列表是 SPA，切换目录后按钮文案与统计需要跟随更新
    setInterval(() => {
        if (!ui.host || ui.running) return;
        const next = getPageContext();
        const changed = (!next && ui.context) || (next && (!ui.context || next.mode !== ui.context.mode || next.path !== ui.context.path));
        if (changed) refreshContext();
    }, 1500);
})();
