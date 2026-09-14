#!/usr/bin/env python3

# api/system.py — System status, brightness, shutdown, restart

import json
import os
import socket
import subprocess

from flask import Blueprint, jsonify, request

from .config import SYSTEM_FILES, METER_ID


system_bp = Blueprint("system", __name__)


# ── Common RPi backlight paths ────────────────────────────────────────────────

BACKLIGHT_PATHS = [
    "/sys/class/backlight/1-0045",      # User's specific path
    "/sys/class/backlight/rpi_backlight",
    "/sys/class/backlight/soc:backlight",
]


def get_backlight_path():
    for path in BACKLIGHT_PATHS:
        if os.path.exists(path):
            return path

    return None


def get_ip_address():
    """
    Find the local IP address, prioritizing external connectivity
    but falling back to interface-specific checks.
    """

    # 1. Try connecting to an external address.
    #    This is useful for multi-homed hosts.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]

            if ip and not ip.startswith("127."):
                return ip

    except OSError:
        pass

    # 2. Fallback: use a private broadcast address.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("10.255.255.255", 1))
            ip = sock.getsockname()[0]

            if ip and not ip.startswith("127."):
                return ip

    except OSError:
        pass

    return "127.0.0.1"


def get_mac_address():
    """Return the MAC address for the first available network interface."""

    for interface in ("wlan0", "eth0", "enp1s0"):
        path = f"/sys/class/net/{interface}/address"

        if not os.path.exists(path):
            continue

        try:
            with open(path, "r") as file:
                mac = file.read().strip().upper()

            if mac:
                return mac

        except OSError:
            continue

    return "00:00:00:00:00:00"


def get_wifi_status():
    """
    Return the current Wi-Fi state from the system runtime flag.

    Connection-state polling is owned by app.py. This API helper is kept
    for compatibility with the system status endpoints and does not spawn
    nmcli or maintain a second polling cache.
    """

    return os.path.exists(SYSTEM_FILES["wifi_up"])


def invalidate_wifi_status_cache():
    """
    Compatibility no-op.

    Wi-Fi polling/cache ownership now belongs to app.py, so there is no
    cache in this module to invalidate.
    """

    return None


def _get_tv_status(ble_available):
    """Return the current TV state."""

    if not ble_available:
        return True

    tv_status_path = SYSTEM_FILES["tv_status"]

    if not os.path.exists(tv_status_path):
        return False

    try:
        with open(tv_status_path, "r") as file:
            tv_state = file.read().strip().upper()

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
        with open(sw_version_path, "r") as file:
            sw_versions = json.load(file)

    except (OSError, json.JSONDecodeError):
        pass

    return sw_versions


def _get_installation_done():
    """Return whether the installation-complete flag is set."""

    path = SYSTEM_FILES["install_done"]

    if not os.path.exists(path):
        return False

    try:
        with open(path, "r") as file:
            return file.read().strip() == "1"

    except OSError:
        return False


def _get_system_flags():
    """
    Return the small set of system flags needed by the connection monitor.

    Kept for the API endpoint and other callers. The main Qt application
    supplies connection state directly to the frontend instead of
    JavaScript polling this endpoint.
    """

    ble_available = os.path.exists(
        SYSTEM_FILES["bluetooth_available"]
    )

    return {
        "usb_jack": os.path.exists(
            SYSTEM_FILES["jack_status"]
        ),
        "hdmi_vcc": os.path.exists(
            SYSTEM_FILES["hdmi_input"]
        ),
        "wifi": get_wifi_status(),
        "internet": os.path.exists(
            SYSTEM_FILES["internet_ok"]
        ),
        "tv_on": _get_tv_status(ble_available),
    }


# ── GET /api/system/flags ─────────────────────────────────────────────────────

@system_bp.route("/flags", methods=["GET"])
def system_flags():
    """
    Lightweight system status endpoint.

    This endpoint remains available for compatibility and diagnostics.
    The normal frontend connection monitor is driven by Qt/Python.
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
        "gsm": os.path.exists(
            SYSTEM_FILES["gsm_up"]
        ),
        "usb_jack": os.path.exists(
            SYSTEM_FILES["jack_status"]
        ),
        "hdmi_vcc": os.path.exists(
            SYSTEM_FILES["hdmi_input"]
        ),
        "video_detection": os.path.exists(
            SYSTEM_FILES["video_detection"]
        ),
        "tv_on": tv_on,
        "ble_available": ble_available,
        "installation_done": _get_installation_done(),
        "ip_address": get_ip_address(),
        "mac_address": get_mac_address(),
        "internet": os.path.exists(
            SYSTEM_FILES["internet_ok"]
        ),
        "sw_versions": _get_software_versions(),
    })


# ── POST /api/system/brightness ───────────────────────────────────────────────

@system_bp.route("/brightness", methods=["POST"])
def set_brightness():
    path = get_backlight_path()

    if not path:
        return jsonify({
            "success": False,
            "error": "No backlight device found",
        }), 404

    data = request.get_json(force=True) or {}

    try:
        value = int(data.get("brightness", 128))

        max_b_path = f"{path}/max_brightness"

        with open(max_b_path) as file:
            max_b = int(file.read().strip())

        # Ensure we don't go too dark.
        value = max(
            int(max_b * 0.1),
            min(value, max_b),
        )

        # Use subprocess for sudo handling.
        subprocess.run(
            [
                "sudo",
                "tee",
                f"{path}/brightness",
            ],
            input=str(value),
            text=True,
            capture_output=True,
            check=False,
        )

        return jsonify({
            "success": True,
            "brightness": value,
        })

    except (OSError, ValueError, TypeError) as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
        }), 500


# ── GET /api/system/brightness ────────────────────────────────────────────────

@system_bp.route("/brightness", methods=["GET"])
def get_brightness():
    path = get_backlight_path()

    if not path:
        return jsonify({
            "success": False,
            "error": "No backlight device found",
        }), 404

    try:
        with open(f"{path}/brightness") as file:
            brightness = int(file.read().strip())

        with open(f"{path}/max_brightness") as file:
            max_brightness = int(file.read().strip())

        return jsonify({
            "success": True,
            "brightness": brightness,
            "max": max_brightness,
        })

    except (OSError, ValueError) as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
        }), 500


# ── POST /api/system/reboot ───────────────────────────────────────────────────

@system_bp.route("/reboot", methods=["POST"])
def reboot():
    try:
        # Delay the reboot so the HTTP response can be returned first.
        #
        # The command is deliberately passed as an argument list rather
        # than through shell=True.
        subprocess.Popen(
            [
                "systemd-run",
                "--on-active=1",
                "systemctl",
                "reboot",
            ]
        )

        return jsonify({"success": True})

    except (OSError, subprocess.SubprocessError) as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
        }), 500


# ── POST /api/system/shutdown ─────────────────────────────────────────────────

@system_bp.route("/shutdown", methods=["POST"])
def shutdown():
    try:
        # Delay the shutdown so the HTTP response can be returned first.
        #
        # The command is deliberately passed as an argument list rather
        # than through shell=True.
        subprocess.Popen(
            [
                "systemd-run",
                "--on-active=1",
                "systemctl",
                "poweroff",
            ]
        )

        return jsonify({"success": True})

    except (OSError, subprocess.SubprocessError) as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
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