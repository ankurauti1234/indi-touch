#!/usr/bin/env python3
# api/system.py — System status, brightness, shutdown, restart, weather

import os
import sys
import subprocess
import socket
import time
import threading
import requests

from flask import Blueprint, jsonify, request

from .config import SYSTEM_FILES, METER_ID

# Ensure utils path is available for AWS IoT credentials
if "/opt/apm/scripts/utils" not in sys.path:
    sys.path.insert(0, "/opt/apm/scripts/utils")

try:
    from aws_iot_credentials import get_credentials
except ImportError:
    get_credentials = None

system_bp = Blueprint("system", __name__)

# Common RPi backlight paths
BACKLIGHT_PATHS = [
    "/sys/class/backlight/1-0045",      # User's specific path
    "/sys/class/backlight/rpi_backlight",
    "/sys/class/backlight/soc:backlight"
]

def get_backlight_path():
    for p in BACKLIGHT_PATHS:
        if os.path.exists(p):
            return p
    return None

def get_ip_address():
    """Finds the local IP address, prioritizing external connectivity but falling back to interface-specific checks."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    return "127.0.0.1"

def get_mac_address():
    try:
        for interface in ["wlan0", "eth0", "enp1s0"]:
            path = f"/sys/class/net/{interface}/address"
            if os.path.exists(path):
                with open(path, "r") as f:
                    return f.read().strip().upper()
    except Exception:
        pass
    return "00:00:00:00:00:00"

# ── GET /api/system/status ────────────────────────────────────────────────────
@system_bp.route("/status", methods=["GET"])
def system_status():
    """Unified status of all /run file indicators + network info."""
    wifi_ok = False
    try:
        r = subprocess.run(["nmcli", "-t", "-g", "GENERAL.STATE", "device", "show", "wlan0"], 
                           capture_output=True, text=True, timeout=2)
        if "connected" in r.stdout.lower():
            wifi_ok = True
    except:
        wifi_ok = os.path.exists(SYSTEM_FILES["wifi_up"])

    ble_available = os.path.exists(SYSTEM_FILES["bluetooth_available"])
    tv_on = True
    
    if ble_available:
        if os.path.exists(SYSTEM_FILES["tv_status"]):
            try:
                with open(SYSTEM_FILES["tv_status"], "r") as f:
                    tv_state = f.read().strip().upper()
                    tv_on = (tv_state == "ON")
            except:
                tv_on = False
        else:
            tv_on = False

    sw_versions = {}
    sw_version_path = "/var/lib/sw_version.json"
    if os.path.exists(sw_version_path):
        try:
            import json
            with open(sw_version_path, "r") as f:
                sw_versions = json.load(f)
        except:
            pass

    return jsonify({
        "success": True,
        "meter_id":         METER_ID,
        "wifi":            wifi_ok,
        "gsm":             os.path.exists(SYSTEM_FILES["gsm_up"]),
        "usb_jack":        os.path.exists(SYSTEM_FILES["jack_status"]),
        "hdmi_vcc":        os.path.exists(SYSTEM_FILES["hdmi_input"]),
        "video_detection": os.path.exists(SYSTEM_FILES["video_detection"]),
        "tv_on":           tv_on,
        "ble_available":   ble_available,
        "installation_done": os.path.exists(SYSTEM_FILES["install_done"]) and open(SYSTEM_FILES["install_done"]).read().strip() == "1",
        "ip_address":      get_ip_address(),
        "mac_address":     get_mac_address(),
        "internet":        os.path.exists(SYSTEM_FILES["internet_ok"]),
        "sw_versions":     sw_versions,
    })

# ── POST /api/system/brightness ───────────────────────────────────────────────
@system_bp.route("/brightness", methods=["POST"])
def set_brightness():
    path = get_backlight_path()
    if not path:
        return jsonify({"success": False, "error": "No backlight device found"}), 404
        
    data = request.get_json(force=True) or {}
    try:
        value = int(data.get("brightness", 128))
        max_b_path = f"{path}/max_brightness"
        with open(max_b_path) as f:
            max_b = int(f.read().strip())
        
        value = max(int(max_b * 0.1), min(value, max_b))
        subprocess.run(["sudo", "tee", f"{path}/brightness"], input=str(value), text=True, capture_output=True)
        return jsonify({"success": True, "brightness": value})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ── GET /api/system/brightness ────────────────────────────────────────────────
@system_bp.route("/brightness", methods=["GET"])
def get_brightness():
    path = get_backlight_path()
    if not path:
        return jsonify({"success": False, "error": "No backlight device found"}), 404
    try:
        with open(f"{path}/brightness") as f:
            b = int(f.read().strip())
        with open(f"{path}/max_brightness") as f:
            max_b = int(f.read().strip())
        return jsonify({"success": True, "brightness": b, "max": max_b})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ── POST /api/system/reboot ────────────────────────────────────────────────────
@system_bp.route("/reboot", methods=["POST"])
def reboot():
    try:
        subprocess.Popen("sleep 1 && sudo reboot", shell=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ── POST /api/system/shutdown ─────────────────────────────────────────────────
@system_bp.route("/shutdown", methods=["POST"])
def shutdown():
    try:
        subprocess.Popen("sleep 1 && sudo shutdown -h now", shell=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ── GET /api/system/settings ──────────────────────────────────────────────────
@system_bp.route("/settings", methods=["GET"])
def get_settings():
    from .settings_manager import load_settings
    return jsonify(load_settings())

# ── POST /api/system/settings ─────────────────────────────────────────────────
@system_bp.route("/settings", methods=["POST"])
def save_app_settings():
    from .settings_manager import save_settings
    data = request.get_json(force=True) or {}
    save_settings(data)
    return jsonify({"success": True})

# ── WEATHER ───────────────────────────────────────────────────────────────────
_weather_cache = {"data": None, "timestamp": 0, "city": None}
_cached_owm_api_key = None
_owm_key_lock = threading.Lock()

IOT_CONFIG = {
    "CERT_DIR": "/opt/apm/certs",
    "AWS_ENDPOINT": "cetv6dtf9d304.credentials.iot.ap-south-1.amazonaws.com",
    "AWS_ROLE_ALIAS": "iot-image-code-role",
    "AWS_REGION": "ap-south-1",
}

def get_owm_api_key() -> str:
    """Retrieve and cache OpenWeatherMap API key from AWS SSM using IoT credentials."""
    global _cached_owm_api_key

    if _cached_owm_api_key:
        return _cached_owm_api_key

    with _owm_key_lock:
        if _cached_owm_api_key:
            return _cached_owm_api_key

        try:
            if get_credentials:
                import boto3
                credentials = get_credentials(IOT_CONFIG)
                ssm = boto3.client(
                    "ssm",
                    region_name=IOT_CONFIG["AWS_REGION"],
                    aws_access_key_id=credentials["AWS_ACCESS_KEY_ID"],
                    aws_secret_access_key=credentials["AWS_SECRET_ACCESS_KEY"],
                    aws_session_token=credentials["AWS_SESSION_TOKEN"],
                )
                response = ssm.get_parameter(
                    Name="/apm/weather/api",
                    WithDecryption=True,
                )
                key = response.get("Parameter", {}).get("Value", "").strip()
                if key:
                    _cached_owm_api_key = key
                    return _cached_owm_api_key
        except Exception as e:
            print(f"[Weather] Warning: Failed to fetch API key from AWS SSM via IoT credentials: {e}")

        fallback_key = os.environ.get("OWM_API_KEY", "")
        if fallback_key:
            _cached_owm_api_key = fallback_key
            return _cached_owm_api_key

    return ""

_last_known_city = "Yerevan"

def get_auto_city() -> str:
    """Resolve location from public IP with sticky fallback."""
    global _last_known_city
    try:
        r = requests.get("http://ip-api.com/json/?fields=status,city", timeout=3)
        if r.status_code == 200:
            data = r.json()
            if data.get("status") == "success":
                city = (data.get("city") or "").strip()
                if city:
                    _last_known_city = city
                    return _last_known_city
    except Exception as e:
        print(f"[Weather] Auto city lookup error: {e}, using fallback: {_last_known_city}")

    return _last_known_city

# ── GET /api/system/weather ──────────────────────────────────────────────────
@system_bp.route("/weather", methods=["GET"])
def get_weather():
    city = request.args.get("city", "auto").strip()
    if not city or city.lower() == "auto":
        city = get_auto_city()

    now = time.time()

    # Return cached data if fresh (15 minutes = 900 seconds)
    if _weather_cache["data"] and _weather_cache["city"] == city and (now - _weather_cache["timestamp"] < 900):
        return jsonify(_weather_cache["data"])

    api_key = get_owm_api_key()
    if not api_key:
        return jsonify({"error": "Weather API key unavailable"}), 503

    url = f"https://api.openweathermap.org/data/2.5/weather?q={city}&units=metric&appid={api_key}"
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            _weather_cache["data"] = data
            _weather_cache["timestamp"] = now
            _weather_cache["city"] = city
            return jsonify(data)
        return jsonify({"error": "Failed to fetch weather"}), resp.status_code
    except Exception as e:
        if _weather_cache["data"]:
            return jsonify(_weather_cache["data"])
        return jsonify({"error": str(e)}), 500