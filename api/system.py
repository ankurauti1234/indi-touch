#!/usr/bin/env python3

# api/system.py — System status, brightness, shutdown, restart

import json
import os
import socket
import subprocess
import threading
import time

from flask import Blueprint, jsonify, request

from .config import SYSTEM_FILES, METER_ID


system_bp = Blueprint("system", __name__)


# Common RPi backlight paths

BACKLIGHT_PATHS = [
    "/sys/class/backlight/1-0045",      # User's specific path
    "/sys/class/backlight/rpi_backlight",
    "/sys/class/backlight/soc:backlight"
]


# ── Cached system status ──────────────────────────────────────────────────────

_WIFI_CACHE_TTL = 30.0
_wifi_cache_lock = threading.Lock()
_wifi_cache_value = False
_wifi_cache_timestamp = 0.0

_mac_address_cache = None
_mac_address_lock = threading.Lock()


def get_backlight_path():
    for p in BACKLIGHT_PATHS:
        if os.path.exists(p):
            return p
    return None


def get_ip_address():
    """Find the local IP address, prioritizing external connectivity but falling back to interface-specific checks."""

    # 1. Try connecting to an external address
    # (best for multi-homed hosts)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]

            if ip and not ip.startswith("127."):
                return ip

    except (OSError, socket.timeout):
        pass

    # 2. Fallback: use a private broadcast address
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]

            if ip and not ip.startswith("127."):
                return ip

    except (OSError, socket.timeout):
        pass

    return "127.0.0.1"


def get_mac_address():
    """Return the MAC address, cached for the lifetime of the process."""

    global _mac_address_cache

    if _mac_address_cache is not None:
        return _mac_address_cache

    with _mac_address_lock:
        if _mac_address_cache is not None:
            return _mac_address_cache

        for interface in ["wlan0", "eth0", "enp1s0"]:
            path = f"/sys/class/net/{interface}/address"

            if not os.path.exists(path):
                continue

            try:
                with open(path, "r") as f:
                    mac = f.read().strip().upper()

                if mac:
                    _mac_address_cache = mac
                    return mac

            except OSError:
                continue

        _mac_address_cache = "00:00:00:00:00:00"
        return _mac_address_cache


def get_wifi_status():
    """
    Return WiFi connection state.

    nmcli is relatively expensive compared with reading the /run flag,
    so cache its result for a short period.
    """

    global _wifi_cache_value, _wifi_cache_timestamp

    now = time.monotonic()

    # Only hold the lock while checking the cache.
    # The subprocess runs outside the lock.
    with _wifi_cache_lock:
        if now - _wifi_cache_timestamp < _WIFI_CACHE_TTL:
            return _wifi_cache_value

    try:
        result = subprocess.run(
            [
                "nmcli",
                "-t",
                "-g",
                "GENERAL.STATE",
                "device",
                "show",
                "wlan0"
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=False
        )

        wifi_ok = "connected" in result.stdout.lower()

    except (OSError, subprocess.SubprocessError):
        wifi_ok = os.path.exists(SYSTEM_FILES["wifi_up"])

    with _wifi_cache_lock:
        _wifi_cache_value = wifi_ok
        _wifi_cache_timestamp = time.monotonic()
        return _wifi_cache_value


def invalidate_wifi_status_cache():
    """Force the next WiFi status request to query nmcli again."""

    global _wifi_cache_timestamp

    with _wifi_cache_lock:
        _wifi_cache_timestamp = 0.0


def _get_tv_status(ble_available):
    """Return the current TV state."""

    if not ble_available:
        return True

    tv_status_path = SYSTEM_FILES["tv_status"]

    if not os.path.exists(tv_status_path):
        return False

    try:
        with open(tv_status_path, "r") as f:
            tv_state = f.read().strip().upper()

        return tv_state == "ON"

    except OSError:
        return False


def _get_software_versions():
    """Return software versions from /var/lib/sw_version.json."""

    sw_versions = {}
    sw_version_path = "/var/lib/sw_version.json"

    if not os.path.exists(sw_version_path):
        return sw_versions

    try:
        with open(sw_version_path, "r") as f:
            sw_versions = json.load(f)

    except (OSError, json.JSONDecodeError):
        pass

    return sw_versions


def _get_installation_done():
    """Return whether the installation-complete flag is set."""

    path = SYSTEM_FILES["install_done"]

    if not os.path.exists(path):
        return False

    try:
        with open(path, "r") as f:
            return f.read().strip() == "1"

    except OSError:
        return False


def _get_system_flags():
    """
    Return the small set of system flags needed by the
    connection monitor.
    """

    ble_available = os.path.exists(
        SYSTEM_FILES["bluetooth_available"]
    )

    return {
        "usb_jack": os.path.exists(SYSTEM_FILES["jack_status"]),
        "hdmi_vcc": os.path.exists(SYSTEM_FILES["hdmi_input"]),
        "wifi": get_wifi_status(),
        "internet": os.path.exists(SYSTEM_FILES["internet_ok"]),
        "tv_on": _get_tv_status(ble_available)
    }


# ── GET /api/system/flags ─────────────────────────────────────────────────────

@system_bp.route("/flags", methods=["GET"])
def system_flags():
    """
    Lightweight system status endpoint used by the
    frontend connection monitor.
    """

    return jsonify(_get_system_flags())


# ── GET /api/system/status ────────────────────────────────────────────────────

@system_bp.route("/status", methods=["GET"])
def system_status():
    """Unified status of all /run file indicators + network info."""

    ble_available = os.path.exists(
        SYSTEM_FILES["bluetooth_available"]
    )

    tv_on = _get_tv_status(ble_available)

    return jsonify({
        "success": True,
        "meter_id": METER_ID,
        "wifi": get_wifi_status(),
        "gsm": os.path.exists(SYSTEM_FILES["gsm_up"]),
        "usb_jack": os.path.exists(SYSTEM_FILES["jack_status"]),
        "hdmi_vcc": os.path.exists(SYSTEM_FILES["hdmi_input"]),
        "video_detection": os.path.exists(
            SYSTEM_FILES["video_detection"]
        ),
        "tv_on": tv_on,
        "ble_available": ble_available,
        "installation_done": _get_installation_done(),
        "ip_address": get_ip_address(),
        "mac_address": get_mac_address(),
        "internet": os.path.exists(SYSTEM_FILES["internet_ok"]),
        "sw_versions": _get_software_versions(),
    })


# ── POST /api/system/brightness ───────────────────────────────────────────────

@system_bp.route("/brightness", methods=["POST"])
def set_brightness():
    path = get_backlight_path()

    if not path:
        return jsonify({
            "success": False,
            "error": "No backlight device found"
        }), 404

    data = request.get_json(force=True) or {}

    try:
        value = int(data.get("brightness", 128))

        max_b_path = f"{path}/max_brightness"

        with open(max_b_path) as f:
            max_b = int(f.read().strip())

        # Ensure we don't go too dark
        value = max(int(max_b * 0.1), min(value, max_b))

        # Use subprocess for better sudo handling
        subprocess.run(
            [
                "sudo",
                "tee",
                f"{path}/brightness"
            ],
            input=str(value),
            text=True,
            capture_output=True,
            check=False
        )

        return jsonify({
            "success": True,
            "brightness": value
        })

    except (OSError, ValueError, TypeError) as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ── GET /api/system/brightness ────────────────────────────────────────────────

@system_bp.route("/brightness", methods=["GET"])
def get_brightness():
    path = get_backlight_path()

    if not path:
        return jsonify({
            "success": False,
            "error": "No backlight device found"
        }), 404

    try:
        with open(f"{path}/brightness") as f:
            b = int(f.read().strip())

        with open(f"{path}/max_brightness") as f:
            max_b = int(f.read().strip())

        return jsonify({
            "success": True,
            "brightness": b,
            "max": max_b
        })

    except (OSError, ValueError) as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ── POST /api/system/reboot ────────────────────────────────────────────────────

@system_bp.route("/reboot", methods=["POST"])
def reboot():
    try:
        # Run in background after 1s delay so we can return the response
        subprocess.Popen(
            "sleep 1 && sudo reboot",
            shell=True
        )

        return jsonify({"success": True})

    except (OSError, subprocess.SubprocessError) as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ── POST /api/system/shutdown ─────────────────────────────────────────────────

@system_bp.route("/shutdown", methods=["POST"])
def shutdown():
    try:
        # Run in background after 1s delay so we can return the response
        subprocess.Popen(
            "sleep 1 && sudo shutdown -h now",
            shell=True
        )

        return jsonify({"success": True})

    except (OSError, subprocess.SubprocessError) as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


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