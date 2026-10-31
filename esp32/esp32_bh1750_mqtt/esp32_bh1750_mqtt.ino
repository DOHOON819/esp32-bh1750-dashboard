#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>
#include "secrets.h"

// ESP32 DevKit V1 센서 및 모터 설정
constexpr int SOIL_PIN = 34;
constexpr int MOTOR_PIN = 26;
constexpr int WATER_LEVEL_PIN = 27;  // 수위 센서: D27
constexpr int WATER_EMPTY_LEVEL = HIGH;
constexpr int SDA_PIN = 21;
constexpr int SCL_PIN = 22;
constexpr uint8_t BH1750_ADDRESS = 0x23;

// 토양 수분 센서 보정값
constexpr int DRY_VALUE = 0;
constexpr int WET_VALUE = 2670;
constexpr int SOIL_START_THRESHOLD = 2200;
constexpr int SOIL_STOP_THRESHOLD = 2650;

// 기존 급수 동작: 최대 5초 가동 후 60초 대기, 수위 복구는 1초 확인
constexpr int MOTOR_PWM = 255;
constexpr unsigned long MOTOR_DURATION_MS = 5000;
constexpr unsigned long SOIL_SETTLE_MS = 60000;
constexpr unsigned long WATER_RECOVERY_MS = 1000;

const char* MQTT_HOST = "broker.emqx.io";
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
unsigned long lastSoilReadingAt = 0;
bool lightSensorOK = false;
bool soilReadingReady = false;
bool soilSensorError = false;  // 오류 발생 시 재시작 전까지 자동 급수 차단
bool waterEmpty = false;  // 물 부족 시 급수와 측정 중단, 상태 전송은 유지
bool telemetryPending = true;
bool waterRecoveryPending = false;
unsigned long waterDetectedAt = 0;
int soilRaw = 0;
float soilPercent = 0;
bool wateringActive = false;
bool pumpRunning = false;
bool waitingForSoil = false;
unsigned long pumpStartedAt = 0;
unsigned long pumpStoppedAt = 0;

bool checkWaterLevel() {
  if (digitalRead(WATER_LEVEL_PIN) == WATER_EMPTY_LEVEL) {
    waterRecoveryPending = false;
    if (!waterEmpty) {
      // 일반 급수 종료와 달리 토양 안정화 대기나 다음 급수를 예약하지 않는다.
      analogWrite(MOTOR_PIN, 0);
      pumpRunning = false;
      wateringActive = false;
      waitingForSoil = false;
      soilReadingReady = false;
      waterEmpty = true;
      telemetryPending = true;
      Serial.println("물이 없습니다. 급수와 측정을 중단하고 웹으로 알립니다. 물을 채우면 자동으로 재개합니다.");
    }
    return false;
  }
  if (!waterEmpty) return true;

  // 물결이나 접점 흔들림으로 반복 재개되지 않도록 1초간 수위를 확인한다.
  if (!waterRecoveryPending) {
    waterRecoveryPending = true;
    waterDetectedAt = millis();
  }
  if (millis() - waterDetectedAt < WATER_RECOVERY_MS) return false;

  waterEmpty = false;
  waterRecoveryPending = false;
  soilReadingReady = false;
  telemetryPending = true;
  Serial.println("물이 채워졌습니다. 토양 수분을 다시 측정하고 작업을 재개합니다.");
  return true;
}

void readSoil() {
  if (waterEmpty) return;
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    // 급수 중일 때만 토양 측정 사이에도 수위를 확인한다.
    if (pumpRunning && !checkWaterLevel()) return;
    sum += analogRead(SOIL_PIN);
    delay(10);
  }
  if (pumpRunning && !checkWaterLevel()) return;
  soilRaw = sum / 10;
  if (soilRaw == 0) {
    const bool pumpWasRunning = pumpRunning;
    analogWrite(MOTOR_PIN, 0);
    pumpRunning = false;
    wateringActive = false;
    waitingForSoil = false;
    if (!soilSensorError) {
      Serial.println("토양수분센서 오류: 원시값 0. 자동 급수 중단. 센서 점검 후 재시작하세요.");
    }
    soilSensorError = true;
    // 토양 센서 오류로 급수를 끝낸 경우에도 종료 직후 수위를 확인한다.
    if (pumpWasRunning && !checkWaterLevel()) return;
  }
  soilPercent = (float)(soilRaw - DRY_VALUE) * 100.0f /
                (WET_VALUE - DRY_VALUE);
  soilPercent = constrain(soilPercent, 0.0f, 100.0f);
  soilReadingReady = true;

  Serial.print("Soil ADC: ");
  Serial.println(soilRaw);
  Serial.print("Soil Moisture (calibrated): ");
  Serial.print(soilPercent, 1);
  Serial.println(" %");

  lastSoilReadingAt = millis();
}

void stopPump() {
  analogWrite(MOTOR_PIN, 0);
  pumpRunning = false;
  waitingForSoil = true;
  pumpStoppedAt = millis();
  // 펌프를 끈 직후 한 번 확인한다. 이후 안정화 대기 중에는 읽지 않는다.
  if (!checkWaterLevel()) return;
  Serial.println("펌프 정지: 60초 동안 토양 안정화 대기");
}

void updateWatering() {
  if (waterEmpty || soilSensorError) return;
  if (pumpRunning && !checkWaterLevel()) return;
  const unsigned long now = millis();
  if (pumpRunning && now - pumpStartedAt >= MOTOR_DURATION_MS) {
    stopPump();
  }
  if (waterEmpty || !soilReadingReady) return;

  // 상한에 도달하면 급수 종료. 다음 급수는 시작 임계값 이하일 때 시작.
  if (soilRaw >= SOIL_STOP_THRESHOLD) {
    wateringActive = false;
    if (pumpRunning) stopPump();
  }
  if (waterEmpty || pumpRunning) return;

  // 펌프를 끈 뒤에는 반드시 1분을 기다리고 새 측정값으로 판단.
  if (waitingForSoil) {
    if (millis() - pumpStoppedAt < SOIL_SETTLE_MS) return;
    readSoil();
    if (waterEmpty || soilSensorError) return;
    waitingForSoil = false;
    if (soilRaw >= SOIL_STOP_THRESHOLD) wateringActive = false;
  }

  if (soilRaw <= SOIL_START_THRESHOLD) wateringActive = true;
  if (wateringActive) {
    // 실제로 펌프를 켜려는 시점에만 급수 전 수위를 확인한다.
    if (!checkWaterLevel()) return;
    analogWrite(MOTOR_PIN, MOTOR_PWM);
    pumpStartedAt = millis();
    pumpRunning = true;
    Serial.println("펌프 가동: PWM 255, 최대 5초");
  }
}

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
    telemetryPending = true;
  } else {
    Serial.print("실패, 코드: ");
    Serial.println(mqttClient.state());
  }
}

void publishReading() {
  if (!mqttClient.connected()) return;

  const float lux = !waterEmpty && lightSensorOK ? lightMeter.readLightLevel() : -1;
  if (!waterEmpty && lux < 0) {
    Serial.println("BH1750 읽기 실패");
  }

  // 물 부족으로 아직 측정하지 못한 값은 0 대신 null로 전송한다.
  char soilRawText[16] = "null";
  char soilPercentText[16] = "null";
  if (lastSoilReadingAt != 0) {
    snprintf(soilRawText, sizeof(soilRawText), "%d", soilRaw);
    snprintf(soilPercentText, sizeof(soilPercentText), "%.1f", soilPercent);
  }

  char payload[256];
  snprintf(
      payload,
      sizeof(payload),
      "{\"lux\":%.1f,\"soilRaw\":%s,\"soilPercent\":%s,\"waterEmpty\":%s,\"soilSensorError\":%s,\"soilStale\":%s,\"rssi\":%d,\"uptime\":%lu}",
      lux,
      soilRawText,
      soilPercentText,
      waterEmpty ? "true" : "false",
      soilSensorError ? "true" : "false",
      (waterEmpty || lastSoilReadingAt == 0) ? "true" : "false",
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
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);
  Serial.begin(115200);
  pinMode(WATER_LEVEL_PIN, INPUT_PULLUP);
  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);

  Wire.begin(SDA_PIN, SCL_PIN);
  lightSensorOK = lightMeter.begin(
      BH1750::CONTINUOUS_HIGH_RES_MODE, BH1750_ADDRESS);
  Serial.println(lightSensorOK ? "BH1750 connected!" : "BH1750 connection failed!");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);
  mqttClient.setSocketTimeout(3);
  checkWaterLevel();
  connectWiFi();
}

void loop() {
  // 물 부족으로 급수를 보류한 경우에는 재시도 전 수위를 계속 확인한다.
  // 일반 대기 중에는 수위 센서를 읽지 않는다.
  if (waterEmpty) checkWaterLevel();
  if (!waterEmpty) {
    updateWatering();
    // 네트워크 연결 여부와 관계없이 토양수분 측정 및 모터 제어
    if (!waterEmpty && (!soilReadingReady || millis() - lastSoilReadingAt >= 2000UL)) {
      readSoil();
    }
    updateWatering();
  }

  // 네트워크 호출이 지연되어도 펌프의 정지 시간이 늘어나지 않도록 한다.
  if (pumpRunning) {
    delay(1);
    return;
  }

  connectWiFi();
  connectMqtt();
  mqttClient.loop();

  const unsigned long now = millis();
  if (mqttClient.connected() &&
      (telemetryPending || now - lastPublishAt >= PUBLISH_INTERVAL_MS)) {
    lastPublishAt = now;
    telemetryPending = false;
    publishReading();
  }
  delay(1);
}
