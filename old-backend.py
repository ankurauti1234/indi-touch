#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import json
import time
import subprocess
import threading
import requests
from typing import List, Tuple

from flask import Flask, render_template, request, jsonify
from flask_cors import CORS

from PyQt5 import QtWidgets, QtCore
from PyQt5.QtCore import QUrl, Qt
from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEngineSettings
from PyQt5.QtGui import QKeySequence
from PyQt5.QtWidgets import QShortcut

import paho.mqtt.client as mqtt
import ssl

from datetime import datetime


from functools import partial

import sqlite3

import shutil

runtime_dir = "/tmp/runtime-root"

if os.path.exists(runtime_dir):
    shutil.rmtree(runtime_dir)

os.makedirs(runtime_dir, mode=0o700)

# pylint: disable=no-member
os.chown(runtime_dir, 0, 0)  # root:root
# pylint: enable=no-member

os.environ["XDG_RUNTIME_DIR"] = runtime_dir

# ----------------------------------------------------------------------
# 1. Qt / Chromium sandbox settings (uncomment if needed on restricted env)
# ----------------------------------------------------------------------
os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--no-sandbox"
# os.environ["XDG_RUNTIME_DIR"] = "/tmp/runtime-root"
os.makedirs("/tmp/runtime-root", exist_ok=True)
os.chmod("/tmp/runtime-root", 700)

# ----------------------------------------------------------------------
# 2. Flask application
# ----------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# ----------------------------------------------------------------------
# 3. Device configuration
# ----------------------------------------------------------------------
DEVICE_CONFIG = {
    "device_id_file": "/var/lib/device_id.txt",
    "hhid_file": "/var/lib/hhid.txt",
    # "default_meter_id": "AM100003",
    # "members_file": "/var/lib/meter_members.json",
    # "guests_file": "/var/lib/meter_guests.json",
    "certs_dir": "/opt/apm/certs"
}

SYSTEM_FILES = {
    "install_done": "/var/lib/self_installation_done",
    "wifi_up": "/run/wifi_network_up",
    "gsm_up": "/run/gsm_network_up",
    "jack_status": "/run/jack_status",
    "hdmi_input": "/run/input_source_hdmi",
    "video_detection": "/run/video_object_detection",
    "current_state": "/var/lib/current_state",
}

DB_PATH = "/var/lib/meter.db"

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.cursor()
        
        # Create members table if not exists
        cur.execute("""
            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id TEXT NOT NULL,
                hhid TEXT NOT NULL,
                member_code TEXT,
                name TEXT,                    -- ← NEW COLUMN
                dob TEXT,
                gender TEXT,
                created_at TEXT,
                active INTEGER DEFAULT 0
            )
        """)

        # Add 'name' column if it doesn't exist (for upgrades)
        cur.execute("PRAGMA table_info(members)")
        columns = [col[1] for col in cur.fetchall()]
        if 'name' not in columns:
            print("[DB] Adding 'name' column to members table")
            cur.execute("ALTER TABLE members ADD COLUMN name TEXT")
            
            # Backfill: set name = member_code where null
            cur.execute("""
                UPDATE members 
                SET name = member_code 
                WHERE name IS NULL AND member_code IS NOT NULL
            """)

        # Guests table (unchanged)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS guests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id TEXT NOT NULL,
                hhid TEXT NOT NULL,
                age INTEGER,
                gender TEXT,
                active INTEGER DEFAULT 1
            )
        """)
        conn.commit()

def deactivate_all_members_and_publish():
    """On boot: reset members to inactive and QUEUE a fresh Type 3 event"""
    try:
        hhid = load_hhid()
        if not hhid:
            print("[BOOT] No HHID configured yet — skipping member reset")
            return

        # Reset all members to inactive in DB
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.cursor()
            cur.execute("UPDATE members SET active = 0 WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
            count = cur.rowcount
            conn.commit()
        print(f"[BOOT] Deactivated {count} members in database")

        # Build fresh Type 3 payload (all inactive)
        data = load_members_data()
        members = [
            {
                "member_id": m.get("member_code", ""),
                "age": calculate_age(m["dob"]),
                "gender": m["gender"],
                "active": m.get("active", False)
            }
            for m in data.get("members", [])
            if "dob" in m and "gender" in m and calculate_age(m["dob"]) is not None
        ]

        payload = {
            "DEVICE_ID": METER_ID,
            "TS": str(int(time.time())),
            "Type": 3,
            "Details": {"members": members}
        }

        # DIRECTLY enqueue it — bypasses any early direct-publish attempt
        _enqueue(payload)
        print("[BOOT] Fresh 'all inactive' Type 3 event QUEUED — will be sent when MQTT connects")

    except Exception as e:
        print(f"[BOOT] Error in deactivate_all_members_and_publish: {e}")

def clear_guests_and_publish():
    """On boot: remove all guests and queue a fresh Type 4 event (no guests)"""
    try:
        hhid = load_hhid()
        if not hhid:
            print("[BOOT] No HHID yet — skipping guest clear")
            return

        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.cursor()
            # Delete all guests for this meter and household
            cur.execute("DELETE FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
            deleted_count = cur.rowcount
            conn.commit()

        print(f"[BOOT] Removed {deleted_count} guests from database")

        # Build fresh Type 4 payload — empty guests list
        payload = {
            "DEVICE_ID": METER_ID,
            "TS": str(int(time.time())),
            "Type": 4,
            "Details": {
                "guests": []   # Empty list = no guests
            }
        }

        # Directly enqueue it
        _enqueue(payload)
        print("[BOOT] Fresh 'no guests' Type 4 event QUEUED")

    except Exception as e:
        print(f"[BOOT] Error in clear_guests_and_publish: {e}")

def get_meter_id():
    device_id_file = DEVICE_CONFIG["device_id_file"]
    
    if os.path.exists(device_id_file):
        try:
            with open(device_id_file, "r") as f:
                meter_id = f.read().strip()
                if meter_id:                    # not empty
                    return meter_id
        except Exception as e:
            print(f"[CONFIG] Failed to read {device_id_file}: {e}")
    
    # If file doesn't exist or is empty → fall back
    fallback = DEVICE_CONFIG.get("default_meter_id", "IM000000")
    print(f"[CONFIG] Using fallback meter ID: {fallback}")
    return fallback

# ----------------------------------------------------------------------
# 4. Load meter-id
# ----------------------------------------------------------------------
try:
    with open(DEVICE_CONFIG["device_id_file"], "r") as f:
        METER_ID = f.read().strip()
except FileNotFoundError:
    METER_ID = get_meter_id()
print(f"[INFO] METER_ID = {METER_ID}")

# ----------------------------------------------------------------------
# 5. Helper utilities
# ----------------------------------------------------------------------
def run_system_command(command: List[str]) -> Tuple[bool, str]:
    try:
        res = subprocess.run(command, check=True, capture_output=True, text=True)
        return True, res.stdout
    except subprocess.CalledProcessError as e:
        return False, e.stderr


def current_state() -> str:
    if not os.path.exists(SYSTEM_FILES["current_state"]):
        with open(SYSTEM_FILES["current_state"], "w") as f:
            f.write("welcome")
    return open(SYSTEM_FILES["current_state"]).read().strip()

def set_current_state(state: str):
    with open(SYSTEM_FILES["current_state"], "w") as f:
        f.write(state)


def is_installation_done() -> bool:
    if not os.path.exists(SYSTEM_FILES["install_done"]):
        with open(SYSTEM_FILES["install_done"], "w") as f:
            f.write("0")
    return open(SYSTEM_FILES["install_done"]).read().strip() == "1"


def set_installation_done():
    with open(SYSTEM_FILES["install_done"], "w") as f:
        f.write("1")


def save_hhid(hhid: str):
    with open(DEVICE_CONFIG["hhid_file"], "w") as f:
        f.write(hhid)


def load_hhid() -> str:
    try:
        with open(DEVICE_CONFIG["hhid_file"], "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def save_members_data(data: dict):
    meter_id = data.get("meter_id", METER_ID)
    hhid = data.get("hhid", load_hhid())
    members = data.get("members", [])
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM members WHERE meter_id = ? AND hhid = ?", (meter_id, hhid))
        for m in members:
            cur.execute("""
                INSERT INTO members (
                    meter_id, hhid, member_code, name, dob, gender, created_at, active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                meter_id, hhid,
                m.get("member_code"),
                m.get("name", m.get("member_code")),  # fallback to member_code if name missing
                m.get("dob"),
                m.get("gender"),
                m.get("created_at"),
                int(m.get("active", False))
            ))
        conn.commit()


def load_members_data() -> dict:
    hhid = load_hhid()
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT member_code, name, dob, gender, created_at, active
            FROM members WHERE meter_id = ? AND hhid = ?
        """, (METER_ID, hhid))
        members = []
        for row in cur.fetchall():
            members.append({
                "member_code": row[0],
                "name": row[1] or row[0],  # fallback to member_code if name is NULL
                "dob": row[2],
                "gender": row[3],
                "created_at": row[4],
                "active": bool(row[5])
            })
    return {"meter_id": METER_ID, "hhid": hhid, "members": members}


# ----------------------------------------------------------------------
# 6. MQTT Setup – ULTRA ROBUST: logs missing certs, auto-retry, instant publish
# ----------------------------------------------------------------------
MQTT_TOPIC          = "indi/AM/meter"
AWS_IOT_ENDPOINT    = "a3uoz4wfsx2nz3-ats.iot.ap-south-1.amazonaws.com"
RECONNECT_DELAY     = 5
MAX_RECONNECT_DELAY = 60

client   = None
_pub_q   = []
_q_lock  = threading.Lock()

def _mqtt_log(msg: str):
    print(f"[MQTT] {msg}")

# ----------------------------------------------------------------------
# Cert validation with detailed logging
# ----------------------------------------------------------------------
def get_cert_paths():

    certs_dir = DEVICE_CONFIG["certs_dir"]


    keyfile   = os.path.join(certs_dir, f"{METER_ID}.key")
    certfile  = os.path.join(certs_dir, f"{METER_ID}Chain.crt")
    cafile    = os.path.join(certs_dir, "AmazonRootCA1.pem")

    missing = []
    if not os.path.exists(keyfile):   missing.append(f"KEY: {keyfile}")
    if not os.path.exists(certfile):  missing.append(f"CERT: {certfile}")
    if not os.path.exists(cafile):    missing.append(f"CA: {cafile}")

    if missing:
        _mqtt_log("CERTS MISSING → " + " | ".join(missing))
        return None
    else:
        _mqtt_log(f"Certs OK: {keyfile}, {certfile}, {cafile}")
        return keyfile, certfile, cafile

# ----------------------------------------------------------------------
# Queue
# ----------------------------------------------------------------------
def _enqueue(payload: dict):
    with _q_lock:
        _pub_q.append(payload)
    _mqtt_log(f"QUEUED (size={len(_pub_q)})")

def _flush_queue():
    with _q_lock:
        if not _pub_q:
            _mqtt_log("Flush called — queue empty, nothing to do")
            return

        to_send = _pub_q[:]
        _pub_q.clear()

    _mqtt_log(f"Flushing {len(to_send)} queued events...")
    for pl in to_send:
        try:
            _mqtt_log(f"  Sending Type {pl.get('Type')} ...")
            client.publish(MQTT_TOPIC, json.dumps(pl))
        except Exception as e:
            _mqtt_log(f"  Publish failed: {e} — re-queuing this event")
            with _q_lock:
                _pub_q.append(pl)  # only re-queue the failed one
            break  # stop on first error — retry on next connect
    _mqtt_log("Flush attempt done")
# ----------------------------------------------------------------------
# MQTT Callbacks
# ----------------------------------------------------------------------
def on_connect(client_, userdata, flags, rc, *args):
    if rc == 0:
        _mqtt_log(f"CONNECTED → flushing queue (size={len(_pub_q)})")
        _flush_queue()
    else:
        _mqtt_log(f"CONNECT FAILED rc={rc}")

def on_disconnect(client_, userdata, rc):
    _mqtt_log(f"DISCONNECTED rc={rc}" + (" (will reconnect)" if rc != 0 else ""))

def on_publish(client_, userdata, mid):
    _mqtt_log(f"PUBLISHED mid={mid}")

# ----------------------------------------------------------------------
# MQTT Worker Thread
# ----------------------------------------------------------------------
def _mqtt_worker():
    global client
    backoff = RECONNECT_DELAY

    while True:
        cert_paths = get_cert_paths()
        if not cert_paths:
            time.sleep(10)
            continue

        keyfile, certfile, cafile = cert_paths

        try:
            # Remove the callback_api_version parameter to match the working code
            client = mqtt.Client(client_id=METER_ID, clean_session=False)
            client.tls_set(ca_certs=cafile, certfile=certfile, keyfile=keyfile,
                           tls_version=ssl.PROTOCOL_TLSv1_2)
            client.on_connect = on_connect
            client.on_disconnect = on_disconnect
            client.on_publish = on_publish

            _mqtt_log(f"Connecting to {AWS_IOT_ENDPOINT}:8883")
            client.connect(AWS_IOT_ENDPOINT, 8883, keepalive=60)
            client.loop_forever()
        except Exception as e:
            _mqtt_log(f"MQTT ERROR: {e}")

        _mqtt_log(f"Reconnecting in {backoff}s...")
        time.sleep(backoff)
        backoff = min(backoff * 2, MAX_RECONNECT_DELAY)

# ----------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------
def init_mqtt() -> bool:
    t = threading.Thread(target=_mqtt_worker, daemon=True)
    t.start()
    time.sleep(1)
    return True

import time

def publish_member_event():
    data = load_members_data()
    members = [
        {
            "member_id": m.get("member_code", ""),   # ← Always use member_code here!
            "age": calculate_age(m["dob"]),
            "gender": m["gender"],
            "active": m.get("active", False)
        }
        for m in data.get("members", [])
        if all(k in m for k in ["dob", "gender"]) and calculate_age(m["dob"]) is not None
    ]

    payload = {
        "DEVICE_ID": METER_ID,
        "TS": str(int(time.time())),
        "Type": 3,
        "Details": {"members": members}
    }

    if members:
        if client and client.is_connected():
            try:
                _mqtt_log(f"PUBLISHING: {payload}")
                client.publish(MQTT_TOPIC, json.dumps(payload))
            except Exception as e:
                _mqtt_log(f"Publish failed: {e}")
                _enqueue(payload)
        else:
            _enqueue(payload)
    else:
        _mqtt_log("No valid members to publish")


def calculate_age(dob_str):
    try:
        dob = datetime.strptime(dob_str, "%Y-%m-%d")
        today = datetime.today()
        return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
    except Exception:
        return None


# ----------------------------------------------------------------------
# 7. Flask routes
# ----------------------------------------------------------------------
API_BASE = "https://bt72jq8w9i.execute-api.ap-south-1.amazonaws.com/test"
INITIATE_URL = f"{API_BASE}/initiate-assignment"
VERIFY_URL   = f"{API_BASE}/verify-otp"
MEMBERS_URL  = f"{API_BASE}/members"

# === GUESTS FILE ===

def load_guests_count():
    """Fast count — used by main dashboard"""
    try:
        hhid = load_hhid()
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
            return cur.fetchone()[0]
    except Exception as e:
        print(f"[GUESTS] Count error: {e}")
        return 0

def get_guests_for_ui():
    """Full list — used when opening Add Guest dialog"""
    try:
        return load_guests_data()
    except:
        return []

@app.route("/api/guest_count", methods=["GET"])
def api_guest_count():
    count = load_guests_count()
    return jsonify({"success": True, "count": count}), 200

@app.route("/api/guests_list", methods=["GET"])
def api_guests_list():
    guests = get_guests_for_ui()
    return jsonify({"success": True, "guests": guests}), 200
    

@app.route("/api/update_guests", methods=["POST"])
def update_guests():
    try:
        payload = request.get_json()
        if not payload or "Details" not in payload:
            return jsonify({"success": False, "error": "Invalid payload"}), 400

        guest_list = payload["Details"].get("guests", [])

        # THIS LINE FIXES EVERYTHING
        save_guests_data(guest_list)  # ← Saves to db

        payload_json = json.dumps(payload)

        publish_ok = False
        if client and client.is_connected():
            publish_ok = wait_for_publish_success(client, payload_json, timeout=8.0)

        if not publish_ok:
            _enqueue(payload)

        return jsonify({
            "success": True,
            "guest_count": len(guest_list),
            "mqtt_status": "sent" if publish_ok else "queued"
        }), 200

    except Exception as e:
        print(f"[ERROR] update_guests: {e}")
        import traceback; traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/sync_guests", methods=["POST"])
def sync_guests():
    try:
        data = request.get_json()
        if not data or "guests" not in data:
            return jsonify({"success": False, "error": "Invalid data"}), 400

        guest_list = data["guests"]

        # Build MQTT payload
        payload = {
            "DEVICE_ID": METER_ID,
            "TS": str(int(time.time())),
            "Type": 4,
            "Details": {
                "guests": [
                    {"age": g["age"], "gender": g["gender"], "active": True}
                    for g in guest_list
                ]
            }
        }

        payload_json = json.dumps(payload)
        _mqtt_log(f"SYNC GUESTS → {len(guest_list)} guests")

        publish_ok = False
        if client and client.is_connected():
            publish_ok = wait_for_publish_success(client, payload_json, timeout=8.0)

        if not publish_ok:
            _enqueue(payload)
            publish_ok = True

        if not publish_ok:
            return jsonify({"success": False, "error": "Cannot sync"}), 503

        # Save guests to db
        save_guests_data(guest_list)

        return jsonify({
            "success": True,
            "guest_count": len(guest_list)
        }), 200

    except Exception as e:
        _mqtt_log(f"ERROR sync_guests: {e}")
        return jsonify({"success": False, "error": "Server error"}), 500


@app.route("/api/get_guests", methods=["GET"])
def get_guests():
    guests = load_guests_data()
    return jsonify({
        "success": True,
        "guests": guests,
        "count": len(guests)
    }), 200

# === GUESTS ARE NOW STORED IN DB ===
def load_guests_data():
    """Load only guests from the db"""
    try:
        hhid = load_hhid()
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT age, gender, active
                FROM guests WHERE meter_id = ? AND hhid = ?
            """, (METER_ID, hhid))
            guests = []
            for row in cur.fetchall():
                guests.append({
                    "age": row[0],
                    "gender": row[1],
                    "active": bool(row[2])
                })
            return guests
    except Exception as e:
        print(f"[GUESTS] Load error: {e}")
        return []

def save_guests_data(guest_list):
    """Save guests to the db"""
    try:
        hhid = load_hhid()
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
            for g in guest_list:
                cur.execute("""
                    INSERT INTO guests (meter_id, hhid, age, gender, active)
                    VALUES (?, ?, ?, ?, ?)
                """, (METER_ID, hhid, g.get("age"), g.get("gender"), int(g.get("active", True))))
            conn.commit()
        print(f"[GUESTS] Saved {len(guest_list)} guests → db")
    except Exception as e:
        print(f"[GUESTS] Save failed: {e}")
        raise

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/check_installation", methods=["GET"])
def check_installation():
    return jsonify({"installed": is_installation_done(), "meter_id": METER_ID})


@app.route("/api/check_current_state", methods=["GET"])
def check_current_state():
    return jsonify({"current_state": current_state()})


@app.route("/api/check_wifi", methods=["GET"])
def check_wifi():
    set_current_state("connect_select")
    try:
        ok, out = run_system_command(
            ["nmcli", "-t", "-f", "TYPE,DEVICE", "connection", "show", "--active"]
        )
        if not ok:
            return jsonify({"success": False}), 200

        for line in out.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":", 1)
            if len(parts) < 2:
                continue
            conn_type, device = parts[0], parts[1]

            if conn_type == "802-11-wireless" and (device.startswith("wlan") or device.startswith("wlx")):
                return jsonify({"success": True}), 200

        return jsonify({"success": False}), 200
    except Exception:
        return jsonify({"success": False}), 200


@app.route("/api/current_wifi", methods=["GET"])
def current_wifi():
    try:
        ok, out = run_system_command(
            ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"]
        )
        if not ok:
            return jsonify({"success": False, "error": "nmcli failed"}), 500

        for line in out.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue

            name, conn_type, device = parts[0], parts[1], parts[2]

            if conn_type == "802-11-wireless" and (device.startswith("wlan") or device.startswith("wlx")):
                return jsonify({"success": True, "ssid": name}), 200

        return jsonify({"success": False, "error": "No active Wi-Fi connection"}), 404

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/wifi/connect", methods=["POST"])
def wifi_connect():
    data = request.json
    ssid = data.get("ssid")
    pwd = data.get("password")

    if not ssid:
        return jsonify({"success": False, "error": "SSID is required"}), 400
    if not pwd:
        return jupytext({"success": False, "error": "Password is required"}), 400

    wifi_up_file = SYSTEM_FILES["wifi_up"]

    try:
        # Step 1: Delete existing connection (ignore errors if not exists)
        delete_cmd = ["sudo", "nmcli", "connection", "delete", ssid]
        try:
            run_system_command(delete_cmd)
            print(f"[WiFi] Removed existing connection: {ssid}")
        except subprocess.CalledProcessError as e:
            # It's OK if connection doesn't exist
            if "not found" not in e.stderr.lower():
                print(f"[WiFi] Warning: Failed to delete old connection: {e.stderr}")
        except Exception as e:
            print(f"[WiFi] Unexpected error deleting connection: {e}")

        # Step 2: Connect to Wi-Fi
        connect_cmd = ["sudo", "nmcli", "device", "wifi", "connect", ssid, "password", pwd]
        ok, out = run_system_command(connect_cmd)

        if not ok:
            error_msg = out.strip() or "Unknown error during nmcli connect"
            print(f"[WiFi] Connection failed: {error_msg}")
            return jsonify({
                "success": False,
                "error": "Failed to connect",
                "details": error_msg
            }), 500

        print(f"[WiFi] Successfully connected to {ssid}")

        # Step 3: Create /run/wifi_network_up file using sudo tee
        try:
            # Use tee to write as root
            subprocess.run(
                ["echo", "1", "|", "sudo", "tee", wifi_up_file],
                shell=True,
                check=True
            )
            print(f"[WiFi] Created flag: {wifi_up_file}")
        except subprocess.CalledProcessError as e:
            print(f"[WiFi] Failed to create wifi_up file: {e}")
            # Don't fail the whole request — Wi-Fi is connected!
        except Exception as e:
            print(f"[WiFi] Unexpected error writing wifi_up: {e}")

        return jsonify({"success": True, "message": "Connected", "ssid": ssid}), 200

    except subprocess.CalledProcessError as e:
        error_detail = e.stderr.strip() if e.stderr else "nmcli command failed"
        print(f"[WIFI CONNECT ERROR] Subprocess error: {error_detail}")
        return jsonify({
            "success": False,
            "error": "Wi-Fi command failed",
            "details": error_detail
        }), 500

    except Exception as e:
        print(f"[WIFI CONNECT ERROR] Unexpected: {str(e)}")
        return jsonify({
            "success": False,
            "error": "Internal server error",
            "details": str(e)
        }), 500


@app.route("/api/wifi/disconnect", methods=["POST"])
def wifi_disconnect():
    try:
        run_system_command(["sudo", "nmcli", "device", "disconnect", "wlan0"])
        # if os.path.exists(SYSTEM_FILES["wifi_up"]):
        #     os.remove(SYSTEM_FILES["wifi_up"])
        return jsonify({"success": True, "message": "Disconnected"}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


import json
import time
import configparser
from pathlib import Path
from flask import jsonify
import subprocess

def run_system_command(cmd):
    """Helper to run system commands safely."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True, result.stdout
    except subprocess.CalledProcessError as e:
        return False, e.stderr
    except Exception as e:
        return False, str(e)


@app.route("/api/wifi/networks", methods=["GET"])
def list_wifi_networks():
    """
    Returns available + saved Wi-Fi networks (merged, no duplicates).
    Includes passwords for saved networks (requires sudo).
    Logs everything to console.
    """
    try:
        # === 1. Rescan and list available networks ===
        print("[WiFi] Rescanning networks...")
        run_system_command(["sudo", "nmcli", "device", "wifi", "rescan"])
        time.sleep(2.5)  # Give time for scan

        ok, out = run_system_command([
            "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"
        ])
        if not ok:
            return jsonify({"success": False, "error": "Failed to scan networks"}), 500

        available = []
        seen_ssids = set()
        for line in out.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":", 2)  # Only split on first two colons
            if len(parts) < 3 or not parts[0].strip():
                continue

            ssid = parts[0].strip()
            if ssid in seen_ssids:
                continue  # Avoid duplicates from nmcli
            seen_ssids.add(ssid)

            signal = parts[1].strip()
            security = parts[2].strip() if parts[2].strip() else "Open"

            available.append({
                "ssid": ssid,
                "signal_strength": f"{signal}%",
                "security": security,
                "saved": False,
                "password": None
            })

        # === 2. Fetch saved connections WITH password (requires sudo) ===
        nm_dir = Path("/etc/NetworkManager/system-connections")
        saved = []

        if not nm_dir.exists():
            print("[WiFi] /etc/NetworkManager/system-connections/ not found.")
        else:
            # Use sudo to read files
            try:
                ok, file_list = run_system_command(["sudo", "ls", str(nm_dir)])
                if not ok:
                    print("[WiFi] Failed to list system-connections (ls failed)")
                else:
                    for filename in file_list.strip().split("\n"):
                        if not filename.strip():
                            continue
                        file_path = nm_dir / filename

                        # Read file with sudo
                        ok, content = run_system_command(["sudo", "cat", str(file_path)])
                        if not ok:
                            print(f"[WiFi] Failed to read {filename}: {content}")
                            continue

                        parser = configparser.RawConfigParser()
                        try:
                            # Parse INI content from string
                            from io import StringIO
                            parser.read_string(content, source=filename)
                        except Exception as e:
                            print(f"[WiFi] Failed to parse {filename}: {e}")
                            continue

                        def safe_get(section, key):
                            try:
                                return parser.get(section, key)
                            except:
                                return None

                        ssid = (
                            safe_get("wifi", "ssid") or
                            safe_get("802-11-wireless", "ssid") or
                            safe_get("connection", "id")
                        )
                        if not ssid:
                            continue
                        ssid = ssid.strip().strip('"').strip("'")

                        key_mgmt = (
                            safe_get("wifi-security", "key-mgmt") or
                            safe_get("802-11-wireless-security", "key-mgmt") or
                            "none"
                        ).lower()

                        password = None
                        if key_mgmt in ["wpa-psk", "wpa-eap"]:
                            password = safe_get("wifi-security", "psk")
                        elif key_mgmt == "none":
                            password = ""  # Open or WEP might use different keys

                        saved.append({
                            "ssid": ssid,
                            "signal_strength": None,
                            "security": key_mgmt.title().replace("Psk", "PSK").replace("Eap", "EAP"),
                            "saved": True,
                            "password": password
                        })

            except Exception as e:
                print(f"[WiFi] Error accessing system-connections: {e}")

        # === Debug: Print saved networks ===
        print("\n[WiFi SAVED NETWORKS] ======================")
        if saved:
            print(json.dumps([{
                "ssid": s["ssid"],
                "security": s["security"],
                "saved": s["saved"],
                "password": "*****" if s["password"] else None
            } for s in saved], indent=2))
        else:
            print("(none found)")
        print("===========================================\n")

        # === 3. Merge: available + saved (prefer available signal, keep password) ===
        merged = {}
        for net in available:
            merged[net["ssid"]] = net.copy()

        for s in saved:
            if s["ssid"] in merged:
                merged[s["ssid"]]["saved"] = True
                if s["password"]:
                    merged[s["ssid"]]["password"] = s["password"]
            else:
                merged[s["ssid"]] = {
                    "ssid": s["ssid"],
                    "signal_strength": None,
                    "security": s["security"],
                    "saved": True,
                    "password": s["password"]
                }

        # === 4. Sort: saved first, then by signal strength ===
        def sort_key(x):
            signal_val = int(x["signal_strength"].replace("%", "")) if x["signal_strength"] else 0
            return (not x["saved"], -signal_val)

        result = sorted(merged.values(), key=sort_key)

        # === 5. Final response (mask password in logs for safety) ===
        response = {"success": True, "networks": result}

        print("[WiFi API RESPONSE] ========================")
        log_response = {"success": True, "networks": [
            {k: ("*****" if k == "password" and v else v) for k, v in net.items()}
            for net in result
        ]}
        print(json.dumps(log_response, indent=2))
        print("============================================\n")

        return jsonify(response), 200

    except Exception as e:
        import traceback
        print(f"[WiFi ERROR] {e}\n{traceback.format_exc()}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/check_gsm", methods=["GET"])
def check_gsm():
    if (os.path.exists(SYSTEM_FILES["gsm_up"])):
        set_current_state("connect_select")
        return jsonify({"success": True})
    return jsonify({"success": False})


@app.route("/api/shutdown", methods=["POST"])
def shutdown():
    try:
        subprocess.run(["sudo", "systemctl", "poweroff"], check=True)
        return jsonify({"success": True, "message": "Shutting down..."}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/restart", methods=["POST"])
def restart():
    try:
        subprocess.run(["sudo", "systemctl", "reboot"], check=True)
        return jsonify({"success": True, "message": "Restarting..."}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/submit_hhid", methods=["POST"])
def submit_hhid():
    set_current_state("hhid_input")
    hhid = request.json.get("hhid")
    if not hhid:
        return jsonify({"success": False, "error": "HHID required"}), 400

    save_hhid(hhid)
    try:
        payload = {"meter_id": METER_ID, "hhid": hhid}
        resp = requests.post(INITIATE_URL, json=payload, timeout=30)
        data = resp.json()
        set_current_state("otp_verification")
        return jsonify({"success": data.get("success", False)}), 200
    except requests.exceptions.Timeout:
        return jsonify({"success": False, "error": "Timeout"}), 504
    except requests.exceptions.ConnectionError as e:
        # Handles "Max retries exceeded" and other connection-related issues (common with AWS endpoints)
        return jsonify({"success": False, "error": "Connection failed: please try again later"}), 503
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/submit_otp", methods=["POST"])
def submit_otp():
    data = request.json
    meter_id = data.get("meter_id") or METER_ID
    hhid = data.get("hhid")
    otp = data.get("otp")
    if not all([meter_id, hhid, otp]):
        return jsonify({"success": False, "error": "meter_id, hhid, otp required"}), 400

    try:
        payload = {"meter_id": meter_id, "hhid": hhid, "otp": otp}
        resp = requests.post(VERIFY_URL, json=payload, timeout=30)
        result = resp.json()
        if result.get("success"):
            save_hhid(hhid)
            set_current_state("input_source_detection")
        return jsonify({"success": result.get("success", False)}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/input_sources", methods=["GET"])
def get_input_sources():
    sources = []
    errors = []

    # set_current_state("input_source_detection")
    print('"/api/input_sources" called')

    # if os.path.exists(SYSTEM_FILES["jack_status"]):
    #     try:
    #         status = open(SYSTEM_FILES["jack_status"]).read().strip()
    #         if status == "line_in":
    #             sources.append("line_in")
    #         elif status == "internal":
    #             sources.append("internal")
    #         else:
    #             errors.append(f"Unknown jack_status: {status}")
    #     except Exception as e:
    #         errors.append(f"Error reading jack_status: {str(e)}")

    if os.path.exists(SYSTEM_FILES["jack_status"]):
        sources.append("line_in")

    if os.path.exists(SYSTEM_FILES["hdmi_input"]):
        sources.append("HDMI")

    if not sources and not errors:
        return jsonify({
            "success": False,
            "error": "No input sources detected",
            "sources": []
        }), 404

    return jsonify({
        "success": True,
        "sources": sources,
        "errors": errors if errors else None
    }), 200


@app.route("/api/video_detection", methods=["GET"])
def check_video_detection():
    set_current_state("video_object_detection")
    if os.path.exists(SYSTEM_FILES["video_detection"]):
        try:
            content = open(SYSTEM_FILES["video_detection"]).read().strip()
            return jsonify({
                "success": True,
                "detected": True,
                "status": content or "active"
            }), 200
        except Exception as e:
            return jsonify({
                "success": False,
                "error": f"Failed to read video_detection: {str(e)}"
            }), 500
    else:
        return jsonify({
            "success": True,
            "detected": False,
            "status": "not_running"
        }), 200


@app.route("/api/members", methods=["GET"])
def get_members():
    try:
        data = load_members_data()
        return jsonify({"success": True, "data": data}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500



# --- Add this helper at the top with other functions ---
def attempt_publish(payload_json: str) -> bool:
    """Attempts async publish and returns True if accepted by MQTT client."""
    if not client or not client.is_connected():
        _mqtt_log("Cannot publish: not connected")
        return False
    
    try:
        result = client.publish(MQTT_TOPIC, payload_json)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            _mqtt_log(f"Publish accepted (mid={result.mid}) - will send async")
            return True
        else:
            _mqtt_log(f"Publish rejected (rc={result.rc})")
            return False
    except Exception as e:
        _mqtt_log(f"Publish exception: {e}")
        return False

@app.route("/api/toggle_member_status", methods=["POST"])
def toggle_member_status():
    index = request.json.get("index")
    if not isinstance(index, int):
        return jsonify({"success": False, "error": "Invalid index"}), 400

    try:
        data = load_members_data()
        members = data.get("members", [])
        if not (0 <= index < len(members)):
            return jupytext({"success": False, "error": "Index out of range"}), 400

        member = members[index]
        new_active_state = not member.get("active", False)

        members_payload = []
        for i, m in enumerate(members):
            age = calculate_age(m.get("dob"))
            if age is None:
                continue
            members_payload.append({
                "member_id": m.get("member_code", ""),
                "age": age,
                "gender": m["gender"],
                "active": new_active_state if i == index else m.get("active", False)
            })

        payload = {
            "DEVICE_ID": METER_ID,
            "TS": str(int(time.time())),
            "Type": 3,
            "Details": {"members": members_payload}
        }
        payload_json = json.dumps(payload)

        publish_ok = attempt_publish(payload_json)
        if not publish_ok:
            _enqueue(payload)
            if client and client.is_connected():
                _flush_queue()  # Immediately try sending the queue if connected
            _mqtt_log("Publish failed - enqueued and attempted flush")

        member["active"] = new_active_state
        save_members_data(data)

        return jsonify({
            "success": True,
            "member": member,
            "mqtt_sent": publish_ok  # True if direct, False if enqueued/flushed
        }), 200

    except Exception as e:
        _mqtt_log(f"Error in toggle_member_status: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/edit_member_name", methods=["POST"])
def edit_member_name():
    """
    Request:
      { "index": 0, "name": "Rahul" }
    """
    idx = request.json.get("index")
    new_name = request.json.get("name")
    if not isinstance(idx, int) or not new_name:
        return jsonify({"success": False, "error": "index and name required"}), 400

    try:
        data = load_members_data()
        members = data.get("members", [])
        if 0 <= idx < len(members):
            old_name = members[idx].get("name", members[idx]["member_code"])
            members[idx]["name"] = new_name.strip()

            save_members_data(data)

            # Optional: publish updated state (recommended)
            publish_member_event()

            print(f"[MEMBER] Renamed member {idx}: '{old_name}' → '{new_name}'")

            return jsonify({
                "success": True,
                "member": members[idx],
                "message": "Display name updated"
            }), 200
        else:
            return jsonify({"success": False, "error": "Index out of range"}), 400
    except Exception as e:
        print(f"[ERROR] edit_member_name: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/finalize", methods=["POST"])
def finalize():
    set_current_state("finalize")
    hhid = load_hhid()
    if not hhid:
        return jsonify({"success": False, "error": "HHID not found"}), 400

    try:
        url = f"{MEMBERS_URL}?meterid={METER_ID}&hhid={hhid}"
        resp = requests.get(url, timeout=30)
        server_data = resp.json()

        if server_data.get("success"):
            members = [
                {
                    "member_code": m["member_code"],
                    "dob": m["dob"],
                    "gender": m["gender"],
                    "created_at": m.get("created_at"),
                    "active": False  # default off
                }
                for m in server_data.get("members", [])
                if all(k in m for k in ["member_code", "dob", "gender"])
            ]
            save_data = {
                "meter_id": METER_ID,
                "hhid": hhid,
                "members": members
            }
            save_members_data(save_data)
            set_installation_done()
            return jsonify({"success": True, "data": server_data}), 200
        else:
            set_installation_done()
            return jsonify({"success": False, "error": server_data.get("message", "Failed")}), 400
    except requests.exceptions.Timeout:
        set_installation_done()
        return jsonify({"success": False, "error": "Timeout"}), 504
    except Exception as e:
        set_installation_done()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/close")
def close_application():
    QtCore.QCoreApplication.quit()
    return "Closing..."


@app.route("/api/brightness", methods=["POST"])
def set_brightness():
    """
    Adjust display brightness via /sys/class/backlight/10-0045.
    Expects JSON: { "brightness": <51–255> }
    """
    try:
        data = request.get_json()
        brightness = int(data.get("brightness", 51))
        path = "/sys/class/backlight/1-0045"

        # Get maximum brightness
        with open(f"{path}/max_brightness") as f:
            max_brightness = int(f.read().strip())

        # Clamp value and write it
        brightness = max(51, min(brightness, max_brightness))
        os.system(f"echo {brightness} | sudo tee {path}/brightness > /dev/null")

        print(f"[BRIGHTNESS] Set to {brightness}")
        return jsonify({"success": True, "brightness": brightness}), 200
    except Exception as e:
        print(f"[BRIGHTNESS] Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/current_brightness")
def get_current_brightness():
    """
    Returns current brightness from /sys/class/backlight/1-0045/brightness
    """
    try:
        path = "/sys/class/backlight/1-0045"
        with open(f"{path}/brightness") as f:
            brightness = int(f.read().strip())
        return jsonify({"success": True, "brightness": brightness}), 200
    except Exception as e:
        print(f"[BRIGHTNESS-GET] Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500



# ----------------------------------------------------------------------
# 8. Flask runner
# ----------------------------------------------------------------------
def run_flask():
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False, threaded=True)


# ----------------------------------------------------------------------
# 9. PyQt5 Browser
# ----------------------------------------------------------------------
class BrowserWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.browser = QWebEngineView()
        self.setCentralWidget(self.browser)
        self.setCursor(Qt.BlankCursor)
        self.showFullScreen()

        # ---------- NEW: BLOCK CONTEXT MENU ----------
        self.browser.setContextMenuPolicy(Qt.NoContextMenu)   # disables right-click menu
        # ----------------------------------------------

        self.browser.setZoomFactor(1.0)
        settings = self.browser.settings()
        settings.setAttribute(QWebEngineSettings.ShowScrollBars, False)
        settings.setAttribute(QWebEngineSettings.JavascriptEnabled, True)

        self.browser.setAttribute(Qt.WA_AcceptTouchEvents, False)
        self.setAttribute(Qt.WA_AcceptTouchEvents, False)


        ZOOM_PREVENT_JS = """
        (function(){
            var m = document.createElement('meta');
            m.name = 'viewport';
            m.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
            document.head.appendChild(m);
            var block = function(e){ e.preventDefault(); };
            document.addEventListener('gesturestart',  block, {passive:false});
            document.addEventListener('gesturechange', block, {passive:false});
            document.addEventListener('gestureend',    block, {passive:false});
            document.addEventListener('touchmove', function(e){
                if(e.touches.length>1) e.preventDefault();
            }, {passive:false});
            document.addEventListener('wheel', function(e){
                if(e.ctrlKey) e.preventDefault();
            }, {passive:false});
        })();
        """

        def _inject(ok: bool):
            if ok:
                self.browser.page().runJavaScript(ZOOM_PREVENT_JS)

        self.browser.loadFinished.connect(_inject)

        for seq in [QKeySequence.ZoomIn, QKeySequence.ZoomOut, "Ctrl+=", "Ctrl+-", "Ctrl+0"]:
            QShortcut(QKeySequence(seq), self, lambda: None)

        self.browser.setUrl(QUrl("http://127.0.0.1:5000"))

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_F4 and event.modifiers() == Qt.AltModifier:
            self.close()
        super().keyPressEvent(event)

    def wheelEvent(self, event):
        if event.modifiers() & Qt.ControlModifier:
            event.ignore()
        else:
            super().wheelEvent(event)


LAST_BOOT_ID_FILE = "/var/lib/meter_last_boot_id.txt"

def get_current_boot_id():
    """Read current boot_id from kernel"""
    try:
        with open('/proc/sys/kernel/random/boot_id', 'r') as f:
            return f.read().strip()
    except Exception as e:
        print(f"[BOOT_ID] Error reading current boot_id: {e}")
        return None

def is_fresh_boot():
    """Check if current boot_id is different from last saved one"""
    current = get_current_boot_id()
    if not current:
        return False  # Safe fallback

    if not os.path.exists(LAST_BOOT_ID_FILE):
        print("[BOOT_ID] No previous boot_id found — treating as fresh boot")
        return True

    try:
        with open(LAST_BOOT_ID_FILE, 'r') as f:
            last = f.read().strip()
        if current != last:
            print(f"[BOOT_ID] Boot ID changed: {last} → {current} — fresh boot detected")
            return True
        else:
            print("[BOOT_ID] Same boot_id — not a fresh boot (process restart?)")
            return False
    except Exception as e:
        print(f"[BOOT_ID] Error reading last boot_id: {e}")
        return True  # Safe: assume fresh if can't read

def save_current_boot_id():
    """Save current boot_id for next comparison"""
    current = get_current_boot_id()
    if current:
        try:
            with open(LAST_BOOT_ID_FILE, "w") as f:
                f.write(current)
            print(f"[BOOT_ID] Saved current boot_id: {current}")
        except Exception as e:
            print(f"[BOOT_ID] Failed to save boot_id: {e}")

# ----------------------------------------------------------------------
# Periodic Type 3 (members state) heartbeat - every 60 minutes
# ----------------------------------------------------------------------

HEARTBEAT_INTERVAL_SECONDS = 3600  # 60 minutes

def send_periodic_members_heartbeat():
    """Builds and publishes current members state every hour"""
    while True:
        try:
            time.sleep(HEARTBEAT_INTERVAL_SECONDS)

            # Only send if we have a valid HHID (installation probably done)
            hhid = load_hhid()
            if not hhid:
                _mqtt_log("[HEARTBEAT] No HHID yet → skipping periodic Type 3")
                continue

            # Build current payload (same logic as publish_member_event)
            data = load_members_data()
            members = [
                {
                    "member_id": m.get("member_code", ""),
                    "age": calculate_age(m["dob"]),
                    "gender": m["gender"],
                    "active": m.get("active", False)
                }
                for m in data.get("members", [])
                if all(k in m for k in ["dob", "gender"]) and calculate_age(m["dob"]) is not None
            ]

            if not members:
                _mqtt_log("[HEARTBEAT] No valid members → skipping")
                continue

            payload = {
                "DEVICE_ID": METER_ID,
                "TS": str(int(time.time())),
                "Type": 3,
                "Details": {"members": members}
            }

            payload_json = json.dumps(payload)

            _mqtt_log(f"[HEARTBEAT] Sending periodic Type 3 (members snapshot) - {len(members)} members")

            publish_ok = False
            if client and client.is_connected():
                publish_ok = wait_for_publish_success(client, payload_json, timeout=8.0)

            if publish_ok:
                _mqtt_log("[HEARTBEAT] Periodic Type 3 published successfully")
            else:
                _enqueue(payload)
                _mqtt_log("[HEARTBEAT] Periodic Type 3 QUEUED (MQTT not connected)")

        except Exception as e:
            _mqtt_log(f"[HEARTBEAT] Error in periodic members heartbeat: {e}")
            time.sleep(60)  # wait 1 min before retrying if crashed
# ----------------------------------------------------------------------
# 10. Main
# ----------------------------------------------------------------------
if __name__ == "__main__":
    init_db()

    # Start periodic heartbeat thread
    heartbeat_thread = threading.Thread(target=send_periodic_members_heartbeat, daemon=True)
    heartbeat_thread.start()
    print("[STARTUP] Periodic members heartbeat thread started (every 60 min)")
    
    # === 1. Start MQTT thread FIRST and give it time to initialize ===
    mqtt_thread = threading.Thread(target=init_mqtt, daemon=True)
    mqtt_thread.start()
    time.sleep(3)  # Critical: give MQTT time to start, connect, and possibly flush old queue

    # === 2. Detect fresh boot using boot_id ===
    if is_fresh_boot():
        print("[BOOT] Fresh boot detected — resetting viewing session")

        # Reset DB state
        deactivate_all_members_and_publish()  # queues fresh Type 3 (may be flushed already)
        clear_guests_and_publish()            # queues fresh Type 4

        # === 3. NOW FORCE CLEAR THE QUEUE completely ===
        with _q_lock:
            old_size = len(_pub_q)
            _pub_q.clear()
            print(f"[BOOT] Fully cleared queue ({old_size} old/stale events removed)")

        # === 4. Re-queue fresh events — these will be the ONLY ones ===
        deactivate_all_members_and_publish()
        clear_guests_and_publish()
        print("[BOOT] Re-queued fresh Type 3 and Type 4 events — clean state")

    else:
        print("[BOOT] Same boot — preserving existing queue (offline events safe)")

    # === 5. Save boot_id for next time ===
    save_current_boot_id()

    # === 6. Start Flask ===
    threading.Thread(target=run_flask, daemon=True).start()
    time.sleep(1.5)

    # === 7. Start Qt UI ===
    qt_app = QtWidgets.QApplication(sys.argv)
    win = BrowserWindow()
    win.show()
    sys.exit(qt_app.exec_())