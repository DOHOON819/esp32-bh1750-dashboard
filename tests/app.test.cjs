const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const topic = "dohoon819/esp32-light/04fa372de25d455cb9cbfb965edd2193/data";

function dashboard() {
  let now = 100000;
  const elements = new Map();
  const handlers = {};
  const intervals = [];
  const context2d = new Proxy({}, {
    get: (_, key) => key === "createLinearGradient"
      ? () => ({ addColorStop() {} })
      : () => {},
  });
  const client = {
    on(name, handler) { handlers[name] = handler; },
    subscribe(_, __, callback) { callback(null); },
    end() {},
  };
  const sandbox = {
    document: {
      querySelector(selector) {
        assert.ok(html.includes(`id="${selector.slice(1)}"`), `Missing element ${selector}`);
        if (!elements.has(selector)) {
          elements.set(selector, {
            textContent: "--", dataset: {}, style: {}, hidden: false,
            addEventListener() {},
            getBoundingClientRect: () => ({ width: 400, height: 190 }),
            getContext: () => context2d,
          });
        }
        return elements.get(selector);
      },
    },
    mqtt: { connect: () => client },
    window: { devicePixelRatio: 1, addEventListener() {} },
    crypto: { randomUUID: () => "abcd-1234-5678-9012" },
    Date: class extends Date { static now() { return now; } },
    console: { info() {}, error() {} },
    setInterval(fn) { intervals.push(fn); },
  };
  vm.runInNewContext(source, sandbox, { filename: "app.js" });
  handlers.connect();
  return {
    el: (id) => elements.get(`#${id}`),
    send: (payload) => handlers.message(topic, Buffer.from(JSON.stringify(payload))),
    tick(seconds) { now += seconds * 1000; intervals.forEach((fn) => fn()); },
  };
}

test("BH1750 failure does not discard the user's soil reading", () => {
  const app = dashboard();
  app.send({ lux: -1, soilRaw: 193, soilPercent: 7.2, rssi: -74, uptime: 228 });
  assert.equal(app.el("soilRaw").textContent, "193");
  assert.equal(app.el("soilPercent").textContent, "7.2");
  assert.equal(app.el("luxValue").textContent, "--");
  assert.equal(app.el("connection").dataset.state, "online");
  assert.equal(app.el("waterStatus").dataset.state, "unknown");
});

test("empty tank before any measurement shows an alert, not a false 0%", () => {
  const app = dashboard();
  app.send({ lux: -1, soilRaw: null, soilPercent: null, waterEmpty: true, soilStale: true });
  assert.equal(app.el("waterStatus").dataset.state, "empty");
  assert.equal(app.el("waterTitle").textContent, "물이 부족합니다");
  assert.match(app.el("waterDescription").textContent, /물통을 채워주세요/);
  assert.equal(app.el("soilPercent").textContent, "--");
  assert.equal(app.el("soilRaw").textContent, "--");
});

test("tank recovery clears the alert and replaces the paused soil reading", () => {
  const app = dashboard();
  app.send({ lux: -1, soilRaw: 193, soilPercent: 7.2, waterEmpty: true, soilStale: true });
  assert.match(app.el("soilDescription").textContent, /마지막/);
  app.send({ lux: 300, soilRaw: 2650, soilPercent: 99.3, waterEmpty: false, soilStale: false });
  assert.equal(app.el("waterStatus").dataset.state, "ok");
  assert.equal(app.el("soilPercent").textContent, "99.3");
  assert.equal(app.el("luxValue").textContent, "300");
  assert.doesNotMatch(app.el("soilDescription").textContent, /마지막/);
});

test("zero readings are valid and a soil sensor error is explained", () => {
  const app = dashboard();
  app.send({ lux: 0, soilRaw: 0, soilPercent: 0, waterEmpty: false, soilSensorError: true });
  assert.equal(app.el("luxValue").textContent, "0");
  assert.equal(app.el("soilPercent").textContent, "0");
  assert.match(app.el("soilDescription").textContent, /센서 오류/);
});

test("a stopped stream is marked as unresponsive", () => {
  const app = dashboard();
  app.send({ lux: -1, soilRaw: 193, soilPercent: 7.2 });
  app.tick(21);
  assert.equal(app.el("connection").dataset.state, "offline");
  assert.equal(app.el("connectionText").textContent, "센서 응답 없음");
});

test("non-object data cannot claim a working sensor connection", () => {
  const app = dashboard();
  app.send(null);
  app.send([]);
  assert.notEqual(app.el("connection").dataset.state, "online");
});
