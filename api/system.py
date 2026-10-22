#!/usr/bin/env python3
# api/system.py — System status, brightness, shutdown, restart

import os
import subprocess
import socket

from flask import Blueprint, jsonify, request

from .config import SYSTEM_FILES, METER_ID

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
    # 1. Try connecting to an external addr (best for multi-homed hosts)
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

    # 2. Fallback: check common interfaces manually using socket/ioctl or simple list
    try:
        # On Linux, we can use socket.gethostname() and then gethostbyname,
        # but that often returns 127.0.1.1 on RPi.
        # Instead, iterate over common interfaces via subprocess if needed,
        # or just use a dummy connect to a local addr in the subnet.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Try a "connect" to any addr in a private range that doesn't actually need to exist
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
    # Robust WiFi check: check if wlan0 is actually connected via nmcli
    wifi_ok = False
    try:
        r = subprocess.run(
            ["nmcli", "-t", "-g", "GENERAL.STATE", "device", "show", "wlan0"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if "connected" in r.stdout.lower():
            wifi_ok = True
    except Exception:
        wifi_ok = os.path.exists(SYSTEM_FILES.get("wifi_up", "/run/wifi_network_up"))

    # TV is ON if the presence flag /run/tv-status-on exists
    tv_flag_file = SYSTEM_FILES.get("tv_status", "/run/tv-status-on")
    tv_on = os.path.exists(tv_flag_file)

    # Bluetooth availability
    ble_available = os.path.exists(SYSTEM_FILES.get("bluetooth_available", "/run/bluetooth_available"))

    # Installation state
    install_done = False
    install_file = SYSTEM_FILES.get("install_done", "/var/lib/self_installation_done")
    if os.path.exists(install_file):
        try:
            with open(install_file, "r") as f:
                install_done = (f.read().strip() == "1")
        except Exception:
            install_done = False

    # Software Versions from /var/lib/sw_version.json
    sw_versions = {}
    sw_version_path = "/var/lib/sw_version.json"
    if os.path.exists(sw_version_path):
        try:
            with open(sw_version_path, "r") as f:
                sw_versions = json.load(f)
        except Exception:
            sw_versions = {}

    return jsonify({
        "success": True,
        "meter_id": METER_ID,
        "wifi": wifi_ok,
        "gsm": os.path.exists(SYSTEM_FILES.get("gsm_up", "/run/gsm_network_up")),
        "usb_jack": os.path.exists(SYSTEM_FILES.get("jack_status", "/run/jack_status")),
        "hdmi_vcc": os.path.exists(SYSTEM_FILES.get("hdmi_input", "/run/input_source_hdmi")),
        "video_detection": os.path.exists(SYSTEM_FILES.get("video_detection", "/run/video_object_detection")),
        "tv_on": tv_on,
        "ble_available": ble_available,
        "installation_done": install_done,
        "ip_address": get_ip_address(),
        "mac_address": get_mac_address(),
        "internet": os.path.exists(SYSTEM_FILES.get("internet_ok", "/run/internet_ok")),
        "sw_versions": sw_versions,
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
        
        # Ensure we don't go too dark
        value = max(int(max_b * 0.1), min(value, max_b))
        
        # Use subprocess for better sudo handling
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
        # Run in background after 1s delay so we can return the response
        subprocess.Popen("sleep 1 && sudo reboot", shell=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── POST /api/system/shutdown ─────────────────────────────────────────────────
@system_bp.route("/shutdown", methods=["POST"])
def shutdown():
    try:
        # Run in background after 1s delay so we can return the response
        subprocess.Popen("sleep 1 && sudo shutdown -h now", shell=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── GET /api/system/settings ──────────────────────────────────────────────────
@system_bp.route("/settings", methods=["GET"])
def get_settings():
    """Return app settings from JSON file."""
    from .settings_manager import load_settings
    return jsonify(load_settings())


# ── POST /api/system/settings ─────────────────────────────────────────────────
@system_bp.route("/settings", methods=["POST"])
def save_app_settings():
    """Save app settings to JSON file."""
    from .settings_manager import save_settings
    data = request.get_json(force=True) or {}
    save_settings(data)
    return jsonify({"success": True})
