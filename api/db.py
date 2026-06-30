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
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id       TEXT NOT NULL,
                hhid           TEXT NOT NULL,
                member_code    TEXT,
                name           TEXT,
                dob            TEXT,
                gender         TEXT,
                created_at     TEXT,
                avatar_url     TEXT,
                offline_avatar TEXT,
                active         INTEGER DEFAULT 0
            )
        """)

        # Column upgrade path
        cur.execute("PRAGMA table_info(members)")
        cols = {c[1] for c in cur.fetchall()}

        for col, typedef in [
            ("name", "TEXT"),
            ("avatar_url", "TEXT"),
            ("offline_avatar", "TEXT"),
        ]:
            if col not in cols:
                print(f"[DB] Adding '{col}' column to members")
                cur.execute(f"ALTER TABLE members ADD COLUMN {col} {typedef}")

        if "name" in cols:
            cur.execute("""
                UPDATE members
                SET name = member_code
                WHERE name IS NULL AND member_code IS NOT NULL
            """)

        # Guests table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS guests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                meter_id   TEXT NOT NULL,
                hhid       TEXT NOT NULL,
                age        INTEGER,
                gender     TEXT,
                seed       TEXT,
                duration   TEXT,
                active     INTEGER DEFAULT 1,
                created_at TEXT
            )
        """)

        # App settings table
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

        # Groups table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                member_codes   TEXT NOT NULL,
                active         INTEGER DEFAULT 0
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
            SELECT member_code,
                   name,
                   dob,
                   gender,
                   created_at,
                   avatar_url,
                   offline_avatar,
                   active
            FROM members
            WHERE meter_id = ? AND hhid = ?
            ORDER BY id
        """, (METER_ID, hhid))

        members = []

        for row in cur.fetchall():
            members.append({
                "member_code": row[0],
                "name": row[1] or row[0],
                "dob": row[2],
                "gender": row[3],
                "created_at": row[4],
                "avatar_url": row[5] or FALLBACK_AVATAR,
                "offline_avatar": row[6] or FALLBACK_AVATAR,
                "active": bool(row[7]),
                "age": calculate_age(row[2])
            })

    return {
        "meter_id": METER_ID,
        "hhid": hhid,
        "members": members
    }


def save_members_data(data: dict):
    meter_id = data.get("meter_id", METER_ID)
    hhid = data.get("hhid", load_hhid())
    members = data.get("members", [])

    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute(
            "DELETE FROM members WHERE meter_id = ? AND hhid = ?",
            (meter_id, hhid)
        )

        for m in members:
            cur.execute("""
                INSERT INTO members (
                    meter_id,
                    hhid,
                    member_code,
                    name,
                    dob,
                    gender,
                    created_at,
                    avatar_url,
                    offline_avatar,
                    active
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                meter_id,
                hhid,
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
            UPDATE members
            SET offline_avatar = ?
            WHERE meter_id = ?
              AND hhid = ?
              AND member_code = ?
        """, (filename, METER_ID, hhid, member_code))

        conn.commit()


def undeclare_all_members_in_db():
    hhid = load_hhid()

    with get_conn() as conn:
        conn.execute("""
            UPDATE members
            SET active = 0
            WHERE meter_id = ? AND hhid = ?
        """, (METER_ID, hhid))

        conn.execute("""
            DELETE FROM guests
            WHERE meter_id = ? AND hhid = ?
        """, (METER_ID, hhid))

        conn.commit()


# ── Guests ────────────────────────────────────────────────────────────────────

# ── Guests ────────────────────────────────────────────────────────────────────

def load_guests_data() -> list:
    hhid = load_hhid()

    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT
                id,
                age,
                gender,
                active
            FROM guests
            WHERE meter_id = ? AND hhid = ?
            ORDER BY id
        """, (METER_ID, hhid))

        guests = []

        for r in cur.fetchall():
            guests.append({
                "id": r[0],
                "age": r[1],
                "gender": r[2],
                "active": bool(r[3]),
            })

        return guests


def save_guests_data(guest_list: list):
    hhid = load_hhid()

    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute("""
            DELETE FROM guests
            WHERE meter_id = ? AND hhid = ?
        """, (METER_ID, hhid))

        for g in guest_list:
            cur.execute("""
                INSERT INTO guests (
                    meter_id,
                    hhid,
                    age,
                    gender,
                    active
                )
                VALUES (?, ?, ?, ?, ?)
            """, (
                METER_ID,
                hhid,
                g.get("age"),
                g.get("gender"),
                int(g.get("active", True)),
            ))

        conn.commit()

    print(f"[DB] Saved {len(guest_list)} guests")


# ── App Settings ──────────────────────────────────────────────────────────────

def get_setting(key: str, default=None):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            (key,)
        ).fetchone()

        return row[0] if row else default


def set_setting(key: str, value):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO app_settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key)
            DO UPDATE SET value = excluded.value
        """, (key, str(value)))

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
        conn.execute("""
            UPDATE notifications
            SET read = 1
            WHERE id = ?
        """, (notif_id,))

        conn.commit()


def save_notification(title: str, message: str, n_type: str = "info"):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO notifications (
                title,
                message,
                type,
                read,
                created_at
            )
            VALUES (?, ?, ?, 0, ?)
        """, (
            title,
            message,
            n_type,
            datetime.now().isoformat()
        ))

        conn.commit()
# ── Groups ────────────────────────────────────────────────────────────────────

def load_groups_data() -> list:
    import json
    # Ensure default groups are created first if none exist
    get_or_create_default_groups()
    
    # Load all members first to check dynamic active status
    members_data = load_members_data()
    members_by_code = {m["member_code"]: m for m in members_data["members"]}
    
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, name, member_codes FROM groups ORDER BY id")
        groups = []
        for row in cur.fetchall():
            group_id = row[0]
            name = row[1]
            try:
                member_codes = json.loads(row[2])
            except Exception:
                member_codes = []
            
            # Find members belonging to the group
            group_members = [members_by_code[code] for code in member_codes if code in members_by_code]
            
            # Dynamic active calculation: active if there is at least one member and ALL members in the group are active
            if not group_members:
                active = False
            else:
                active = all(m["active"] for m in group_members)
            
            groups.append({
                "id": group_id,
                "name": name,
                "member_codes": member_codes,
                "active": active,
                "members": group_members
            })
            
    return groups

def get_or_create_default_groups():
    import json
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM groups")
        count = cur.fetchone()[0]
        if count == 0:
            members_data = load_members_data()
            members = members_data.get("members", [])
            if members:
                # 1. All Members
                all_codes = [m["member_code"] for m in members]
                cur.execute("INSERT INTO groups (name, member_codes) VALUES (?, ?)", ("All Members", json.dumps(all_codes)))
                
                # 2. Adults
                adult_codes = [m["member_code"] for m in members if m.get("age") is not None and m["age"] >= 18]
                if adult_codes:
                    cur.execute("INSERT INTO groups (name, member_codes) VALUES (?, ?)", ("Adults", json.dumps(adult_codes)))
                
                # 3. Kids
                kid_codes = [m["member_code"] for m in members if m.get("age") is not None and m["age"] < 18]
                if kid_codes:
                    cur.execute("INSERT INTO groups (name, member_codes) VALUES (?, ?)", ("Kids", json.dumps(kid_codes)))
                
                conn.commit()

def create_group_in_db(name: str, member_codes: list) -> dict:
    import json
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO groups (name, member_codes) VALUES (?, ?)",
            (name.strip(), json.dumps(member_codes))
        )
        group_id = cur.lastrowid
        conn.commit()
    
    return {"id": group_id, "name": name, "member_codes": member_codes}

def update_group_in_db(group_id: int, name: str, member_codes: list):
    import json
    with get_conn() as conn:
        conn.execute(
            "UPDATE groups SET name = ?, member_codes = ? WHERE id = ?",
            (name.strip(), json.dumps(member_codes), group_id)
        )
        conn.commit()

def delete_group_from_db(group_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        conn.commit()

def toggle_group_in_db(group_id: int) -> bool:
    import json
    # 1. Load the group's member codes
    with get_conn() as conn:
        row = conn.execute("SELECT member_codes FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            raise ValueError("Group not found")
        member_codes = json.loads(row[0])
    
    # 2. Load members to see current active state
    members_data = load_members_data()
    members = members_data["members"]
    members_by_code = {m["member_code"]: m for m in members}
    
    group_members = [members_by_code[code] for code in member_codes if code in members_by_code]
    if not group_members:
        return False
    
    # A group is fully active if all its members are active
    all_active = all(m["active"] for m in group_members)
    target_state = not all_active
    
    # Update active states of members in database
    with get_conn() as conn:
        for code in member_codes:
            conn.execute(
                "UPDATE members SET active = ? WHERE member_code = ? AND meter_id = ? AND hhid = ?",
                (int(target_state), code, METER_ID, load_hhid())
            )
        conn.commit()
        
    return target_state


# ── Utilities ─────────────────────────────────────────────────────────────────

def calculate_age(dob_str: str):
    try:
        dob = datetime.strptime(dob_str, "%Y-%m-%d")
        today = datetime.today()

        return (
            today.year
            - dob.year
            - ((today.month, today.day) < (dob.month, dob.day))
        )

    except Exception:
        return None