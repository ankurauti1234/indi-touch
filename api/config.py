#!/usr/bin/env python3
# api/config.py — All constants, paths, and device configuration

import os


def _data_dir() -> str:
    """Returns /var/lib if writable, otherwise a local data/ fallback."""
    if os.access("/var/lib", os.W_OK):
        return "/var/lib"
    d = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
    os.makedirs(d, exist_ok=True)
    return d

VAR_LIB = _data_dir()
RUN_DIR = "/run"   # /run flags are written by system services; we only read them

# ── File-based indicators ─────────────────────────────────────────────────────
SYSTEM_FILES = {
    "install_done":    f"{VAR_LIB}/self_installation_done",
    "wifi_up":         f"{RUN_DIR}/wifi_network_up",
    "gsm_up":          f"{RUN_DIR}/gsm_network_up",
    "jack_status":     f"{RUN_DIR}/jack_status",
    "hdmi_input":      f"{RUN_DIR}/input_source_hdmi",
    "video_detection": f"{RUN_DIR}/video_object_detection",
    "current_state":   f"{VAR_LIB}/current_state",
    "last_boot_id":    f"{VAR_LIB}/meter_last_boot_id.txt",
    "tv_status":       f"{RUN_DIR}/tv_status",
    "ble_status":      f"{RUN_DIR}/ble_status",
}

SETTINGS_FILE = os.path.join(VAR_LIB, "settings.json")
WALLPAPER_DIR = os.path.join(VAR_LIB, "wallpapers")
AVATAR_DIR    = os.path.join(VAR_LIB, "avatars")
os.makedirs(WALLPAPER_DIR, exist_ok=True)
os.makedirs(AVATAR_DIR, exist_ok=True)

# ── Device identity ───────────────────────────────────────────────────────────
DEVICE_CONFIG = {
    "device_id_file": f"{VAR_LIB}/device_id.txt",
    "hhid_file":      f"{VAR_LIB}/hhid.txt",
    "certs_dir":      "/opt/apm/certs",
}

DB_PATH = os.path.join(VAR_LIB, "meter.db")

# ── Remote API ────────────────────────────────────────────────────────────────
API_BASE    = "https://bt72jq8w9i.execute-api.ap-south-1.amazonaws.com/test"
INITIATE_URL = f"{API_BASE}/initiate-assignment"
VERIFY_URL   = f"{API_BASE}/verify-otp"
MEMBERS_URL  = f"{API_BASE}/members"

# ── MQTT & D-Bus ──────────────────────────────────────────────────────────────
DBUS_INTERFACE       = "collector.Service"
DBUS_OBJECT_PATH     = "/collector/service"
DBUS_SIGNAL_EVENT    = "Event"

MQTT_TOPIC           = "indi/AM/meter"
AWS_IOT_ENDPOINT     = "a3uoz4wfsx2nz3-ats.iot.ap-south-1.amazonaws.com"
MQTT_PORT            = 8883
RECONNECT_DELAY      = 5
MAX_RECONNECT_DELAY  = 60
HEARTBEAT_INTERVAL   = 3600   # seconds

# ── Fallback avatar (inline SVG data URI) ─────────────────────────────────────
FALLBACK_AVATAR = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E"
    "%3Ccircle cx='50' cy='35' r='25' fill='%23666'/%3E"
    "%3Cellipse cx='50' cy='85' rx='40' ry='25' fill='%23666'/%3E%3C/svg%3E"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
def get_meter_id() -> str:
    try:
        with open(DEVICE_CONFIG["device_id_file"]) as f:
            mid = f.read().strip()
            if mid:
                return mid
    except FileNotFoundError:
        pass
    return "IM000000"

def load_hhid() -> str:
    try:
        with open(DEVICE_CONFIG["hhid_file"]) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""

def save_hhid(hhid: str):
    with open(DEVICE_CONFIG["hhid_file"], "w") as f:
        f.write(hhid)

def is_installation_done() -> bool:
    try:
        return open(SYSTEM_FILES["install_done"]).read().strip() == "1"
    except FileNotFoundError:
        return False

def set_installation_done():
    with open(SYSTEM_FILES["install_done"], "w") as f:
        f.write("1")

def current_state() -> str:
    try:
        return open(SYSTEM_FILES["current_state"]).read().strip()
    except FileNotFoundError:
        return "welcome"

def set_current_state(state: str):
    with open(SYSTEM_FILES["current_state"], "w") as f:
        f.write(state)

def file_flag_exists(key: str) -> bool:
    """Return True if the /run indicator file exists."""
    return os.path.exists(SYSTEM_FILES.get(key, ""))

def _get_boot_id():
    try:
        return open("/proc/sys/kernel/random/boot_id").read().strip()
    except Exception:
        return None

def is_fresh_boot() -> bool:
    current = _get_boot_id()
    if not current:
        return False
    try:
        last = open(SYSTEM_FILES["last_boot_id"]).read().strip()
        return current != last
    except FileNotFoundError:
        return True

def save_boot_id():
    bid = _get_boot_id()
    if bid:
        with open(SYSTEM_FILES["last_boot_id"], "w") as f:
            f.write(bid)

METER_ID = get_meter_id()
print(f"[CONFIG] METER_ID = {METER_ID}")
