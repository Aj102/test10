/* =====================================================
   CFSI Student Portfolio - Upload Safety AI (client)
   Scans files BEFORE they are uploaded:
   - images            -> downscaled JPEG sent to the AI
   - videos            -> 4 time-ordered frames sent to a
                          dedicated video check
   - PDFs / DOCX       -> extracted text sent to the AI
   - text documents    -> raw text sent to the AI
   - titles, tags,
     captions, names   -> sent along with every check

   The actual AI lives in the Supabase Edge Function
   "moderate-upload" (see supabase/functions/moderate-upload).
   If the function is not deployed yet, uploads are allowed
   and a console warning is shown.
   ===================================================== */

const SAFETY_FUNCTION = 'moderate-upload';
const SAFETY_MAX_IMAGES = 3;
const SAFETY_MAX_VIDEO_FRAMES = 4;
const SAFETY_MAX_TEXT = 6000;
const SAFETY_IMAGE_MAX_SIDE = 1024;
const SAFETY_VIDEO_MAX_SIDE = 720;

let __safetyPdfPromise = null;
let __safetyZipPromise = null;
let __safetyModal = null;
let __academicModal = null;

/* ---------- lazy third-party loaders (only when needed) ---------- */
function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            if (existing.dataset.loaded === '1') return resolve();
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.onload = () => { script.dataset.loaded = '1'; resolve(); };
        script.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(script);
    });
}

async function loadPdfJs() {
    if (!__safetyPdfPromise) {
        __safetyPdfPromise = (async () => {
            await loadExternalScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
            if (!window.pdfjsLib) throw new Error('pdf.js did not load');
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
            return window.pdfjsLib;
        })().catch(err => {
            __safetyPdfPromise = null;
            throw err;
        });
    }
    return __safetyPdfPromise;
}

async function loadJSZip() {
    if (!__safetyZipPromise) {
        __safetyZipPromise = (async () => {
            await loadExternalScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
            if (!window.JSZip) throw new Error('JSZip did not load');
            return window.JSZip;
        })().catch(err => {
            __safetyZipPromise = null;
            throw err;
        });
    }
    return __safetyZipPromise;
}

/* ---------- image helpers ---------- */
function loadImageElement(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image could not be read'));
        img.src = url;
    });
}

async function imageToDataUrl(source, maxWidth = SAFETY_IMAGE_MAX_SIDE) {
    const objectUrl = typeof source === 'string' ? source : URL.createObjectURL(source);
    try {
        const img = await loadImageElement(objectUrl);
        const scale = Math.min(1, maxWidth / (img.naturalWidth || img.width || maxWidth));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
    } finally {
        if (typeof source !== 'string') URL.revokeObjectURL(objectUrl);
    }
}

/* ---------- video frame sampling ---------- */
function captureVideoFrame(video, time, maxWidth = 960) {
    return new Promise((resolve, reject) => {
        const onSeeked = () => {
            cleanup();
            try {
                const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round((video.videoWidth || maxWidth) * scale));
                canvas.height = Math.max(1, Math.round((video.videoHeight || maxWidth) * scale));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            } catch (err) {
                reject(err);
            }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Video frame timeout')); }, 6000);
        function cleanup() {
            clearTimeout(timer);
            video.removeEventListener('seeked', onSeeked);
        }
        video.addEventListener('seeked', onSeeked);
        video.currentTime = Math.min(time, Math.max(0, (video.duration || 1) - 0.1));
    });
}

async function extractVideoFrames(file, maxFrames = SAFETY_MAX_VIDEO_FRAMES) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;

    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Video load timeout')), 8000);
            video.onloadeddata = () => { clearTimeout(timer); resolve(); };
            video.onerror = () => { clearTimeout(timer); reject(new Error('Video could not be read')); };
        });

        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const fractions = maxFrames >= 4
            ? [0.06, 0.32, 0.62, 0.9]
            : maxFrames === 3
                ? [0.06, 0.5, 0.9]
                : maxFrames === 2
                    ? [0.15, 0.8]
                    : [0.5];
        const times = fractions.slice(0, Math.max(1, maxFrames)).map(fraction => {
            const t = duration ? duration * fraction : 0;
            return Math.min(t, Math.max(0, (duration || 1) - 0.1));
        });

        const frames = [];
        for (const time of times) {
            try {
                frames.push(await captureVideoFrame(video, time, SAFETY_VIDEO_MAX_SIDE));
            } catch {
                /* skip this frame */
            }
        }
        return { duration, frames };
    } finally {
        video.removeAttribute('src');
        URL.revokeObjectURL(objectUrl);
    }
}

/* ---------- document text extraction ---------- */
const SAFETY_TEXT_EXTENSIONS = /\.(txt|csv|md|json|html?|css|js|jsx|ts|tsx|py|xml|svg|log|sql|ini|yml|yaml)$/i;

async function extractPdfText(file) {
    const pdfjs = await loadPdfJs();
    const data = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data, disableAutoFetch: true, isEvalSupported: false }).promise;

    const pages = [];
    const pageCount = Math.min(doc.numPages, 3);
    for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str || '').join(' '));
        if (pages.join(' ').length > 2500) break;
    }
    return pages.join('\n').slice(0, 2500);
}

async function extractDocxText(file) {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file('word/document.xml');
    if (!entry) return '';
    const xml = await entry.async('string');
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    return (parsed.documentElement.textContent || '').replace(/\s+/g, ' ').slice(0, 2500);
}

/* ---------- payload builder ---------- */
async function buildSafetyPayload(files, metaText) {
    const texts = [];
    const images = [];
    const videos = [];
    const meta = String(metaText || '').trim();
    if (meta) texts.push(meta);

    const allFiles = Array.from(files || []);
    if (allFiles.length) {
        texts.push(allFiles.map(f => `File: ${f.name}`).join('\n'));
    }

    for (const file of allFiles) {
        const type = file.type || '';

        try {
            if (images.length < SAFETY_MAX_IMAGES && type.startsWith('image/')) {
                images.push(await imageToDataUrl(file));
                continue;
            }

            if (type.startsWith('video/')) {
                const sample = await extractVideoFrames(file, SAFETY_MAX_VIDEO_FRAMES);
                if (sample.frames.length) {
                    videos.push({
                        name: file.name,
                        duration: Math.round(sample.duration || 0),
                        frames: sample.frames
                    });
                } else {
                    texts.push(`Note: ${file.name} is a video but no frames could be extracted for review.`);
                }
                continue;
            }

            if (/pdf$/i.test(type) || /\.pdf$/i.test(file.name)) {
                texts.push(await extractPdfText(file));
                continue;
            }

            if (/wordprocessingml/i.test(type) || /\.docx$/i.test(file.name)) {
                texts.push(await extractDocxText(file));
                continue;
            }

            if (SAFETY_TEXT_EXTENSIONS.test(file.name) || type.startsWith('text/')) {
                const raw = await file.slice(0, 20000).text();
                texts.push(raw.slice(0, 2500));
                continue;
            }
        } catch (err) {
            console.warn(`Safety AI could not inspect ${file.name}:`, err.message || err);
        }
    }

    return {
        text: texts.filter(Boolean).join('\n').slice(0, SAFETY_MAX_TEXT),
        images,
        videos
    };
}

/* ---------- main entry ---------- */
/**
 * Scans files + text with the moderation Edge Function.
 * Returns { flagged, reasons, unavailable, academic }.
 * `academic` is { relevant, reason } when the AI judged the upload,
 * or null when it could not be checked.
 * Fails open (flagged: false) when the function is unreachable
 * so a missing deployment never blocks real uploads.
 */
async function checkUploadSafety(files, metaText) {
    const payload = await buildSafetyPayload(files, metaText);
    const hasVideoFrames = payload.videos.some(v => v.frames.length);

    if (!payload.text && payload.images.length === 0 && !hasVideoFrames) {
        return { flagged: false, reasons: [], unavailable: false, academic: null };
    }

    try {
        let { data, error } = await sb.functions.invoke(SAFETY_FUNCTION, { body: payload });
        if (error) throw error;
        if (!data) throw new Error('Empty response');
        if (data.error) throw new Error(data.error);

        // An older deployed function has no video pass; send the frames as stills instead.
        if (hasVideoFrames && !data.flagged && !(data.checks && 'video' in data.checks)) {
            const retry = await sb.functions.invoke(SAFETY_FUNCTION, {
                body: {
                    text: payload.text,
                    images: [...payload.videos.flatMap(v => v.frames), ...payload.images].slice(0, 4)
                }
            });
            if (retry.error) throw retry.error;
            if (!retry.data) throw new Error('Empty response');
            if (retry.data.error) throw new Error(retry.data.error);
            data = retry.data;
        }

        return {
            flagged: !!data.flagged,
            reasons: Array.isArray(data.reasons) ? data.reasons : [],
            unavailable: false,
            academic: data.academic && typeof data.academic === 'object' ? data.academic : null
        };
    } catch (err) {
        console.warn('Safety AI unavailable - upload allowed:', err.message || err);
        return { flagged: false, reasons: [], unavailable: true, academic: null };
    }
}

/* ---------- warning modal ---------- */
function injectSafetyStyles() {
    if (document.getElementById('cfsi-safety-styles')) return;
    const style = document.createElement('style');
    style.id = 'cfsi-safety-styles';
    style.textContent = `
        .safety-overlay {
            position: fixed;
            inset: 0;
            z-index: 1600;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            box-sizing: border-box;
            background: rgba(11, 37, 69, 0.6);
            backdrop-filter: blur(5px);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        }
        .safety-overlay.open {
            opacity: 1;
            pointer-events: auto;
        }
        .safety-card {
            width: 100%;
            max-width: 440px;
            background: #ffffff;
            border-radius: 18px;
            padding: 26px;
            box-sizing: border-box;
            text-align: center;
            box-shadow: 0 24px 60px rgba(11, 37, 69, 0.35);
            transform: translateY(14px);
            transition: transform 0.25s ease;
            font-family: 'Inter', sans-serif;
        }
        .safety-overlay.open .safety-card {
            transform: translateY(0);
        }
        .safety-icon {
            width: 56px;
            height: 56px;
            margin: 0 auto 14px;
            border-radius: 50%;
            background: #fff1f2;
            border: 1px solid #fecdd3;
            color: #e11d48;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
        }
        .safety-card h3 {
            margin: 0 0 6px;
            font-family: 'Poppins', sans-serif;
            font-size: 18px;
            color: #0B2545;
        }
        .safety-card > p {
            margin: 0 0 14px;
            font-size: 13px;
            color: #475569;
            line-height: 1.5;
        }
        .safety-reasons {
            list-style: none;
            margin: 0 0 12px;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 6px;
            text-align: left;
        }
        .safety-reasons li {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            background: #fff1f2;
            border: 1px solid #fecdd3;
            color: #9f1239;
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 12.5px;
            font-weight: 600;
            line-height: 1.4;
        }
        .safety-note {
            margin: 0 0 16px;
            font-size: 11.5px;
            color: #64748b;
        }
        .safety-btn {
            width: 100%;
            padding: 11px 18px;
            border: none;
            border-radius: 10px;
            background: #e11d48;
            color: #ffffff;
            font-family: 'Poppins', sans-serif;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
        }
        .safety-btn:hover {
            background: #be123c;
        }
        .safety-btn:focus-visible {
            outline: 3px solid rgba(225, 29, 72, 0.35);
            outline-offset: 2px;
        }

        /* academic warning variant (amber, non-blocking) */
        .safety-overlay.academic .safety-icon {
            background: #fffbeb;
            border-color: #fde68a;
            color: #d97706;
        }
        .safety-overlay.academic .safety-reasons li {
            background: #fffbeb;
            border-color: #fde68a;
            color: #92400e;
        }
        .safety-overlay.academic .safety-btn {
            background: #d97706;
        }
        .safety-overlay.academic .safety-btn:hover {
            background: #b45309;
        }
        .safety-overlay.academic .safety-btn:focus-visible {
            outline-color: rgba(217, 119, 6, 0.35);
        }
        .safety-btn.secondary {
            background: #f1f5f9;
            color: #334155;
            border: 1px solid #cbd5e1;
        }
        .safety-btn.secondary:hover {
            background: #e2e8f0;
        }
        .safety-actions {
            display: flex;
            gap: 10px;
        }
        @media (max-width: 480px) {
            .safety-actions { flex-direction: column-reverse; }
        }
    `;
    document.head.appendChild(style);
}

function getSafetyModal() {
    if (__safetyModal) return __safetyModal;

    injectSafetyStyles();

    const overlay = document.createElement('div');
    overlay.className = 'safety-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'safetyTitle');
    overlay.innerHTML = `
        <div class="safety-card">
            <div class="safety-icon"><i class="fa-solid fa-shield-halved"></i></div>
            <h3 id="safetyTitle">Upload blocked by Safety AI</h3>
            <p>This file may contain content that is not allowed on the CFSI portfolio:</p>
            <ul class="safety-reasons"></ul>
            <p class="safety-note">Nothing was uploaded. Please choose a different file.</p>
            <button type="button" class="safety-btn">Choose Another File</button>
        </div>
    `;

    document.body.appendChild(overlay);
    __safetyModal = overlay;
    return overlay;
}

function showSafetyWarning(reasons) {
    const overlay = getSafetyModal();
    const list = overlay.querySelector('.safety-reasons');
    list.innerHTML = '';

    (reasons && reasons.length ? reasons : ['Potentially inappropriate content']).forEach(reason => {
        const li = document.createElement('li');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-exclamation';
        const text = document.createElement('span');
        text.textContent = reason;
        li.append(icon, text);
        list.appendChild(li);
    });

    return new Promise(resolve => {
        const close = () => {
            overlay.classList.remove('open');
            overlay.querySelector('.safety-btn').removeEventListener('click', close);
            document.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = event => {
            if (event.key === 'Escape') close();
        };

        overlay.querySelector('.safety-btn').addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        overlay.classList.add('open');
        overlay.querySelector('.safety-btn').focus();
    });
}

function getAcademicModal() {
    if (__academicModal) return __academicModal;

    injectSafetyStyles();

    const overlay = document.createElement('div');
    overlay.className = 'safety-overlay academic';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'academicTitle');
    overlay.innerHTML = `
        <div class="safety-card">
            <div class="safety-icon"><i class="fa-solid fa-book-open"></i></div>
            <h3 id="academicTitle">This file may not be academic</h3>
            <p>The AI could not connect this upload to a school project:</p>
            <ul class="safety-reasons"></ul>
            <p class="safety-note">You can still upload it if it belongs to your portfolio.</p>
            <div class="safety-actions">
                <button type="button" class="safety-btn secondary" data-choice="cancel">Choose Another File</button>
                <button type="button" class="safety-btn" data-choice="upload">Upload Anyway</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    __academicModal = overlay;
    return overlay;
}

/**
 * Soft warning for non-academic uploads.
 * Resolves true when the student chooses to upload anyway,
 * false when they cancel.
 */
function showAcademicWarning(reason) {
    const overlay = getAcademicModal();
    const list = overlay.querySelector('.safety-reasons');
    list.innerHTML = '';

    if (reason) {
        const li = document.createElement('li');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-info';
        const text = document.createElement('span');
        text.textContent = reason;
        li.append(icon, text);
        list.appendChild(li);
        list.style.display = '';
    } else {
        list.style.display = 'none';
    }

    return new Promise(resolve => {
        function finish(proceed) {
            overlay.classList.remove('open');
            overlay.querySelectorAll('.safety-btn').forEach(btn => btn.removeEventListener('click', onClick));
            document.removeEventListener('keydown', onKey);
            overlay.removeEventListener('click', onBackdrop);
            resolve(proceed);
        }
        function onClick(event) {
            finish(event.currentTarget.dataset.choice === 'upload');
        }
        function onKey(event) {
            if (event.key === 'Escape') finish(false);
        }
        function onBackdrop(event) {
            if (event.target === overlay) finish(false);
        }

        overlay.querySelectorAll('.safety-btn').forEach(btn => btn.addEventListener('click', onClick));
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', onBackdrop);
        overlay.classList.add('open');
        overlay.querySelector('[data-choice="upload"]').focus();
    });
}
