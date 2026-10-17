#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>
#include "secrets.h"

constexpr int SDA_PIN = 21;
constexpr int SCL_PIN = 22;
constexpr uint8_t BH1750_ADDRESS = 0x23;

const char* MQTT_HOST = "broker.hivemq.com";
constexpr uint16_t MQTT_PORT = 1883;
const char* MQTT_TOPIC_DATA =
    "dohoon819/esp32-light/04fa372de25d455cb9cbfb965edd2193/data";
const char* MQTT_TOPIC_STATUS =
    "dohoon819/esp32-light/04fa372de25d455cb9cbfb965edd2193/status";

constexpr unsigned long PUBLISH_INTERVAL_MS = 5000;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
constexpr unsigned long MQTT_RETRY_INTERVAL_MS = 5000;

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
BH1750 lightMeter;

unsigned long lastPublishAt = 0;
unsigned long lastWiFiAttemptAt = 0;
unsigned long lastMqttAttemptAt = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  const unsigned long now = millis();
  if (lastWiFiAttemptAt != 0 && now - lastWiFiAttemptAt < WIFI_RETRY_INTERVAL_MS) {
    return;
  }

  lastWiFiAttemptAt = now;
  Serial.print("Wi-Fi 연결 중: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) return;

  const unsigned long now = millis();
  if (lastMqttAttemptAt != 0 && now - lastMqttAttemptAt < MQTT_RETRY_INTERVAL_MS) {
    return;
  }
  lastMqttAttemptAt = now;

  String clientId = "esp32-light-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.print("MQTT 연결 중...");

  const bool connected = mqttClient.connect(
      clientId.c_str(),
      MQTT_TOPIC_STATUS,
      0,
      true,
      "offline"
  );

  if (connected) {
    Serial.println("완료");
    mqttClient.publish(MQTT_TOPIC_STATUS, "online", true);
  } else {
    Serial.print("실패, 코드: ");
    Serial.println(mqttClient.state());
  }
}

void publishReading() {
  if (!mqttClient.connected()) return;

  const float lux = lightMeter.readLightLevel();
  if (lux < 0) {
    Serial.println("BH1750 읽기 실패");
    return;
  }

  char payload[128];
  snprintf(
      payload,
      sizeof(payload),
      "{\"lux\":%.1f,\"rssi\":%d,\"uptime\":%lu}",
      lux,
      WiFi.RSSI(),
      millis() / 1000UL
  );

  if (mqttClient.publish(MQTT_TOPIC_DATA, payload, true)) {
    Serial.print("전송: ");
    Serial.println(payload);
  } else {
    Serial.println("MQTT 전송 실패");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  if (!lightMeter.begin(
          BH1750::CONTINUOUS_HIGH_RES_MODE,
          BH1750_ADDRESS,
          &Wire)) {
    Serial.println("BH1750 초기화 실패: 배선과 주소를 확인하세요.");
    while (true) delay(1000);
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(256);
  connectWiFi();
  Serial.println("ESP32 조도 센서 시작");
}

void loop() {
  connectWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    connectMqtt();
    mqttClient.loop();
  }

  const unsigned long now = millis();
  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publishReading();
  }

  delay(10);
}

