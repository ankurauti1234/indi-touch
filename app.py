#!/usr/bin/env python3
# main.py — Single entry point for Inditronics APM on Raspberry Pi
#
# Starts Flask API server in the background, then launches the PyQt6 browser
# window pointing at http://127.0.0.1:5000.
#
# Run:  python main.py

import os
import sys
import time
import threading

# ── Chromium / Qt environment ─────────────────────────────────────────────────
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--no-sandbox")
os.makedirs("/tmp/runtime-root", exist_ok=True)
os.chmod("/tmp/runtime-root", 0o700)
os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-root")
os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "1")

# ── PyQt5 imports ─────────────────────────────────────────────────────────────
try:
    from PyQt5.QtCore    import QUrl, Qt, QTimer
    from PyQt5.QtWidgets import QApplication, QMainWindow, QShortcut
    from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEngineSettings
    from PyQt5.QtGui     import QKeySequence
except ImportError:
    print("[ERROR] PyQt5 / PyQt5-WebEngine not found.")
    print("        pip install PyQt5 PyQtWebEngine")
    sys.exit(1)

# ── API imports ───────────────────────────────────────────────────────────────
from api         import create_app
from api.config  import SYSTEM_FILES, is_installation_done, is_fresh_boot, save_boot_id
from api.db      import init_db
from api.collector_service import (
    publish_member_event, publish_guest_event, send_event
)
from api.db import load_members_data, load_guests_data, calculate_age

FLASK_PORT = 5000
POLL_INTERVAL_MS = 5000   # how often to check /run files in the Qt event loop


# ── Flask runner ──────────────────────────────────────────────────────────────
def run_flask():
    flask_app = create_app()
    flask_app.run(host="0.0.0.0", port=FLASK_PORT,
                  debug=False, use_reloader=False, threaded=True)


# ── PyQt6 browser window ──────────────────────────────────────────────────────
class BrowserWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.view = QWebEngineView()
        self.setCentralWidget(self.view)

        # ── Window chrome ──────────────────────────────────────────────────────
        self.setCursor(Qt.BlankCursor)
        self.view.setContextMenuPolicy(Qt.NoContextMenu)
        self.showFullScreen()

        # ── WebEngine settings ─────────────────────────────────────────────────
        settings = self.view.settings()
        settings.setAttribute(QWebEngineSettings.LocalStorageEnabled,             True)
        settings.setAttribute(QWebEngineSettings.JavascriptEnabled,               True)
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.AllowRunningInsecureContent,     True)
        settings.setAttribute(QWebEngineSettings.ShowScrollBars,                  False)

        # ── Block zoom shortcuts ───────────────────────────────────────────────
        for seq in ("Ctrl++", "Ctrl+-", "Ctrl+=", "Ctrl+0"):
            QShortcut(QKeySequence(seq), self).activated.connect(lambda: None)

        # ── Touch / gesture protection JS ─────────────────────────────────────
        self._protect_js = """
        (function(){
            var m = document.createElement('meta');
            m.name = 'viewport';
            m.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
            document.head.appendChild(m);
            var b = function(e){ e.preventDefault(); };
            document.addEventListener('gesturestart',  b, {passive:false});
            document.addEventListener('gesturechange', b, {passive:false});
            document.addEventListener('gestureend',    b, {passive:false});
            document.addEventListener('touchmove', function(e){
                if(e.touches.length>1) e.preventDefault();
            }, {passive:false});
            document.addEventListener('wheel', function(e){
                if(e.ctrlKey) e.preventDefault();
            }, {passive:false});
        })();
        """
        self.view.loadFinished.connect(self._on_load_finished)

        # ── Connection state polling (every POLL_INTERVAL_MS) ─────────────────
        self._last_usb  = None
        self._last_wifi = None
        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(POLL_INTERVAL_MS)
        self._poll_timer.timeout.connect(self._poll_connections)
        self._poll_timer.start()

        # ── Load the app ───────────────────────────────────────────────────────
        self.view.setUrl(QUrl(f"http://127.0.0.1:{FLASK_PORT}"))

    def _on_load_finished(self, ok: bool):
        if ok:
            self.view.page().runJavaScript(self._protect_js)
            # Push current connection state immediately after load
            self._push_usb_state()
            self._push_wifi_state()

    # ── Connection polling ────────────────────────────────────────────────────
    def _push_usb_state(self):
        connected = os.path.exists(SYSTEM_FILES["jack_status"])
        js = f"if(window.setUsbState) window.setUsbState({'true' if connected else 'false'});"
        self.view.page().runJavaScript(js)
        self._last_usb = connected

    def _push_wifi_state(self):
        connected = os.path.exists(SYSTEM_FILES["wifi_up"])
        js = f"if(window.setWifiState) window.setWifiState({'true' if connected else 'false'});"
        self.view.page().runJavaScript(js)
        self._last_wifi = connected

    def _poll_connections(self):
        usb  = os.path.exists(SYSTEM_FILES["jack_status"])
        wifi = os.path.exists(SYSTEM_FILES["wifi_up"])

        if usb != self._last_usb:
            self._push_usb_state()
        if wifi != self._last_wifi:
            self._push_wifi_state()

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


# ── Boot sequence ─────────────────────────────────────────────────────────────
def _boot_reset():
    """On first boot: reset all members/guests to inactive and publish."""
    from api.config import load_hhid, METER_ID
    hhid = load_hhid()
    if not hhid:
        print("[BOOT] No HHID — skipping reset")
        return

    import sqlite3, time as _t
    from api.config import DB_PATH

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE members SET active = 0 WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
        conn.execute("DELETE FROM guests WHERE meter_id = ? AND hhid = ?", (METER_ID, hhid))
        conn.commit()

    data    = load_members_data()
    members = [
        {"member_id": m["member_code"], "age": calculate_age(m["dob"]),
         "gender": m["gender"], "active": False}
        for m in data.get("members", [])
        if "dob" in m and "gender" in m and calculate_age(m["dob"]) is not None
    ]
    send_event(3, {"members": members})
    send_event(4, {"guests": []})
    print(f"[BOOT] Reset {len(members)} members to inactive, cleared guests")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    # 1. Database
    init_db()

    # 2. Boot sequence / Fresh-boot detection
    if is_fresh_boot():
        print("[BOOT] Fresh boot — resetting session")
        _boot_reset()
    save_boot_id()

    # 4. Flask in background thread
    flask_thread = threading.Thread(target=run_flask, daemon=True, name="flask")
    flask_thread.start()
    time.sleep(1.5)  # wait for Flask to bind before Qt loads the URL
    print(f"[APP] Flask running at http://127.0.0.1:{FLASK_PORT}")
    print(f"[APP] Installation done: {is_installation_done()}")

    # 5. PyQt6 Qt window
    qt_app = QApplication(sys.argv)
    window = BrowserWindow()
    window.show()
    sys.exit(qt_app.exec_())


if __name__ == "__main__":
    main()
