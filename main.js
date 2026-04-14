const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext('2d');
const preview = document.getElementById("preview");
const counter = document.getElementById("counter");
const container1 = document.getElementById("container1");
const calibration = document.getElementById("calibration");
const reset = document.getElementById("reset");
const crop_start = document.getElementById("crop_start");
const crop_stop = document.getElementById("crop_stop");
const record_start = document.getElementById("record_start");
const record_stop = document.getElementById("record_stop");
const aspect_ratio = document.getElementById("aspect_ratio");
const flashWhite = document.getElementById("flashWhite");
const flashRed = document.getElementById("flashRed");

// ==== ZMIENNE =====
let recordFlag = false
let detection = null;
let lastFrame = null;
let changeTimeout = null;
const CHANGE_THRESHOLD = 7.25; // czułość (większe = mniej wrażliwe) 6,5 do 8
let baseOrientation = null;
const ROTATION_THRESHOLD = 1.5; // stopnie
let projectorRatioIndex = 0
let projectorRatio = 16/9
let useFront = false; // false = tylna kamera
let stream;
let draggingPoint = null;
let offset = { x: 0, y: 0 };
let points = [
    { x: 0.25, y: 0.25 }, // lewy góra
    { x: 0.75, y: 0.25 }, // prawy góra
    { x: 0.75, y: 0.75 }, // prawy dół
    { x: 0.25, y: 0.75 } // lewy dół
]; 

// ===== FUNKCJE =====
function angleDiff(a, b) {
    let diff = Math.abs(a - b);
    return Math.min(diff, 360 - diff); // magiczna linia
}

function flashWhiteEffect() {
    flashWhite.style.opacity = "1";

    setTimeout(() => {
        flashWhite.style.opacity = "0";
    }, 250);
}

function flashRedEffect() {
    flashRed.style.opacity = "1";

    setTimeout(() => {
        flashRed.style.opacity = "0";
    }, 250);
}

function detectSlideChange() {
    if (!cv || points.length !== 4) return;

    const w = video.videoWidth;
    const h = video.videoHeight;

    // klatka z video
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tctx = tempCanvas.getContext("2d");
    tctx.drawImage(video, 0, 0, w, h);

    let src = cv.imread(tempCanvas);

    // punkty
    const pts = points.map(p => [p.x * w, p.y * h]);

    // transform jak wcześniej (bez kombinowania z ratio – prosty crop)
    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        pts[0][0], pts[0][1],
        pts[1][0], pts[1][1],
        pts[2][0], pts[2][1],
        pts[3][0], pts[3][1],
    ]);

    let size = new cv.Size(200, 150); // MAŁY obraz do analizy (szybciej)
    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        size.width, 0,
        size.width, size.height,
        0, size.height
    ]);

    let M = cv.getPerspectiveTransform(srcTri, dstTri);
    let current = new cv.Mat();
    cv.warpPerspective(src, current, M, size);

    // grayscale (łatwiej porównywać)
    cv.cvtColor(current, current, cv.COLOR_RGBA2GRAY);

    if (lastFrame) {
        let diff = new cv.Mat();
        cv.absdiff(current, lastFrame, diff);

        let mean = cv.mean(diff)[0]; // średnia różnica

        if (mean > CHANGE_THRESHOLD) {
            // zmiana wykryta
            if (changeTimeout) clearTimeout(changeTimeout);

            changeTimeout = setTimeout(() => {
                // sprawdzamy czy się uspokoiło
                warpAndPreview();
            }, 1000);
        }

        diff.delete();
    }

    if (lastFrame) lastFrame.delete();
    lastFrame = current.clone();

    // cleanup
    current.delete();
    src.delete();
    M.delete();
    srcTri.delete();
    dstTri.delete();
}

function startDetection() {
    if (detection) return;
    detection = setInterval(detectSlideChange, 200);
}

function stopDetection() {
    if (!detection) return;

    clearInterval(detection);
    detection = null;
}


function Aspect_ratio(){
    projectorRatioIndex += 1;
    projectorRatioIndex %= 3;

    switch (projectorRatioIndex){
        case 0:
            projectorRatio = 16/9;
            aspect_ratio.innerHTML = "16:9";
            break;
        case 1:
            projectorRatio = 4/3;
            aspect_ratio.innerHTML = "4/3";
            break;
        case 2:
            projectorRatio = 1/1;
            aspect_ratio.innerHTML = "1/1";
            break;
    }
}

function CounterReset(){
    counter.innerHTML = 0;
}

function Crop_start(){
    crop_start.style.display = "none";
    crop_stop.style.display = "inline";
    calibration.style.display = "none";
    reset.style.display = "inline";
    record_start.style.display = "none";
    overlay.style.pointerEvents = "auto";
    aspect_ratio.style.display = "none";
}

function Crop_stop(){
    crop_start.style.display = "inline";
    crop_stop.style.display = "none";
    calibration.style.display = "inline";
    reset.style.display = "none";
    record_start.style.display = "inline";
    overlay.style.pointerEvents = "none"
    aspect_ratio.style.display = "inline";
}

function Record_start(){
    startDetection()
    record_start.style.display = "none";
    record_stop.style.display = "inline";
    crop_start.style.display = "none";
    calibration.style.display = "none";
    aspect_ratio.style.display = "none";

    recordFlag = true;
}

function Record_stop(){
    stopDetection()
    record_start.style.display = "inline";
    record_stop.style.display = "none";
    crop_start.style.display = "inline";
    calibration.style.display = "inline";
    aspect_ratio.style.display = "inline";

    recordFlag = false;
}

function Reset(){
    points = [
        { x: 0.25, y: 0.25 }, // lewy góra
        { x: 0.75, y: 0.25 }, // prawy góra
        { x: 0.75, y: 0.75 }, // prawy dół
        { x: 0.25, y: 0.75 } // lewy dół
    ]; 
    drawPolygon()
}

async function StartCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: useFront ? "user" : "environment" ,
                width: {ideal: 3840},
                height: {ideal: 2160}
            },
            audio: false
        });
        video.srcObject = stream;
    } catch (err) {
        alert("Brak dostępu do kamery: " + err);
    }
}

function Resize() {
    const videoRatio = video.videoWidth / video.videoHeight;
    const screenRatio = window.innerWidth / window.innerHeight;
    let width,height

    if (window.innerWidth < 390 || window.innerHeight < 300) {
        container1.style.zIndex = "-2"
        preview.style.zIndex = "-2"
        Crop_stop()
    } else {
        container1.style.zIndex = "3"
        preview.style.zIndex = "2"
    }
    
    if (videoRatio > screenRatio) {
        width = window.innerWidth;
        height = window.innerWidth / videoRatio;
    } else {
        width = window.innerHeight * videoRatio;
        height = window.innerHeight;
    }

    video.style.width = width + "px"
    video.style.height = height + "px";
    overlay.style.width = width + "px";
    overlay.style.height = height + "px";
    overlay.width = width;
    overlay.height = height;
    drawPolygon()
}

function drawPolygon() {
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    ctx.strokeStyle = "red";
    ctx.fillStyle = "red";
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x*overlay.width, points[0].y*overlay.height);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x*overlay.width, points[i].y*overlay.height);
    }
    ctx.closePath();
    ctx.stroke()

    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x*overlay.width, p.y*overlay.height, 3, 0, Math.PI * 2);
        ctx.fill();
    });
}

function getMousePos(e) {
    const rect = overlay.getBoundingClientRect();
    let clientX = e.clientX;
    let clientY = e.clientY;

    return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height
    };
}

function findClosestPoint(pos) {
    let minDist = Infinity;
    let closest = null;
    points.forEach((pt, index) => {
        const dx = pt.x - pos.x;
        const dy = pt.y - pos.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < minDist) {
            minDist = dist;
            closest = index;
        }
    });
    return closest;
}

function warpAndPreview() {
    if (!cv || points.length !== 4) return;

    const w = video.videoWidth;
    const h = video.videoHeight;

    // canvas tymczasowy
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tctx = tempCanvas.getContext("2d");
    tctx.drawImage(video, 0, 0, w, h);

    let src = cv.imread(tempCanvas);

    // punkty w pikselach
    const pts = points.map(p => [p.x * w, p.y * h]);

    // szerokość i wysokość zaznaczonego czworokąta
    const widthA = Math.hypot(pts[2][0] - pts[3][0], pts[2][1] - pts[3][1]);
    const widthB = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const maxWidth = Math.max(widthA, widthB);

    const heightA = Math.hypot(pts[1][0] - pts[2][0], pts[1][1] - pts[2][1]);
    const heightB = Math.hypot(pts[0][0] - pts[3][0], pts[0][1] - pts[3][1]);
    const maxHeight = Math.max(heightA, heightB);

    // proporcja oryginalnego czworokąta
    const rectRatio = maxWidth / maxHeight;

    let finalWidth, finalHeight;

    // dopasowanie do screenRatio
    if (rectRatio > projectorRatio) {
        // czworokąt szerszy niż docelowy ekran → ograniczamy width
        finalWidth = maxWidth;
        finalHeight = maxWidth / projectorRatio;
    } else {
        // czworokąt wyższy niż ekran → ograniczamy height
        finalHeight = maxHeight;
        finalWidth = maxHeight * projectorRatio;
    }

    // źródłowe punkty
    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        pts[0][0], pts[0][1],
        pts[1][0], pts[1][1],
        pts[2][0], pts[2][1],
        pts[3][0], pts[3][1],
    ]);

    // docelowe punkty z dopasowaną proporcją
    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        finalWidth, 0,
        finalWidth, finalHeight,
        0, finalHeight
    ]);

    let M = cv.getPerspectiveTransform(srcTri, dstTri);
    let dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(finalWidth, finalHeight));

    // zapis do pliku (PNG = bezstratny)
    const outCanvas = document.createElement("canvas");
    outCanvas.width = finalWidth;
    outCanvas.height = finalHeight;

    // wrzucamy wynik OpenCV na canvas
    cv.imshow(outCanvas, dst);

    // download
    outCanvas.toBlob(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `slajd_${Date.now()}.png`;
        a.click();

        URL.revokeObjectURL(a.href);
    }, "image/png");

    // podgląd w canvas preview
    preview.width = finalWidth;
    preview.height = finalHeight;
    cv.imshow(preview, dst);

    // sprzątanie
    src.delete();
    dst.delete();
    M.delete();
    srcTri.delete();
    dstTri.delete();
    counter.innerHTML = parseInt(counter.innerHTML) + 1
    flashWhiteEffect();
}

// ===== EVENTY =====
aspect_ratio.addEventListener("pointerup" , Aspect_ratio)

counter.addEventListener('pointerup',CounterReset)

function log(msg){
    let el = document.getElementById("debug");
    if(!el){
        el = document.createElement("div");
        el.id = "debug";
        el.style.position = "fixed";
        el.style.top = "0";
        el.style.left = "0";
        el.style.width = "100%";
        el.style.height = "50%";
        el.style.background = "rgba(0,0,0,0.7)";
        el.style.color = "lime";
        el.style.fontSize = "12px";
        el.style.zIndex = 99999;
        el.style.overflow = "auto";
        document.body.appendChild(el);
    }
    el.innerHTML += msg + "<br>";
}

record_start.addEventListener('pointerup', () => {
    setTimeout(() => {
        Record_start();
    }, 200);
});
record_stop.addEventListener('pointerup',Record_stop)

crop_start.addEventListener("pointerup" , Crop_start)
crop_stop.addEventListener('pointerup', Crop_stop)

reset.addEventListener("pointerup" , Reset)

video.addEventListener('loadedmetadata', Resize);
window.addEventListener('resize', Resize);

overlay.addEventListener("pointerdown", (e) => {
    const pos = getMousePos(e);
    draggingPoint = findClosestPoint(pos);
    offset.x = points[draggingPoint].x - pos.x;
    offset.y = points[draggingPoint].y - pos.y;
});

overlay.addEventListener("pointermove", (e) => {
    if (draggingPoint !== null) {
        const pos = getMousePos(e);
        points[draggingPoint].x = pos.x + offset.x;
        points[draggingPoint].y = pos.y + offset.y;
        drawPolygon();
    }
});

overlay.addEventListener("pointerup", () => {
    draggingPoint = null;
});

overlay.addEventListener("pointercancel", () => {
    draggingPoint = null;
});

overlay.addEventListener("pointerleave", () => {
    draggingPoint = null;
});

let lastTap = 0;

video.addEventListener("pointerdown", (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
        warpAndPreview();
    }
    lastTap = now;
});

window.addEventListener("deviceorientation", (e) => {
    if (!recordFlag) return;
    if (e.alpha === null || e.beta === null || e.gamma === null) return;

    const current = {
        alpha: e.alpha,
        beta: e.beta,
        gamma: e.gamma
    };

    // pierwszy pomiar jako baza
    if (!baseOrientation) {
        baseOrientation = current;
        return;
    }

    const dAlpha = angleDiff(current.alpha, baseOrientation.alpha);
    const dBeta = Math.abs(current.beta - baseOrientation.beta);
    const dGamma = Math.abs(current.gamma - baseOrientation.gamma);

    if (
        dAlpha > ROTATION_THRESHOLD ||
        dBeta > ROTATION_THRESHOLD ||
        dGamma > ROTATION_THRESHOLD
    ) {
        Record_stop();
        flashRedEffect();

        // reset bazy
        baseOrientation = current;
    }
});

let startY = null;
let currentValue = null;
let mode = null; // "brightness" albo "exposure"

function setupBrightnessControl() {
    if (!stream) return;

    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities();
    const settings = track.getSettings();

    // log(JSON.stringify(capabilities));

    // 🔥 wybór trybu
    if (capabilities.brightness) {
        mode = "brightness";
        currentValue = settings.brightness ?? (capabilities.brightness.max + capabilities.brightness.min) / 2;
    } else if (capabilities.exposureCompensation) {
        mode = "exposure";
        currentValue = settings.exposureCompensation ?? 0;
    } else {
        return;
    }

    video.addEventListener("pointerdown", e => {
        startY = e.clientY;
    });

    video.addEventListener("pointermove", e => {
        if (startY === null) return;

        const delta = startY - e.clientY;

        let min, max;

        if (mode === "brightness") {
            min = capabilities.brightness.min;
            max = capabilities.brightness.max;
        } else {
            min = -2;
            max = 2;
        }

        const sensitivity = (max - min) / 300;
        let newValue = currentValue + delta * sensitivity;

        newValue = Math.max(min, Math.min(max, newValue));

        if (mode === "brightness") {
            track.applyConstraints({
                advanced: [{ brightness: newValue }]
            });
        } else {
            track.applyConstraints({
                advanced: [{
                    exposureMode: "manual",
                    exposureCompensation: newValue
                }]
            });
            // alert(newValue)
        }
    });

    video.addEventListener("pointerup", () => {
        const s = track.getSettings();

        if (mode === "brightness") {
            currentValue = s.brightness ?? currentValue;
        } else {
            currentValue = s.exposureCompensation ?? currentValue;
        }

        startY = null;
    });
}
// po uruchomieniu kamery:
StartCamera().then(() => {
    setupBrightnessControl();
});

// // ===== START =====
// StartCamera()

// let startY = null;
// let currentBrightness = null;
// const [track] = stream.getVideoTracks();
// const capabilities = track.getCapabilities();
// const settings = track.getSettings();

// // start z aktualnej jasności lub środka zakresu
// currentBrightness = settings.brightness ?? (capabilities.brightness.max + capabilities.brightness.min)/2;

// // ===== EVENTY =====
// video.addEventListener("pointerdown", e => {
//     startY = e.clientY;
// });

// video.addEventListener("pointermove", e => {
//     if (startY === null) return;
//     const delta = startY - e.clientY; // w górę → delta > 0
//     const sensitivity = (capabilities.brightness.max - capabilities.brightness.min) / 300; // ruch 300px → pełny zakres
//     let newBrightness = currentBrightness + delta * sensitivity;

//     // ograniczenia
//     newBrightness = Math.max(capabilities.brightness.min, Math.min(capabilities.brightness.max, newBrightness));

//     // zastosowanie
//     track.applyConstraints({
//         advanced: [{ brightness: newBrightness }]
//     });
// });

// video.addEventListener("pointerup", e => {
//     currentBrightness = track.getSettings().brightness ?? currentBrightness;
//     startY = null;
// });
