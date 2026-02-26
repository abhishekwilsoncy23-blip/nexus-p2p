let pc, dataChannel, roomCode, selectedNetwork;
let writer, fileStream; 
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

const client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

// --- 1. UI & DRAG-AND-DROP SETUP ---
document.addEventListener('DOMContentLoaded', () => {
    // Basic Navigation
    document.getElementById('net-local').addEventListener('click', () => setNetwork('local'));
    document.getElementById('net-internet').addEventListener('click', () => setNetwork('internet'));
    document.getElementById('role-send').addEventListener('click', () => setRole('send'));
    document.getElementById('role-receive').addEventListener('click', () => setRole('receive'));
    document.getElementById('back-to-1').addEventListener('click', () => showStep(1));
    document.getElementById('start-transfer').addEventListener('click', transferFile);
    document.getElementById('join-btn').addEventListener('click', joinSession);
    document.querySelectorAll('.cancel-btn').forEach(btn => btn.addEventListener('click', () => location.reload()));

    // Drag and Drop Logic
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-pick');
    const fileNameDisplay = document.getElementById('file-name-display');

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) showSelectedFile(fileInput.files[0].name);
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = "var(--primary)";
        dropZone.style.background = "rgba(59, 130, 246, 0.05)";
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = "var(--border)";
        dropZone.style.background = "rgba(0,0,0,0.2)";
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = "var(--border)";
        dropZone.style.background = "rgba(0,0,0,0.2)";
        if (e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files; 
            showSelectedFile(fileInput.files[0].name);
        }
    });

    function showSelectedFile(name) {
        dropZone.style.display = 'none';
        fileNameDisplay.style.display = 'block';
        fileNameDisplay.innerHTML = `<i class='bx bx-check-circle'></i> Ready: <b>${name}</b>`;
    }
});

function setNetwork(net) {
    selectedNetwork = net;
    document.getElementById('network-title').innerText = net === 'local' ? "Local Path" : "Global Path";
    showStep(2);
}

function setRole(role) {
    role === 'send' ? hostSession() : showStep('receive');
    if (role === 'send') showStep('send');
}

function showStep(s) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('step-' + s).classList.add('active');
}

// --- 2. WebRTC & SIGNALING ---
function createConnection(isHost) {
    const iceConfig = selectedNetwork === 'local' 
        ? { iceServers: [] } 
        : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    pc = new RTCPeerConnection(iceConfig);
    
    pc.onicecandidate = ({candidate}) => {
        if (!candidate && pc.localDescription) {
            const type = pc.localDescription.type === 'offer' ? 'off' : 'ans';
            const sdp = btoa(JSON.stringify(pc.localDescription));
            client.publish(`peerdrop/v1/${roomCode}/${type}`, sdp, { retain: true });
        }
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected') {
            statusEl.innerHTML = "<i class='bx bx-check-shield'></i> SECURE LINK ACTIVE";
            statusEl.classList.add('online');
            updateLog("<b>End-to-End Encrypted Tunnel Established.</b>");
        }
    };

    if (!isHost) {
        pc.ondatachannel = (e) => {
            dataChannel = e.channel;
            setupDataChannel();
        };
    }
}

async function hostSession() {
    roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    document.getElementById('send-code-display').innerText = roomCode;
    createConnection(true);
    dataChannel = pc.createDataChannel("peerdrop-stream", { ordered: true });
    setupDataChannel();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    client.subscribe(`peerdrop/v1/${roomCode}/ans`);
}

function joinSession() {
    roomCode = document.getElementById('input-code').value;
    if (roomCode.length !== 6) return;
    createConnection(false);
    client.subscribe(`peerdrop/v1/${roomCode}/off`);
    updateLog("Connecting to secure stream...");
}

client.on('message', async (topic, msg) => {
    const sdp = JSON.parse(atob(msg.toString()));
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (topic.endsWith('/off')) {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
    }
});

// --- 3. STREAMING DATA (LARGE FILE SUPPORT) ---
function setupDataChannel() {
    dataChannel.binaryType = "arraybuffer";

    dataChannel.onmessage = async (e) => {
        if (typeof e.data === 'string') {
            const meta = JSON.parse(e.data);
            window.incomingMeta = meta;
            window.receivedBytes = 0;
            updateLog(`📥 Streaming: ${meta.name} (${(meta.size/1024/1024).toFixed(2)} MB)`);

            fileStream = window.streamSaver.createWriteStream(meta.name, { size: meta.size });
            writer = fileStream.getWriter();
        } else {
            const chunk = new Uint8Array(e.data);
            await writer.write(chunk);
            window.receivedBytes += chunk.byteLength;

            if (window.receivedBytes >= window.incomingMeta.size) {
                await writer.close();
                updateLog("✅ Transfer Complete. File saved securely.");
            }
        }
    };
}

async function transferFile() {
    const file = document.getElementById('file-pick').files[0];
    const bar = document.getElementById('prog-bar');
    const speedTag = document.getElementById('speed-tag');
    if (!file || !dataChannel || dataChannel.readyState !== "open") return alert("Connect to a peer and select a file first.");

    dataChannel.send(JSON.stringify({ name: file.name, size: file.size }));
    
    const CHUNK_SIZE = 65536; 
    let offset = 0;
    bar.style.display = 'block';
    let startTime = Date.now();

    while (offset < file.size) {
        if (dataChannel.bufferedAmount > 2 * 1024 * 1024) {
            await new Promise(r => setTimeout(r, 40));
            continue;
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        dataChannel.send(buffer);
        
        offset += CHUNK_SIZE;
        bar.value = (offset / file.size) * 100;

        let elapsed = (Date.now() - startTime) / 1000;
        let mbps = (offset / 1024 / 1024 / elapsed).toFixed(2);
        speedTag.innerText = `Transfer Rate: ${mbps} MB/s`;
    }

    updateLog(`🚀 Finished sending ${file.name}`);
    bar.style.display = 'none';
}

function updateLog(m) {
    const d = document.createElement('div');
    d.innerHTML = m;
    logEl.appendChild(d);
}

client.on('connect', () => { 
    statusEl.innerHTML = "<i class='bx bx-radio-circle-marked'></i> SIGNALING READY"; 
});
