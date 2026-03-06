#!/usr/bin/env python3
# api/collector_service.py — D-Bus client for the data collector service

import dbus
import time
import json
from .config import DBUS_INTERFACE, DBUS_OBJECT_PATH, DBUS_SIGNAL_EVENT, METER_ID
from .db import load_members_data, load_guests_data, calculate_age

def _log(msg: str):
    print(f"[COLLECTOR] {msg}")

def send_event(event_type, details):
    """
    Emits a D-Bus signal to the Data Collector Service.
    
    Args:
        event_type (str or int): The type of event (e.g., '3' for members, '4' for guests).
        details (dict): Event details that will be JSON encoded.
    """
    try:
        # Connect to the System Bus
        bus = dbus.SystemBus()
        
        # Ensure event_type is a string for the collector's expectation
        type_str = str(event_type)
        details_str = json.dumps(details)
        timestamp = int(time.time())

        # Creating a signal message manually:
        msg = dbus.lowlevel.SignalMessage(
            DBUS_OBJECT_PATH, 
            DBUS_INTERFACE, 
            DBUS_SIGNAL_EVENT
        )
        msg.append(METER_ID, signature='s')
        msg.append(dbus.Int64(timestamp), signature='x')
        msg.append(type_str, signature='s')
        msg.append(details_str, signature='s')
        
        bus.get_connection().send_message(msg)
        
        _log(f"SENT Signal Event: Type={type_str}, TS={timestamp}")
        return True
        
    except Exception as e:
        _log(f"Failed to send D-Bus signal: {e}")
        return False

# ── Event Wrappers (Compatibility with MQTT Service Interface) ────────────────

def publish_member_event():
    """Fetches member data and emits a Type 3 D-Bus signal."""
    try:
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
            return False
            
        return send_event(3, {"members": members})
    except Exception as e:
        _log(f"Member event failed: {e}")
        return False

def publish_guest_event(guest_list: list = None):
    """Fetches guest data and emits a Type 4 D-Bus signal."""
    try:
        if guest_list is None:
            guest_list = load_guests_data()
            
        details = {
            "guests": [
                {"age": g["age"], "gender": g["gender"], "active": True} 
                for g in guest_list
            ]
        }
        return send_event(4, details)
    except Exception as e:
        _log(f"Guest event failed: {e}")
        return False

if __name__ == "__main__":
    # Quick test
    send_event("test", {"status": "ok"})
