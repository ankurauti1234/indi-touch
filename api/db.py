#!/usr/bin/env python3
# api/db.py — SQLite database initialization and helpers

import sqlite3
from datetime import datetime
from .config import DB_PATH, METER_ID, load_hhid, FALLBACK_AVATAR


def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        cur = conn.cursor()

        # Members table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS members (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id      TEXT NOT NULL,
                hhid          TEXT NOT NULL,
                member_code   TEXT,
                name          TEXT,
                dob           TEXT,
                gender        TEXT,
                created_at    TEXT,
                avatar_url    TEXT,
                offline_avatar TEXT,
                active        INTEGER DEFAULT 0
            )
        """)

        # Column upgrade path
        cur.execute("PRAGMA table_info(members)")
        cols = {c[1] for c in cur.fetchall()}
        for col, typedef in [
            ("name",           "TEXT"),
            ("avatar_url",     "TEXT"),
            ("offline_avatar", "TEXT"),
        ]:
            if col not in cols:
                print(f"[DB] Adding '{col}' column to members")
                cur.execute(f"ALTER TABLE members ADD COLUMN {col} {typedef}")
        if "name" in cols:
            cur.execute("""
                UPDATE members SET name = member_code
                WHERE name IS NULL AND member_code IS NOT NULL
            """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS guests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id   TEXT NOT NULL,
                hhid       TEXT NOT NULL,
                name       TEXT,
                age        INTEGER,
                gender     TEXT,
                seed       TEXT,
                duration   TEXT,
                active     INTEGER DEFAULT 1,
                created_at TEXT
            )
        """)

        # App settings table (key/value store replacing data.js config)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        # Notifications table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                message    TEXT,
                type       TEXT DEFAULT 'info',
                read       INTEGER DEFAULT 0,
                created_at TEXT
            )
        """)

        conn.commit()
    print("[DB] Database initialized")


# ── Members ───────────────────────────────────────────────────────────────────

def load_members_data() -> dict:
    hhid = load_hhid()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT member_code, name, dob, gender, created_at,
                   avatar_url, offline_avatar, active
            FROM members WHERE meter_id = ? AND hhid = ?
            ORDER BY id
        """, (METER_ID, hhid))
        members = []
        for row in cur.fetchall():
            members.append({
                "member_code":    row[0],
                "name":           row[1] or row[0],
                "dob":            row[2],
                "gender":         row[3],
                "created_at":     row[4],
                "avatar_url":     row[5] or FALLBACK_AVATAR,
                "offline_avatar": row[6] or FALLBACK_AVATAR,
                "active":         bool(row[7]),
                "age":            calculate_age(row[2])
            })
    return {"meter_id": METER_ID, "hhid": hhid, "members": members}


def save_members_data(data: dict):
    meter_id = data.get("meter_id", METER_ID)
    hhid     = data.get("hhid", load_hhid())
    members  = data.get("members", [])
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM members WHERE meter_id = ? AND hhid = ?", (meter_id, hhid))
        for m in members:
            cur.execute("""
                INSERT INTO members
                    (meter_id, hhid, member_code, name, dob, gender,
                     created_at, avatar_url, offline_avatar, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                meter_id, hhid,
                m.get("member_code"),
                m.get("name", m.get("member_code")),
                m.get("dob"),
                m.get("gender"),
                m.get("created_at"),
                m.get("avatar_url"),
                m.get("offline_avatar"),
                int(m.get("active", False)),
            ))
        conn.commit()


def toggle_member_in_db(index: int) -> tuple:
    """Toggle a member's active state; returns (member_dict, new_state) or raises."""
    data = load_members_data()
    members = data.get("members", [])
    if not (0 <= index < len(members)):
        raise IndexError("Member index out of range")
    members[index]["active"] = not members[index].get("active", False)
    save_members_data(data)
    return members[index], members[index]["active"]


def rename_member_in_db(index: int, new_name: str) -> dict:
    data = load_members_data()
    members = data["members"]
    if not (0 <= index < len(members)):
        raise IndexError("Member index out of range")
    members[index]["name"] = new_name.strip()
    save_members_data(data)
    return members[index]


def update_member_offline_avatar(member_code: str, filename: str):
    hhid = load_hhid()
    with get_conn() as conn:
        conn.execute("""
            UPDATE members SET offline_avatar = ?
            WHERE meter_id = ? AND hhid = ? AND member_code = ?
        """, (filename, METER_ID, hhid, member_code))
        conn.commit()


def undeclare_all_members_in_db():
    hhid = load_hhid()
    with get_conn() as conn:
        conn.execute("UPDATE members SET active = 0 WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
        conn.execute("DELETE FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
        conn.commit()


# ── Guests ────────────────────────────────────────────────────────────────────

def load_guests_data() -> list:
    hhid = load_hhid()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, name, age, gender, seed, duration, active, created_at FROM guests
            WHERE meter_id = ? AND hhid = ?
        """, (METER_ID, hhid))
        return [{
            "id":       r[0],
            "name":     r[1],
            "age":      r[2],
            "gender":   r[3],
            "seed":     r[4],
            "duration": r[5],
            "active":   bool(r[6]),
            "created_at": r[7]
        } for r in cur.fetchall()]


def save_guests_data(guest_list: list):
    hhid = load_hhid()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
        for g in guest_list:
            cur.execute("""
                INSERT INTO guests
                    (meter_id, hhid, name, age, gender, seed, duration, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                METER_ID, hhid,
                g.get("name"),
                g.get("age"),
                g.get("gender"),
                g.get("seed"),
                g.get("duration"),
                int(g.get("active", True)),
                g.get("created_at") or datetime.now().isoformat()
            ))
        conn.commit()
    print(f"[DB] Saved {len(guest_list)} guests")


# ── App Settings (replaces data.js config) ────────────────────────────────────

def get_setting(key: str, default=None):
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default


def set_setting(key: str, value):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value))
        )
        conn.commit()


# ── Notifications ─────────────────────────────────────────────────────────────

def get_notifications(unread_only: bool = False) -> list:
    with get_conn() as conn:
        cur = conn.cursor()
        query = "SELECT * FROM notifications"
        if unread_only:
            query += " WHERE read = 0"
        query += " ORDER BY id DESC"
        cur.execute(query)
        return [dict(row) for row in cur.fetchall()]


def mark_notification_read(notif_id: int):
    with get_conn() as conn:
        conn.execute("UPDATE notifications SET read = 1 WHERE id = ?", (notif_id,))
        conn.commit()


def save_notification(title: str, message: str, n_type: str = "info"):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO notifications (title, message, type, read, created_at)
            VALUES (?, ?, ?, 0, ?)
        """, (title, message, n_type, datetime.now().isoformat()))
        conn.commit()


# ── Utilities ─────────────────────────────────────────────────────────────────

def calculate_age(dob_str: str):
    try:
        dob = datetime.strptime(dob_str, "%Y-%m-%d")
        today = datetime.today()
        return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
    except Exception:
        return None
