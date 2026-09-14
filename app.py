#!/usr/bin/env python3

# app.py — Single entry point for Inditronics APM on Raspberry Pi
#
# Starts the Flask API server in the background, then launches the PyQt5
# browser window pointing at http://127.0.0.1:5000.
#
# Run: python app.py


import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time

from waitress import serve


# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

logger = logging.getLogger(__name__)


# ── Chromium / Qt environment ────────────────────────────────────────────────

# Do NOT disable the Chromium sandbox here.
# The service runs as an unprivileged user so QtWebEngine can use its
# sandbox normally.

os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "1")


# ── PyQt5 imports ────────────────────────────────────────────────────────────

try:
    from PyQt5.QtCore import QUrl, Qt, QTimer
    from PyQt5.QtWidgets import QApplication, QMainWindow, QShortcut
    from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEngineSettings
    from PyQt5.QtGui import QKeySequence

except ImportError:
    print("[ERROR] PyQt5 / PyQt5-WebEngine not found.")
    print("        pip install PyQt5 PyQt5-WebEngine")
    sys.exit(1)


# ── API imports ───────────────────────────────────────────────────────────────

from api import create_app

from api.config import (
    SYSTEM_FILES,
    is_installation_done,
    is_fresh_boot,
    save_boot_id,
    load_hhid,
    METER_ID,
)

from api.db import (
    calculate_age,
    get_conn,
    init_db,
    load_members_data,
)

from api.collector_service import send_event
from api.system import _get_tv_status


FLASK_PORT = 5000


# ── Connection state controller ──────────────────────────────────────────────
#
# Qt/Python is the single controller for connection state.
# JavaScript does not independently poll the API.

POLL_INTERVAL_MS = 5000


# ── Wi-Fi state cache ─────────────────────────────────────────────────────────
#
# Wi-Fi state is owned by the Qt/Python connection-state controller.
# The nmcli call is cached so the 5-second Qt polling loop does not spawn
# nmcli on every iteration.

_WIFI_INTERFACE = "wlan0"
_WIFI_CACHE_TTL = 30.0

_wifi_cache_lock = threading.Lock()
_wifi_cache_value = False
_wifi_cache_timestamp = 0.0


def get_wifi_state():
    """
    Return cached Wi-Fi connection state.

    The subprocess call is performed outside the cache lock so a slow
    NetworkManager command cannot block another caller holding the lock.
    """

    global _wifi_cache_value
    global _wifi_cache_timestamp

    now = time.monotonic()

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
                _WIFI_INTERFACE,
            ],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )

        state = result.stdout.strip()
        connected = state.startswith("100")

    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("[WIFI] Failed to read Wi-Fi state: %s", exc)
        connected = False

    with _wifi_cache_lock:
        _wifi_cache_value = connected
        _wifi_cache_timestamp = time.monotonic()

    return connected


# ── TV state cache ────────────────────────────────────────────────────────────
#
# tv_on is also owned by the Qt/Python connection-state controller.
# Keep a short cache so repeated Qt polling does not repeatedly query the
# underlying Bluetooth state.

_TV_CACHE_TTL = 5.0

_tv_cache_lock = threading.Lock()
_tv_cache_value = False
_tv_cache_timestamp = 0.0


def get_tv_state():
    """
    Return cached TV power state.

    The low-level TV state reader remains in api.system.py.
    app.py owns the cached connection-state value used by the UI.
    """

    global _tv_cache_value
    global _tv_cache_timestamp

    now = time.monotonic()

    with _tv_cache_lock:
        if now - _tv_cache_timestamp < _TV_CACHE_TTL:
            return _tv_cache_value

    ble_available = os.path.exists(
        SYSTEM_FILES["bluetooth_available"]
    )

    try:
        state = bool(_get_tv_status(ble_available))

    except Exception as exc:
        logger.warning("[TV] Failed to read TV state: %s", exc)
        state = False

    with _tv_cache_lock:
        _tv_cache_value = state
        _tv_cache_timestamp = time.monotonic()

    return state


# ── Flask readiness polling ───────────────────────────────────────────────────

FLASK_READY_TIMEOUT = 15.0
FLASK_READY_POLL_INTERVAL = 0.1


# ── Flask runner ──────────────────────────────────────────────────────────────

def run_flask():
    flask_app = create_app()

    # Keep the API loopback-only. The kiosk's Flask API must not be exposed
    # directly to the LAN.
    serve(
        flask_app,
        host="127.0.0.1",
        port=FLASK_PORT,
        threads=2,
    )


def wait_for_flask():
    """
    Wait until the local Flask/Waitress server is actually accepting
    connections.

    Returns True when the port is ready and False when the deadline expires.
    """

    deadline = time.monotonic() + FLASK_READY_TIMEOUT

    while time.monotonic() < deadline:
        try:
            with socket.create_connection(
                ("127.0.0.1", FLASK_PORT),
                timeout=0.2,
            ):
                return True

        except OSError:
            time.sleep(FLASK_READY_POLL_INTERVAL)

    return False


# ── PyQt5 browser window ──────────────────────────────────────────────────────

class BrowserWindow(QMainWindow):

    def __init__(self):
        super().__init__()

        self.view = QWebEngineView()
        self.setCentralWidget(self.view)

        # ── Window chrome ─────────────────────────────────────────────────────

        self.setCursor(Qt.BlankCursor)
        self.view.setContextMenuPolicy(Qt.NoContextMenu)
        self.showFullScreen()

        # ── WebEngine settings ────────────────────────────────────────────────

        settings = self.view.settings()

        settings.setAttribute(
            QWebEngineSettings.LocalStorageEnabled,
            True,
        )

        settings.setAttribute(
            QWebEngineSettings.JavascriptEnabled,
            True,
        )

        settings.setAttribute(
            QWebEngineSettings.LocalContentCanAccessRemoteUrls,
            True,
        )

        # Do not permit insecure HTTP content to bypass Chromium's
        # mixed-content protections.
        settings.setAttribute(
            QWebEngineSettings.AllowRunningInsecureContent,
            False,
        )

        settings.setAttribute(
            QWebEngineSettings.ShowScrollBars,
            False,
        )

        # ── Block zoom shortcuts ──────────────────────────────────────────────

        for seq in ("Ctrl++", "Ctrl+-", "Ctrl+=", "Ctrl+0"):
            QShortcut(
                QKeySequence(seq),
                self,
            ).activated.connect(lambda: None)

        # ── Touch / gesture protection JS ─────────────────────────────────────

        self._protect_js = """
        (function(){
            var m = document.createElement('meta');
            m.name = 'viewport';
            m.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
            document.head.appendChild(m);

            var b = function(e){ e.preventDefault(); };

            document.addEventListener(
                'gesturestart',
                b,
                {passive:false}
            );

            document.addEventListener(
                'gesturechange',
                b,
                {passive:false}
            );

            document.addEventListener(
                'gestureend',
                b,
                {passive:false}
            );

            document.addEventListener(
                'touchmove',
                function(e){
                    if(e.touches.length > 1) e.preventDefault();
                },
                {passive:false}
            );

            document.addEventListener(
                'wheel',
                function(e){
                    if(e.ctrlKey) e.preventDefault();
                },
                {passive:false}
            );
        })();
        """

        # ── Frontend readiness handshake ──────────────────────────────────────
        #
        # main.js changes document.title to "APM_READY" only after
        # DOMContentLoaded initialization is complete.

        self.view.titleChanged.connect(self._on_title_changed)

        # Load failures are still useful to log.
        self.view.loadFinished.connect(self._on_load_finished)

        # ── Connection state controller ───────────────────────────────────────

        self._last_state = None
        self._page_ready = False

        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(POLL_INTERVAL_MS)
        self._poll_timer.timeout.connect(self._poll_connections)

        # ── Load the app ───────────────────────────────────────────────────────

        self.view.setUrl(
            QUrl(f"http://127.0.0.1:{FLASK_PORT}")
        )

    def _on_load_finished(self, ok: bool):
        if not ok:
            logger.error("[APP] Web page failed to load")
            return

        self.view.page().runJavaScript(self._protect_js)

    def _on_title_changed(self, title: str):
        """
        Receive the frontend readiness signal from main.js.
        """

        if title != "APM_READY":
            return

        if self._page_ready:
            return

        self._page_ready = True

        logger.info("[APP] Frontend ready")

        # Push the current state immediately once the page is actually ready.
        self._poll_connections()

        self._poll_timer.start()

    # ── Connection state ──────────────────────────────────────────────────────

    def _read_state(self):
        """
        Read one complete snapshot of connection-related state.

        All connection state comes from the Qt/Python side so there is
        one source of truth for the UI.
        """

        return {
            "usb_jack": os.path.exists(
                SYSTEM_FILES["jack_status"]
            ),
            "hdmi_vcc": os.path.exists(
                SYSTEM_FILES["hdmi_input"]
            ),
            "wifi": get_wifi_state(),
            "internet": os.path.exists(
                SYSTEM_FILES["internet_ok"]
            ),
            "tv_on": get_tv_state(),
        }

    def _push_state(self, state):
        """
        Push one complete connection-state snapshot into the renderer.
        """

        js_state = json.dumps(
            {
                "usb_jack": bool(state["usb_jack"]),
                "hdmi_vcc": bool(state["hdmi_vcc"]),
                "wifi": bool(state["wifi"]),
                "internet": bool(state["internet"]),
                "tv_on": bool(state["tv_on"]),
            },
            separators=(",", ":"),
        )

        js = (
            "if (window.applyDeviceState) "
            f"window.applyDeviceState({js_state});"
        )

        self.view.page().runJavaScript(js)

    def _poll_connections(self):
        """
        Read and push one complete state snapshot only when it changes.
        """

        if not self._page_ready:
            return

        state = self._read_state()

        if state != self._last_state:
            self._last_state = state
            self._push_state(state)

    # ── Key handling ──────────────────────────────────────────────────────────

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_F4 and event.modifiers() == Qt.AltModifier:
            self.close()

        super().keyPressEvent(event)

    def wheelEvent(self, event):
        if event.modifiers() & Qt.ControlModifier:
            event.ignore()
        else:
            super().wheelEvent(event)


# ── Background Internet Checker ──────────────────────────────────────────────

INTERNET_TARGETS = (
    ("1.1.1.1", 53),
    ("8.8.8.8", 53),
    ("9.9.9.9", 53),
)

INTERNET_CONNECT_TIMEOUT = 3.0

# Stable/up interval.
INTERNET_OK_INTERVAL = 60.0

# Retry interval while debouncing failures.
INTERNET_FAILURE_RETRY_INTERVAL = 5.0

# Three complete failed checks before declaring the connection down.
INTERNET_FAIL_THRESHOLD = 3

# When down, retry using exponential backoff, capped at 60 seconds.
INTERNET_BACKOFF_INITIAL = 5.0
INTERNET_BACKOFF_MAX = 60.0


def _check_internet_once():
    """
    Return True if any configured connectivity target accepts
    a TCP connection.

    Targets are checked in order and the first successful connection
    immediately reports the internet as available.
    """

    for host, port in INTERNET_TARGETS:
        sock = socket.socket(
            socket.AF_INET,
            socket.SOCK_STREAM,
        )

        try:
            sock.settimeout(INTERNET_CONNECT_TIMEOUT)
            sock.connect((host, port))
            return True

        except OSError:
            continue

        finally:
            sock.close()

    return False


def _set_internet_flag(internet_ok):
    """
    Create or remove the internet flag only when necessary.

    OSError is logged so permissions or filesystem problems are visible.
    """

    flag_path = SYSTEM_FILES["internet_ok"]

    if internet_ok:
        if os.path.exists(flag_path):
            return

        try:
            with open(flag_path, "w"):
                pass

        except OSError as exc:
            logger.error(
                "[INTERNET] Failed to create %s: %s",
                flag_path,
                exc,
            )

    else:
        if not os.path.exists(flag_path):
            return

        try:
            os.remove(flag_path)

        except OSError as exc:
            logger.error(
                "[INTERNET] Failed to remove %s: %s",
                flag_path,
                exc,
            )


def check_internet_loop():
    """
    Maintain the internet status flag using multiple connectivity targets,
    failure debounce, and backoff.

    Healthy state:
        - Check every 60 seconds.

    Failure debounce:
        - A failed healthy check is retried every 5 seconds.
        - Three consecutive failures are required before declaring
          the connection down.

    Down state:
        - Retry using exponential backoff: 5, 10, 20, 40, 60 seconds.
        - A successful probe immediately restores the connection.
    """

    internet_ok = os.path.exists(
        SYSTEM_FILES["internet_ok"]
    )

    consecutive_failures = 0
    backoff = INTERNET_BACKOFF_INITIAL

    while True:
        probe_ok = _check_internet_once()

        if probe_ok:
            consecutive_failures = 0
            backoff = INTERNET_BACKOFF_INITIAL

            if not internet_ok:
                internet_ok = True
                _set_internet_flag(True)

            time.sleep(INTERNET_OK_INTERVAL)
            continue

        # Probe failed.
        consecutive_failures += 1

        if internet_ok:
            # Keep the existing "up" state while failures are being
            # debounced. Retry quickly instead of waiting the full
            # healthy-state interval.
            if consecutive_failures < INTERNET_FAIL_THRESHOLD:
                time.sleep(INTERNET_FAILURE_RETRY_INTERVAL)
                continue

            internet_ok = False
            _set_internet_flag(False)

            consecutive_failures = 0
            backoff = INTERNET_BACKOFF_INITIAL

            # Give the down-state loop its first retry delay.
            time.sleep(backoff)

            continue

        # Already down: use exponential backoff.
        time.sleep(backoff)

        backoff = min(
            backoff * 2,
            INTERNET_BACKOFF_MAX,
        )


# ── Boot sequence ─────────────────────────────────────────────────────────────

def _boot_reset():
    """On first boot: reset all members/guests to inactive and publish."""

    hhid = load_hhid()

    if not hhid:
        print("[BOOT] No HHID — skipping reset")
        return

    conn = get_conn()

    conn.execute(
        """
        UPDATE members
        SET active = 0
        WHERE meter_id = ? AND hhid = ?
        """,
        (METER_ID, hhid),
    )

    conn.execute(
        """
        DELETE FROM guests
        WHERE meter_id = ? AND hhid = ?
        """,
        (METER_ID, hhid),
    )

    conn.commit()

    data = load_members_data()

    members = [
        {
            "member_id": m["member_code"],
            "age": calculate_age(m["dob"]),
            "gender": m["gender"],
            "active": False,
        }
        for m in data.get("members", [])
        if (
            "dob" in m
            and "gender" in m
            and calculate_age(m["dob"]) is not None
        )
    ]

    send_event(
        3,
        {"members": members},
    )

    send_event(
        4,
        {"guests": []},
    )

    print(
        f"[BOOT] Reset {len(members)} members to inactive, "
        "cleared guests"
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main():

    # 1. Database
    init_db()

    # 2. Boot sequence / fresh-boot detection
    if is_fresh_boot():
        print("[BOOT] Fresh boot — resetting session")
        _boot_reset()

    save_boot_id()

    # 3. Flask API server
    flask_thread = threading.Thread(
        target=run_flask,
        daemon=True,
        name="flask",
    )

    flask_thread.start()

    # 4. Internet monitor
    internet_thread = threading.Thread(
        target=check_internet_loop,
        daemon=True,
        name="internet_check",
    )

    internet_thread.start()

    # 5. Wait for Flask to actually accept connections.
    if not wait_for_flask():
        logger.error(
            "[APP] Flask failed to bind to "
            "127.0.0.1:%d within %.1f seconds",
            FLASK_PORT,
            FLASK_READY_TIMEOUT,
        )

        sys.exit(1)

    print(
        f"[APP] Flask running at "
        f"http://127.0.0.1:{FLASK_PORT}"
    )

    print(
        f"[APP] Installation done: "
        f"{is_installation_done()}"
    )

    # 6. PyQt5 Qt window
    qt_app = QApplication(sys.argv)

    window = BrowserWindow()
    window.show()

    sys.exit(qt_app.exec_())


if __name__ == "__main__":
    main()