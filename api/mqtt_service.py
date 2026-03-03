#!/usr/bin/env python3
# api/mqtt_service.py — MQTT worker, queue and publish helpers

import json
import os
import ssl
import threading
import time

import paho.mqtt.client as mqtt

from .config import (
    METER_ID, SYSTEM_FILES,
    MQTT_TOPIC, AWS_IOT_ENDPOINT, MQTT_PORT,
    DEVICE_CONFIG, RECONNECT_DELAY, MAX_RECONNECT_DELAY, HEARTBEAT_INTERVAL,
    load_hhid,
)
from .db import load_members_data, load_guests_data, calculate_age

# ── Shared state ──────────────────────────────────────────────────────────────
_client: mqtt.Client | None = None
_pub_q:  list = []
_q_lock  = threading.Lock()


def _log(msg: str):
    print(f"[MQTT] {msg}")


# ── Certificate paths ─────────────────────────────────────────────────────────
def _get_cert_paths():
    d = DEVICE_CONFIG["certs_dir"]
    key  = os.path.join(d, f"{METER_ID}.key")
    cert = os.path.join(d, f"{METER_ID}Chain.crt")
    ca   = os.path.join(d, "AmazonRootCA1.pem")
    missing = [p for p in [key, cert, ca] if not os.path.exists(p)]
    if missing:
        _log("CERTS MISSING → " + ", ".join(missing))
        return None
    return key, cert, ca


# ── Queue ─────────────────────────────────────────────────────────────────────
def _enqueue(payload: dict):
    with _q_lock:
        _pub_q.append(payload)
    _log(f"QUEUED (total={len(_pub_q)})")


def _flush_queue():
    with _q_lock:
        if not _pub_q:
            return
        batch = _pub_q[:]
        _pub_q.clear()
    for pl in batch:
        try:
            _client.publish(MQTT_TOPIC, json.dumps(pl))
            _log(f"FLUSHED Type {pl.get('Type')}")
        except Exception as e:
            _log(f"Flush failed: {e} — re-queuing")
            with _q_lock:
                _pub_q.insert(0, pl)
            break


# ── Callbacks ─────────────────────────────────────────────────────────────────
def _on_connect(client, _userdata, _flags, rc, *args):
    if rc == 0:
        _log(f"CONNECTED → flushing {len(_pub_q)} queued events")
        _flush_queue()
    else:
        _log(f"CONNECT FAILED rc={rc}")


def _on_disconnect(client, _userdata, rc):
    _log(f"DISCONNECTED rc={rc}")


def _on_publish(client, _userdata, mid):
    _log(f"ACK mid={mid}")


# ── Publish helper ────────────────────────────────────────────────────────────
def publish(payload: dict, enqueue_on_fail=True) -> bool:
    """Publish immediately if connected, otherwise enqueue."""
    global _client
    if _client and _client.is_connected():
        try:
            res = _client.publish(MQTT_TOPIC, json.dumps(payload))
            ok = res.rc == mqtt.MQTT_ERR_SUCCESS
            if ok:
                _log(f"PUBLISHED Type {payload.get('Type')} mid={res.mid}")
                return True
            _log(f"Publish rejected rc={res.rc}")
        except Exception as e:
            _log(f"Publish exception: {e}")
    if enqueue_on_fail:
        _enqueue(payload)
    return False


# ── Typed events ──────────────────────────────────────────────────────────────
def publish_member_event():
    data    = load_members_data()
    members = [
        {
            "member_id": m["member_code"],
            "age":       calculate_age(m["dob"]),
            "gender":    m["gender"],
            "active":    m["active"],
        }
        for m in data.get("members", [])
        if "dob" in m and "gender" in m and calculate_age(m["dob"]) is not None
    ]
    if not members:
        _log("No valid members — skipping Type 3")
        return
    publish({
        "DEVICE_ID": METER_ID,
        "TS":        str(int(time.time())),
        "Type":      3,
        "Details":   {"members": members},
    })


def publish_guest_event(guest_list: list = None):
    if guest_list is None:
        guest_list = load_guests_data()
    publish({
        "DEVICE_ID": METER_ID,
        "TS":        str(int(time.time())),
        "Type":      4,
        "Details":   {"guests": [{"age": g["age"], "gender": g["gender"], "active": True} for g in guest_list]},
    })


# ── Boot reset helpers ────────────────────────────────────────────────────────
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


# ── Heartbeat ─────────────────────────────────────────────────────────────────
def _heartbeat_worker():
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        if load_hhid():
            _log("[HEARTBEAT] Sending periodic Type 3 & Type 4")
            publish_member_event()
            publish_guest_event()


# ── MQTT worker ───────────────────────────────────────────────────────────────
def _mqtt_worker():
    global _client
    backoff = RECONNECT_DELAY
    while True:
        paths = _get_cert_paths()
        if not paths:
            time.sleep(10)
            continue
        key, cert, ca = paths
        try:
            _client = mqtt.Client(client_id=METER_ID, clean_session=False)
            _client.tls_set(ca_certs=ca, certfile=cert, keyfile=key,
                            tls_version=ssl.PROTOCOL_TLS)
            _client.on_connect    = _on_connect
            _client.on_disconnect = _on_disconnect
            _client.on_publish    = _on_publish
            _log(f"Connecting → {AWS_IOT_ENDPOINT}:{MQTT_PORT}")
            _client.connect(AWS_IOT_ENDPOINT, MQTT_PORT, keepalive=60)
            backoff = RECONNECT_DELAY   # reset on success
            _client.loop_forever()
        except Exception as e:
            _log(f"Error: {e}")
        _log(f"Reconnecting in {backoff}s")
        time.sleep(backoff)
        backoff = min(backoff * 2, MAX_RECONNECT_DELAY)


# ── Init ──────────────────────────────────────────────────────────────────────
def init_mqtt():
    threading.Thread(target=_mqtt_worker,   daemon=True, name="mqtt-worker").start()
    threading.Thread(target=_heartbeat_worker, daemon=True, name="mqtt-heartbeat").start()
    _log("MQTT and heartbeat threads started")
