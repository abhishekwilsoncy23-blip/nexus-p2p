let pc, dataChannel, roomCode, selectedNetwork;
let writer, fileStream; // For StreamSaver
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

const client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

// --- 1. UI SETUP ---
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('net-local').addEventListener('click', () => setNetwork('local'));
    document.getElementById('net-internet').addEventListener('click', () => setNetwork('internet'));
    document.getElementById('role-send').addEventListener('click', () => setRole('send'));
    document.getElementById('role-receive').addEventListener('click', () => setRole('receive'));
    document.getElementById('back-to-1').addEventListener('click', () => showStep(1));
    document.getElementById('start-transfer').addEventListener('click', transferFile);
    document.getElementById('join-btn').addEventListener('click', joinSession);
    document.querySelectorAll('.cancel-btn').forEach(btn => btn.addEventListener('click', () => location.reload()));
});

function setNetwork(net) {
    selectedNetwork = net;
    document.getElementById('network-title').innerText = net === 'local' ? "🏠 Local Path" : "🌍 Internet Path";
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
            client.publish(`nexus/large/${roomCode}/${type}`, sdp, { retain: true });
        }
    };

    pc.oniceconnectionstatechange = () => {
        statusEl.innerText = pc.iceConnectionState.toUpperCase();
        if (pc.iceConnectionState === 'connected') {
            statusEl.innerText = "LINK ACTIVE 🟢";
            updateLog("<b>P2P Stream Established.</b>");
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
    dataChannel = pc.createDataChannel("nexus-stream", { ordered: true });
    setupDataChannel();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    client.subscribe(`nexus/large/${roomCode}/ans`);
}

function joinSession() {
    roomCode = document.getElementById('input-code').value;
    if (roomCode.length !== 6) return;
    createConnection(false);
    client.subscribe(`nexus/large/${roomCode}/off`);
    updateLog("Connecting to stream...");
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

            // Direct-to-disk write stream
            fileStream = window.streamSaver.createWriteStream(meta.name, { size: meta.size });
            writer = fileStream.getWriter();
        } else {
            const chunk = new Uint8Array(e.data);
            await writer.write(chunk);
            window.receivedBytes += chunk.byteLength;

            if (window.receivedBytes >= window.incomingMeta.size) {
                await writer.close();
                updateLog("✅ File saved successfully.");
            }
        }
    };
}

async function transferFile() {
    const file = document.getElementById('file-pick').files[0];
    const bar = document.getElementById('prog-bar');
    const speedTag = document.getElementById('speed-tag');
    if (!file || !dataChannel || dataChannel.readyState !== "open") return alert("Not Connected");

    dataChannel.send(JSON.stringify({ name: file.name, size: file.size }));
    
    const CHUNK_SIZE = 65536; // 64KB chunks for high performance
    let offset = 0;
    bar.style.display = 'block';
    let startTime = Date.now();

    while (offset < file.size) {
        // Backpressure check: wait if buffer > 2MB to prevent crash
        if (dataChannel.bufferedAmount > 2 * 1024 * 1024) {
            await new Promise(r => setTimeout(r, 40));
            continue;
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        dataChannel.send(buffer);
        
        offset += CHUNK_SIZE;
        bar.value = (offset / file.size) * 100;

        // Speed calculation
        let elapsed = (Date.now() - startTime) / 1000;
        let mbps = (offset / 1024 / 1024 / elapsed).toFixed(2);
        speedTag.innerText = `Speed: ${mbps} MB/s`;
    }

    updateLog(`🚀 Finished sending ${file.name}`);
    bar.style.display = 'none';
}

function updateLog(m) {
    const d = document.createElement('div');
    d.innerHTML = m;
    logEl.appendChild(d);
}

client.on('connect', () => { statusEl.innerText = "READY"; });
