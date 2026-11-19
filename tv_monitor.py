#!/usr/bin/env python3
"""
TV Monitor Service — v4.7
===========================
/opt/apm/tv-manager/tv_monitor.py

Drop-in replacement for v4.0. Same systemd service, same D-Bus interface,
same meter.db schema, same event pipeline.

PURPOSE (v4.1 re-scope): PURE TV ON/OFF detection only.
Content/app detection (YouTube/Netflix/etc.) is intentionally removed.
WiFi reports ON/OFF only, on Type 51, fully separate from the BT plug.

What changed in v4.2 (from v4.1):
  - LG false-positive guard: port 3000 collides with Next.js/Node/Grafana
    dev servers. Real LG is silent to a plain HTTP GET (proven: .34 TIMEOUT);
    a web server answers 'HTTP/1.' (proven: .191 -> HTTP/1.1 307). LG is now
    rejected when 3000 answers HTTP. Scoped to LG ONLY — Samsung(8001),
    Roku(8060), Cast(8008), Philips(1925) are legitimately HTTP and untouched.

What changed from v4.0:
  1.  Content/app detection REMOVED — source is always "TV". We no longer
      parse LG/Samsung/Cast app IDs; we only answer "is a TV port open?".
  2.  Type 23 (power) events REMOVED from WiFi entirely. The BT plug owns
      Type 23 (wattage-based). WiFi never emits Type 23 — no double source,
      no flap. ON/OFF rides Type 51 as STARTED(on)/ENDED(off).
  3.  ON/OFF detection is now a lightweight PORT PROBE, not an API call.
      Proven by captured data (LG/KONKA close ports ~5s on power-off).
      This also eliminates the LG pywebostv 4-minute hang — we never open
      a WebSocket for on/off.
  4.  NO heartbeat. Only STARTED (TV on) and ENDED (TV off) are emitted.
  5.  STARTUP RECONCILIATION with persisted state. Per-TV last on/off state
      is persisted to STATE_PATH and reloaded on boot, so a crash/reboot
      between STARTED and ENDED can no longer strand a TV as "ON" on
      Indirex, and an already-ON TV is not re-STARTED (no duplicate session).
  6.  Samsung power:standby still honoured — Samsung holds its port open
      ~75s after power-off, so standby begins the OFF countdown early.

What stays identical:
  - D-Bus path/interface/event format (Type 51 envelope + actions)
  - meter.db tv_devices table schema
  - systemd service file (no changes needed)
  - Subnet scan / discovery / MAC-based DHCP recovery
  - Log directory, rotation, format
"""

import dbus
import json
import logging
import logging.handlers
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import shutil

# ── Optional dependency checks (graceful, not fatal) ──────────────────────────
HAS_ADB = shutil.which("adb") is not None
HAS_PYWEBOSTV = False
try:
    from pywebostv.connection import WebOSClient
    from pywebostv.controls import ApplicationControl
    HAS_PYWEBOSTV = True
except ImportError:
    pass

# ══════════════════════════════════════════════════════════════════════════════
#  CONFIG
# ══════════════════════════════════════════════════════════════════════════════

DB_PATH = "/var/lib/meter.db"
METER_ID_FILE = "/var/lib/device_id.txt"

# Scan
SCAN_WORKERS = 40
SCAN_INTERVAL = 600          # periodic re-scan every 10 min
TCP_GATE_TIMEOUT = 0.5       # per-port timeout during scan (was 0.3)
TCP_MONITOR_TIMEOUT = 1.0    # per-port timeout during monitoring
HTTP_TIMEOUT = 2.5
ADB_TIMEOUT = 5

# Monitor
MONITOR_INTERVAL = 5         # app check every 5s
UNREACHABLE_RESCAN = 60      # re-scan after 60s of unreachable

# D-Bus
DBUS_PATH = "/collector/service"
DBUS_INTERFACE = "collector.Service"
DBUS_TYPE_SOURCE = "51"      # TV event (STARTED/STANDBY/ENDED actions)
# NOTE: Type 23 (power) is deliberately NOT defined here. The BT plug owns
# Type 23. WiFi must never emit it. ON/OFF rides Type 51.

# Persisted per-TV ON/OFF state — survives service restarts so a reboot
# between STARTED and ENDED cannot strand a TV as "ON" on Indirex.
STATE_PATH = "/var/lib/tv_monitor_state.json"
IDENTITY_PATH = "/var/lib/tv_monitor_identity.json"

# ── 14-Port TV Matrix ────────────────────────────────────────────────────────
# port → brand identifier
TV_PORT_MAP = {
    8001:  "samsung",
    8002:  "samsung",
    3000:  "lg",
    3001:  "lg",
    5555:  "android_tv",
    8008:  "cast_tv",
    8009:  "cast_tv",
    8060:  "roku",
    1925:  "philips",
    36669: "hisense",
    9000:  "vizio",
    7345:  "vizio",
    10000: "sony",
    50001: "sony",
    6466:  "vise",
    6467:  "vise",
}

# Priority order for brand selection when multiple ports respond
# api_ok=True brands are checked first, then this order breaks ties
BRAND_PRIORITY = [
    "samsung", "lg", "android_tv", "roku", "philips",
    "cast_tv", "hisense", "vizio", "sony", "vise"
]

# Primary port per brand (used for monitoring)
BRAND_PRIMARY_PORT = {
    "samsung":    8001,
    "lg":         3000,
    "android_tv": 5555,
    "cast_tv":    8008,
    "roku":       8060,
    "philips":    1925,
    "hisense":    36669,
    "vizio":      9000,
    "sony":       10000,
    "vise":       6466,
}

# All ports per brand (reverse of TV_PORT_MAP). For ON/OFF we treat a TV as
# ON if ANY of its brand's ports answers — more robust than one primary port.
BRAND_PORTS = {}
for _p, _b in TV_PORT_MAP.items():
    BRAND_PORTS.setdefault(_b, []).append(_p)

# Samsung app IDs
SAMSUNG_APPS = {
    "111299001912":  "YOUTUBE",
    "3201907018807": "NETFLIX",
    "3201601007250": "HOTSTAR",
    "3201512006963": "PRIME_VIDEO",
}

# Android TV packages (ADB)
ANDROID_TV_APPS = {
    "com.google.android.youtube.tv":         "YOUTUBE",
    "com.netflix.ninja":                     "NETFLIX",
    "com.amazon.amazonvideo.livingroom":     "PRIME_VIDEO",
    "in.startv.hotstar.dplus.tv":            "HOTSTAR",
    "com.jio.media.jiobeats":               "JIOCINEMA",
    "com.zee5.hidevice":                     "ZEE5",
    "com.sonyliv.smarttv":                   "SONYLIV",
}

# LG webOS app IDs
LG_APPS = {
    "youtube.leanback.v4":    "YOUTUBE",
    "netflix":                "NETFLIX",
    "amazon":                 "PRIME_VIDEO",
    "hotstar":                "HOTSTAR",
    "com.webos.app.livetv":   "TV",
    "com.webos.app.hdmi1":    "TV",
    "com.webos.app.hdmi2":    "TV",
    "com.webos.app.hdmi3":    "TV",
}

# Logging
LOG_DIR = "/var/log/tv-manager"
LOG_FILE = os.path.join(LOG_DIR, "tv_monitor.log")
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3

# ══════════════════════════════════════════════════════════════════════════════
#  LOGGING
# ══════════════════════════════════════════════════════════════════════════════

os.makedirs(LOG_DIR, exist_ok=True)

log = logging.getLogger("tv_monitor")
log.setLevel(logging.INFO)

_fmt = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

_stdout = logging.StreamHandler(sys.stdout)
_stdout.setFormatter(_fmt)
log.addHandler(_stdout)

_file = logging.handlers.RotatingFileHandler(
    LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT,
)
_file.setFormatter(_fmt)
log.addHandler(_file)


# ══════════════════════════════════════════════════════════════════════════════
#  METER ID
# ══════════════════════════════════════════════════════════════════════════════

def read_meter_id():
    try:
        with open(METER_ID_FILE, "r") as f:
            mid = f.read().strip()
            return mid if mid else "IM000000"
    except Exception:
        return "IM000000"


METER_ID = read_meter_id()


# ══════════════════════════════════════════════════════════════════════════════
#  D-BUS — Type 51 (source) + Type 23 (power)
# ══════════════════════════════════════════════════════════════════════════════

def _dbus_send(event_type, details_dict):
    """Low-level D-Bus signal sender."""
    try:
        bus = dbus.SystemBus()
        msg = dbus.lowlevel.SignalMessage(
            DBUS_PATH, DBUS_INTERFACE, "Event"
        )
        details = json.dumps(details_dict)
        ts = int(time.time())
        msg.append(METER_ID)
        msg.append(dbus.Int64(ts))
        msg.append(event_type)
        msg.append(details)
        bus.send_message(msg)
        log.debug(f"[DBUS] Sent: type={event_type} ts={ts} {details}")
        return True
    except Exception as e:
        log.warning(f"[DBUS] Failed: {e}")
        return False


def dbus_send_tv_event(tv_label, action, tv_type):
    """
    Type 51 — TV lifecycle event. source is always "TV".
    action: STARTED (TV on), STANDBY (screen off), ENDED (TV gone).
    All three are Type 51. No backdating. No Type 54.
    """
    details = {
        "source": "TV",
        "tv_label": tv_label,
        "tv_type": tv_type,
        "action": action,
    }
    return _dbus_send(DBUS_TYPE_SOURCE, details)


# ── Persisted ON/OFF state (for startup reconciliation) ───────────────────────
def load_state():
    """Return {tv_label: "STARTED"|"STANDBY"|"ENDED"} from the last run, or {}.
    Migrates dict-format entries from prior v4.7 builds."""
    try:
        with open(STATE_PATH, "r") as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return {}
            # Migrate dict-format entries: {"TV1": {"state":"STARTED","mac":"..."}}
            # back to plain strings: {"TV1": "STARTED"}
            migrated = False
            for k, v in list(data.items()):
                if isinstance(v, dict) and "state" in v:
                    data[k] = v["state"]
                    migrated = True
            if migrated:
                save_state(data)
                log.info("[STATE] Migrated dict-format entries to plain strings")
            return data
    except Exception:
        return {}


def save_state(state_dict):
    """Persist {tv_label: last_action} atomically. Best-effort."""
    try:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state_dict, f)
        os.replace(tmp, STATE_PATH)
    except Exception as e:
        log.warning(f"[STATE] Could not persist state: {e}")


# In-memory mirror of the persisted state, kept in sync on every transition.
_LAST_STATE = {}

# ── MAC identity tracking (separate file, not read by API/UI) ──────
_IDENTITY = {}


def _load_identity():
    """Return {tv_label: mac} from the identity file, or {}."""
    try:
        with open(IDENTITY_PATH, "r") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_identity(identity_dict):
    """Persist {tv_label: mac} atomically. Best-effort."""
    try:
        tmp = IDENTITY_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(identity_dict, f)
        os.replace(tmp, IDENTITY_PATH)
    except Exception as e:
        log.warning(f"[IDENTITY] Could not persist identity: {e}")


def _record_state(tv_label, action, mac=None):
    _LAST_STATE[tv_label] = action          # Plain string — API/UI compatible
    save_state(_LAST_STATE)
    if mac:
        _IDENTITY[tv_label] = mac
        _save_identity(_IDENTITY)


# ══════════════════════════════════════════════════════════════════════════════
#  DB ACCESS — one connection per call (unchanged from v3.1)
# ══════════════════════════════════════════════════════════════════════════════

def _db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def get_labeled_tvs():
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, mac, ip, tv_type, label, model, pairing_key "
            "FROM tv_devices WHERE label IS NOT NULL ORDER BY label"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_device(ip, tv_type, mac=None, model=None, name=None):
    """
    Insert or update a discovered TV device.

    v4.4 LABEL-LOCK RULE: labels are set by the user, never by a scan.
    This function NEVER writes to the label column. It only updates IP
    (DHCP recovery on same MAC), mac, model, and last_seen. The IP+brand
    fallback explicitly skips rows that already carry a label from a
    *different* MAC, so a rescan cannot steal a label from one TV and
    give it to another.
    """
    now = datetime.now(timezone.utc).isoformat()
    model_str = model or name or f"{tv_type} TV"

    with _db() as conn:
        existing = None

        # MAC-first lookup (survives DHCP IP changes)
        if mac and mac != "00:00:00:00:00:00":
            existing = conn.execute(
                "SELECT id, label, ip FROM tv_devices WHERE mac=?", (mac,)
            ).fetchone()
            if existing and existing["ip"] != ip:
                log.info(f"[SCAN] DHCP change: {existing['label'] or 'unlabeled'} "
                         f"moved {existing['ip']} → {ip} (MAC {mac})")

        # Fallback: IP + brand match — but ONLY unlabeled rows.
        # A labeled row with a different MAC is a DIFFERENT TV that
        # happens to share the IP (DHCP reassigned it). We must NOT
        # update that row — doing so would steal the label.
        if not existing:
            existing = conn.execute(
                "SELECT id, label, ip FROM tv_devices "
                "WHERE ip=? AND tv_type=? AND label IS NULL",
                (ip, tv_type)
            ).fetchone()

        if existing:
            conn.execute(
                "UPDATE tv_devices SET last_seen=?, ip=?, "
                "mac=COALESCE(?,mac), model=COALESCE(?,model) WHERE id=?",
                (now, ip, mac, model_str, existing["id"])
            )
            if existing["label"]:
                log.info(f"[SCAN] Updated {existing['label']}: "
                         f"{tv_type} {model_str} at {ip}")
        else:
            conn.execute(
                "INSERT INTO tv_devices "
                "(mac, ip, tv_type, model, first_seen, last_seen) "
                "VALUES (?,?,?,?,?,?)",
                (mac, ip, tv_type, model_str, now, now)
            )
            log.info(f"[SCAN] New {tv_type}: {model_str} at {ip} (mac={mac or '?'})")

        conn.commit()


# ══════════════════════════════════════════════════════════════════════════════
#  NETWORK HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def get_pi_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def tcp_probe(ip, port, timeout=0.5):
    """TCP connect probe. Returns (is_open, response_ms)."""
    start = time.time()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        ok = s.connect_ex((ip, port)) == 0
        ms = round((time.time() - start) * 1000, 1)
        s.close()
        return (ok, ms)
    except Exception:
        ms = round((time.time() - start) * 1000, 1)
        return (False, ms)


def get_arp_mac(ip):
    """Read MAC from kernel ARP table. TCP probes auto-populate this."""
    try:
        with open("/proc/net/arp", "r") as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    mac = parts[3].upper()
                    if mac != "00:00:00:00:00:00":
                        return mac
    except Exception:
        pass
    return None


def http_get_json(url, timeout=2.5):
    """Simple HTTP GET → JSON. Returns None on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "IndiMeter/4.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode(errors="ignore"))
    except Exception:
        return None


def http_get_text(url, timeout=2.5):
    """Simple HTTP GET → text. Returns None on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "IndiMeter/4.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode(errors="ignore")
    except Exception:
        return None


def _ping(ip, timeout=1):
    """
    Quick ICMP ping to check if host is alive on the subnet.
    Returns True if the IP responds, False otherwise.

    Used only when TCP port is closed — adds ~1s worst case, zero
    overhead when TV is ON. Separates two physical states:
      Port closed + ping alive  =  STANDBY (WiFi radio on, screen off)
      Port closed + ping dead   =  ENDED   (TV gone from network)
    """
    try:
        result = subprocess.run(
            ['ping', '-c', '1', '-W', str(timeout), ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout + 1
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError, Exception):
        return False


# ══════════════════════════════════════════════════════════════════════════════
#  BRAND-SPECIFIC DISCOVERY (scan phase)
# ══════════════════════════════════════════════════════════════════════════════

def discover_samsung(ip):
    """Samsung Tizen — GET /api/v2/ for device info."""
    data = http_get_json(f"http://{ip}:8001/api/v2/")
    if not data:
        return {"brand": "samsung", "api_ok": False}
    device = data.get("device", data)
    return {
        "brand": "samsung", "api_ok": True,
        "model": device.get("modelName", ""),
        "name":  device.get("name", ""),
        "mac":   (device.get("wifiMac") or "").upper() or None,
    }


def discover_cast(ip):
    """Cast/DIAL — eureka_info, SSDP desc, DIAL apps."""
    info = {"brand": "cast_tv", "api_ok": False, "name": "", "model": "", "mac": None}

    # eureka_info
    data = http_get_json(f"http://{ip}:8008/setup/eureka_info")
    if data:
        info["api_ok"] = True
        info["name"] = data.get("name", "")
        info["model"] = data.get("model_name", "")
        info["mac"] = (data.get("mac_address") or "").upper() or None

    # SSDP device-desc.xml (fallback for name/model/manufacturer)
    xml = http_get_text(f"http://{ip}:8008/ssdp/device-desc.xml")
    if xml:
        info["api_ok"] = True
        for tag, key in [("friendlyName", "name"), ("modelName", "model")]:
            m = re.search(rf"<{tag}>(.*?)</{tag}>", xml)
            if m and not info.get(key):
                info[key] = m.group(1)
        mfr = re.search(r"<manufacturer>(.*?)</manufacturer>", xml)
        if mfr:
            info["manufacturer"] = mfr.group(1)

    if not info["api_ok"]:
        return {"brand": "cast_tv", "api_ok": False}
    return info


def discover_roku(ip):
    """Roku ECP — /query/device-info."""
    xml = http_get_text(f"http://{ip}:8060/query/device-info")
    if not xml:
        return {"brand": "roku", "api_ok": False}

    def xv(tag):
        m = re.search(rf"<{tag}>(.*?)</{tag}>", xml)
        return m.group(1) if m else ""

    return {
        "brand": "roku", "api_ok": True,
        "name":  xv("friendly-device-name") or xv("user-device-name"),
        "model": xv("model-name"),
        "mac":   (xv("wifi-mac") or xv("ethernet-mac")).upper() or None,
    }


def discover_philips(ip):
    """Philips JointSpace."""
    for ver in ["6", "1"]:
        data = http_get_json(f"http://{ip}:1925/{ver}/system")
        if data:
            return {
                "brand": "philips", "api_ok": True,
                "name": data.get("name", ""), "model": data.get("model", ""),
            }
    return {"brand": "philips", "api_ok": False}


def discover_lg(ip):
    """LG WebOS — port open confirms presence."""
    return {"brand": "lg", "api_ok": True, "model": "LG TV"}


def discover_android_tv(ip):
    """Android TV ADB — port open confirms ADB enabled."""
    return {"brand": "android_tv", "api_ok": True}


def discover_generic(ip, brand):
    """Generic — port open, no API to probe."""
    return {"brand": brand, "api_ok": False}


DISCOVER_FUNCS = {
    "samsung":    discover_samsung,
    "lg":         discover_lg,
    "android_tv": discover_android_tv,
    "cast_tv":    discover_cast,
    "roku":       discover_roku,
    "philips":    discover_philips,
    "hisense":    lambda ip: discover_generic(ip, "hisense"),
    "vizio":      lambda ip: discover_generic(ip, "vizio"),
    "sony":       lambda ip: discover_generic(ip, "sony"),
    "vise":       lambda ip: discover_generic(ip, "vise"),
}


# ══════════════════════════════════════════════════════════════════════════════
#  SUBNET SCAN — 14-port TCP sweep (no ping gate)
# ══════════════════════════════════════════════════════════════════════════════

def is_plain_http_server(ip, port=3000, timeout=1.5):
    """
    v4.2 — LG false-positive guard.
    True if the port answers like a standard HTTP/web server (e.g. a
    Next.js / Node / Grafana dev server squatting on LG's control port 3000).

    Hardware-proven on IM000030:
      real LG  192.168.0.34:3000  -> TIMEOUT/silent        -> returns False
      Next.js  192.168.0.191:3000 -> 'HTTP/1.1 307 ...'     -> returns True
    Used ONLY to gate LG (port 3000). NEVER applied to Samsung(8001),
    Roku(8060), Cast(8008) or Philips(1925) — those control ports are
    legitimately HTTP REST APIs and would be wrongly rejected.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
        s.sendall(
            f"GET / HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n"
            .encode("utf-8")
        )
        resp = s.recv(64).decode("utf-8", errors="ignore")
        return resp.startswith("HTTP/1.")
    except Exception:
        # timeout / reset / closed / empty = NOT a web server = real LG port
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def probe_host_all_ports(ip):
    """Probe all TV ports on one IP. Returns dict or None."""
    open_ports = []
    for port in TV_PORT_MAP:
        is_open, _ = tcp_probe(ip, port, timeout=TCP_GATE_TIMEOUT)
        if is_open:
            open_ports.append(port)

    if not open_ports:
        return None

    # Get MAC from ARP (TCP probes already triggered ARP resolution)
    mac = get_arp_mac(ip)

    # Determine brands from open ports
    brands_found = sorted(set(TV_PORT_MAP[p] for p in open_ports))

    # v4.2 — LG guard. Port 3000 collides with Next.js/Node/Grafana dev
    # servers. Real LG webOS is silent to a plain HTTP GET; a web server
    # answers 'HTTP/1.'. If 3000 answers HTTP, it is NOT an LG TV.
    # Scoped to LG only — other brands' ports are legitimately HTTP.
    if "lg" in brands_found and (3000 in open_ports or 3001 in open_ports):
        if is_plain_http_server(ip, 3000):
            log.info(f"[{ip}] port 3000 open but answered plain HTTP — "
                     f"web server, not an LG TV; rejecting lg")
            brands_found = [b for b in brands_found if b != "lg"]
            open_ports = [p for p in open_ports if p not in (3000, 3001)]
            if not brands_found:
                return None

    # Query APIs for each brand
    api_results = {}
    for brand in brands_found:
        brand_ports = sorted(p for p, b in TV_PORT_MAP.items()
                             if b == brand and p in open_ports)
        func = DISCOVER_FUNCS.get(brand, lambda ip: discover_generic(ip, brand))
        try:
            api_results[brand] = func(ip)
        except Exception:
            api_results[brand] = {"brand": brand, "api_ok": False}

    # Pick winning brand: api_ok=True first, then priority order
    verified = [b for b in brands_found if api_results.get(b, {}).get("api_ok")]
    pool = verified if verified else brands_found

    primary_brand = pool[0]
    for b in BRAND_PRIORITY:
        if b in pool:
            primary_brand = b
            break

    info = api_results.get(primary_brand, {})

    # Use API-provided MAC, fallback to ARP MAC
    device_mac = info.get("mac") or mac
    if device_mac == "00:00:00:00:00:00":
        device_mac = mac

    return {
        "ip":       ip,
        "tv_type":  primary_brand,
        "mac":      device_mac,
        "model":    info.get("model") or info.get("name") or f"{primary_brand} TV",
        "name":     info.get("name", ""),
        "ports":    sorted(open_ports),
        "brands":   brands_found,
    }


def scan_subnet():
    """Full /24 TCP sweep — finds all TVs regardless of ping response."""
    pi_ip = get_pi_ip()
    if not pi_ip:
        log.error("[SCAN] Cannot determine Pi IP")
        return None

    subnet = ".".join(pi_ip.split(".")[:3])
    log.info(f"[SCAN] Scanning {subnet}.0/24 — {len(TV_PORT_MAP)} ports, "
             f"{SCAN_WORKERS} workers, TCP {TCP_GATE_TIMEOUT}s timeout "
             f"[adb={'yes' if HAS_ADB else 'no'}, "
             f"pywebostv={'yes' if HAS_PYWEBOSTV else 'no'}]")
    start = time.time()

    candidates = []
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        futures = {
            pool.submit(probe_host_all_ports, f"{subnet}.{i}"): i
            for i in range(1, 255)
            if f"{subnet}.{i}" != pi_ip
        }
        for future in as_completed(futures):
            try:
                result = future.result()
                if result:
                    upsert_device(
                        result["ip"], result["tv_type"],
                        mac=result.get("mac"),
                        model=result.get("model"),
                        name=result.get("name"),
                    )
                    candidates.append(result)
                    log.info(f"[SCAN] ✓ {result['ip']} → {result['tv_type']} "
                             f"({result.get('model','?')}) "
                             f"ports:{result['ports']} mac:{result.get('mac','?')}")
            except Exception:
                pass

    elapsed = time.time() - start
    log.info(f"[SCAN] Complete — {len(candidates)} TV(s) in {elapsed:.1f}s")
    return candidates


# ══════════════════════════════════════════════════════════════════════════════
#  APP/SOURCE MONITORING — per brand
# ══════════════════════════════════════════════════════════════════════════════

def samsung_get_source(ip):
    """Samsung: check /api/v2/ for PowerState + running apps."""
    # First check power state
    try:
        data = http_get_json(f"http://{ip}:8001/api/v2/")
        if data:
            device = data.get("device", {})
            power = device.get("PowerState", "").lower()
            if power == "standby":
                return "__STANDBY__"  # Special marker: TV going to sleep
    except Exception:
        pass

    # Check each known app
    for app_id, name in SAMSUNG_APPS.items():
        try:
            r = http_get_json(f"http://{ip}:8001/api/v2/applications/{app_id}")
            if r and r.get("running") and r.get("visible"):
                return name
        except Exception:
            return None  # TV unreachable
    return "TV"


def android_tv_get_source(ip):
    """Android TV: ADB dumpsys for foreground activity."""
    if not HAS_ADB:
        return None
    try:
        r = subprocess.run(
            ["adb", "connect", f"{ip}:5555"],
            capture_output=True, text=True, timeout=ADB_TIMEOUT
        )
        if "unable" in r.stdout.lower() or "connected" not in r.stdout.lower():
            subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                           capture_output=True, timeout=3)
            return None

        r = subprocess.run(
            ["adb", "-s", f"{ip}:5555", "shell",
             "dumpsys", "activity", "activities"],
            capture_output=True, text=True, timeout=ADB_TIMEOUT
        )

        raw_app = ""
        for line in r.stdout.splitlines():
            if "mResumedActivity" in line or "ResumedActivity" in line:
                for pkg, name in ANDROID_TV_APPS.items():
                    if pkg in line:
                        subprocess.run(
                            ["adb", "disconnect", f"{ip}:5555"],
                            capture_output=True, timeout=3
                        )
                        return name
                # Extract raw package for OTHER_OTT
                m = re.search(r'(\S+/\S+)', line)
                if m:
                    raw_app = m.group(1).split("/")[0]
                break

        subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                       capture_output=True, timeout=3)

        if raw_app:
            return f"OTHER_OTT:{raw_app}"
        return "TV"

    except Exception:
        try:
            subprocess.run(["adb", "disconnect", f"{ip}:5555"],
                           capture_output=True, timeout=3)
        except Exception:
            pass
        return None


# ── LG webOS ─────────────────────────────────────────────────────────────────
_lg_clients = {}


def _lg_connect(ip, pairing_key=None):
    """Connect to LG TV with timeout wrapper to prevent 4-min hang."""
    if not HAS_PYWEBOSTV:
        return None

    result = [None]

    def _connect():
        try:
            store = {}
            if pairing_key:
                store = {"client_key": pairing_key}

            client = WebOSClient(ip, secure=True)
            client.connect()

            registered = False
            for status in client.register(store):
                if status == WebOSClient.REGISTERED:
                    registered = True

            if not registered:
                log.warning(f"[LG] Registration failed for {ip}")
                return

            app_control = ApplicationControl(client)

            new_key = store.get("client_key")
            if new_key and new_key != pairing_key:
                _save_lg_pairing_key(ip, new_key)
                log.info(f"[LG] Pairing key saved for {ip}")

            result[0] = {"client": client, "app_control": app_control}

        except Exception as e:
            log.debug(f"[LG] Connection failed to {ip}: {e}")

    t = threading.Thread(target=_connect, daemon=True)
    t.start()
    t.join(timeout=10)  # 10 second timeout (was unbounded)

    if result[0]:
        _lg_clients[ip] = result[0]
        log.info(f"[LG] Connected to {ip}")
        return result[0]
    else:
        _lg_clients.pop(ip, None)
        return None


def _save_lg_pairing_key(ip, key):
    with _db() as conn:
        conn.execute(
            "UPDATE tv_devices SET pairing_key=? WHERE ip=? AND tv_type='lg'",
            (key, ip)
        )
        conn.commit()


def _classify_lg_app(app_id):
    """Classify LG foreground app. Returns (source, raw_app_id)."""
    if not app_id:
        return ("TV", "")
    app_lower = app_id.lower()
    for pattern, name in LG_APPS.items():
        if pattern in app_lower:
            return (name, app_id)
    if "youtube" in app_lower:
        return ("YOUTUBE", app_id)
    if "netflix" in app_lower:
        return ("NETFLIX", app_id)
    if "hotstar" in app_lower:
        return ("HOTSTAR", app_id)
    if "prime" in app_lower or "amazon" in app_lower:
        return ("PRIME_VIDEO", app_id)
    if "jio" in app_lower:
        return ("JIOCINEMA", app_id)
    if "zee5" in app_lower:
        return ("ZEE5", app_id)
    if "sonyliv" in app_lower:
        return ("SONYLIV", app_id)
    return ("OTHER_OTT", app_id)


def lg_get_source(ip, pairing_key=None):
    """Check foreground app on LG TV. Returns (source, raw_app_id) or None."""
    if not HAS_PYWEBOSTV:
        # Without pywebostv: use port probe as ON/OFF only
        is_open, _ = tcp_probe(ip, 3000, timeout=TCP_MONITOR_TIMEOUT)
        if is_open:
            return ("TV", "")  # ON but can't determine source
        return None

    conn = _lg_clients.get(ip)
    if not conn:
        conn = _lg_connect(ip, pairing_key)
        if not conn:
            return None

    # Thread-wrapped get_current to prevent hang
    result = [None]

    def _get():
        try:
            result[0] = conn["app_control"].get_current()
        except Exception:
            pass

    t = threading.Thread(target=_get, daemon=True)
    t.start()
    t.join(timeout=5)

    if result[0] is None:
        _lg_clients.pop(ip, None)
        return None

    return _classify_lg_app(result[0])


# ── Cast/DIAL source detection ───────────────────────────────────────────────

DIAL_APPS = ["Netflix", "YouTube"]


def cast_get_source(ip):
    """Cast/DIAL: check port reachability + DIAL app states."""
    is_open, _ = tcp_probe(ip, 8008, timeout=TCP_MONITOR_TIMEOUT)
    if not is_open:
        return None  # TV is OFF

    # Check DIAL app states
    for app_name in DIAL_APPS:
        try:
            xml = http_get_text(f"http://{ip}:8008/apps/{app_name}", timeout=1.5)
            if xml:
                state_m = re.search(r"<state>(.*?)</state>", xml)
                if state_m and state_m.group(1).lower() == "running":
                    return (app_name.upper(), app_name)
        except Exception:
            pass

    return ("TV", "")  # ON but no known DIAL app running


# ── Vise / generic port-only detection ────────────────────────────────────────

def vise_get_source(ip):
    """Vise: port reachability only (no content API)."""
    is_open, _ = tcp_probe(ip, 6466, timeout=TCP_MONITOR_TIMEOUT)
    if is_open:
        return ("TV", "")  # ON, no content detection
    return None


def roku_get_source(ip):
    """Roku: check active app via ECP."""
    xml = http_get_text(f"http://{ip}:8060/query/active-app")
    if not xml:
        return None

    app_m = re.search(r'<app id="(\d+)"[^>]*>(.*?)</app>', xml)
    if app_m:
        app_name = app_m.group(2).strip().lower()
        if "youtube" in app_name:
            return ("YOUTUBE", app_m.group(2))
        if "netflix" in app_name:
            return ("NETFLIX", app_m.group(2))
        if "prime" in app_name or "amazon" in app_name:
            return ("PRIME_VIDEO", app_m.group(2))
        if "hotstar" in app_name:
            return ("HOTSTAR", app_m.group(2))
        if app_m.group(1) in ("-1", "0"):
            return ("TV", "")  # Home screen
        return ("OTHER_OTT", app_m.group(2))
    return ("TV", "")


# ── Unified source getter ────────────────────────────────────────────────────

def get_tv_reachable(tv):
    """
    Three-state reachability probe for any brand.

    Returns:
      True      → port open, API responding → TV is ON
      "STANDBY" → Samsung API reports standby, OR port closed but IP
                  responds to ping (WiFi radio alive, screen off)
      False     → port closed AND ping failed → TV gone from network

    Samsung: API is checked first. If PowerState="standby", returns
    "STANDBY" immediately (no need for ping — API is authoritative).

    All others: TCP port probe. If port closed, falls back to ICMP ping
    to distinguish "screen off" (ping alive) from "TV gone" (ping dead).

    No LG WebSocket opened here — the 4-minute hang is gone.
    """
    tv_type = tv["tv_type"]
    ip = tv["ip"]

    # ── Samsung: API first (honours standby + beats 75s ghost port) ──
    if tv_type == "samsung":
        try:
            data = http_get_json(f"http://{ip}:8001/api/v2/",
                                 timeout=HTTP_TIMEOUT)
            if data:
                power = data.get("device", {}).get("PowerState", "").lower()
                if power == "standby":
                    return "STANDBY"
                return True   # API responded with info → ON
        except Exception:
            pass
        # fall through to port probe if HTTP check was inconclusive

    # ── Any brand: ON if ANY of its known ports answers ──────────────
    ports = BRAND_PORTS.get(tv_type) or [BRAND_PRIMARY_PORT.get(tv_type, 8008)]
    for p in ports:
        is_open, _ = tcp_probe(ip, p, timeout=TCP_MONITOR_TIMEOUT)
        if is_open:
            return True

    # ── All ports closed → ping to distinguish STANDBY from ENDED ────
    if _ping(ip):
        return "STANDBY"   # WiFi radio alive, screen off

    return False            # TV gone from network


# ══════════════════════════════════════════════════════════════════════════════
#  STATE TRACKER — per labeled TV
# ══════════════════════════════════════════════════════════════════════════════

class TVState:
    """
    Three-state TV lifecycle:  STARTED → STANDBY → ENDED

    STARTED  — TV is on, content visible. Fires only after silent buffer
               proving window (20s for most brands, 80s for Samsung from
               STANDBY to outlast the 75s ghost port).

    STANDBY  — Screen off, session closed. Two detection paths:
               1. Samsung API reports PowerState:"standby" → instant
               2. Port closed + IP pingable → after 30s grace (inferred)
               3. Port closed + ping dead → fires as session closer
                  BEFORE ENDED (STANDBY always precedes ENDED)

    ENDED    — TV gone from network. Port closed, ping dead, and all
               subnet rescans exhausted. Means IP changed, different
               network, or unplugged.

    Ghost wake filtering:
      Port opens for <20s then closes → reachable_since resets to None.
      ZERO events emitted. Ghost wake is invisible to Indirex.
    """

    GRACE_CHECKS = 6         # 30s unreachable → STANDBY
    ON_BUFFER_SECS = 20.0    # 20s sustained connection → STARTED
    SAMSUNG_BUFFER_SECS = 85.0  # 85s for Samsung from STANDBY
    MAX_RESCANS = 3           # subnet rescans before ENDED

    def __init__(self, label, tv_type, tv_mac=None):
        self.label = label
        self.tv_type = tv_type
        self.tv_mac = tv_mac
        self.fail_count = 0
        self.reachable_since = None      # monotonic clock — real elapsed time
        self.unreachable_since = None
        self.rescan_attempts = 0
        self.on_since = None

        # ── Startup reconciliation ───────────────────────────────
        _last = _LAST_STATE.get(label)      # Plain string or None
        # v4.7: reject persisted state if physical TV changed (MAC mismatch)
        saved_mac = _IDENTITY.get(label)
        if saved_mac and tv_mac and saved_mac != tv_mac:
            log.info(f"[{label}] MAC changed ({saved_mac} → {tv_mac})"
                     f" — clean slate")
            _last = None

        self.is_on = (_last == "STARTED")
        self.is_standby = (_last == "STANDBY")
        self.is_ended = (_last == "ENDED") or (_last is None)

        if self.is_on or self.is_standby:
            self.on_since = time.time()
            state_str = "STANDBY" if self.is_standby else "ON"
            log.info(f"[{label}] Reconcile: last state {state_str}")

    def update(self, reachable):
        """
        Called every 5 seconds per TV.

        reachable = True        → port open, API responding
        reachable = "STANDBY"   → Samsung API standby OR port closed + ping OK
        reachable = False       → port closed + ping failed (TV gone)
        """

        # ══════════════════════════════════════════════════════════
        # 1. STANDBY SIGNAL
        #    Samsung API standby  → instant (authoritative)
        #    Ping-alive standby   → after 30s grace (inferred)
        # ══════════════════════════════════════════════════════════
        if reachable == "STANDBY":
            self.reachable_since = None

            # ── Samsung: API is the ground truth, no grace needed ──
            if self.tv_type == "samsung":
                self.fail_count = 0
                self.unreachable_since = None
                if self.is_on:
                    dur = self._duration()
                    log.warning(f"[{self.label}] >>> STANDBY "
                                f"(Samsung API, was on {dur})")
                    if not dbus_send_tv_event(self.label, "STANDBY",
                                              self.tv_type):
                        log.error(f"[{self.label}] D-Bus failed, "
                                  f"retry next cycle")
                        return
                    _record_state(self.label, "STANDBY", self.tv_mac)
                    self.is_on = False
                    self.is_standby = True
                    self.on_since = None
                # Already standby → stay. Ping alive → no rescans.
                return

            # ── Non-Samsung: port closed, IP still pingable ────────
            self.fail_count += 1
            if self.unreachable_since is None:
                self.unreachable_since = time.time()

            if self.fail_count >= self.GRACE_CHECKS and self.is_on:
                dur = self._duration()
                log.warning(f"[{self.label}] >>> STANDBY "
                            f"(port closed 30s, IP alive, was on {dur})")
                if not dbus_send_tv_event(self.label, "STANDBY",
                                          self.tv_type):
                    log.error(f"[{self.label}] D-Bus failed, "
                              f"retry next cycle")
                    return
                _record_state(self.label, "STANDBY", self.tv_mac)
                self.is_on = False
                self.is_standby = True
                self.on_since = None

            # Ping works → TV is on the network → no rescans needed
            self.rescan_attempts = 0
            self.unreachable_since = None
            return

        # ══════════════════════════════════════════════════════════
        # 2. TV GONE FROM NETWORK (port closed + ping failed)
        # ══════════════════════════════════════════════════════════
        if reachable is False:
            self.reachable_since = None

            # Already ENDED — nothing to do, don't trigger rescans
            if self.is_ended:
                return

            self.fail_count += 1

            if self.unreachable_since is None:
                self.unreachable_since = time.time()

            # Still in grace period → wait
            if self.fail_count < self.GRACE_CHECKS:
                return

            # ── STANDBY fires FIRST (session closer) ─────────────
            # Even when both port and ping are dead, STANDBY always
            # fires before ENDED. This closes the viewing session.
            if self.is_on:
                dur = self._duration()
                log.warning(f"[{self.label}] >>> STANDBY "
                            f"(unreachable 30s, was on {dur})")
                if not dbus_send_tv_event(self.label, "STANDBY",
                                          self.tv_type):
                    log.error(f"[{self.label}] D-Bus failed, "
                              f"retry next cycle")
                    return
                _record_state(self.label, "STANDBY", self.tv_mac)
                self.is_on = False
                self.is_standby = True
                self.on_since = None
                return   # Don't check ENDED on the same cycle

            # ── ENDED fires AFTER rescans are exhausted ───────────
            if self.is_standby and self.rescan_attempts >= self.MAX_RESCANS:
                log.warning(f"[{self.label}] >>> ENDED "
                            f"(rescans exhausted, TV gone from network)")
                if not dbus_send_tv_event(self.label, "ENDED",
                                          self.tv_type):
                    log.error(f"[{self.label}] D-Bus failed, "
                              f"retry next cycle")
                    return
                _record_state(self.label, "ENDED", self.tv_mac)
                self.is_standby = False
                self.is_ended = True
            return

        # ══════════════════════════════════════════════════════════
        # 3. TV REACHABLE (port open, API responding)
        # ══════════════════════════════════════════════════════════

        # Log recovery from downtime
        if self.unreachable_since:
            down = int(time.time() - self.unreachable_since)
            log.info(f"[{self.label}] TV back online (was down {down}s)")

        self.fail_count = 0
        self.unreachable_since = None
        self.rescan_attempts = 0

        # ── Already ON → nothing to do ────────────────────────────
        if self.is_on:
            self.reachable_since = None
            return

        # ── Silent buffer: proving window before STARTED ──────────
        now = time.monotonic()
        if self.reachable_since is None:
            self.reachable_since = now

        # Samsung ghost port: holds TCP 8001 open ~75s after standby.
        # Need 85s of continuous reachability to safely outlast it.
        if self.is_standby and self.tv_type == "samsung":
            buffer_secs = self.SAMSUNG_BUFFER_SECS
        else:
            buffer_secs = self.ON_BUFFER_SECS

        elapsed = now - self.reachable_since
        if elapsed < buffer_secs:
            log.debug(f"[{self.label}] Proving "
                      f"({elapsed:.0f}s / {buffer_secs:.0f}s)")
            return

        # ── Survived proving → TV is genuinely ON ─────────────────
        log.info(f"[{self.label}] >>> STARTED "
                 f"(confirmed after {elapsed:.0f}s)")
        if not dbus_send_tv_event(self.label, "STARTED", self.tv_type):
            log.error(f"[{self.label}] D-Bus failed, retry next cycle")
            return
        _record_state(self.label, "STARTED", self.tv_mac)
        self.is_on = True
        self.is_standby = False
        self.is_ended = False
        self.on_since = time.time()
        self.reachable_since = None

    def needs_rescan(self):
        """True if TV unreachable long enough for DHCP re-scan.
        Rescans are spaced: 60s, 120s, 180s from first unreachable."""
        if self.unreachable_since is None:
            return False
        if self.rescan_attempts >= self.MAX_RESCANS:
            return False
        return (time.time() - self.unreachable_since) >= (
            UNREACHABLE_RESCAN * (self.rescan_attempts + 1)
        )

    def _duration(self):
        if not self.on_since:
            return "unknown"
        elapsed = int(time.time() - self.on_since)
        m, s = divmod(elapsed, 60)
        return f"{m}m {s}s" if m > 0 else f"{s}s"


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ══════════════════════════════════════════════════════════════════════════════

def main():
    global _LAST_STATE, _IDENTITY

    log.info("=" * 60)
    log.info("  TV Monitor Service v4.7 — STARTED/STANDBY/ENDED (Type 51)")
    log.info(f"  Meter ID: {METER_ID}")
    log.info(f"  Ports: {len(TV_PORT_MAP)} ({sorted(TV_PORT_MAP.keys())})")
    log.info(f"  Grace period: {TVState.GRACE_CHECKS * MONITOR_INTERVAL}s "
             f"({TVState.GRACE_CHECKS} checks)")
    log.info("  Type 23: NOT emitted (BT plug owns power)")

    # Load persisted ON/OFF state and MAC identity for startup reconciliation.
    _LAST_STATE = load_state()
    _IDENTITY = _load_identity()
    if _LAST_STATE:
        log.info(f"  Reconcile: restored last state {_LAST_STATE}")
    log.info("=" * 60)

    running = True

    def stop(sig, frame):
        nonlocal running
        log.info("Shutdown signal received")
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    # Initial scan
    scan_subnet()

    last_scan = time.time()
    tv_states = {}

    while running:
        # ── Periodic re-scan ──────────────────────────────────────
        if time.time() - last_scan > SCAN_INTERVAL:
            log.info("[SCAN] Periodic re-scan...")
            scan_subnet()
            last_scan = time.time()

        # ── Get labeled TVs ───────────────────────────────────────
        try:
            tvs = get_labeled_tvs()
        except Exception as e:
            log.error(f"DB error: {e}")
            time.sleep(MONITOR_INTERVAL)
            continue

        # ── Clean up removed labels (runs even if list is empty) ──
        active = {tv["label"] for tv in tvs}
        for label in list(tv_states.keys()):
            if label not in active:
                log.info(f"[{label}] Label removed, stopping monitor")
                del tv_states[label]
                if label in _LAST_STATE:
                    _LAST_STATE.pop(label, None)
                    save_state(_LAST_STATE)
                if label in _IDENTITY:
                    _IDENTITY.pop(label, None)
                    _save_identity(_IDENTITY)

        if not tvs:
            time.sleep(MONITOR_INTERVAL)
            continue

        # ── Monitor each labeled TV (PARALLEL probes) ──────────────
        rescan_needed = False

        # Ensure TVState objects exist for every labeled TV
        for tv in tvs:
            label = tv["label"]
            tv_mac = tv.get("mac")
            if label not in tv_states:
                tv_states[label] = TVState(label, tv["tv_type"], tv_mac)
                log.info(f"[{label}] Monitoring: {tv['tv_type']} "
                         f"{tv.get('model','?')} at {tv['ip']} "
                         f"(mac={tv_mac or '?'})")
            else:
                st = tv_states[label]
                # Fix 2: Check if physical TV changed (MAC mismatch)
                if (tv_mac and st.tv_mac and tv_mac != st.tv_mac):
                    log.info(f"[{label}] Device changed "
                             f"({st.tv_mac} → {tv_mac}) — resetting")
                    tv_states[label] = TVState(label, tv["tv_type"],
                                               tv_mac)
                elif st.tv_type != tv["tv_type"]:
                    old_type = st.tv_type
                    st.tv_type = tv["tv_type"]
                    log.info(f"[{label}] tv_type updated: "
                             f"{old_type} → {tv['tv_type']}")

        # Probe ALL TVs in parallel — total time = max(single probe) ≈ 1s
        with ThreadPoolExecutor(max_workers=min(len(tvs), 7)) as pool:
            futures = {pool.submit(get_tv_reachable, tv): tv for tv in tvs}
            for fut in as_completed(futures):
                tv = futures[fut]
                label = tv["label"]
                try:
                    reachable = fut.result()
                except Exception:
                    reachable = False
                tv_states[label].update(reachable)

                if tv_states[label].needs_rescan():
                    rescan_needed = True

        # ── Re-scan if TV went unreachable (DHCP) ─────────────────
        if rescan_needed:
            log.info("[SCAN] Triggered re-scan (TV unreachable, "
                     "possible DHCP change)...")
            results = scan_subnet()
            last_scan = time.time()
            # Fix 4: Only count attempt if scan actually ran
            # scan_subnet returns None if it couldn't determine Pi IP
            if results is not None:
                for label in list(tv_states.keys()):
                    if tv_states[label].needs_rescan():
                        tv_states[label].rescan_attempts += 1

            try:
                refreshed = get_labeled_tvs()
                for tv in refreshed:
                    if tv["label"] in tv_states:
                        log.info(f"[{tv['label']}] Current IP: {tv['ip']}")
            except Exception:
                pass

        time.sleep(MONITOR_INTERVAL)

    log.info("TV Monitor stopped.")


if __name__ == "__main__":
    main()
