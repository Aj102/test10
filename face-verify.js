/* Face-check signup gate · face-check v2
   Estimates the signer-up's age on-device to pick the right account type.
   No images, frames, or recordings ever leave the browser. */
(function () {
    "use strict";

    if (window.FaceVerify) return;

    const SCRIPT_URL = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
    const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    const RESULT_KEY = "cfsi_face_check";
    const RESULT_TTL = 15 * 60 * 1000;
    const ADULT_AGE = 18;
    const SAMPLES_TARGET = 10;
    const SAMPLES_MIN = 6;
    const SAMPLE_INTERVAL = 280;
    const SCAN_TIMEOUT = 18000;
    /* The age model needs a reasonably large, lit, straight-on face. Small or
       dark faces read much younger than the person really is. */
    const MIN_FACE_RATIO = 0.28;
    const MIN_LUMA = 55;
    const MAX_LUMA = 220;

    let scriptPromise = null;
    let modelsPromise = null;
    let ui = null;
    let active = null;
    let stylesReady = false;

    /* ---------- helpers ---------- */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function median(list) {
        const arr = [...list].sort((a, b) => a - b);
        const mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }

    /* Drop the lowest and highest sample so a single noisy read cannot flip
       the label, then average the rest. */
    function trimmedMean(list) {
        const arr = [...list].sort((a, b) => a - b);
        const drop = arr.length >= 8 ? Math.floor(arr.length * 0.1) : 0;
        const kept = arr.slice(drop, arr.length - drop);
        if (!kept.length) return median(arr);
        return kept.reduce((sum, value) => sum + value, 0) / kept.length;
    }

    let lumaCanvas = null;

    function faceLuma(video, box) {
        const sx = Math.max(0, box.x + box.width * 0.2);
        const sy = Math.max(0, box.y + box.height * 0.2);
        const sw = Math.min(video.videoWidth - sx, box.width * 0.6);
        const sh = Math.min(video.videoHeight - sy, box.height * 0.6);
        if (sw <= 0 || sh <= 0) return null;

        if (!lumaCanvas) {
            lumaCanvas = document.createElement("canvas");
            lumaCanvas.width = 32;
            lumaCanvas.height = 32;
        }
        const ctx = lumaCanvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        return total / (32 * 32);
    }

    function landmarkPoint(points, from, to) {
        let x = 0, y = 0;
        for (let i = from; i <= to; i++) { x += points[i].x; y += points[i].y; }
        const count = to - from + 1;
        return { x: x / count, y: y / count };
    }

    /* Returns { ok } or { hint } describing what the user should fix before
       the frame is good enough to count as a sample. */
    function assessFrame(face, video) {
        const box = face.detection.box;
        if (box.height < video.videoHeight * MIN_FACE_RATIO) {
            return { hint: "Move a little closer so your face fills the frame." };
        }

        const centerX = (box.x + box.width / 2) / video.videoWidth;
        const centerY = (box.y + box.height / 2) / video.videoHeight;
        if (Math.abs(centerX - 0.5) > 0.28 || Math.abs(centerY - 0.45) > 0.32) {
            return { hint: "Center your face in the frame." };
        }

        const points = face.landmarks && face.landmarks.positions;
        if (points && points.length >= 48) {
            const leftEye = landmarkPoint(points, 36, 41);
            const rightEye = landmarkPoint(points, 42, 47);
            const nose = points[30];
            const eyeMidX = (leftEye.x + rightEye.x) / 2;
            const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 1;

            if (Math.abs(nose.x - eyeMidX) / eyeDist > 0.3) {
                return { hint: "Face the camera straight on." };
            }
            if (Math.abs(rightEye.y - leftEye.y) / eyeDist > 0.2) {
                return { hint: "Keep your head level." };
            }
        }

        const luma = faceLuma(video, box);
        if (luma !== null && luma < MIN_LUMA) {
            return { hint: "It is too dark. Face a window or lamp, then hold still." };
        }
        if (luma !== null && luma > MAX_LUMA) {
            return { hint: "The light is too bright. Step out of direct light." };
        }

        return { ok: true };
    }

    function injectStyles() {
        if (stylesReady) return;
        stylesReady = true;
        const style = document.createElement("style");
        style.id = "fvStyles";
        style.textContent = `
.fv-page-hint { margin: 14px auto 0; max-width: 520px; padding: 0 18px; text-align: center; font-size: 12px; line-height: 1.5; color: #64748b; }
.fv-page-hint i { color: #0c5cbe; margin-right: 5px; }

.fv-overlay { position: fixed; inset: 0; z-index: 9999; display: none; align-items: center; justify-content: center; padding: 20px; background: rgba(7, 20, 38, .72); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.fv-overlay.is-open { display: flex; }
body.fv-locked { overflow: hidden; }

.fv-card { width: min(470px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: #fff; border-radius: 22px; box-shadow: 0 30px 90px rgba(4, 16, 36, .45); font-family: "Poppins", "Inter", system-ui, sans-serif; color: #0b2545; animation: fv-pop .18s ease-out; }
@keyframes fv-pop { from { transform: translateY(8px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }

.fv-head { display: flex; align-items: flex-start; gap: 12px; padding: 20px 22px 10px; }
.fv-badge { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center; background: #eef4ff; color: #0c5cbe; font-size: 18px; }
.fv-headtext { flex: 1; min-width: 0; }
.fv-headtext h2 { margin: 0; font-size: 17px; line-height: 1.25; color: #0b2545; }
.fv-headtext p { margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: #64748b; }
.fv-close { border: 0; background: #f1f5fb; color: #475569; width: 32px; height: 32px; border-radius: 10px; cursor: pointer; font-size: 14px; }
.fv-close:hover { background: #e6edf7; }

.fv-stage { position: relative; margin: 6px 22px 0; border-radius: 16px; overflow: hidden; background: #0b1424; aspect-ratio: 4 / 3; }
.fv-stage video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
.fv-frame { position: absolute; inset: 13% 22%; border: 2px dashed rgba(255, 255, 255, .7); border-radius: 18px; pointer-events: none; }
.fv-status { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 12px; font-size: 12px; line-height: 1.35; color: #e2e8f0; background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, .72) 100%); }
.fv-status.is-error { color: #ffd9d9; }
.fv-status.is-ok { color: #c8f7d8; }

.fv-result { margin: 14px 22px 0; padding: 13px 14px; border-radius: 14px; background: #f4f7ff; border: 1px solid #dbe6fa; font-size: 13px; color: #243b53; }
.fv-result[hidden] { display: none; }
.fv-category { display: flex; align-items: center; gap: 12px; }
.fv-category > i { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; font-size: 20px; background: #e9f8ef; color: #1a7f4b; }
.fv-category.is-adult > i { background: #eef4ff; color: #0c5cbe; }
.fv-category strong { display: block; font-size: 22px; line-height: 1.1; color: #0b2545; }
.fv-category span { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
.fv-fb-text { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5; color: #334155; }
.fv-fb-text i { color: #0c5cbe; margin-right: 4px; }
.fv-check { display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; color: #0b2545; cursor: pointer; }
.fv-check input { margin-top: 2px; accent-color: #0c5cbe; }

.fv-actions { display: flex; flex-wrap: wrap; gap: 9px; padding: 14px 22px 4px; }
.fv-btn { flex: 1 1 120px; padding: 11px 14px; border-radius: 12px; border: 1px solid #d6e0ef; background: #fff; color: #0b2545; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s; }
.fv-btn:hover { background: #f4f7fd; border-color: #c3d3ea; }
.fv-btn.primary { background: #0c5cbe; border-color: #0c5cbe; color: #fff; }
.fv-btn.primary:hover { background: #0a4fa4; }
.fv-btn[hidden] { display: none; }
.fv-foot { margin: 10px 22px 18px; font-size: 10.5px; line-height: 1.5; color: #7a869a; }

.fv-choices { display: grid; gap: 10px; padding: 4px 22px 6px; }
.fv-choice-btn { display: grid; grid-template-columns: 34px 1fr; grid-template-rows: auto auto; column-gap: 12px; align-items: center; text-align: left; padding: 13px 14px; border-radius: 14px; border: 1px solid #d9e3f3; background: #fff; cursor: pointer; font-family: inherit; }
.fv-choice-btn:hover { border-color: #a9c3ea; background: #f7faff; }
.fv-choice-btn i { grid-row: 1 / span 2; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: #eef4ff; color: #0c5cbe; font-size: 15px; }
.fv-choice-btn strong { font-size: 13.5px; color: #0b2545; }
.fv-choice-btn span { font-size: 11.5px; color: #64748b; }
.fv-choice-btn.primary { border-color: #0c5cbe; background: #f2f7ff; }
`;
        document.head.appendChild(style);
    }

    /* ---------- library + models ---------- */
    function loadFaceApi() {
        if (window.faceapi) return Promise.resolve(window.faceapi);
        if (!scriptPromise) {
            scriptPromise = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = SCRIPT_URL;
                s.async = true;
                s.onload = () => window.faceapi
                    ? resolve(window.faceapi)
                    : reject(new Error("The face-check library did not load."));
                s.onerror = () => reject(new Error("Could not download the face-check library. Check your internet connection."));
                document.head.appendChild(s);
            });
        }
        return scriptPromise;
    }

    function loadModels() {
        if (!modelsPromise) {
            const api = window.faceapi;
            modelsPromise = Promise.all([
                api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                api.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
                api.nets.ageGenderNet.loadFromUri(MODEL_URL)
            ]).catch(() => {
                modelsPromise = null;
                throw new Error("Could not load the face model. Check your internet connection and try again.");
            });
        }
        return modelsPromise;
    }

    /* ---------- overlay ---------- */
    function ensureUI() {
        if (ui) return ui;
        injectStyles();

        const overlay = document.createElement("div");
        overlay.className = "fv-overlay";
        overlay.innerHTML = `
            <div class="fv-card" role="dialog" aria-modal="true" aria-labelledby="fvTitle">
                <div class="fv-head">
                    <span class="fv-badge"><i class="fa-solid fa-shield-halved"></i></span>
                    <div class="fv-headtext">
                        <h2 id="fvTitle">Quick face check</h2>
                        <p>On-device check to pick the right account type.</p>
                    </div>
                    <button type="button" class="fv-close" aria-label="Close face check"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="fv-stage">
                    <video autoplay muted playsinline></video>
                    <span class="fv-frame" aria-hidden="true"></span>
                    <div class="fv-status" role="status" aria-live="polite">Camera is off.</div>
                </div>
                <div class="fv-result" hidden></div>
                <div class="fv-actions">
                    <button type="button" class="fv-btn" data-ref="fallback">Camera not working?</button>
                    <button type="button" class="fv-btn" data-ref="retry" hidden>Scan again</button>
                    <button type="button" class="fv-btn primary" data-ref="continue" hidden>Continue</button>
                </div>
                <p class="fv-foot">This check runs on your device and only decides between a student and an adult account. No photos are uploaded or saved. It is not an ID check.</p>
            </div>`;

        document.body.appendChild(overlay);

        ui = {
            overlay,
            video: overlay.querySelector("video"),
            status: overlay.querySelector(".fv-status"),
            result: overlay.querySelector(".fv-result"),
            continueBtn: overlay.querySelector('[data-ref="continue"]'),
            retryBtn: overlay.querySelector('[data-ref="retry"]'),
            fallbackBtn: overlay.querySelector('[data-ref="fallback"]'),
            closeBtn: overlay.querySelector(".fv-close")
        };

        ui.closeBtn.addEventListener("click", cancelScan);
        ui.overlay.addEventListener("click", event => {
            if (event.target === ui.overlay) cancelScan();
        });
        ui.retryBtn.addEventListener("click", () => {
            if (!active) return;
            resetDetectionUI(active);
            startRun(active);
        });
        ui.fallbackBtn.addEventListener("click", () => {
            if (!active) return;
            showFallback(active);
        });
        ui.continueBtn.addEventListener("click", onContinue);

        return ui;
    }

    function setStatus(text, tone) {
        if (!ui) return;
        ui.status.textContent = text;
        ui.status.classList.toggle("is-error", tone === "error");
        ui.status.classList.toggle("is-ok", tone === "ok");
    }

    function openOverlay() {
        ensureUI();
        ui.overlay.classList.add("is-open");
        document.body.classList.add("fv-locked");
        document.addEventListener("keydown", onKeydown);
    }

    function closeOverlay() {
        if (!ui) return;
        ui.overlay.classList.remove("is-open");
        document.body.classList.remove("fv-locked");
        document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(event) {
        if (event.key === "Escape") cancelScan();
    }

    function resetDetectionUI(run) {
        if (!ui) return;
        stopWatchdog(run);
        ui.result.hidden = true;
        ui.result.innerHTML = "";
        ui.continueBtn.hidden = true;
        ui.retryBtn.hidden = true;
        ui.fallbackBtn.hidden = false;
        ui.continueBtn.textContent = "Continue";
        run.pending = null;
        run.fallbackMode = false;
        setStatus("Starting camera…");
    }

    function stopWatchdog(run) {
        if (run && run.watchdog) {
            clearTimeout(run.watchdog);
            run.watchdog = null;
        }
    }

    function stopCamera() {
        if (active && active.stream) {
            active.stream.getTracks().forEach(track => track.stop());
            active.stream = null;
        }
        if (ui && ui.video) ui.video.srcObject = null;
    }

    /* ---------- camera + detection ---------- */
    function openCamera(video) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return Promise.reject(new Error("This browser cannot open a camera here. Use HTTPS or localhost in Chrome, Edge, or Safari."));
        }
        return navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: "user",
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        }).then(stream => {
            video.srcObject = stream;
            return video.play().catch(() => {}).then(() => stream);
        }).catch(err => {
            const name = err && err.name;
            if (name === "NotAllowedError" || name === "SecurityError") {
                throw new Error("Camera access was blocked. Allow camera access for this site, then try again.");
            }
            if (name === "NotFoundError" || name === "OverconstrainedError") {
                throw new Error("No camera was found on this device.");
            }
            if (name === "NotReadableError") {
                throw new Error("The camera is busy in another app. Close it, then try again.");
            }
            throw err;
        });
    }

    async function startRun(run) {
        const token = run.token = (run.token || 0) + 1;
        stopWatchdog(run);
        run.watchdog = setTimeout(() => {
            if (active === run && run.token === token && !run.pending && !run.fallbackMode) {
                showCameraError(new Error("The face check is taking too long on this device. Try again in better light, or continue without the camera."));
            }
        }, 30000);
        try {
            await loadFaceApi();
            if (run.cancelled || active !== run) return;
            setStatus("Loading face model… first time can take a moment.");
            await loadModels();
            if (run.cancelled || active !== run) return;
            if (!run.stream) run.stream = await openCamera(ui.video);
            if (run.cancelled || active !== run) return;
            setStatus("Looking for your face…");
            await sampleAges(run, token);
        } catch (err) {
            if (run.cancelled || active !== run) return;
            showCameraError(err);
        }
    }

    async function sampleAges(run, token) {
        const api = window.faceapi;
        const options = new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
        const samples = [];
        const startedAt = Date.now();
        let lastHint = "";

        const hint = text => {
            if (text === lastHint) return;
            lastHint = text;
            setStatus(text);
        };

        while (!run.cancelled && active === run && run.token === token && Date.now() - startedAt < SCAN_TIMEOUT) {
            if (ui.video.readyState >= 2) {
                let faces = [];
                try {
                    const detection = api
                        .detectAllFaces(ui.video, options)
                        .withFaceLandmarks(true)
                        .withAgeAndGender();
                    faces = await Promise.race([
                        detection,
                        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 8000))
                    ]);
                } catch (_) {
                    faces = [];
                }
                if (run.cancelled || active !== run || run.token !== token) return;

                faces = faces
                    .filter(face => face.landmarks && Number.isFinite(face.age))
                    .sort((a, b) => (b.detection.box.width * b.detection.box.height) - (a.detection.box.width * a.detection.box.height));

                if (faces.length > 1) {
                    const main = faces[0].detection.box.width * faces[0].detection.box.height;
                    const second = faces[1].detection.box.width * faces[1].detection.box.height;
                    if (second >= main * 0.6) {
                        hint("Only the person signing up should be in the frame.");
                        await sleep(SAMPLE_INTERVAL);
                        continue;
                    }
                }

                if (faces.length) {
                    const check = assessFrame(faces[0], ui.video);
                    if (check.ok) {
                        samples.push(faces[0].age);
                        lastHint = "";
                        setStatus(`Checking your face… ${samples.length}/${SAMPLES_TARGET}`);
                        if (samples.length >= SAMPLES_TARGET) break;
                    } else {
                        hint(check.hint);
                    }
                } else {
                    hint("Face the camera in good light and hold still.");
                }
            }
            await sleep(SAMPLE_INTERVAL);
        }

        if (run.cancelled || active !== run || run.token !== token) return;
        if (samples.length < SAMPLES_MIN) {
            showCameraError(new Error("We could not get a clear read of your face. Move closer, face a light, and try again."));
            return;
        }
        showVerdict(run, trimmedMean(samples));
    }

    function showVerdict(run, age) {
        if (run.fallbackMode) return;
        stopWatchdog(run);
        stopCamera();
        const adult = age >= ADULT_AGE;
        run.pending = { age, adult, method: "camera", at: Date.now() };
        run.fallbackMode = false;

        ui.result.hidden = false;
        ui.result.innerHTML = `
            <div class="fv-category ${adult ? "is-adult" : ""}">
                <i class="fa-solid ${adult ? "fa-user-tie" : "fa-graduation-cap"}"></i>
                <div>
                    <strong>${adult ? "Adult" : "Student"}</strong>
                    <span>account type</span>
                </div>
            </div>`;
        ui.continueBtn.hidden = false;
        ui.continueBtn.textContent = "Continue";
        ui.retryBtn.hidden = false;
        ui.fallbackBtn.hidden = true;
        setStatus("Check complete.", "ok");
    }

    function showCameraError(err) {
        stopWatchdog(active);
        stopCamera();
        setStatus((err && err.message) || "The camera check could not start.", "error");
        if (!ui) return;
        ui.result.hidden = true;
        ui.result.innerHTML = "";
        ui.continueBtn.hidden = true;
        ui.retryBtn.hidden = false;
        ui.fallbackBtn.hidden = false;
    }

    function showFallback(run) {
        stopWatchdog(run);
        stopCamera();
        run.fallbackMode = true;
        run.pending = null;

        ui.result.hidden = false;
        ui.retryBtn.hidden = false;
        ui.fallbackBtn.hidden = true;
        ui.continueBtn.hidden = false;
        ui.continueBtn.textContent = "Continue without camera";

        if (run.opts.mode === "adult") {
            ui.result.innerHTML = `
                <p class="fv-fb-text"><i class="fa-solid fa-circle-info"></i> The camera check is unavailable. Confirm you are at least 18 to create a teacher or parent account.</p>
                <label class="fv-check"><input type="checkbox" id="fvHonor"> <span>I confirm I am 18 or older.</span></label>`;
        } else {
            ui.result.innerHTML = `<p class="fv-fb-text"><i class="fa-solid fa-circle-info"></i> The camera check is unavailable. Your account type will be based on the birthdate you entered.</p>`;
        }
        setStatus("Camera check skipped.");
    }

    function onContinue() {
        if (!active) return;

        if (active.fallbackMode) {
            if (active.opts.mode === "adult") {
                const box = document.getElementById("fvHonor");
                if (!box || !box.checked) {
                    setStatus("Tick the confirmation to continue.", "error");
                    return;
                }
                finishScan({ age: null, adult: true, method: "manual", at: Date.now() });
                return;
            }
            const declared = Number(active.opts.declaredAge);
            if (!Number.isFinite(declared) || declared <= 0) {
                setStatus("Camera check unavailable. Try again on a device with a camera.", "error");
                return;
            }
            finishScan({ age: declared, adult: declared >= ADULT_AGE, method: "manual", at: Date.now() });
            return;
        }

        if (active.pending) finishScan(active.pending);
    }

    /* ---------- lifecycle ---------- */
    function finishScan(result) {
        if (!active) return;
        const done = active.resolve;
        const mode = active.opts.mode;
        stopWatchdog(active);
        active.cancelled = true;
        stopCamera();
        closeOverlay();
        active = null;
        if (result) saveResult(result, mode);
        done(result);
    }

    function cancelScan() {
        if (!active) {
            closeOverlay();
            return;
        }
        const done = active.resolve;
        stopWatchdog(active);
        active.cancelled = true;
        stopCamera();
        closeOverlay();
        active = null;
        done(null);
    }

    function scan(opts = {}) {
        if (active) return active.promise;

        ensureUI();
        resetDetectionUI({ pending: null, fallbackMode: false });

        let resolveFn;
        const promise = new Promise(resolve => { resolveFn = resolve; });

        active = {
            promise,
            resolve: resolveFn,
            opts,
            cancelled: false,
            stream: null,
            pending: null,
            fallbackMode: false
        };

        ui.video.srcObject = null;
        openOverlay();
        startRun(active);
        return promise;
    }

    /* ---------- result cache ---------- */
    /* Only a positive adult label is cached, and only for the flow that
       produced it. A student label is never reused: a rescan in better light
       is exactly how a wrongly labeled adult gets through. */
    function saveResult(result, mode) {
        if (!result || !result.adult) return;
        try {
            sessionStorage.setItem(RESULT_KEY, JSON.stringify({
                adult: true,
                method: result.method || "camera",
                mode: mode || "",
                at: Date.now()
            }));
        } catch (_) {}
    }

    function readResult(mode) {
        try {
            const raw = JSON.parse(sessionStorage.getItem(RESULT_KEY) || "null");
            if (!raw || typeof raw.adult !== "boolean") return null;
            if (Date.now() - Number(raw.at || 0) >= RESULT_TTL) return null;
            if (mode !== undefined && raw.mode !== mode) return null;
            return raw;
        } catch (_) {}
        return null;
    }

    function ensure(opts = {}) {
        const stored = readResult(opts.mode || "");
        if (stored) return Promise.resolve(stored);
        return scan(opts);
    }

    /* ---------- dialogs ---------- */
    function showDialog({ icon, title, text, actions, footer }) {
        injectStyles();
        return new Promise(resolve => {
            const overlay = document.createElement("div");
            overlay.className = "fv-overlay is-open";
            overlay.innerHTML = `
                <div class="fv-card" role="dialog" aria-modal="true">
                    <div class="fv-head">
                        <span class="fv-badge"><i class="fa-solid ${icon}"></i></span>
                        <div class="fv-headtext">
                            <h2>${title}</h2>
                            <p>${text}</p>
                        </div>
                        <button type="button" class="fv-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="fv-choices">
                        ${actions.map(action => `
                            <button type="button" class="fv-choice-btn ${action.primary ? "primary" : ""}" data-key="${action.key}">
                                <i class="fa-solid ${action.icon}"></i>
                                <strong>${action.label}</strong>
                                <span>${action.hint}</span>
                            </button>`).join("")}
                    </div>
                    <p class="fv-foot">${footer || ""}</p>
                </div>`;
            document.body.appendChild(overlay);
            document.body.classList.add("fv-locked");

            const onKey = event => {
                if (event.key === "Escape") finish(null);
            };

            function finish(key) {
                overlay.remove();
                document.body.classList.remove("fv-locked");
                document.removeEventListener("keydown", onKey);
                resolve(key);
                const picked = actions.find(action => action.key === key);
                if (picked && picked.href) window.location.href = picked.href;
            }

            overlay.querySelectorAll("[data-key]").forEach(btn => {
                btn.addEventListener("click", () => finish(btn.dataset.key));
            });
            overlay.querySelector(".fv-close").addEventListener("click", () => finish(null));
            overlay.addEventListener("click", event => {
                if (event.target === overlay) finish(null);
            });
            document.addEventListener("keydown", onKey);
        });
    }

    function showAdultChoices() {
        return showDialog({
            icon: "fa-user-shield",
            title: "Adult detected",
            text: "Teacher and parent accounts are available for adults. A student account is for learners under 18.",
            actions: [
                {
                    key: "teacher",
                    label: "Teacher account",
                    hint: "Needs an @fatima.edu.ph email; review student work",
                    icon: "fa-chalkboard-user",
                    primary: true,
                    href: "TeacherSignup.html"
                },
                {
                    key: "parent",
                    label: "Parent account",
                    hint: "Link to your child's portfolio with their Parent Code",
                    icon: "fa-people-group",
                    href: "ParentSignup.html"
                }
            ],
            footer: "Believe this is wrong? Improve the lighting or move closer, then start the sign-up again."
        });
    }

    function showMinorNotice() {
        return showDialog({
            icon: "fa-graduation-cap",
            title: "Student label from the face check",
            text: "The face check labeled this scan as a student. Teacher and parent accounts are for adults 18 and older.",
            actions: [
                {
                    key: "retry",
                    label: "Check again",
                    hint: "Move closer, face a light, and remove glasses",
                    icon: "fa-rotate-right",
                    primary: true
                },
                {
                    key: "student",
                    label: "Continue as student",
                    hint: "Opens the student sign-up with your school email",
                    icon: "fa-graduation-cap",
                    href: "Signup.html"
                }
            ],
            footer: "Poor light or distance can cause a wrong label. If the check keeps failing, ask your adviser."
        });
    }

    window.FaceVerify = {
        version: "2",
        ADULT_AGE,
        ensure,
        scan,
        lastCheck: readResult,
        clear() {
            try { sessionStorage.removeItem(RESULT_KEY); } catch (_) {}
        },
        showAdultChoices,
        showMinorNotice
    };
})();
