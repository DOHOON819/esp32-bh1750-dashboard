# ESP32 BH1750 실시간 조도 대시보드

ESP32가 BH1750 조도값과 SEN0114 토양 수분값을 MQTT로 전송하고, GitHub Pages 대시보드에서 휴대폰으로 확인하는 프로젝트입니다.

## 준비

Arduino IDE의 라이브러리 관리자에서 다음 라이브러리를 설치합니다.

- `BH1750` by Christopher Laws
- `PubSubClient` by Nick O'Leary

ESP32 보드 패키지는 `esp32 by Espressif Systems`를 사용합니다.

## ESP32 설정

1. `esp32/esp32_bh1750_mqtt/secrets.example.h`를 같은 폴더의 `secrets.h`로 복사합니다.
2. `secrets.h`에 Wi-Fi 이름과 비밀번호를 입력합니다.
3. `esp32/esp32_bh1750_mqtt/esp32_bh1750_mqtt.ino`를 Arduino IDE에서 엽니다.
4. 보드와 포트를 선택하고 업로드합니다.
5. 시리얼 모니터를 115200 baud로 열어 연결 및 전송 로그를 확인합니다.

BH1750 배선:

| BH1750 | ESP32 |
| --- | --- |
| VCC | 3.3V |
| GND | GND |
| SDA | GPIO21 |
| SCL | GPIO22 |

SEN0114 배선:

| SEN0114 | ESP32 |
| --- | --- |
| 빨간색/VCC | 3.3V |
| 검은색/GND | GND |
| 파란색/Signal | GPIO34 |

토양 수분 보정값은 `Dry=0`, `Wet=2670`이며 웹사이트에는 0~100%로 환산해 표시합니다.

## 작동 구조

```text
BH1750 → ESP32 → 공개 MQTT 테스트 서버 → GitHub Pages → 휴대폰
```

ESP32는 5초마다 조도, 토양 수분 원시값/백분율, Wi-Fi 신호 세기, 가동 시간을 전송합니다. 마지막 데이터는 MQTT retained 메시지로 저장되어 페이지를 새로 열어도 바로 표시됩니다.

## 주의

이 프로젝트는 빠른 테스트를 위해 EMQX의 공개 MQTT 브로커를 사용합니다. 센서 데이터는 암호화된 전용 저장소가 아니며, 운영 환경이나 개인정보가 포함된 데이터에는 적합하지 않습니다. 장기 운영 시 전용 MQTT 브로커 또는 인증이 있는 IoT 서비스를 사용하세요.
