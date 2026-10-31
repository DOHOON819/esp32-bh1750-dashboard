const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC_ROOT = "dohoon819/esp32-light/04fa372de25d455cb9cbfb965edd2193";
const DATA_TOPIC = `${TOPIC_ROOT}/data`;
const STATUS_TOPIC = `${TOPIC_ROOT}/status`;
const MAX_POINTS = 30;

const elements = {
  connection: document.querySelector("#connection"),
  connectionText: document.querySelector("#connectionText"),
  lux: document.querySelector("#luxValue"),
  description: document.querySelector("#lightDescription"),
  soilPercent: document.querySelector("#soilPercent"),
  soilRaw: document.querySelector("#soilRaw"),
  soilDescription: document.querySelector("#soilDescription"),
  moistureFill: document.querySelector("#moistureFill"),
  lastSeen: document.querySelector("#lastSeen"),
  rssi: document.querySelector("#rssiValue"),
  uptime: document.querySelector("#uptimeValue"),
  canvas: document.querySelector("#luxChart"),
  chartEmpty: document.querySelector("#chartEmpty"),
  chartMin: document.querySelector("#chartMin"),
  chartMax: document.querySelector("#chartMax"),
  reconnect: document.querySelector("#reconnectButton"),
  waterStatus: document.querySelector("#waterStatus"),
  waterTitle: document.querySelector("#waterTitle"),
  waterDescription: document.querySelector("#waterDescription"),
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

function describeSoil(percent) {
  if (percent < 20) return "매우 건조해요 · 물을 확인하세요";
  if (percent < 40) return "조금 건조한 상태예요";
  if (percent < 70) return "적당한 수분 상태예요";
  if (percent < 90) return "충분히 촉촉해요";
  return "수분이 매우 많아요";
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

function sensorNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return NaN;
  }
  return Number(value);
}

function updateWaterStatus(payload) {
  if (typeof payload.waterEmpty !== "boolean") {
    elements.waterStatus.dataset.state = "unknown";
    elements.waterTitle.textContent = "물통 상태 확인 중";
    elements.waterDescription.textContent = "수위 정보가 아직 도착하지 않았어요";
    return;
  }
  elements.waterStatus.dataset.state = payload.waterEmpty ? "empty" : "ok";
  elements.waterTitle.textContent = payload.waterEmpty
    ? "물이 부족합니다"
    : "물통에 물이 있어요";
  elements.waterDescription.textContent = payload.waterEmpty
    ? "물통을 채워주세요. 자동 급수와 센서 측정을 멈췄어요."
    : "수위가 확인됐어요. 물 부족 경고가 해제됐습니다.";
}

function updateReading(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  lastMessageAt = Date.now();
  updateWaterStatus(payload);

  // 조도 오류가 있어도 토양 수분과 물통 상태는 계속 표시한다.
  const lux = sensorNumber(payload.lux);
  if (Number.isFinite(lux) && lux >= 0) {
    elements.lux.textContent = lux.toLocaleString("ko-KR", {
      maximumFractionDigits: 1,
    });
    elements.description.textContent = describeLux(lux);
    readings.push(lux);
    if (readings.length > MAX_POINTS) readings.shift();
    drawChart();
  } else {
    elements.lux.textContent = "--";
    elements.description.textContent = payload.waterEmpty
      ? "물 부족으로 측정을 멈췄어요"
      : "조도 센서 연결을 확인해주세요";
  }

  const soilRaw = sensorNumber(payload.soilRaw);
  const soilPercent = sensorNumber(payload.soilPercent);
  if (Number.isFinite(soilRaw) && Number.isFinite(soilPercent)) {
    const boundedPercent = Math.min(100, Math.max(0, soilPercent));
    elements.soilRaw.textContent = Math.round(soilRaw).toLocaleString("ko-KR");
    elements.soilPercent.textContent = boundedPercent.toLocaleString("ko-KR", {
      maximumFractionDigits: 1,
    });
    elements.soilDescription.textContent = payload.soilSensorError
      ? "수분 센서 오류 · 자동 급수를 멈췄어요"
      : payload.soilStale || payload.waterEmpty
        ? "측정 중단 전 마지막 수분 값이에요"
        : describeSoil(boundedPercent);
    elements.moistureFill.style.width = `${boundedPercent}%`;
  } else {
    elements.soilRaw.textContent = "--";
    elements.soilPercent.textContent = "--";
    elements.moistureFill.style.width = "0%";
    elements.soilDescription.textContent = payload.waterEmpty
      ? "물 부족으로 측정을 멈췄어요"
      : "수분 센서 값을 기다리고 있어요";
  }
  elements.rssi.textContent = Number.isFinite(sensorNumber(payload.rssi))
    ? `${payload.rssi} dBm`
    : "--";
  elements.uptime.textContent = formatUptime(sensorNumber(payload.uptime));
  updateLastSeen();
  return true;
}

function updateLastSeen() {
  if (!lastMessageAt) return;
  const seconds = Math.floor((Date.now() - lastMessageAt) / 1000);
  elements.lastSeen.textContent = seconds < 5 ? "방금 전" : `${seconds}초 전`;
  if (seconds > 20 && elements.connection.dataset.state !== "offline") {
    setConnection("offline", "센서 응답 없음");
  }
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
    client.subscribe(`${TOPIC_ROOT}/#`, { qos: 0 }, (error) => {
      if (error) {
        console.error("MQTT 구독 오류", error);
        setConnection("offline", "구독 오류");
      } else {
        console.info("MQTT 구독 완료", `${TOPIC_ROOT}/#`);
      }
    });
  });

  client.on("message", (topic, message) => {
    const text = message.toString();
    if (topic === STATUS_TOPIC) {
      if (text === "online") {
        const recent = lastMessageAt && Date.now() - lastMessageAt <= 20000;
        setConnection(recent ? "online" : "connecting", recent ? "센서 연결됨" : "센서 데이터 대기");
      } else {
        setConnection("offline", "센서 꺼짐");
      }
      return;
    }

    if (topic === DATA_TOPIC) {
      try {
        if (updateReading(JSON.parse(text))) {
          setConnection("online", "센서 연결됨");
        }
      } catch (error) {
        console.error("센서 데이터 형식 오류", error);
      }
    }
  });

  client.on("reconnect", () => setConnection("connecting", "재연결 중"));
  client.on("offline", () => setConnection("offline", "네트워크 끊김"));
  client.on("error", (error) => {
    console.error("MQTT 연결 오류", error);
    setConnection("offline", "연결 오류");
  });
}

elements.reconnect.addEventListener("click", connect);
window.addEventListener("resize", drawChart);
setInterval(updateLastSeen, 1000);
connect();
