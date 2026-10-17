const BROKER_URL = "wss://broker.hivemq.com:8884/mqtt";
const TOPIC_ROOT = "dohoon819/esp32-light/04fa372de25d455cb9cbfb965edd2193";
const DATA_TOPIC = `${TOPIC_ROOT}/data`;
const STATUS_TOPIC = `${TOPIC_ROOT}/status`;
const MAX_POINTS = 30;

const elements = {
  connection: document.querySelector("#connection"),
  connectionText: document.querySelector("#connectionText"),
  lux: document.querySelector("#luxValue"),
  description: document.querySelector("#lightDescription"),
  lastSeen: document.querySelector("#lastSeen"),
  rssi: document.querySelector("#rssiValue"),
  uptime: document.querySelector("#uptimeValue"),
  canvas: document.querySelector("#luxChart"),
  chartEmpty: document.querySelector("#chartEmpty"),
  chartMin: document.querySelector("#chartMin"),
  chartMax: document.querySelector("#chartMax"),
  reconnect: document.querySelector("#reconnectButton"),
};

let client;
let lastMessageAt = 0;
const readings = [];

function setConnection(state, text) {
  elements.connection.dataset.state = state;
  elements.connectionText.textContent = text;
}

function describeLux(lux) {
  if (lux < 10) return "매우 어두운 상태예요";
  if (lux < 50) return "어두운 실내 밝기예요";
  if (lux < 300) return "편안한 실내 밝기예요";
  if (lux < 1000) return "밝은 실내 환경이에요";
  if (lux < 10000) return "매우 밝은 빛이 감지됐어요";
  return "강한 햇빛 수준이에요";
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}

function updateReading(payload) {
  const lux = Number(payload.lux);
  if (!Number.isFinite(lux) || lux < 0) return;

  lastMessageAt = Date.now();
  elements.lux.textContent = lux.toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  });
  elements.description.textContent = describeLux(lux);
  elements.rssi.textContent = Number.isFinite(Number(payload.rssi))
    ? `${payload.rssi} dBm`
    : "--";
  elements.uptime.textContent = formatUptime(Number(payload.uptime));

  readings.push(lux);
  if (readings.length > MAX_POINTS) readings.shift();
  drawChart();
  updateLastSeen();
}

function updateLastSeen() {
  if (!lastMessageAt) return;
  const seconds = Math.floor((Date.now() - lastMessageAt) / 1000);
  elements.lastSeen.textContent = seconds < 5 ? "방금 전" : `${seconds}초 전`;
}

function drawChart() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const padding = 8;

  ctx.clearRect(0, 0, width, height);
  if (readings.length === 0) return;
  elements.chartEmpty.hidden = true;

  const min = Math.min(...readings);
  const max = Math.max(...readings);
  const spread = Math.max(max - min, 10);
  const floor = Math.max(0, min - spread * 0.15);
  const ceiling = max + spread * 0.15;

  const points = readings.map((value, index) => ({
    x: readings.length === 1
      ? width / 2
      : padding + (index / (readings.length - 1)) * (width - padding * 2),
    y: height - padding - ((value - floor) / (ceiling - floor)) * (height - padding * 2),
  }));

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(86, 242, 155, 0.32)");
  gradient.addColorStop(1, "rgba(86, 242, 155, 0)");

  ctx.beginPath();
  ctx.moveTo(points[0].x, height);
  points.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points.at(-1).x, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = "#62f3a2";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(98, 243, 162, 0.5)";
  ctx.shadowBlur = 10;
  ctx.stroke();

  elements.chartMin.textContent = `${Math.round(floor).toLocaleString()} lux`;
  elements.chartMax.textContent = `${Math.round(ceiling).toLocaleString()} lux`;
}

function connect() {
  if (client) client.end(true);
  setConnection("connecting", "연결 중");

  client = mqtt.connect(BROKER_URL, {
    clientId: `web_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
  });

  client.on("connect", () => {
    setConnection("connecting", "센서 확인 중");
    client.subscribe([DATA_TOPIC, STATUS_TOPIC]);
  });

  client.on("message", (topic, message) => {
    const text = message.toString();
    if (topic === STATUS_TOPIC) {
      setConnection(text === "online" ? "online" : "offline", text === "online" ? "센서 연결됨" : "센서 꺼짐");
      return;
    }

    if (topic === DATA_TOPIC) {
      try {
        updateReading(JSON.parse(text));
        setConnection("online", "센서 연결됨");
      } catch (error) {
        console.error("센서 데이터 형식 오류", error);
      }
    }
  });

  client.on("reconnect", () => setConnection("connecting", "재연결 중"));
  client.on("offline", () => setConnection("offline", "네트워크 끊김"));
  client.on("error", () => setConnection("offline", "연결 오류"));
}

elements.reconnect.addEventListener("click", connect);
window.addEventListener("resize", drawChart);
setInterval(updateLastSeen, 1000);
connect();

